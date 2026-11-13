import type { AppSettings, EnhancedSupportStatus } from "./types";

export type EnhancedSetupOutcome =
    | { kind: "disabled" }
    | { kind: "declined" }
    | { kind: "target-conflict" | "repair-declined" | "install-declined-fallback" | "upgrade-declined" | "upgrade-forbidden" | "available" | "installed" | "upgraded" | "repaired" | "missing" | "skipped" | "compiler-unavailable"; status: EnhancedSupportStatus; automatic?: boolean };

const CMD_RUN_COMPONENT = {
    name: "CMD_RUN",
    purpose: "An SQL function that improves CL processing and message logging. It enables SQL scripts with embedded CL commands to run in the same SQL server job.",
    without: "Without enhanced CL support, CL commands run in a different job. OVRDBF overrides, library list changes, and QTEMP objects apply to that job instead of the SQL server job.",
};

function alternativeSettingsHint(): string {
    return "To use another library on a new connection, change Function Library in Settings and reconnect.";
}

export function enhancedSupportInstallationMessages(
    installations: EnhancedSupportStatus[], newerAvailable?: EnhancedSupportStatus | null, detail?: string,
): string[] {
    if (!installations.length) return [];
    const messages = ["Additional CMD_RUN installations detected."];
    for (const installation of installations) {
        const bundledVersion = installation.bundledVersion || "unknown";
        const versionComment = installation.versionStatus === "current" ? `matches bundled version ${bundledVersion}`
            : installation.versionStatus === "newer" ? `newer than bundled version ${bundledVersion}`
                : installation.versionStatus === "older" ? `older than bundled version ${bundledVersion}`
                    : "version status unknown";
        const newestComment = newerAvailable?.library?.toUpperCase() === installation.library.toUpperCase()
            ? "; newest detected installation" : "";
        const detailComment = detail ? `; ${detail}` : "";
        messages.push(`${installation.library} (version ${installation.installedVersion || "unknown"}): ${versionComment}${newestComment}${detailComment}.`);
    }
    messages.push(alternativeSettingsHint());
    return messages;
}

function promptAlternatives(status: EnhancedSupportStatus, targetLibrary: string): EnhancedSupportStatus[] {
    const installations = [...(status.installations ?? [])];
    if (status.installed && !installations.some((entry) => entry.library.toUpperCase() === status.library.toUpperCase())) {
        installations.push(status);
    }
    return installations.filter((entry, index) => entry.installed && entry.library.toUpperCase() !== targetLibrary.toUpperCase()
        && installations.findIndex((other) => other.installed && other.library.toUpperCase() === entry.library.toUpperCase()) === index);
}

function compareVersions(installedVersion?: string | null, bundledVersion?: string | null): number | null {
    const numeric = /^[0-9]+(\.[0-9]+)*$/;
    if (!numeric.test(installedVersion || "") || !numeric.test(bundledVersion || "")) return null;
    const installed = installedVersion!.split(".");
    const bundled = bundledVersion!.split(".");
    for (let index = 0; index < Math.max(installed.length, bundled.length); index++) {
        const left = BigInt(installed[index] || "0");
        const right = BigInt(bundled[index] || "0");
        if (left !== right) return left > right ? 1 : -1;
    }
    return 0;
}

