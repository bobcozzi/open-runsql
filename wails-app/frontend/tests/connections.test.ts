// Connections pane: profile list + edit form.
import { describe, expect, it, vi } from "vitest";
import { createConnectionsPane } from "../src/connections";
import { scriptForConnection } from "../src/sessionScript";
import type { ConnectionProfile } from "../src/types";

const P1: ConnectionProfile = {
    name: "Prod", host: "prod.ibmi", user: "COZZI", defaultSchema: "QIWS",
    naming: "system", tls: true, savePassword: true, lastUsedAt: 100,
};
const P2: ConnectionProfile = {
    name: "Dev", host: "dev.ibmi", user: "DEV1", defaultSchema: "",
    naming: "sql", tls: false, savePassword: false, lastUsedAt: 90,
};

function mkPane(profiles: ConnectionProfile[] = [P1, P2], over: Partial<Parameters<typeof createConnectionsPane>[0]> = {}) {
    const opts = {
        load: () => Promise.resolve(profiles),
        save: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
        // Vault: P1 has a stored password, P2 doesn't.
        getPassword: vi.fn((name: string) => Promise.resolve(name === "Prod" ? "secret" : "")),
        onChanged: vi.fn(),
        ...over,
    };
    const pane = createConnectionsPane(opts);
    document.body.appendChild(pane.root);
    return { pane, opts };
}

// Field order: Name, Host, User, Password, Schema, Naming, Bidi, TLS, SavePw, ...
// (TLS/SavePw/Preload/SaveScript are span.switch controls, not input/select.)
const fields = (root: HTMLElement) =>
    [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".conn-field input, .conn-field select, .conn-field .switch")];

