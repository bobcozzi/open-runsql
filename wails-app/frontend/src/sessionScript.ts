import type { ConnectionProfile } from "./types";
import { t } from "./l10n";

export function scriptForConnection(profile: ConnectionProfile | undefined, currentText: string): string {
    if (!profile) return currentText;
    return profile.saveScript === false ? profile.script ?? "" : profile.sessionScript ?? "";
}

export async function reloadInitialScript(
    confirmReload: () => boolean | Promise<boolean>,
    getInitial: () => Promise<string>,
    restore: (text: string) => void,
): Promise<void> {
    if (!await confirmReload()) return;
    restore(await getInitial());
}

export function confirmReloadInitialScript(): Promise<boolean> {
    if (document.querySelector(".reload-script-confirm")) return Promise.resolve(false);
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "confirm-overlay reload-script-confirm";
        const dialog = document.createElement("div");
        dialog.className = "confirm-dialog";
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("aria-labelledby", "reload-script-confirm-title");
        const title = document.createElement("div");
        title.className = "confirm-title";
        title.id = "reload-script-confirm-title";
        title.textContent = t("html.reloadInitialScript", "Reload initial SQL script");
        const message = document.createElement("div");
        message.textContent = t("main.confirmReloadInitialScript", "Reload the initial SQL script? Current editor changes will be replaced.");
        const actions = document.createElement("div");
        actions.className = "confirm-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn";
        cancel.textContent = t("confirm.cancel", "Cancel");
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "btn primary";
        accept.textContent = t("confirm.reload", "Reload");
        const finish = (accepted: boolean) => { overlay.remove(); resolve(accepted); };
        cancel.addEventListener("click", () => finish(false));
        accept.addEventListener("click", () => finish(true));
        overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(false); });
        overlay.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.stopPropagation(); finish(false); }
        });
        actions.append(cancel, accept);
        dialog.append(title, message, actions);
        overlay.append(dialog);
        document.body.append(overlay);
        cancel.focus();
    });
}