function eligibleInstallation(status: EnhancedSupportStatus, bundledVersion = status.bundledVersion): boolean {
    const library = status.library.toUpperCase();
    const comparison = compareVersions(status.installedVersion, bundledVersion);
    if (!/^[A-Z#$@][A-Z0-9_#$@]{0,9}$/.test(library) || library === "QTEMP" || library === "QSYS" ||
        (library.startsWith("Q") && library !== "QGPL") || !status.installed || !status.programExists || !status.routineExists || !status.routineMatches ||
        (status.versionStatus !== "current" && status.versionStatus !== "newer") ||
        comparison === null || comparison < 0) return false;
    return true;
}

function supportPrompt(
    host: string, library: string, status: EnhancedSupportStatus,
    operation: "install" | "upgrade" | "repair", details: string,
): string {
    const alternatives = promptAlternatives(status, library);
    const versions = operation === "upgrade" ? `\nInstalled version: ${status.installedVersion || "unknown"}` : "";
    const otherLibraries = alternatives.length
        ? `\n\nDuplicate function names in these libraries:\n${alternatives.map((entry) => `${entry.library} (version ${entry.installedVersion || "unknown"})${eligibleInstallation(entry, status.bundledVersion) ? "" : " - not eligible"}`).join("\n")}`
        : "";
    return `Server: ${host}\nFunction: ${CMD_RUN_COMPONENT.name}\nLibrary: ${library}\nFunction Version: ${status.bundledVersion || "unknown"}${versions}\n\nThe application requests to ${operation === "repair" ? "repair the host components and install" : operation} the SQL function ${CMD_RUN_COMPONENT.name} on IBM i.\n\nComponent: ${CMD_RUN_COMPONENT.name} - ${CMD_RUN_COMPONENT.purpose}\n\n${CMD_RUN_COMPONENT.without}${otherLibraries}\n\n${details}`;
}

function installDetails(): string {
    return `Click Install to install CMD_RUN. The source is placed in QCOZZISRC and compiled on the IBM i server; the C++ compiler is required. The new program will have public authority AUT(*ALL).`;
}

export async function setupEnhancedSupport(
    settings: AppSettings,
    host: string,
    check: (library: string) => Promise<EnhancedSupportStatus>,
    install: (library: string) => Promise<EnhancedSupportStatus>,
    confirm: (message: string, operation?: "install" | "upgrade" | "repair" | "select", alternatives?: EnhancedSupportStatus[]) => boolean | string | Promise<boolean | string>,
    override?: boolean,
    upgrade?: (library: string, expectedInstalledVersion: string) => Promise<EnhancedSupportStatus>,
    detected?: (status: EnhancedSupportStatus) => void,
    repair?: (library: string) => Promise<EnhancedSupportStatus>,
    select?: (library: string) => Promise<EnhancedSupportStatus>,
    selected?: (library: string) => void,
    autoStarting?: (operation: "install" | "upgrade" | "repair", library: string, alternatives: EnhancedSupportStatus[]) => void,
): Promise<EnhancedSetupOutcome> {
    if (override !== true) return { kind: "disabled" };
    const library = settings.enhancedSupportLibrary || "SQLTOOLS";
    const status = await check(library);
    if (status.cppCompilerAvailable === false) return { kind: "compiler-unavailable", status };
    const target = status.configuredTarget;
    const alternatives = promptAlternatives(status, library).filter((entry) => eligibleInstallation(entry, status.bundledVersion));
    const policy = settings.functionUpdateNotifications ?? "always";
    let automatic = false;
    const ask = async (message: string, operation: "install" | "upgrade" | "repair" | "select"): Promise<boolean | { kind: "available" | "skipped"; status: EnhancedSupportStatus }> => {
        if (policy === "noneSkip") return { kind: "skipped", status };
        if (operation === "select" && policy === "noneAuto") return false;
        if (operation !== "select" && (policy === "noneAuto" || (operation === "install" || operation === "repair") && policy === "updatesOnly" || operation === "upgrade" && policy === "newOnly")) {
            automatic = true;
            autoStarting?.(operation, library, promptAlternatives(status, library));
            return true;
        }
        const choice = select && alternatives.length ? await confirm(message, operation, alternatives) : await confirm(message, operation);
        if (typeof choice !== "string") return choice === true;
        const chosen = alternatives.find((entry) => entry.library.toUpperCase() === choice.toUpperCase());
        if (!chosen || !select) throw new Error("Invalid enhanced support library selection.");
        const result = await select(chosen.library.toUpperCase());
        if (result.library.toUpperCase() !== chosen.library.toUpperCase() || !eligibleInstallation(result) ||
            !result.programExists || !result.routineExists || !result.routineMatches ||
            !result.configuredTarget || result.configuredTarget.library.toUpperCase() !== chosen.library.toUpperCase() ||
            !eligibleInstallation(result.configuredTarget) || result.configuredTarget.installedVersion !== result.installedVersion ||
            result.configuredTarget.bundledVersion !== result.bundledVersion || result.configuredTarget.versionStatus !== result.versionStatus) {
            throw new Error(`Selected ${chosen.library}.CMD_RUN could not be verified.`);
        }
        selected?.(chosen.library.toUpperCase());
        return { kind: "available", status: result };
    };
    if (target && target.library.toUpperCase() === library.toUpperCase() && !target.installed && (target.programExists || target.routineExists || target.routineMatches)) {
        const targetLibrary = library.toUpperCase();
        if (!target.programExists || target.routineExists || target.routineMatches || !repair || (targetLibrary.startsWith("Q") && targetLibrary !== "QGPL")) {
            if (select && alternatives.length) {
                const choice = await ask(`Server: ${host}\nLibrary: ${targetLibrary}\n\nThe configured library contains an incomplete or conflicting CMD_RUN. No host objects will be replaced; inspect the target before installation.`, "select");
                if (typeof choice !== "boolean") return choice;
            }
            return { kind: "target-conflict", status };
        }
        const fallback = status.installed && status.library.toUpperCase() !== targetLibrary
            ? status.versionStatus === "older"
                ? `Cancel avoids replacing the program. ${status.library}.CMD_RUN is older and unavailable until upgraded.`
                : "Cancel avoids replacing the program. Enhanced CL remains unavailable for this connection."
            : "Cancel avoids replacing the program. Enhanced CL remains unavailable for this connection.";
        const accepted = await ask(supportPrompt(host, targetLibrary, status, "repair", `${fallback}\n\nReplace the existing ${targetLibrary}/CMD_RUN program and install the SQL function? The program may belong to another application or owner. The old program moves to QRPLOBJ; the new program has public authority AUT(*ALL). New source members and the compiled module are retained.\n\nA failure may leave partial changes, with no rollback or automatic retry; inspect the objects and host job log before manual recovery. Coordinate exclusive administrative access throughout: catalog visibility and checks cannot prevent concurrent changes.`), "repair");
        if (typeof accepted !== "boolean") return accepted;
        if (!accepted) return { kind: "repair-declined", status };
        let result: EnhancedSupportStatus;
        try {
            result = await repair(library);
        } catch (error) {
            throw new Error(`Repair of ${targetLibrary}/CMD_RUN failed; partial changes may remain and no rollback or automatic retry was attempted. Inspect the target and host job log before manual recovery: ${String((error as Error)?.message ?? error)}`);
        }
        if (result.library.toUpperCase() !== targetLibrary || !result.installed || !result.programExists || !result.routineExists || !result.routineMatches ||
            result.versionStatus !== "current" || !result.version || result.version !== result.installedVersion || result.version !== result.bundledVersion ||
            !result.cppMember || !result.sqlMember || !result.module) {
            throw new Error(`Repair of ${targetLibrary}/CMD_RUN did not complete; partial changes may remain. Inspect the target and host job log before manual recovery; do not retry automatically.`);
        }
        return { kind: "repaired", status: result, ...(automatic ? { automatic: true } : {}) };
    }
    if (target && target.library.toUpperCase() === library.toUpperCase() && !target.installed
        && status.installed && status.library.toUpperCase() !== library.toUpperCase()) {
        const accepted = await ask(supportPrompt(host, library, status, "install", installDetails()), "install");
        if (typeof accepted !== "boolean") return accepted;
        if (!accepted) {
            return { kind: "install-declined-fallback", status };
        }
        let result: EnhancedSupportStatus;
        try {
            result = await install(library);
        } catch (error) {
            const detail = String((error as Error)?.message ?? error);
            if (detail.includes("No source members were added or uploaded")) {
                throw new Error(`Installation in ${library} stopped before source upload: ${detail}`);
            }
            throw new Error(`Installation in ${library} failed; partial changes may remain. Inspect the target and host job log before retrying: ${detail}`);
        }
        if (result.library.toUpperCase() !== library.toUpperCase() || !eligibleInstallation(result)) {
            throw new Error(`Enhanced support installation in ${library} did not complete; inspect the target before retrying.`);
        }
        return { kind: "installed", status: result, ...(automatic ? { automatic: true } : {}) };
    }
    if (status.installed) {
        detected?.(status);
        if (status.library.toUpperCase() !== library.toUpperCase()) return { kind: "missing", status };
        const comparison = compareVersions(status.installedVersion, status.bundledVersion);
        if ((status.versionStatus !== "older" && status.versionStatus !== "current" && status.versionStatus !== "newer") ||
            comparison === null || (status.versionStatus === "older" && comparison !== -1)) {
            if (select && alternatives.length) {
                const choice = await ask(`Server: ${host}\nLibrary: ${library}\n\nThe installed CMD_RUN version could not be determined. It will not be replaced. Select an eligible library to use instead, or cancel and inspect the configured installation.`, "select");
                if (typeof choice !== "boolean") return choice;
            }
            return { kind: "missing", status };
        }
        if (status.versionStatus !== "older") return eligibleInstallation(status) && target && eligibleInstallation(target) &&
            target.library.toUpperCase() === library.toUpperCase() && status.programExists && status.routineExists && status.routineMatches &&
            target.programExists && target.routineExists && target.routineMatches && target.installedVersion === status.installedVersion &&
            target.bundledVersion === status.bundledVersion && target.versionStatus === status.versionStatus
            ? { kind: "available", status } : { kind: "missing", status };
        const discoveredLibrary = status.library.toUpperCase();
        if (discoveredLibrary.startsWith("Q") && discoveredLibrary !== "QGPL") return { kind: "upgrade-forbidden", status };
        if (!status.installedVersion || !status.bundledVersion || !upgrade) return { kind: "missing", status };
        if ((policy === "newOnly" || policy === "noneAuto") && (!target || target.library.toUpperCase() !== discoveredLibrary || !target.installed ||
            !target.programExists || !target.routineExists || !target.routineMatches || !status.programExists || !status.routineExists || !status.routineMatches ||
            target.installedVersion !== status.installedVersion || target.bundledVersion !== status.bundledVersion || target.versionStatus !== "older")) {
            return { kind: "missing", status };
        }
        const accepted = await ask(supportPrompt(host, status.library, status, "upgrade", `Cancel leaves ${status.library}.CMD_RUN unavailable for enhanced CL until upgraded.\n\nThe CMD_RUN program and SQL routine will be replaced. Dependencies may be affected and routine labels and comments will be replaced. Existing and new sources and the compiled module are retained. The old program moves to QRPLOBJ; the new program has public authority AUT(*ALL).\n\nA failure can leave partial changes, with no rollback or automatic retry; inspect the target and host job log before manual recovery. Coordinate exclusive administrative access and review authorities before proceeding.`), "upgrade");
        if (typeof accepted !== "boolean") return accepted;
        if (!accepted) return { kind: "upgrade-declined", status };
        let result: EnhancedSupportStatus;
        try {
            result = await upgrade(status.library, status.installedVersion);
        } catch (error) {
            throw new Error(`Upgrade of ${status.library}.CMD_RUN failed; partial changes may remain. Inspect the target and host job log before retrying: ${String((error as Error)?.message ?? error)}`);
        }
        if (result.library.toUpperCase() !== status.library.toUpperCase() || result.versionStatus !== "current" || !eligibleInstallation(result)) {
            throw new Error(`Upgrade of ${status.library}.CMD_RUN did not complete; partial changes may remain. Inspect the target before retrying.`);
        }
        return { kind: "upgraded", status: result, ...(automatic ? { automatic: true } : {}) };
    }
    if (!target) throw new Error("Enhanced support discovery requires an updated JDBC bridge.");
    if (target.library.toUpperCase() !== library.toUpperCase()) throw new Error("Invalid enhanced support installation target.");
    if (target.programExists || target.routineExists) {
        throw new Error(`Enhanced support in ${library} is incomplete or conflicts with an existing object (program: ${target.programExists ? "found" : "not found"}; routine: ${target.routineExists ? "found" : "not found"}). No installation was attempted; inspect CMD_RUN before installation.`);
    }
    const accepted = await ask(supportPrompt(host, library, status, "install", installDetails()), "install");
    if (typeof accepted !== "boolean") return accepted;
    if (!accepted) return { kind: "declined" };
    let result: EnhancedSupportStatus;
    try {
        result = await install(library);
    } catch (error) {
        const detail = String((error as Error)?.message ?? error);
        if (detail.includes("No source members were added or uploaded")) {
            throw new Error(`Installation in ${library} stopped before source upload: ${detail}`);
        }
        throw new Error(`Installation in ${library} failed; partial changes may remain. Inspect the target and host job log before retrying: ${detail}`);
    }
    if (result.library.toUpperCase() !== library.toUpperCase() || !eligibleInstallation(result)) throw new Error(`Enhanced support installation in ${library} did not complete.`);
    return { kind: "installed", status: result, ...(automatic ? { automatic: true } : {}) };
}

export function enhancedSupportAlternativeMessage(status: EnhancedSupportStatus): string[] | null {
    const configuredLibrary = status.configuredTarget?.library || status.library;
    const alternatives = (status.installations ?? []).filter((entry, index, entries) =>
        entry.library.toUpperCase() !== configuredLibrary.toUpperCase()
        && entries.findIndex((other) => other.library.toUpperCase() === entry.library.toUpperCase()) === index);
    if (!alternatives.length) return null;
    return enhancedSupportInstallationMessages(alternatives, status.newerAvailable);
}

export function enhancedSupportMessage(outcome: EnhancedSetupOutcome, host: string): { text: string; warning: boolean } | null {
    if (outcome.kind === "disabled") return null;
    if (outcome.kind === "declined") return { text: `Enhanced support installation declined for ${host}.`, warning: false };
    const { status } = outcome;
    if (outcome.kind === "skipped") return { text: `Enhanced support changes skipped on ${host} by notification settings.`, warning: false };
    if (outcome.kind === "compiler-unavailable") {
        return { text: `IBM i C++ compiler library QCPPLE was not detected on ${host}. No CMD_RUN source was uploaded and no module was built; this connection will use QSYS2.QCMDEXC until the compiler is detected. Install the C++ compiler and reconnect to try Enhanced CL Support again.`, warning: true };
    }
    const versions = `Installed version: ${status.installedVersion || "unknown"}; version included with this app: ${status.bundledVersion || "unknown"}.`;
    if (outcome.kind === "target-conflict" || outcome.kind === "repair-declined" || outcome.kind === "install-declined-fallback") {
        const target = status.configuredTarget!;
        const reason = outcome.kind === "target-conflict"
            ? `Configured library ${target.library} has an incomplete or conflicting CMD_RUN installation (program: ${target.programExists ? "found" : "not found"}; routine: ${target.routineExists ? "found" : "not found"}). Nothing was replaced; inspect the target before installation.`
            : outcome.kind === "repair-declined" ? `Repair in ${target.library} was declined; nothing was replaced.` : `Installation in ${target.library} was declined.`;
        const fallback = " Enhanced CL is unavailable for this connection.";
        const alternatives = enhancedSupportAlternativeMessage(status);
        const noAlternatives = alternatives ? "" : " No recognized alternate CMD_RUN installations.";
        return { text: `${reason}${fallback}${noAlternatives}`, warning: true };
    }
    if (outcome.kind === "upgrade-forbidden") {
        return { text: `${status.library}.CMD_RUN on ${host} cannot be upgraded: enhanced support target libraries must not begin with Q except QGPL. Enhanced CL execution remains unavailable until upgraded. ${versions}`, warning: true };
    }
    if (outcome.kind === "upgrade-declined") {
        return { text: `Upgrade of ${status.library}.CMD_RUN on ${host} was declined. Enhanced CL execution remains unavailable until upgraded. ${versions}`, warning: true };
    }
    if (outcome.kind === "missing") {
        return { text: `Enhanced support is unavailable in ${status.library} on ${host}. ${versions} Inspect the installation or select another Function Library in Settings; an unknown version will not be replaced.`, warning: true };
    }
    const detected = `${outcome.automatic ? "Automatically " : ""}${outcome.kind === "repaired" ? "Repaired" : outcome.kind === "upgraded" ? "Upgraded" : outcome.kind === "installed" ? "Installed" : "Detected"} ${status.library}.CMD_RUN version ${status.installedVersion || "unknown"}. Using it for CL processing.`;
    if (outcome.kind === "available" && status.versionStatus === "newer" && !status.newerAvailable
        && status.configuredTarget?.installed && status.configuredTarget.library.toUpperCase() === status.library.toUpperCase()) {
        return { text: detected, warning: false };
    }
    const state = status.versionStatus === "current" && status.installedVersion && status.bundledVersion
        ? "current" : status.versionStatus === "older" || status.versionStatus === "newer" ? status.versionStatus : "unknown";
    if (state !== "current") {
        return { text: `${detected} Version status ${state}. ${versions} Existing objects were not replaced; newer or unknown versions are never automatically upgraded or downgraded.`, warning: true };
    }
    return { text: detected, warning: false };
}

export function enhancedSupportLogEntry(outcome: EnhancedSetupOutcome, host: string): { text: string; cls: string; reveal: boolean } | null {
    const message = enhancedSupportMessage(outcome, host);
    if (!message) return null;
    if (!message.warning && (outcome.kind === "installed" || outcome.kind === "upgraded" || outcome.kind === "repaired")) {
        return { text: `Completed: ${message.text}`, cls: "msg-success", reveal: true };
    }
    if (!message.warning && outcome.kind === "available") {
        return { text: message.text, cls: "msg-detected", reveal: false };
    }
    return { text: message.text, cls: message.warning ? "msg-warning" : "msg-info", reveal: message.warning };
}

export function appendEnhancedSupportLog(
    tab: { snapshot?: { messagesHtml: string; messagesVisible: boolean; activePane?: string }; pendingMessagesHtml?: string; pendingMessagesReveal?: boolean },
    active: boolean, list: HTMLElement, text: string, cls: string, reveal: boolean,
): string | null {
    const line = document.createElement("li");
    line.className = `msg ${cls} msg-indent`;
    line.textContent = text;
    if (active) {
        list.appendChild(line);
        return list.innerHTML;
    }
    if (!tab.snapshot) {
        tab.pendingMessagesHtml = (tab.pendingMessagesHtml ?? "") + line.outerHTML;
        tab.pendingMessagesReveal = tab.pendingMessagesReveal || reveal;
        return tab.pendingMessagesHtml;
    }
    tab.snapshot.messagesHtml += line.outerHTML;
    tab.snapshot.messagesVisible = true;
    if (reveal) tab.snapshot.activePane = "messages";
    return tab.snapshot.messagesHtml;
}

let enhancedDialogSequence = 0;

export function confirmEnhancedSupport(message: string, operation: "install" | "upgrade" | "repair" | "select" = "install", alternatives: EnhancedSupportStatus[] = []): Promise<boolean | string> {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay";
        const dialog = document.createElement("div");
        dialog.className = "confirm-dialog enhanced-support-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-labelledby", "enhanced-support-confirm-title");
        const title = document.createElement("div");
        title.className = "confirm-title";
        title.id = "enhanced-support-confirm-title";
        title.textContent = operation === "select" ? "Select Function Library" : "Install IBM i Server Host Components";
        const description = document.createElement("div");
        description.className = "enhanced-support-body";
        const sections = message.split("\n\n");
        sections.forEach((section, index) => {
            const element = document.createElement(index === 0 && section.startsWith("Server: ") ? "div" : "p");
            element.className = index === 0 && section.startsWith("Server: ") ? "enhanced-support-details" : "enhanced-support-section";
            if (section.startsWith("Duplicate function names in these libraries:\n")) element.classList.add("enhanced-support-alternatives");
            element.textContent = section;
            description.append(element);
        });
        const actions = document.createElement("div");
        actions.className = "confirm-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = "Cancel";
        const install = document.createElement("button");
        install.type = "button";
        install.className = "btn primary";
        install.textContent = operation === "select" ? "Use Library" : operation === "repair" ? "Repair" : operation === "upgrade" ? "Upgrade" : "Install";
        install.disabled = operation === "select";
        const operationLabel = install.textContent;
        let selected = "";
        if (alternatives.length) {
            const groupName = `enhanced-support-action-${++enhancedDialogSequence}`;
            const choices = document.createElement("fieldset");
            choices.className = "enhanced-support-choices";
            const legend = document.createElement("legend");
            legend.textContent = operation === "select" ? "Choose which function library to use" : "Choose where to install the function";
            choices.append(legend);
            const addChoice = (value: string, labelText: string) => {
                const label = document.createElement("label");
                const radio = document.createElement("input");
                radio.type = "radio";
                radio.name = groupName;
                radio.value = value;
                radio.checked = operation !== "select" && !value;
                radio.addEventListener("change", () => {
                    selected = value;
                    install.disabled = operation === "select" && !value;
                });
                label.append(radio, document.createTextNode(labelText));
                choices.append(label);
            };
            const configuredLibrary = message.match(/^Library:\s*(.+)$/m)?.[1]?.trim();
            if (operation !== "select") {
                const configuredVersion = message.match(/^Installed version:\s*(.+)$/m)?.[1]?.trim();
                const version = configuredVersion ? ` (version ${configuredVersion})` : "";
                addChoice("", `${configuredLibrary || "Configured library"}${version} DEFAULT`);
            }
            for (const entry of alternatives) addChoice(entry.library, `${entry.library} (version ${entry.installedVersion || "unknown"})`);
            description.append(choices);
        }
        const finish = (accepted: boolean | string) => { overlay.remove(); resolve(accepted); };
        cancel.addEventListener("click", () => finish(false));
        install.addEventListener("click", () => {
            if (!selected) { finish(true); return; }
            const confirmation = document.createElement("div");
            confirmation.className = "confirm-overlay";
            const box = document.createElement("div");
            box.className = "confirm-dialog";
            box.setAttribute("role", "dialog");
            box.setAttribute("aria-modal", "true");
            box.setAttribute("aria-label", "Confirm Function Library");
            const question = document.createElement("p");
            question.textContent = "Should we change the Function Library name in Settings to this library?";
            const libraryName = document.createElement("p");
            libraryName.textContent = selected;
            const buttons = document.createElement("div");
            buttons.className = "confirm-actions";
            const back = document.createElement("button");
            back.type = "button";
            back.className = "btn";
            back.textContent = "Cancel";
            const ok = document.createElement("button");
            ok.type = "button";
            ok.className = "btn primary";
            ok.textContent = "OK";
            const close = () => { confirmation.remove(); dialog.removeAttribute("aria-hidden"); install.focus(); };
            back.addEventListener("click", close);
            ok.addEventListener("click", () => { confirmation.remove(); finish(selected); });
            confirmation.addEventListener("keydown", (event) => {
                if (event.key === "Escape") { event.stopPropagation(); close(); }
            });
            buttons.append(back, ok);
            box.append(question, libraryName, buttons);
            confirmation.append(box);
            dialog.setAttribute("aria-hidden", "true");
            document.body.append(confirmation);
            back.focus();
        });
        overlay.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.stopPropagation(); finish(false); }
        });
        actions.append(cancel, install);
        dialog.append(title, description, actions);
        overlay.append(dialog);
        document.body.append(overlay);
        cancel.focus();
    });
}