describe("connections pane", () => {
    it("commits an unchecked auto-restore switch before reconnecting", async () => {
        let saved: ConnectionProfile = { ...P1, savePassword: false, script: "startup", sessionScript: "last session" };
        const { pane } = mkPane([saved], {
            load: async () => [saved],
            save: async (_name, profile) => { saved = { ...saved, ...profile }; },
        });
        await vi.waitFor(() => expect(pane.root.querySelector(".conn-keys .settings-key")).toBeTruthy());
        const toggle = pane.root.querySelector<HTMLElement>('[role="switch"][aria-label="Auto Save/Restore SQL Script between connections"]')!;
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        toggle.click();
        expect(await pane.commit()).toBe(true);
        expect(saved.saveScript).toBe(false);
        expect(scriptForConnection(saved, "last session")).toBe("startup");
        pane.root.remove();
    });

    it("saves pending profile edits before Connect in new Tab", async () => {
        let saved: ConnectionProfile = { ...P1, savePassword: false, script: "startup", sessionScript: "last session" };
        const onConnect = vi.fn();
        const { pane } = mkPane([saved], {
            load: async () => [saved],
            save: async (_name, profile) => { saved = { ...saved, ...profile }; },
            onConnect,
        });
        await vi.waitFor(() => expect(pane.root.querySelector(".conn-keys .settings-key")).toBeTruthy());
        pane.root.querySelector<HTMLElement>('[role="switch"][aria-label="Auto Save/Restore SQL Script between connections"]')!.click();
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Connect in new Tab")!.click();
        await vi.waitFor(() => expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ saveScript: false, script: "startup" })));
        pane.root.remove();
    });
    it("labels the separate startup and automatic session script options", async () => {
        const { pane } = mkPane([{ ...P1, script: "startup", sessionScript: "last session" }]);
        await vi.waitFor(() => expect(pane.root.querySelector(".conn-script")).toBeTruthy());
        expect(pane.root.textContent).toContain("Auto Save/Restore SQL Script between connections");
        expect(pane.root.textContent).toContain("Startup SQL Script (does not auto-run)");
        expect(pane.root.textContent).toContain("Ignored when Auto Save/Restore SQL Script is on.");
        expect(pane.root.querySelector<HTMLTextAreaElement>(".conn-script")?.value).toBe("startup");
        pane.root.remove();
    });
    it("lists profiles and selects the first", async () => {
        const { pane } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const selected = pane.root.querySelector(".settings-key.selected");
        expect(selected?.textContent).toContain("Prod");
        const [name, host, user, pw, schema, naming, bidi, tls, savePw] = fields(pane.root);
        expect((name as HTMLInputElement).value).toBe("Prod");
        expect((host as HTMLInputElement).value).toBe("prod.ibmi");
        expect((user as HTMLInputElement).value).toBe("COZZI");
        // Password field fills asynchronously from the vault.
        await vi.waitFor(() => {
            expect((pw as HTMLInputElement).value).toBe("••••••••");
        });
        expect((schema as HTMLInputElement).value).toBe("QIWS");
        expect((naming as HTMLSelectElement).value).toBe("system");
        expect((bidi as HTMLSelectElement).value).toBe("");
        expect((tls as HTMLInputElement).checked).toBe(true);
        expect((savePw as HTMLInputElement).checked).toBe(true);
        pane.root.remove();
    });

    it("clicking an entry moves the selection highlight", async () => {
        const { pane } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        expect(pane.root.querySelector(".settings-key.selected")?.textContent).toContain("Prod");
        const items = pane.root.querySelectorAll<HTMLElement>(".conn-keys .settings-key");
        items[1].click();
        await vi.waitFor(() => {
            expect(pane.root.querySelector(".settings-key.selected")?.textContent).toContain("Dev");
        });
        const [name, host] = fields(pane.root);
        expect((name as HTMLInputElement).value).toBe("Dev");
        expect((host as HTMLInputElement).value).toBe("dev.ibmi");
        pane.root.remove();
    });

    it("auto-saves dirty edits when switching entries", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const [name] = fields(pane.root);
        (name as HTMLInputElement).value = "Prod renamed";
        (name as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
        const items = pane.root.querySelectorAll<HTMLElement>(".conn-keys .settings-key");
        items[1].click();
        await vi.waitFor(() => {
            expect(opts.save).toHaveBeenCalledWith("Prod", expect.objectContaining({ name: "Prod renamed" }));
        });
        pane.root.remove();
    });

    it("Reset restores the selected profile and clears dirty state", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const [name, host] = fields(pane.root);
        (name as HTMLInputElement).value = "Changed";
        (name as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Reset")!.click();
        expect((name as HTMLInputElement).value).toBe("Prod");
        // Clean now: switching entries must not save.
        pane.root.querySelectorAll<HTMLElement>(".conn-keys .settings-key")[1].click();
        await new Promise((r) => setTimeout(r, 20));
        expect(opts.save).not.toHaveBeenCalled();
        pane.root.remove();
    });

    it("Duplicate prefills 'Name copy' as a dirty unsaved entry; New sits in the list footer", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        // New/Duplicate live in the list footer, not the form button row.
        const footer = pane.root.querySelector(".conn-list-footer")!;
        expect(footer.querySelector("button")!.textContent).toBe("New");
        const dupBtn = [...footer.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Duplicate")!;
        dupBtn.click();
        const [name] = fields(pane.root);
        expect((name as HTMLInputElement).value).toBe("Prod copy");
        // Not persisted until save.
        await new Promise((r) => setTimeout(r, 20));
        expect(opts.save).not.toHaveBeenCalled();
        pane.root.remove();
    });

    it("typing a new password marks dirty and saves passwordB64", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const [, , , pw] = fields(pane.root);
        (pw as HTMLInputElement).value = "newsecret";
        (pw as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Save")!.click();
        await vi.waitFor(() => {
            expect(opts.save).toHaveBeenCalledWith("Prod", expect.objectContaining({
                savePassword: true, passwordB64: btoa("newsecret"),
            }));
        });
        pane.root.remove();
    });

    it("untouched masked password preserves the stored one (no passwordB64 sent)", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const [name] = fields(pane.root);
        (name as HTMLInputElement).value = "Prod2";
        (name as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Save")!.click();
        await vi.waitFor(() => {
            expect(opts.save).toHaveBeenCalledWith("Prod", expect.objectContaining({
                name: "Prod2", savePassword: true, passwordB64: undefined,
            }));
        });
        pane.root.remove();
    });

    it("Reset restores the masked stored password after typing", async () => {
        const { pane } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const [, , , pw] = fields(pane.root);
        await vi.waitFor(() => {
            expect((pw as HTMLInputElement).value).toBe("••••••••");
        });
        (pw as HTMLInputElement).value = "typed-something";
        (pw as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Reset")!.click();
        await vi.waitFor(() => {
            expect((pw as HTMLInputElement).value).toBe("••••••••");
        });
        pane.root.remove();
    });

    it("Save sends the form profile keyed by the original name", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const [name, host] = fields(pane.root);
        (name as HTMLInputElement).value = "Production";
        (host as HTMLInputElement).value = "prod2.ibmi";
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Save")!.click();
        await vi.waitFor(() => {
            expect(opts.save).toHaveBeenCalledWith("Prod", expect.objectContaining({
                name: "Production", host: "prod2.ibmi", user: "COZZI", naming: "system", tls: true,
            }));
            expect(opts.onChanged).toHaveBeenCalled();
        });
        pane.root.remove();
    });

    it("New clears the form; saving a blank name defaults it to the host", async () => {
        const { pane, opts } = mkPane();
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "New")!.click();
        const [name, host, user] = fields(pane.root);
        expect((name as HTMLInputElement).value).toBe("");
        (host as HTMLInputElement).value = "new.ibmi";
        (user as HTMLInputElement).value = "NEWU";
        // New profile with a typed password saves it when Save-password is on.
        const pw = pane.root.querySelector<HTMLInputElement>(".conn-field input[type='password']")!;
        pw.value = "pw1";
        const savePw = pane.root.querySelector<HTMLInputElement>(".conn-field input[type='checkbox']:not([hidden])");
        void savePw;
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Save")!.click();
        await vi.waitFor(() => {
            expect(opts.save).toHaveBeenCalledWith("", expect.objectContaining({ name: "new.ibmi", host: "new.ibmi" }));
        });
        pane.root.remove();
    });

    it("Delete asks for confirmation and removes the profile", async () => {
        const confirm = vi.fn(() => true);
        const { pane, opts } = mkPane([P1], { confirm });
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(1);
        });
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Delete")!.click();
        await vi.waitFor(() => {
            expect(confirm).toHaveBeenCalled();
            expect(opts.remove).toHaveBeenCalledWith("Prod");
        });
        pane.root.remove();
    });

    it("drag-drop reorders and persists the new sequence", async () => {
        const onReorder = vi.fn(() => Promise.resolve());
        const { pane, opts } = mkPane([P1, P2], { onReorder });
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const items = pane.root.querySelectorAll<HTMLElement>(".conn-keys .settings-key");
        // jsdom lacks DataTransfer/DragEvent; stub what our handlers call.
        const dt = {
            getData: () => "Dev",
            setData: () => { /* no-op */ },
            setDragImage: () => { /* no-op */ },
        } as unknown as DataTransfer;
        const fire = (type: string, el: HTMLElement) => {
            const ev = new Event(type, { bubbles: true, cancelable: true });
            (ev as unknown as { dataTransfer: DataTransfer }).dataTransfer = dt;
            el.dispatchEvent(ev);
        };
        fire("dragstart", items[1]);
        fire("drop", items[0]);
        await vi.waitFor(() => {
            expect(onReorder).toHaveBeenCalledWith(["Dev", "Prod"]);
            expect(opts.onChanged).toHaveBeenCalled();
        });
        pane.root.remove();
    });

    it("A-Z sort button toggles direction and persists", async () => {
        const onReorder = vi.fn(() => Promise.resolve());
        const { pane } = mkPane([P1, P2], { onReorder });
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(2);
        });
        const sortBtn = [...pane.root.querySelectorAll<HTMLButtonElement>(".conn-list-footer button")]
            .find((b) => b.textContent === "A-Z")!;
        sortBtn.click();
        await vi.waitFor(() => {
            expect(onReorder).toHaveBeenCalledWith(["Dev", "Prod"]);
        });
        sortBtn.click();
        await vi.waitFor(() => {
            expect(onReorder).toHaveBeenLastCalledWith(["Prod", "Dev"]);
        });
        pane.root.remove();
    });

    it("Save without host/user reports an error and does not call save", async () => {
        const onError = vi.fn();
        const { pane, opts } = mkPane([P1], { onError });
        await vi.waitFor(() => {
            expect(pane.root.querySelectorAll(".conn-keys .settings-key").length).toBe(1);
        });
        const [, host] = fields(pane.root);
        (host as HTMLInputElement).value = "";
        [...pane.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((b) => b.textContent === "Save")!.click();
        await new Promise((r) => setTimeout(r, 10));
        expect(opts.save).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalled();
        pane.root.remove();
    });
});
