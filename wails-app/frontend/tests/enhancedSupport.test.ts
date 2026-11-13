import { describe, expect, it, vi } from "vitest";
import { appendEnhancedSupportLog, confirmEnhancedSupport, enhancedSupportAlternativeMessage, enhancedSupportLogEntry, enhancedSupportMessage, setupEnhancedSupport } from "../src/enhancedSupport";
import type { AppSettings } from "../src/types";

const target = { library: "MYLIB", installed: false, programExists: false, routineExists: false, routineMatches: false };
const missing = { ...target, configuredTarget: target };

describe("connection enhanced support", () => {
    const installed = (library: string, version: string | null, versionStatus: string) => ({
        library, installed: true, programExists: true, routineExists: true, routineMatches: true,
        installedVersion: version, bundledVersion: "1.9", versionStatus,
    });
    const verified = (library: string) => {
        const entry = installed(library, "1.10", "newer");
        return { ...entry, configuredTarget: entry, installations: [entry] };
    };
    const discovery = () => ({ ...installed("BESTLIB", "9.0", "newer"), configuredTarget: target, installations: [
        installed("BESTLIB", "9.0", "newer"), installed("OTHER", "1.10", "newer"),
        installed("OLDLIB", "1.8", "older"), installed("UNKNOWN", null, "unknown"),
        installed("QFOO", "9.0", "newer"), installed("BAD.NAME", "9.0", "newer"),
        installed("LYING", "1.8", "newer"), installed("QGPL", "1.9.0", "current"),
    ] });
    it.each([undefined, null, "always", "newOnly", "updatesOnly", "noneAuto", "noneSkip"] as const)("applies %s policy to new, repair, update, current and unknown", async (policy) => {
        for (const kind of ["new", "repair", "update", "current", "newer", "unknown"] as const) {
            const configured = kind === "new" ? target : kind === "repair" ? { ...target, programExists: true }
                : installed("MYLIB", kind === "unknown" ? null : kind === "update" ? "1.8" : kind === "newer" ? "2.0" : "1.9", kind === "update" ? "older" : kind);
            const status = { ...configured, bundledVersion: "1.9", configuredTarget: configured, installations: configured.installed ? [configured] : [] };
            const confirm = vi.fn(() => false);
            const result = { ...installed("MYLIB", "1.9", "current"), version: "1.9", cppMember: "CPP", sqlMember: "SQL", module: "MOD" };
            const install = vi.fn(async () => result);
            const upgrade = vi.fn(async () => result);
            const repair = vi.fn(async () => result);
            const starting = vi.fn();
            const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: policy as AppSettings["functionUpdateNotifications"] }, "host", async () => status, install, confirm, true, upgrade, undefined, repair, undefined, undefined, starting);
            const suppressed = (kind === "new" || kind === "repair" || kind === "update") && policy === "noneAuto" || (kind === "new" || kind === "repair") && policy === "updatesOnly" || kind === "update" && policy === "newOnly";
            const needsPrompt = kind === "new" || kind === "repair" || kind === "update";
            expect(outcome.kind, `${kind}/${policy}`).toBe(suppressed ? kind === "new" ? "installed" : kind === "repair" ? "repaired" : "upgraded" : kind === "current" || kind === "newer" ? "available" : kind === "unknown" ? "missing" : policy === "noneSkip" ? "skipped" : kind === "new" ? "declined" : kind === "repair" ? "repair-declined" : "upgrade-declined");
            expect(confirm, `${kind}/${policy}`).toHaveBeenCalledTimes(needsPrompt && !suppressed && policy !== "noneSkip" ? 1 : 0);
            expect(install).toHaveBeenCalledTimes(suppressed && kind === "new" ? 1 : 0);
            expect(upgrade).toHaveBeenCalledTimes(suppressed && kind === "update" ? 1 : 0);
            expect(repair).toHaveBeenCalledTimes(suppressed && kind === "repair" ? 1 : 0);
            expect(starting).toHaveBeenCalledTimes(suppressed ? 1 : 0);
            if (suppressed) {
                expect(starting).toHaveBeenCalledWith(kind === "new" ? "install" : kind === "update" ? "upgrade" : "repair", "MYLIB", []);
                expect(enhancedSupportLogEntry(outcome, "host")?.text).toContain("Completed: Automatically");
                if (kind === "update") expect(upgrade).toHaveBeenCalledExactlyOnceWith("MYLIB", "1.8");
            }
        }
    });
    it.each((["new", "repair", "update"] as const).flatMap((kind) => ["existing", "noneAuto"].map((mode) => ({ kind, mode }))))("automatically performs $kind under $mode without selecting alternatives", async ({ kind, mode }) => {
        const configured = kind === "new" ? target : kind === "repair" ? { ...target, programExists: true } : installed("MYLIB", "1.8", "older");
        const other = installed("OTHER", "1.10", "newer");
        const status = { ...(kind === "update" ? configured : other), bundledVersion: "1.9", configuredTarget: configured, installations: [other, { ...other, library: "other" }] };
        const confirm = vi.fn(() => "OTHER");
        const result = { ...installed("MYLIB", "1.9", "current"), version: "1.9", cppMember: "CPP", sqlMember: "SQL", module: "MOD" };
        const install = vi.fn(async () => result);
        const upgrade = vi.fn(async () => result);
        const repair = vi.fn(async () => result);
        const select = vi.fn(async () => verified("OTHER"));
        const starting = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: mode === "noneAuto" ? "noneAuto" : kind === "update" ? "newOnly" : "updatesOnly" }, "host", async () => status, install, confirm, true, upgrade, undefined, repair, select, undefined, starting);
        expect(outcome.kind).toBe(kind === "new" ? "installed" : kind === "repair" ? "repaired" : "upgraded");
        expect(starting.mock.calls[0][2].map((entry) => entry.library)).toEqual(["OTHER"]);
        expect(confirm).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
        expect(install).toHaveBeenCalledTimes(kind === "new" ? 1 : 0);
        expect(upgrade).toHaveBeenCalledTimes(kind === "update" ? 1 : 0);
        expect(repair).toHaveBeenCalledTimes(kind === "repair" ? 1 : 0);
    });
    it.each((["new", "repair", "update"] as const).flatMap((kind) => ["existing", "noneAuto"].map((mode) => ({ kind, mode }))))("does not retry or select a fallback after automatic $kind fails under $mode", async ({ kind, mode }) => {
        const configured = kind === "new" ? target : kind === "repair" ? { ...target, programExists: true } : installed("MYLIB", "1.8", "older");
        const other = installed("OTHER", "1.10", "newer");
        const status = { ...(kind === "update" ? configured : other), bundledVersion: "1.9", configuredTarget: configured, installations: [other] };
        const write = vi.fn(async () => { throw new Error("collision or host failure"); });
        const confirm = vi.fn();
        const select = vi.fn();
        const starting = vi.fn();
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: mode === "noneAuto" ? "noneAuto" : kind === "update" ? "newOnly" : "updatesOnly" }, "host", async () => status, write, confirm, true, write, undefined, write, select, undefined, starting)).rejects.toThrow("collision or host failure");
        expect(write).toHaveBeenCalledOnce();
        expect(starting).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
    });
    it.each([
        { programExists: true, routineExists: true, routineMatches: false },
        { programExists: false, routineExists: true, routineMatches: false },
        { programExists: false, routineExists: false, routineMatches: true },
        { programExists: true, routineExists: false, routineMatches: true },
    ])("never automatically replaces a conflicting target: %o", async (conflict) => {
        const configured = { ...target, ...conflict };
        const write = vi.fn();
        const start = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "updatesOnly" }, "host", async () => ({ ...configured, configuredTarget: configured, installations: [] }), write, vi.fn(), true, write, undefined, write, undefined, undefined, start);
        expect(outcome.kind).toBe("target-conflict");
        expect(write).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });
    it.each(["wrong library", "mismatched version", "mismatched status", "missing program", "mismatched routine"].flatMap((failure) => ["newOnly", "noneAuto"].map((policy) => ({ failure, policy }))))("does not automatically upgrade an inconsistent target under $policy: $failure", async ({ failure, policy }) => {
        const configured = installed("MYLIB", "1.8", "older");
        const inconsistent = { ...configured, ...(failure === "wrong library" ? { library: "OTHER" } : failure === "mismatched version" ? { installedVersion: "1.7" } : failure === "mismatched status" ? { versionStatus: "current" } : failure === "missing program" ? { programExists: false } : { routineMatches: false }) };
        const write = vi.fn();
        const start = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: policy as AppSettings["functionUpdateNotifications"] }, "host", async () => ({ ...configured, configuredTarget: inconsistent, installations: [configured] }), write, vi.fn(), true, write, undefined, write, undefined, undefined, start);
        expect(outcome.kind).toBe("missing");
        expect(write).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });
    it.each(["new", "repair", "update", "unknown", "conflict"] as const)("silently skips %s without choosing an alternative", async (kind) => {
        const configured = kind === "new" ? target : kind === "repair" ? { ...target, programExists: true }
            : kind === "conflict" ? { ...target, routineExists: true } : installed("MYLIB", kind === "unknown" ? null : "1.8", kind === "unknown" ? "unknown" : "older");
        const other = installed("OTHER", "1.10", "newer");
        const status = { ...(kind === "new" || kind === "repair" ? other : configured), bundledVersion: "1.9", configuredTarget: configured, installations: [other] };
        const write = vi.fn();
        const confirm = vi.fn();
        const select = vi.fn();
        const starting = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "noneSkip" }, "host", async () => status, write, confirm, true, write, undefined, write, select, undefined, starting);
        expect(outcome.kind).toBe("skipped");
        expect(enhancedSupportLogEntry(outcome, "host")).toMatchObject({ cls: "msg-info", reveal: false });
        expect(confirm).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
        expect(starting).not.toHaveBeenCalled();
    });
    it.each(["unknown", "conflict"] as const)("does not open a select-only dialog under noneAuto for %s", async (kind) => {
        const configured = kind === "unknown" ? installed("MYLIB", null, "unknown") : { ...target, routineExists: true };
        const status = { ...configured, bundledVersion: "1.9", configuredTarget: configured, installations: [installed("OTHER", "1.10", "newer")] };
        const write = vi.fn();
        const confirm = vi.fn();
        const select = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "noneAuto" }, "host", async () => status, write, confirm, true, write, undefined, write, select);
        expect(outcome.kind).toBe(kind === "unknown" ? "missing" : "target-conflict");
        expect(confirm).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
    });
    it.each(["always", "newOnly", "updatesOnly", "noneAuto", "noneSkip"] as const)("does nothing when enhanced CL is disabled under %s", async (policy) => {
        const check = vi.fn();
        const write = vi.fn();
        const confirm = vi.fn();
        const select = vi.fn();
        const outcome = await setupEnhancedSupport({ functionUpdateNotifications: policy }, "host", check, write, confirm, false, write, undefined, write, select);
        expect(outcome.kind).toBe("disabled");
        expect(check).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
    });
    it.each([["new", "newOnly"], ["repair", "newOnly"], ["update", "updatesOnly"], ["new", "always"], ["repair", "always"], ["update", "always"]] as const)("requires consent and performs allowed %s under %s", async (kind, policy) => {
        const configured = kind === "new" ? target : kind === "repair" ? { ...target, programExists: true } : installed("MYLIB", "1.8", "older");
        const status = { ...configured, bundledVersion: "1.9", configuredTarget: configured, installations: [] };
        const result = { ...installed("MYLIB", "1.9", "current"), version: "1.9", cppMember: "CPP", sqlMember: "SQL", module: "MOD" };
        const install = vi.fn(async () => result);
        const upgrade = vi.fn(async () => result);
        const repair = vi.fn(async () => result);
        const confirm = vi.fn(() => true);
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: policy }, "host", async () => status, install, confirm, true, upgrade, undefined, repair);
        expect(confirm.mock.calls[0][1]).toBe(kind === "new" ? "install" : kind === "update" ? "upgrade" : "repair");
        expect(outcome.kind).toBe(kind === "new" ? "installed" : kind === "update" ? "upgraded" : "repaired");
        expect(install).toHaveBeenCalledTimes(kind === "new" ? 1 : 0);
        expect(upgrade).toHaveBeenCalledTimes(kind === "update" ? 1 : 0);
        expect(repair).toHaveBeenCalledTimes(kind === "repair" ? 1 : 0);
    });
    it("does not select a discovered fallback on cancel or without a selector", async () => {
        const status = discovery();
        const select = vi.fn();
        const install = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "always" }, "host", async () => status, install, () => false, true, undefined, undefined, undefined, select);
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("Enhanced CL is unavailable");
        expect(select).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
        const confirm = vi.fn();
        expect((await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "always" }, "host", async () => status, install, confirm, true)).kind).toBe("install-declined-fallback");
        expect(confirm).toHaveBeenCalledOnce();
    });
    it("offers unknown targets a select-only dialog without any host replacement", async () => {
        const configured = installed("MYLIB", null, "unknown");
        const status = { ...configured, configuredTarget: configured, installations: [configured, installed("OTHER", "1.10", "newer")] };
        const confirm = vi.fn(() => "OTHER");
        const select = vi.fn(async () => verified("OTHER"));
        const write = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, write, confirm, true, write, undefined, write, select);
        expect(confirm.mock.calls[0][1]).toBe("select");
        expect(outcome.kind).toBe("available");
        expect(write).not.toHaveBeenCalled();
        expect(select).toHaveBeenCalledExactlyOnceWith("OTHER");
    });
    it("falls back to QCMDEXC without prompting or installing when QCPPLE is missing", async () => {
        const status = { ...discovery(), cppCompilerAvailable: false };
        const install = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, install, confirm, true);
        expect(outcome.kind).toBe("compiler-unavailable");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("will use QSYS2.QCMDEXC");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("No CMD_RUN source was uploaded");
        expect(install).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
    });
    it.each([null, "invalid", "1.9", "2.0"])("does not offer an upgrade when older metadata is unverifiable: %s", async (version) => {
        const configured = installed("MYLIB", version, "older");
        const status = { ...configured, configuredTarget: configured, installations: [configured] };
        const confirm = vi.fn();
        const write = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "newOnly" }, "host", async () => status, write, confirm, true, write, undefined, write);
        expect(outcome.kind).toBe("missing");
        expect(confirm).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
    it("requires OK before a select-only dialog calls the backend", async () => {
        const select = vi.fn(async () => verified("OTHER"));
        const updated = vi.fn();
        const configured = installed("MYLIB", null, "unknown");
        const outcome = setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB", functionUpdateNotifications: "updatesOnly" }, "host", async () => ({ ...discovery(), ...configured, configuredTarget: configured }), vi.fn(), confirmEnhancedSupport, true, undefined, undefined, undefined, select, updated);
        await vi.waitFor(() => expect(document.querySelector(".enhanced-support-dialog")).not.toBeNull());
        const dialog = document.querySelector<HTMLElement>(".enhanced-support-dialog")!;
        expect(dialog.textContent).toContain("Select Function Library");
        expect(dialog.textContent).not.toContain("Install in the configured library");
        const radios = dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]');
        expect([...radios].map((radio) => radio.value)).toEqual(["BESTLIB", "OTHER", "QGPL"]);
        const button = [...dialog.querySelectorAll("button")].find((item) => item.textContent === "Use Library")!;
        expect(button.disabled).toBe(true);
        radios[1].click();
        button.click();
        expect(select).not.toHaveBeenCalled();
        expect(updated).not.toHaveBeenCalled();
        const confirmation = document.querySelectorAll<HTMLElement>('[role="dialog"]')[1];
        [...confirmation.querySelectorAll("button")].find((item) => item.textContent === "OK")!.click();
        expect((await outcome).kind).toBe("available");
        expect(select).toHaveBeenCalledExactlyOnceWith("OTHER");
        expect(updated).toHaveBeenCalledExactlyOnceWith("OTHER");
    });
    it("only offers eligible libraries and applies the exact confirmed choice", async () => {
        const confirm = vi.fn(() => "OTHER");
        const select = vi.fn(async () => verified("OTHER"));
        const installedOnHost = vi.fn();
        const updated = vi.fn();
        const result = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => discovery(), installedOnHost, confirm, true, undefined, undefined, undefined, select, updated);
        expect(confirm.mock.calls[0][2]?.map((entry) => entry.library)).toEqual(["BESTLIB", "OTHER", "QGPL"]);
        expect(select).toHaveBeenCalledExactlyOnceWith("OTHER");
        expect(updated).toHaveBeenCalledExactlyOnceWith("OTHER");
        expect(installedOnHost).not.toHaveBeenCalled();
        expect(enhancedSupportMessage(result, "host")?.text).toContain("Detected OTHER.CMD_RUN");
    });
    it("offers a current alternative alongside the configured upgrade", async () => {
        const configured = installed("MYLIB", "1.8", "older");
        const status = { ...configured, configuredTarget: configured, installations: [configured, installed("OTHER", "1.10", "newer")] };
        const select = vi.fn(async () => verified("OTHER"));
        const upgrade = vi.fn();
        const result = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), () => "OTHER", true, upgrade, undefined, undefined, select);
        expect(result.kind).toBe("available");
        expect(upgrade).not.toHaveBeenCalled();
    });
    it.each(["wrong library", "old version", "missing target", "failed selection"])("does not report success for %s", async (failure) => {
        const select = vi.fn(async () => {
            if (failure === "failed selection") throw new Error("not connected");
            const result = verified(failure === "wrong library" ? "BESTLIB" : "OTHER");
            if (failure === "old version") return { ...result, installedVersion: "1.8" };
            if (failure === "missing target") return { ...result, configuredTarget: target };
            return result;
        });
        const updated = vi.fn();
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => discovery(), vi.fn(), () => "OTHER", true, undefined, undefined, undefined, select, updated)).rejects.toThrow();
        expect(updated).not.toHaveBeenCalled();
    });
    it("keeps the first dialog open when the second confirmation is cancelled", async () => {
        const outcome = confirmEnhancedSupport("Server: host\nFunction: CMD_RUN\nLibrary: QGPL\nFunction Version: 0.2.0\n\nDuplicate function names in these libraries:\nOTHER (version 1.10)", "install", [installed("OTHER", "1.10", "newer")]);
        const first = document.querySelector<HTMLElement>(".enhanced-support-dialog")!;
        expect(first.textContent).toContain("QGPL DEFAULT");
        expect(first.textContent).toContain("Choose where to install the function");
        expect(first.textContent).toContain("Duplicate function names in these libraries:");
        expect(first.textContent!.match(/Duplicate function names in these libraries:/g)).toHaveLength(1);
        const radios = first.querySelectorAll<HTMLInputElement>('input[type="radio"]');
        expect(radios).toHaveLength(2);
        expect(radios[0].parentElement?.textContent).toContain("QGPL DEFAULT");
        expect(radios[1].parentElement?.textContent).toContain("OTHER (version 1.10)");
        expect(radios[0].checked).toBe(true);
        radios[1].click();
        const installButton = [...first.querySelectorAll("button")].find((button) => button.textContent === "Install")!;
        expect(installButton.textContent).toBe("Install");
        installButton.click();
        const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
        expect(dialogs[1].textContent).toContain("Should we change the Function Library name in Settings to this library?");
        [...dialogs[1].querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click();
        expect(document.body.contains(first)).toBe(true);
        expect(radios[1].checked).toBe(true);
        [...first.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click();
        expect(await outcome).toBe(false);
    });
    it("returns the selected library only after OK and renders no radios without alternatives", async () => {
        const empty = confirmEnhancedSupport("Confirm");
        expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(0);
        document.querySelector<HTMLButtonElement>('.enhanced-support-dialog button')!.click();
        expect(await empty).toBe(false);
        const outcome = confirmEnhancedSupport("Confirm", "upgrade", [installed("OTHER", "1.10", "newer")]);
        const first = document.querySelector<HTMLElement>(".enhanced-support-dialog")!;
        first.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click();
        [...first.querySelectorAll("button")].find((button) => button.textContent === "Upgrade")!.click();
        const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
        [...dialogs[1].querySelectorAll("button")].find((button) => button.textContent === "OK")!.click();
        expect(await outcome).toBe("OTHER");
    });
    it("keeps the confirmation open after clicking its backdrop", async () => {
        const result = confirmEnhancedSupport("Confirm", "repair");
        const overlay = document.querySelector<HTMLElement>(".confirm-overlay")!;
        overlay.click();
        expect(document.body.contains(overlay)).toBe(true);
        overlay.querySelector<HTMLButtonElement>("button")!.click();
        expect(await result).toBe(false);
    });
    it("marks successful repair as completed with distinct success styling", () => {
        const status = { ...target, installed: true, installedVersion: "0.2.0", bundledVersion: "0.2.0", versionStatus: "current" };
        expect(enhancedSupportLogEntry({ kind: "repaired", status }, "host")).toEqual({
            text: "Completed: Repaired MYLIB.CMD_RUN version 0.2.0. Using it for CL processing.",
            cls: "msg-success", reveal: true,
        });
        expect(enhancedSupportLogEntry({ kind: "repair-declined", status: { ...status, configuredTarget: target } }, "host")?.cls).toBe("msg-warning");
    });
    it("highlights the selected routine before reporting alternatives", () => {
        const status = { ...target, library: "QGPL", installed: true, installedVersion: "0.2.0", bundledVersion: "0.2.0", versionStatus: "current",
            installations: [{ ...target, library: "COZTEST", installed: true, installedVersion: "4" }],
            newerAvailable: { ...target, library: "COZTEST", installed: true, installedVersion: "4" } };
        const selected = enhancedSupportLogEntry({ kind: "available", status }, "host")!;
        const alternative = enhancedSupportAlternativeMessage(status)!;
        expect(selected.cls).toBe("msg-detected");
        expect(selected.text).toContain("Detected QGPL.CMD_RUN version 0.2.0. Using it for CL processing.");
        expect(alternative[0]).toBe("Additional CMD_RUN installations detected.");
        expect(alternative).toContain("COZTEST (version 4): version status unknown; newest detected installation.");
    });
    it("explains a collision without duplicating the selected fallback", () => {
        const status = { ...missing, library: "COZTEST", installed: true, configuredTarget: {
            ...target, library: "QGPL", programExists: true, routineExists: true, routineMatches: false,
        }, installations: [{ ...target, library: "COZTEST", installed: true }, { ...target, library: "OTHER", installed: true, installedVersion: "1.2" }] };
        const message = enhancedSupportMessage({ kind: "target-conflict", status }, "host")!.text;
        expect(message).toContain("program: found; routine: found");
        expect(message).toContain("Enhanced CL is unavailable");
        expect(message).not.toContain("OTHER (version 1.2)");
        expect(enhancedSupportAlternativeMessage(status)).toContain("OTHER (version 1.2): version status unknown.");
        expect(message).not.toContain("COZTEST");
    });
    it("lists all other installations once when the configured library is selected", async () => {
        const selected = { ...target, installed: true, programExists: true, routineExists: true, routineMatches: true, installedVersion: "1.0", bundledVersion: "1.0", versionStatus: "current" };
        const status = { ...selected, configuredTarget: selected, installations: [
            selected, { ...selected, library: "OTHER", installedVersion: "2.0", versionStatus: "newer" },
            { ...selected, library: "UNKNOWN", installedVersion: "", versionStatus: "unknown" },
        ] };
        const detected = vi.fn();
        const confirm = vi.fn();
        const install = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, install, confirm, true, undefined, detected);
        const alternatives = enhancedSupportAlternativeMessage(detected.mock.calls[0][0])!;
        expect(alternatives[0]).toBe("Additional CMD_RUN installations detected.");
        expect(alternatives).toContain("OTHER (version 2.0): newer than bundled version 1.0.");
        expect(alternatives).toContain("UNKNOWN (version unknown): version status unknown.");
        expect(alternatives.join("\n")).not.toContain("MYLIB");
        expect(enhancedSupportMessage(outcome, "host")!.text.match(/MYLIB/g)).toHaveLength(1);
        expect(confirm).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
    });
    it("reports a target collision without alternatives or installation", async () => {
        const conflict = { ...target, library: "QGPL", programExists: true };
        const status = { ...conflict, configuredTarget: conflict, installations: [] };
        const install = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "QGPL" }, "host", async () => status, install, confirm, true);
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("program: found; routine: not found");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("unavailable");
        expect(install).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect(enhancedSupportAlternativeMessage(status)).toBeNull();
    });
    it("never checks or installs for disabled and legacy profiles regardless of global settings", async () => {
        const check = vi.fn(async () => missing);
        const install = vi.fn(async () => ({ ...missing, installed: true, programExists: true, routineExists: true, routineMatches: true, installedVersion: "1", bundledVersion: "1", versionStatus: "current" }));
        const confirm = vi.fn(() => true);
        expect(await setupEnhancedSupport({ clExecutionMode: "enhanced" }, "host", check, install, confirm, false)).toEqual({ kind: "disabled" });
        expect(check).not.toHaveBeenCalled();
        expect(await setupEnhancedSupport({ clExecutionMode: "enhanced", installEnhancedSupport: true }, "host", check, install, confirm)).toEqual({ kind: "disabled" });
        expect(install).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
        expect((await setupEnhancedSupport({ clExecutionMode: "standard", enhancedSupportLibrary: "MYLIB" }, "host", check, install, confirm, true)).kind).toBe("installed");
        expect(install).toHaveBeenCalledOnce();
    });
    it("shows an in-window confirmation and waits for the user's choice", async () => {
        const result = confirmEnhancedSupport("Server: host\nLibrary: MYLIB");
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Server: host");
        expect(dialog.textContent).toContain("Library: MYLIB");
        const install = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Install")!;
        install.click();
        expect(await result).toBe(true);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
    it("cancels the in-window confirmation on Escape", async () => {
        const result = confirmEnhancedSupport("Server: host");
        document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(await result).toBe(false);
    });
    it("does nothing when installation is disabled", async () => {
        const check = vi.fn(async () => missing);
        expect(await setupEnhancedSupport({}, "host", check, check, () => true)).toEqual({ kind: "disabled" });
        expect(check).not.toHaveBeenCalled();
    });
    it("checks and prompts with the server and library before installing", async () => {
        const check = vi.fn(async () => missing);
        const installed = { ...missing, installed: true, programExists: true, routineExists: true, routineMatches: true, installedVersion: "1", bundledVersion: "1", versionStatus: "current" };
        const install = vi.fn(async () => installed);
        const confirm = vi.fn(() => true);
        expect(await setupEnhancedSupport({ installEnhancedSupport: true, enhancedSupportLibrary: "MYLIB" }, "ibmi.example", check, install, confirm, true)).toEqual({ kind: "installed", status: installed });
        expect(confirm.mock.calls[0][0]).toContain("ibmi.example");
        expect(confirm.mock.calls[0][0]).toContain("MYLIB");
        expect(install).toHaveBeenCalledWith("MYLIB");
    });
    it("does not install when declined, present, or conflicting", async () => {
        const install = vi.fn(async () => ({ ...missing, installed: true }));
        const settings = { installEnhancedSupport: true, enhancedSupportLibrary: "MYLIB" };
        expect(await setupEnhancedSupport(settings, "host", async () => missing, install, () => false, true)).toEqual({ kind: "declined" });
        expect((await setupEnhancedSupport(settings, "host", async () => ({ ...missing, installed: true }), install, () => true, true)).kind).toBe("missing");
        expect((await setupEnhancedSupport(settings, "host", async () => ({ ...missing, configuredTarget: { ...missing, programExists: true } }), install, () => true, true)).kind).toBe("target-conflict");
        expect(install).not.toHaveBeenCalled();
    });
    it("does not install on a legacy target-only discovery response", async () => {
        const install = vi.fn();
        const confirm = vi.fn();
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => target, install, confirm, true)).rejects.toThrow("updated JDBC bridge");
        expect(install).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
    });
    it.each(["current", "newer"])("reports %s without replacing an installed object", async (versionStatus) => {
        const actualTarget = { ...target, installed: true, programExists: true, routineExists: true, routineMatches: true,
            installedVersion: versionStatus === "unknown" ? null : versionStatus === "newer" ? "3.0.0" : "2.0.0", bundledVersion: "2.0.0", versionStatus };
        const status = { ...actualTarget, configuredTarget: actualTarget };
        const install = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ installEnhancedSupport: true, enhancedSupportLibrary: "MYLIB" }, "host", async () => status, install, confirm, true);
        const message = enhancedSupportMessage(outcome, "host")!;
        expect(message.text).toContain(`Detected MYLIB.CMD_RUN version ${status.installedVersion}. Using it for CL processing.`);
        expect(message.warning).toBe(false);
        expect(install).not.toHaveBeenCalled();
        expect(confirm).not.toHaveBeenCalled();
    });
    it("reports an unknown version without replacement when no selector is available", async () => {
        const configured = installed("MYLIB", null, "unknown");
        const install = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => ({ ...configured, configuredTarget: configured }), install, confirm, true);
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("unknown version will not be replaced");
        expect(confirm).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
    });
    it("offers the configured target before using another schema", async () => {
        const install = vi.fn();
        const confirm = vi.fn();
        const settings = { enhancedSupportLibrary: "MYLIB" };
        const chosen = await setupEnhancedSupport(settings, "host", async () => ({ ...missing, library: "BESTLIB", installed: true, installedVersion: "3.0.0", bundledVersion: "2.0.0", versionStatus: "newer", configuredTarget: missing }), install, confirm, true);
        expect(enhancedSupportMessage(chosen, "host")?.text).toContain("Enhanced CL is unavailable");
        const legacy = await setupEnhancedSupport(settings, "host", async () => ({ ...missing, installed: true }), install, confirm, true);
        expect(enhancedSupportMessage(legacy, "host")).toMatchObject({ warning: true, text: expect.stringContaining("unavailable") });
        expect(install).not.toHaveBeenCalled();
        expect(confirm).toHaveBeenCalledOnce();
    });
    it("offers to install in the configured library when another routine exists", async () => {
        const status = { ...missing, library: "COZTEST", installed: true, installedVersion: "4", bundledVersion: "0.2.0", versionStatus: "newer", configuredTarget: { ...target, library: "QGPL" } };
        const result = { ...target, library: "QGPL", installed: true, programExists: true, routineExists: true, routineMatches: true, installedVersion: "0.2.0", bundledVersion: "0.2.0", versionStatus: "current" };
        const install = vi.fn(async () => result);
        const confirm = vi.fn(() => true);
        expect(await setupEnhancedSupport({ enhancedSupportLibrary: "QGPL" }, "host", async () => status, install, confirm, true)).toEqual({ kind: "installed", status: result });
        expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Click Install to install CMD_RUN."), "install");
        expect(install).toHaveBeenCalledExactlyOnceWith("QGPL");
    });
    it.each([false, true])("reports a source-file creation stop without claiming partial changes (fallback: %s)", async (hasFallback) => {
        const configuredTarget = { ...target, library: "QGPL" };
        const status = hasFallback
            ? { ...installed("COZTEST", "4", "newer"), configuredTarget, installations: [installed("COZTEST", "4", "newer")] }
            : { ...configuredTarget, configuredTarget, installations: [] };
        const install = vi.fn(async () => {
            throw new Error("QGPL/QCOZZISRC already exists. No source members were added or uploaded.");
        });
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "QGPL" }, "host", async () => status, install, () => true, true))
            .rejects.toThrow("Installation in QGPL stopped before source upload:");
    });
    it.each([true, false])("lists every alternative before the install decision (%s)", async (accept) => {
        const selected = { ...target, library: "BESTLIB", installed: true, installedVersion: "3.0", versionStatus: "newer" };
        const older = { ...target, library: "OLDLIB", installed: true, installedVersion: "0.1", versionStatus: "older" };
        const unknown = { ...target, library: "UNKNOWN", installed: true, installedVersion: null, versionStatus: "unknown" };
        const status = { ...selected, configuredTarget: target, installations: [selected, older, unknown] };
        const install = vi.fn(async () => ({ ...target, installed: true, programExists: true, routineExists: true, routineMatches: true, installedVersion: "0.2", bundledVersion: "0.2", versionStatus: "current" }));
        const confirm = vi.fn(() => accept);
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, install, confirm, true);
        const prompt = confirm.mock.calls[0][0];
        for (const text of ["BESTLIB (version 3.0)", "OLDLIB (version 0.1)", "UNKNOWN (version unknown)", "Duplicate function names in these libraries:", "Click Install to install CMD_RUN.", "QCOZZISRC", "C++ compiler"]) expect(prompt).toContain(text);
        expect(prompt).not.toContain("Cancel avoids installing");
        expect(outcome.kind).toBe(accept ? "installed" : "install-declined-fallback");
        expect(install).toHaveBeenCalledTimes(accept ? 1 : 0);
    });
    it("does not claim an older fallback is usable after cancel or a collision", async () => {
        const selected = { ...target, library: "OLDLIB", installed: true, installedVersion: "0.1", versionStatus: "older" };
        for (const collision of [false, true]) {
            const status = { ...selected, configuredTarget: { ...target, programExists: collision }, installations: [selected] };
            const confirm = vi.fn(() => false);
            const install = vi.fn();
            const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, install, confirm, true);
            const message = enhancedSupportMessage(outcome, "host")!.text;
            expect(message).toContain("unavailable");
            expect(message).not.toContain("Using OLDLIB");
            expect(install).not.toHaveBeenCalled();
            if (!collision) expect(confirm.mock.calls[0][0]).not.toContain("Cancel avoids installing");
        }
    });
    it("renders confirmation text safely", async () => {
        const result = confirmEnhancedSupport("Host <img src=x onerror=alert(1)> & other");
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.querySelector("img")).toBeNull();
        expect(dialog.textContent).toContain("<img src=x onerror=alert(1)>");
        [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click();
        expect(await result).toBe(false);
    });
    it("reports an existing target program without replacing it", async () => {
        const status = { ...missing, library: "COZTEST", installed: true, installedVersion: "4", bundledVersion: "0.2.0", versionStatus: "newer", configuredTarget: { ...target, library: "QGPL", programExists: true } };
        const install = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "QGPL" }, "host", async () => status, install, confirm, true);
        expect(outcome.kind).toBe("target-conflict");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("program: found; routine: not found");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("unavailable");
        expect(confirm).not.toHaveBeenCalled();
        expect(install).not.toHaveBeenCalled();
    });
    it.each([true, false])("asks before program-only repair with alternatives (accept: %s)", async (accept) => {
        const fallback = { ...target, library: "BESTLIB", installed: true, installedVersion: "1.0", versionStatus: "newer" };
        const other = { ...fallback, library: "OLDLIB", installedVersion: "0.1", versionStatus: "older" };
        const status = { ...fallback, bundledVersion: "0.2.0", configuredTarget: { ...target, library: "QGPL", programExists: true }, installations: [fallback, other] };
        const result = { ...target, library: "QGPL", installed: true, programExists: true, routineExists: true, routineMatches: true, version: "0.2.0", installedVersion: "0.2.0", bundledVersion: "0.2.0", versionStatus: "current", cppMember: "CPP", sqlMember: "SQL", module: "MOD" };
        const repair = vi.fn(async () => result);
        const confirm = vi.fn(() => accept);
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "QGPL" }, "host", async () => status, vi.fn(), confirm, true, undefined, undefined, repair);
        expect(confirm).toHaveBeenCalledOnce();
        const [prompt, operation] = confirm.mock.calls[0];
        expect(operation).toBe("repair");
        for (const text of ["QGPL/CMD_RUN", "BESTLIB (version 1.0)", "OLDLIB (version 0.1)", "Enhanced CL remains unavailable", "another application or owner", "QRPLOBJ", "AUT(*ALL)", "source members", "partial changes", "no rollback", "exclusive administrative access"]) expect(prompt).toContain(text);
        expect(repair).toHaveBeenCalledTimes(accept ? 1 : 0);
        if (accept) expect(repair).toHaveBeenCalledWith("QGPL");
        expect(outcome.kind).toBe(accept ? "repaired" : "repair-declined");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain(accept ? "Repaired QGPL.CMD_RUN" : "unavailable");
    });
    it("offers program-only repair with no alternatives and handles cancel", async () => {
        const conflict = { ...target, programExists: true };
        const status = { ...conflict, configuredTarget: conflict, installations: [] };
        const repair = vi.fn();
        const confirm = vi.fn(() => false);
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), confirm, true, undefined, undefined, repair);
        expect(confirm.mock.calls[0][0]).not.toContain("Other installed libraries:");
        expect(confirm.mock.calls[0][0]).not.toContain("Function Library in Settings");
        expect(confirm.mock.calls[0][0]).toContain("Enhanced CL remains unavailable");
        expect(enhancedSupportMessage(outcome, "host")?.text).toContain("unavailable");
        expect(repair).not.toHaveBeenCalled();
    });
    it("does not offer repair for inconsistent routine metadata", async () => {
        const conflict = { ...target, programExists: true, routineMatches: true };
        const status = { ...conflict, configuredTarget: conflict, installations: [] };
        const repair = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), confirm, true, undefined, undefined, repair);
        expect(outcome.kind).toBe("target-conflict");
        expect(confirm).not.toHaveBeenCalled();
        expect(repair).not.toHaveBeenCalled();
    });
    it.each([[true, true], [false, true]])("never offers repair when program=%s routine=%s", async (programExists, routineExists) => {
        const fallback = { ...target, library: "OLDLIB", installed: true, installedVersion: "0.1", versionStatus: "older" };
        const other = { ...fallback, library: "OTHER", installedVersion: "0.0" };
        const status = { ...fallback, configuredTarget: { ...target, programExists, routineExists }, installations: [fallback, other] };
        const repair = vi.fn();
        const confirm = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), confirm, true, undefined, undefined, repair);
        const message = enhancedSupportMessage(outcome, "host")!.text;
        const alternatives = enhancedSupportAlternativeMessage(status)!.join("\n");
        expect(message).toContain("unavailable");
        expect(message).not.toContain("OLDLIB");
        expect(alternatives).toContain("OLDLIB (version 0.1): older than bundled version unknown.");
        expect(alternatives).toContain("OTHER (version 0.0): older than bundled version unknown.");
        expect(message).not.toContain("Using OLDLIB");
        expect(confirm).not.toHaveBeenCalled();
        expect(repair).not.toHaveBeenCalled();
    });
    it("never retries a failed repair or accepts a cross-schema response", async () => {
        const conflict = { ...target, programExists: true };
        const status = { ...conflict, configuredTarget: conflict, installations: [] };
        const repair = vi.fn(async () => { throw new Error("registration failed"); });
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), () => true, true, undefined, undefined, repair)).rejects.toThrow("no rollback or automatic retry");
        expect(repair).toHaveBeenCalledOnce();
        const invalid = vi.fn(async () => ({ ...target, library: "OTHER", installed: true, programExists: true, routineExists: true, routineMatches: true, version: "0.2", installedVersion: "0.2", bundledVersion: "0.2", versionStatus: "current", cppMember: "CPP", sqlMember: "SQL", module: "MOD" }));
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), () => true, true, undefined, undefined, invalid)).rejects.toThrow("did not complete");
        expect(invalid).toHaveBeenCalledOnce();
    });
    it("repairs a program-only target with no alternatives after acceptance", async () => {
        const conflict = { ...target, programExists: true };
        const status = { ...conflict, configuredTarget: conflict, installations: [] };
        const result = { ...target, installed: true, programExists: true, routineExists: true, routineMatches: true, version: "0.2.0", installedVersion: "0.2.0", bundledVersion: "0.2.0", versionStatus: "current", cppMember: "CPP", sqlMember: "SQL", module: "MOD" };
        const repair = vi.fn(async () => result);
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), () => true, true, undefined, undefined, repair);
        expect(outcome).toEqual({ kind: "repaired", status: result });
        expect(repair).toHaveBeenCalledExactlyOnceWith("MYLIB");
    });
    it("labels the repair confirmation action", async () => {
        const result = confirmEnhancedSupport("Confirm", "repair");
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Install IBM i Server Host Components");
        [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Repair")!.click();
        expect(await result).toBe(true);
    });
    it("does not warn when the configured installation is newer than the bundle and has no newer alternative", () => {
        const configuredTarget = { ...target, installed: true };
        const status = { ...configuredTarget, configuredTarget, installedVersion: "3.0", bundledVersion: "0.2.0", versionStatus: "newer" };
        expect(enhancedSupportMessage({ kind: "available", status }, "host")).toEqual({ warning: false, text: "Detected MYLIB.CMD_RUN version 3.0. Using it for CL processing." });
        expect(enhancedSupportAlternativeMessage(status)).toBeNull();
    });
    it("shows installation completion only after a successful install response", async () => {
        const status = { ...missing, installed: true, programExists: true, routineExists: true, routineMatches: true, installedVersion: "2.0.0", bundledVersion: "2.0.0", versionStatus: "current" };
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => missing, async () => status, () => true, true);
        expect(enhancedSupportMessage(outcome, "host")).toEqual({ warning: false, text: expect.stringContaining("Installed MYLIB.CMD_RUN") });
        expect(enhancedSupportMessage({ kind: "installed", status: { ...status, versionStatus: "unknown", installedVersion: "" } }, "host"))
            .toMatchObject({ warning: true, text: expect.stringContaining("Installed MYLIB.CMD_RUN") });
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => missing, async () => missing, () => true, true)).rejects.toThrow("did not complete");
    });
    it("asks before upgrading the discovered routine and passes the exact version", async () => {
        const status = { ...missing, library: "BESTLIB", installed: true, installedVersion: "0.01.0", bundledVersion: "0.2.0", versionStatus: "older", configuredTarget: { ...target, library: "BESTLIB", installed: true } };
        const result = { ...status, programExists: true, routineExists: true, routineMatches: true, installedVersion: "0.2.0", versionStatus: "current" };
        const confirm = vi.fn(() => true);
        const install = vi.fn();
        const upgrade = vi.fn(async () => result);
        const detected = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "BESTLIB" }, "ibmi.example", async () => status, install, confirm, true, upgrade, detected);
        expect(detected).toHaveBeenCalledWith(status);
        expect(confirm).toHaveBeenCalledOnce();
        const [message, operation] = confirm.mock.calls[0];
        expect(operation).toBe("upgrade");
        for (const text of ["ibmi.example", "BESTLIB.CMD_RUN", "0.01.0", "0.2.0", "program and SQL routine will be replaced", "Dependencies", "sources", "partial changes"]) expect(message).toContain(text);
        expect(upgrade).toHaveBeenCalledExactlyOnceWith("BESTLIB", "0.01.0");
        expect(install).not.toHaveBeenCalled();
        expect(outcome).toEqual({ kind: "upgraded", status: result });
        expect(enhancedSupportMessage(outcome, "ibmi.example")?.text).toContain("Upgraded BESTLIB.CMD_RUN");
    });
    it("reports a newer alternative separately before prompting to upgrade the configured routine", async () => {
        const status = { ...missing, installed: true, installedVersion: "0.1.0", bundledVersion: "0.2.0", versionStatus: "older",
            newerAvailable: { ...target, library: "OTHER", installed: true, installedVersion: "1.10", bundledVersion: "0.2.0", versionStatus: "newer" },
            installations: [{ ...target, installed: true, installedVersion: "0.1.0", bundledVersion: "0.2.0", versionStatus: "older" },
                { ...target, library: "OTHER", installed: true, installedVersion: "1.10", bundledVersion: "0.2.0", versionStatus: "newer" }] };
        const events: string[] = [];
        const upgrade = vi.fn(async () => ({ ...status, programExists: true, routineExists: true, routineMatches: true, installedVersion: "0.2.0", versionStatus: "current" }));
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), () => { events.push("prompt"); return true; }, true, upgrade,
            (detected) => events.push(...enhancedSupportAlternativeMessage(detected)!));
        const alternatives = [
            "Additional CMD_RUN installations detected.",
            "OTHER (version 1.10): newer than bundled version 0.2.0; newest detected installation.",
            "To use another library on a new connection, change Function Library in Settings and reconnect.",
        ];
        expect(events).toEqual([...alternatives, "prompt"]);
        expect(upgrade).toHaveBeenCalledExactlyOnceWith("MYLIB", "0.1.0");
        expect(outcome.kind).toBe("upgraded");
        expect(enhancedSupportAlternativeMessage({ ...status, installedVersion: null })).toEqual(alternatives);
        expect(enhancedSupportAlternativeMessage({ ...status, installations: [] })).toBeNull();
    });
    it("keeps older support unavailable when an upgrade is declined", async () => {
        const status = { ...missing, library: "BESTLIB", installed: true, installedVersion: "0.1.0", bundledVersion: "0.2.0", versionStatus: "older" };
        const upgrade = vi.fn();
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "BESTLIB" }, "host", async () => status, vi.fn(), () => false, true, upgrade);
        expect(outcome.kind).toBe("upgrade-declined");
        expect(enhancedSupportMessage(outcome, "host")).toMatchObject({ warning: true, text: expect.stringContaining("remains unavailable") });
        expect(upgrade).not.toHaveBeenCalled();
    });
    it.each(["QSYS", "qtemp", "qFoo"])("does not offer an upgrade for discovered %s", async (library) => {
        const status = { ...missing, library, installed: true, installedVersion: "0.1.0", bundledVersion: "0.2.0", versionStatus: "older" };
        const confirm = vi.fn(() => true);
        const upgrade = vi.fn();
        const outcome = await setupEnhancedSupport({}, "host", async () => status, vi.fn(), confirm, true, upgrade);
        expect(outcome.kind).toBe("missing");
        expect(enhancedSupportMessage(outcome, "host")).toMatchObject({ warning: true, text: expect.stringContaining("unavailable") });
        expect(confirm).not.toHaveBeenCalled();
        expect(upgrade).not.toHaveBeenCalled();
    });
    it("permits an upgrade of a discovered QGPL routine", async () => {
        const status = { ...missing, library: "qgpl", installed: true, installedVersion: "0.1.0", bundledVersion: "0.2.0", versionStatus: "older" };
        const upgrade = vi.fn(async () => ({ ...status, programExists: true, routineExists: true, routineMatches: true, installedVersion: "0.2.0", versionStatus: "current" }));
        const outcome = await setupEnhancedSupport({ enhancedSupportLibrary: "QGPL" }, "host", async () => status, vi.fn(), () => true, true, upgrade);
        expect(outcome.kind).toBe("upgraded");
        expect(upgrade).toHaveBeenCalledWith("qgpl", "0.1.0");
    });
    it("never retries a failed upgrade and warns about partial changes", async () => {
        const status = { ...missing, library: "BESTLIB", installed: true, installedVersion: "0.1.0", bundledVersion: "0.2.0", versionStatus: "older" };
        const upgrade = vi.fn(async () => { throw new Error("compile failed"); });
        await expect(setupEnhancedSupport({ enhancedSupportLibrary: "BESTLIB" }, "host", async () => status, vi.fn(), () => true, true, upgrade)).rejects.toThrow("partial changes may remain");
        expect(upgrade).toHaveBeenCalledExactlyOnceWith("BESTLIB", "0.1.0");
    });
    it("does not offer an upgrade for newer or unknown versions", async () => {
        for (const versionStatus of ["newer", "unknown"]) {
            const confirm = vi.fn();
            const upgrade = vi.fn();
            const status = { ...missing, installed: true, installedVersion: versionStatus === "unknown" ? null : "3.0.0", bundledVersion: "0.2.0", versionStatus };
            await setupEnhancedSupport({}, "host", async () => status, vi.fn(), confirm, true, upgrade);
            expect(confirm).not.toHaveBeenCalled();
            expect(upgrade).not.toHaveBeenCalled();
        }
    });
    it("labels the upgrade confirmation action", async () => {
        const result = confirmEnhancedSupport("Server: host", "upgrade");
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Install IBM i Server Host Components");
        [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Upgrade")!.click();
        expect(await result).toBe(true);
    });
    it.each(["install", "upgrade", "repair"] as const)("includes common explanation and safety information for %s", async (operation) => {
        const conflict = { ...target, programExists: true };
        const currentTarget = { ...target, installed: true, installedVersion: "0.1", versionStatus: "older" };
        const status = operation === "repair"
            ? { ...conflict, configuredTarget: conflict, bundledVersion: "0.2", installations: [] }
            : operation === "upgrade"
                ? { ...currentTarget, configuredTarget: currentTarget, bundledVersion: "0.2", installations: [currentTarget] }
                : { ...missing, bundledVersion: "0.2", installations: [] };
        const confirm = vi.fn(() => false);
        const perform = vi.fn();
        await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "ibmi.example", async () => status, perform, confirm, true, perform, undefined, perform);
        expect(confirm).toHaveBeenCalledOnce();
        const [prompt, actualOperation] = confirm.mock.calls[0];
        expect(actualOperation).toBe(operation);
        for (const text of ["Server: ibmi.example", "Function: CMD_RUN", "Library: MYLIB", "Function Version: 0.2", "SQL function CMD_RUN", "CL processing and message logging", "same SQL server job", "different job", "OVRDBF", "library list", "QTEMP", "AUT(*ALL)"]) expect(prompt).toContain(text);
        expect(prompt).not.toContain("Duplicate function names in these libraries:");
        expect(prompt).not.toContain("Function Library in Settings");
        expect(perform).not.toHaveBeenCalled();
        if (operation !== "install") for (const text of ["partial changes", "no rollback or automatic retry", "host job log", "exclusive administrative access"]) expect(prompt).toContain(text);
        if (operation === "repair") for (const text of ["Replace the existing MYLIB/CMD_RUN program", "another application or owner", "QRPLOBJ"]) expect(prompt).toContain(text);
        if (operation === "upgrade") for (const text of ["Installed version: 0.1", "program and SQL routine will be replaced", "Dependencies may be affected", "labels and comments", "QRPLOBJ"]) expect(prompt).toContain(text);
        if (operation === "install") for (const text of ["QCOZZISRC", "C++ compiler"]) expect(prompt).toContain(text);
    });
    it("lists only distinct other installed libraries on upgrade", async () => {
        const selected = { ...target, installed: true, installedVersion: "0.1", versionStatus: "older" };
        const other = { ...selected, library: "OTHER", installedVersion: "1.2" };
        const status = { ...selected, configuredTarget: selected, bundledVersion: "0.2", installations: [selected, other, { ...other, library: "other" }, { ...other, library: "MISSING", installed: false }] };
        const confirm = vi.fn(() => false);
        await setupEnhancedSupport({ enhancedSupportLibrary: "MYLIB" }, "host", async () => status, vi.fn(), confirm, true, vi.fn());
        const prompt = confirm.mock.calls[0][0];
        expect(prompt).toContain("Duplicate function names in these libraries:\nOTHER (version 1.2) - not eligible");
        expect(prompt).not.toContain("MYLIB (version");
        expect(prompt).not.toContain("other (version");
        expect(prompt).not.toContain("MISSING (version");
        expect(prompt).toContain("Cancel leaves MYLIB.CMD_RUN unavailable");
    });
    it("renders structured prompt sections and keeps actions outside the scrolling body", async () => {
        const result = confirmEnhancedSupport("Server: host\nLibrary: MYLIB\nBundled version: 0.2\n\nFirst paragraph.\n\nSecond <img> paragraph.");
        const dialog = document.querySelector<HTMLElement>(".enhanced-support-dialog")!;
        const body = dialog.querySelector<HTMLElement>(".enhanced-support-body")!;
        expect(dialog.querySelector(".confirm-title")?.textContent).toBe("Install IBM i Server Host Components");
        expect(body.querySelector(".enhanced-support-details")?.textContent).toContain("Library: MYLIB");
        expect(body.querySelectorAll("p")).toHaveLength(2);
        expect(body.querySelector("img")).toBeNull();
        expect(body.textContent).toContain("<img>");
        expect(body.querySelector(".confirm-actions")).toBeNull();
        expect(dialog.querySelector(".confirm-actions")).not.toBeNull();
        dialog.querySelector<HTMLButtonElement>("button")!.click();
        expect(await result).toBe(false);
    });
    it("keeps delayed setup warnings on their originating tab", () => {
        const list = document.createElement("ul");
        list.innerHTML = "<li>Other connection</li>";
        const tab = { snapshot: { messagesHtml: "<li>Original connection</li>", messagesVisible: false, activePane: "results" } };
        const html = appendEnhancedSupportLog(tab, false, list, "Unknown <version>", "msg-warning", true);
        expect(list.textContent).toBe("Other connection");
        expect(html).toContain("Unknown &lt;version&gt;");
        expect(tab.snapshot.messagesVisible).toBe(true);
        expect(tab.snapshot.activePane).toBe("messages");
        appendEnhancedSupportLog(tab, true, list, "Installing...", "msg-action", true);
        expect(list.textContent).toContain("Installing...");
    });
    it("queues log messages when an inactive tab has no snapshot", () => {
        const tab: { pendingMessagesHtml?: string; pendingMessagesReveal?: boolean } = {};
        const list = document.createElement("ul");
        appendEnhancedSupportLog(tab, false, list, "Detected LIB.CMD_RUN", "msg-info", false);
        appendEnhancedSupportLog(tab, false, list, "Warning", "msg-warning", true);
        expect(tab.pendingMessagesHtml).toContain("Detected LIB.CMD_RUN");
        expect(tab.pendingMessagesHtml).toContain("Warning");
        expect(tab.pendingMessagesReveal).toBe(true);
        expect(list.children).toHaveLength(0);
    });
});