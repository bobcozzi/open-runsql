// Settings pane: INI-style key list + typed editor.
import { describe, expect, it, vi } from "vitest";
import { createSettingsPane, type SettingDef } from "../src/settings";
import type { AppSettings } from "../src/types";

const DEFS: SettingDef[] = [
    {
        key: "spoolDownloadDir",
        type: "folder",
        get: (s) => s.spoolDownloadDir ?? "",
        withValue: (s, v) => ({ ...s, spoolDownloadDir: v }),
    },
    {
        key: "rowsPerPage",
        type: "number",
        min: 10,
        max: 500,
        get: (s) => String((s as Record<string, unknown>).rowsPerPage ?? ""),
        withValue: (s, v) => ({ ...s, rowsPerPage: v } as AppSettings),
    },
];

function mkPane(over: Partial<Parameters<typeof createSettingsPane>[0]> = {}) {
    const opts = {
        load: () => Promise.resolve<AppSettings>({}),
        save: vi.fn(() => Promise.resolve()),
        ...over,
    };
    const pane = createSettingsPane(opts, DEFS);
    document.body.appendChild(pane.root);
    return { pane, opts };
}

describe("settings pane", () => {
    it("lists one key per definition and selects the first by default", async () => {
        const { pane } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".settings-key").length).toBe(2);
        });
        expect(pane.root.querySelector(".settings-key.selected")?.textContent).toBe("Spooled files & downloads directory");
        expect(pane.root.querySelector<HTMLInputElement>(".settings-input")?.type).toBe("text");
        pane.root.remove();
    });

    it("clicking a key switches the editor input type (folder -> number)", async () => {
        const { pane } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".settings-key").length).toBe(2);
        });
        const keys = pane.root.querySelectorAll<HTMLElement>(".settings-key");
        keys[1].click();
        const input = pane.root.querySelector<HTMLInputElement>(".settings-input")!;
        expect(input.type).toBe("number");
        expect(input.min).toBe("10");
        expect(input.max).toBe("500");
        pane.root.remove();
    });

    it("folder editor ... button opens the picker and commits the choice", async () => {
        const { pane } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".settings-key").length).toBe(2);
        });
        const save = vi.fn(() => Promise.resolve());
        const defs: SettingDef[] = [{ ...DEFS[0], browse: () => Promise.resolve("/tmp/dl") }, DEFS[1]];
        const pane2 = createSettingsPane({ load: () => Promise.resolve({}), save }, defs);
        document.body.appendChild(pane2.root);
        await vi.waitFor(() => {
            expect(pane2.root.querySelector(".settings-browse")).toBeTruthy();
        });
        pane2.root.querySelector<HTMLButtonElement>(".settings-browse")!.click();
        await vi.waitFor(() => {
            expect(pane2.root.querySelector<HTMLInputElement>(".settings-input")!.value).toBe("/tmp/dl");
            expect(save).toHaveBeenCalledWith({ spoolDownloadDir: "/tmp/dl" });
        });
        pane.root.remove();
        pane2.root.remove();
    });

    it("canceling the picker leaves the value untouched", async () => {
        const save = vi.fn(() => Promise.resolve());
        const defs: SettingDef[] = [{ ...DEFS[0], browse: () => Promise.resolve("") }, DEFS[1]];
        const pane = createSettingsPane({ load: () => Promise.resolve({ spoolDownloadDir: "/orig" }), save }, defs);
        document.body.appendChild(pane.root);
        await vi.waitFor(() => {
            expect(pane.root.querySelector<HTMLInputElement>(".settings-input")!.value).toBe("/orig");
        });
        pane.root.querySelector<HTMLButtonElement>(".settings-browse")!.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(pane.root.querySelector<HTMLInputElement>(".settings-input")!.value).toBe("/orig");
        expect(save).not.toHaveBeenCalled();
        pane.root.remove();
    });

    it("commits a typed folder value on Enter via save()", async () => {
        const save = vi.fn(() => Promise.resolve());
        const { pane } = mkPane({ save });
        await vi.waitFor(() => {
            expect(pane.root.querySelector(".settings-input")).toBeTruthy();
        });
        const input = pane.root.querySelector<HTMLInputElement>(".settings-input")!;
        input.value = "  /tmp/spool  ";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await vi.waitFor(() => {
            expect(save).toHaveBeenCalledWith({ spoolDownloadDir: "/tmp/spool" });
        });
        pane.root.remove();
    });

    it("does not save when the value is unchanged", async () => {
        const save = vi.fn(() => Promise.resolve());
        const { pane } = mkPane({ save });
        await vi.waitFor(() => {
            expect(pane.root.querySelector(".settings-input")).toBeTruthy();
        });
        const input = pane.root.querySelector<HTMLInputElement>(".settings-input")!;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
        expect(save).not.toHaveBeenCalled();
        pane.root.remove();
    });
});
