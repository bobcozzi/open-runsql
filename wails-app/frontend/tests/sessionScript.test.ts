import { describe, expect, it, vi } from "vitest";
import { confirmReloadInitialScript, reloadInitialScript, scriptForConnection } from "../src/sessionScript";
import type { ConnectionProfile } from "../src/types";

const profile: ConnectionProfile = {
    name: "Example", host: "example", user: "user", tls: false,
    script: "startup script", sessionScript: "last session",
};

describe("connection editor initialization", () => {
    it("restores the saved session when auto save is enabled or unset", () => {
        expect(scriptForConnection(profile, "")).toBe("last session");
        expect(scriptForConnection({ ...profile, saveScript: true }, "")).toBe("last session");
        expect(scriptForConnection({ ...profile, sessionScript: undefined }, "")).toBe("");
    });

    it("initializes the startup script when auto save is disabled", () => {
        expect(scriptForConnection({ ...profile, saveScript: false }, "")).toBe("startup script");
    });

    it("initializes the selected profile on reconnect and preserves text for an unknown profile", () => {
        expect(scriptForConnection(profile, "current text")).toBe("last session");
        expect(scriptForConnection({ ...profile, saveScript: false }, "current text")).toBe("startup script");
        expect(scriptForConnection(undefined, "current text")).toBe("current text");
    });
});

describe("reload initial script", () => {
    it("shows a dialog and restores only when Reload is clicked", async () => {
        const restore = vi.fn();
        const pending = reloadInitialScript(confirmReloadInitialScript, async () => "initial", restore);
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
        expect(dialog.textContent).toContain("Current editor changes will be replaced.");
        expect(restore).not.toHaveBeenCalled();
        [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reload")!.click();
        await pending;
        expect(restore).toHaveBeenCalledWith("initial");
        expect(document.querySelector('[role="dialog"]')).toBeNull();
    });

    it("dismisses the dialog without restoring on Cancel or Escape", async () => {
        for (const action of ["cancel", "escape"]) {
            const restore = vi.fn();
            const pending = reloadInitialScript(confirmReloadInitialScript, async () => "initial", restore);
            const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
            if (action === "cancel") {
                [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click();
            } else {
                dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            }
            await pending;
            expect(restore).not.toHaveBeenCalled();
            expect(document.querySelector('[role="dialog"]')).toBeNull();
        }
    });
    it("restores the original text after confirmation, even after subsequent edits", async () => {
        const initial = scriptForConnection(profile, "");
        let editor = "edited and autosaved";
        const updatedProfile = { ...profile, sessionScript: editor };
        expect(scriptForConnection(updatedProfile, "")).toBe(editor);
        await reloadInitialScript(() => true, async () => initial, (text) => { editor = text; });
        expect(editor).toBe("last session");
    });

    it("restores the startup script and supports an empty initial script", async () => {
        const restore = vi.fn();
        await reloadInitialScript(() => true, async () => scriptForConnection({ ...profile, saveScript: false }, ""), restore);
        await reloadInitialScript(() => true, async () => "", restore);
        expect(restore.mock.calls).toEqual([["startup script"], [""]]);
    });

    it("does nothing when confirmation is canceled", async () => {
        const getInitial = vi.fn(async () => "initial");
        const restore = vi.fn();
        await reloadInitialScript(() => false, getInitial, restore);
        expect(getInitial).not.toHaveBeenCalled();
        expect(restore).not.toHaveBeenCalled();
    });
});