import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

const { app, handlers } = vi.hoisted(() => ({
    app: {
        Connect: vi.fn(), Disconnect: vi.fn(async () => {}),
        GetConnectionIdentity: vi.fn(), GetWorkspace: vi.fn(async () => ({ label: "user@host" })),
        GetAppSettings: vi.fn(async () => ({})), ListConnectionProfiles: vi.fn(async () => []),
        SaveConnectionProfile: vi.fn(async () => {}), SetInitialEditorText: vi.fn(async () => {}),
        UpdateEditorText: vi.fn(async () => {}), UpdateMessagesHTML: vi.fn(async () => {}),
        UpdateStatusText: vi.fn(async () => {}), UpdatePinnedResults: vi.fn(async () => {}),
        SetAppSetting: vi.fn(async () => {}), ListDetached: vi.fn(async () => []),
        CancelSpoolList: vi.fn(async () => {}), Version: vi.fn(async () => "test"),
    },
    handlers: new Map<string, (event: { data?: any }) => void>(),
}));

vi.mock("../src/types", () => ({ App: () => app }));
vi.mock("@wailsio/runtime", () => ({ Events: { On: (name: string, handler: (event: { data?: any }) => void) => handlers.set(name, handler) } }));

const html = readFileSync(fileURLToPath(new NodeURL("../index.html", import.meta.url)), "utf8");
const job = () => document.querySelector<HTMLElement>("#server-job")!;
const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!;
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};

async function boot(connection = "") {
    vi.resetModules();
    handlers.clear();
    window.history.replaceState({}, "", connection ? `/?connection=${connection}` : "/");
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>[\s\S]*$/i, "");
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn() }) });
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    await import("../src/main");
}

describe("SQL job toolbar", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        app.GetConnectionIdentity.mockResolvedValue({ host: "host", user: "user" });
        app.GetWorkspace.mockResolvedValue({ label: "user@host" });
    });

    it("tracks the selected tab, allows selection, and logs the job once", async () => {
        app.Connect.mockResolvedValueOnce({ connectionId: "one", host: "host1", user: "user1", serverJob: " 123456 / USER1 / JOB1 ", databaseProduct: "IBM i", databaseVersion: "7.5", driverName: "driver", driverVersion: "1" });
        app.Connect.mockResolvedValueOnce({ connectionId: "two", host: "host2", user: "user2", serverJob: "654321/USER2/JOB2", databaseProduct: "IBM i", databaseVersion: "7.5", driverName: "driver", driverVersion: "1" });
        await boot();
        expect(job().hidden).toBe(true);
        button("btn-connect").click();
        await vi.waitFor(() => expect(job().textContent).toBe("SQL job: 123456/USER1/JOB1"));
        const messages = document.querySelector("#message-list")!.textContent!;
        expect(messages).toContain("Connected - SQL job: 123456/USER1/JOB1");
        expect(messages.match(/123456\/USER1\/JOB1/g)).toHaveLength(1);
        expect(job().nextElementSibling?.id).toBe("btn-connect");
        expect(button("btn-connect").nextElementSibling?.id).toBe("btn-disconnect");
        expect(button("btn-disconnect").nextElementSibling?.querySelector("#sel-theme")).not.toBeNull();
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.selectNodeContents(job());
        selection.removeAllRanges();
        selection.addRange(range);
        expect(selection.toString()).toBe("SQL job: 123456/USER1/JOB1");
        button("btn-new-conn").click();
        expect(job().hidden).toBe(true);
        button("btn-connect").click();
        await vi.waitFor(() => expect(job().textContent).toBe("SQL job: 654321/USER2/JOB2"));
        const tabs = document.querySelectorAll<HTMLButtonElement>("#conn-tab-list .conn-tab");
        tabs[0].click();
        expect(job().textContent).toBe("SQL job: 123456/USER1/JOB1");
        tabs[1].click();
        expect(job().textContent).toBe("SQL job: 654321/USER2/JOB2");
        button("btn-disconnect").click();
        await vi.waitFor(() => expect(job().textContent).toBe("SQL job: 123456/USER1/JOB1"));
        button("btn-disconnect").click();
        await vi.waitFor(() => expect(job().hidden).toBe(true));
        expect(job().textContent).toBe("");
    });

    it("loads detached identity and hides a missing job", async () => {
        app.GetConnectionIdentity.mockResolvedValueOnce({ host: "host", user: "user", serverJob: " 123456 / USER / JOB " });
        await boot("detached-one");
        await vi.waitFor(() => expect(job().textContent).toBe("SQL job: 123456/USER/JOB"));
        expect(app.GetConnectionIdentity).toHaveBeenCalledWith("detached-one");
        await boot("detached-two");
        await vi.waitFor(() => expect(app.GetConnectionIdentity).toHaveBeenCalledWith("detached-two"));
        expect(job().hidden).toBe(true);
        expect(job().textContent).toBe("");
    });

    it("omits the job from a connection and log when it is unavailable", async () => {
        app.Connect.mockResolvedValueOnce({ connectionId: "missing", host: "host", user: "user", databaseProduct: "IBM i", databaseVersion: "7.5", driverName: "driver", driverVersion: "1" });
        await boot();
        button("btn-connect").click();
        await vi.waitFor(() => expect(app.SetInitialEditorText).toHaveBeenCalled());
        expect(job().hidden).toBe(true);
        expect(document.querySelector("#message-list")!.textContent).not.toContain("SQL job:");
    });

    it("ignores a detached identity arriving after disconnect", async () => {
        const pending = deferred<{ host: string; user: string; serverJob: string }>();
        app.GetConnectionIdentity.mockReturnValueOnce(pending.promise);
        await boot("detached");
        button("btn-disconnect").click();
        await vi.waitFor(() => expect(app.Disconnect).toHaveBeenCalledWith("detached"));
        await vi.waitFor(() => expect(button("btn-disconnect").disabled).toBe(true));
        pending.resolve({ host: "host", user: "user", serverJob: "123456/USER/JOB" });
        await pending.promise;
        await Promise.resolve();
        expect(job().hidden).toBe(true);
        expect(job().textContent).toBe("");
    });

    it("restores reattached identities on their own tabs even when responses arrive out of order", async () => {
        const first = deferred<{ host: string; user: string; serverJob: string }>();
        const second = deferred<{ host: string; user: string; serverJob: string }>();
        app.GetConnectionIdentity.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        await boot();
        handlers.get("workspace:reattach")!({ data: { connectionId: "one" } });
        handlers.get("workspace:reattach")!({ data: { connectionId: "two" } });
        second.resolve({ host: "host", user: "user", serverJob: "222222/USER/JOB2" });
        await vi.waitFor(() => expect(job().textContent).toBe("SQL job: 222222/USER/JOB2"));
        first.resolve({ host: "host", user: "user", serverJob: "111111/USER/JOB1" });
        await first.promise;
        await Promise.resolve();
        expect(job().textContent).toBe("SQL job: 222222/USER/JOB2");
        document.querySelectorAll<HTMLButtonElement>("#conn-tab-list .conn-tab")[1].click();
        expect(job().textContent).toBe("SQL job: 111111/USER/JOB1");
    });

    it("ignores a reattached identity arriving after its tab disconnects", async () => {
        const pending = deferred<{ host: string; user: string; serverJob: string }>();
        app.GetConnectionIdentity.mockReturnValueOnce(pending.promise);
        await boot();
        handlers.get("workspace:reattach")!({ data: { connectionId: "one" } });
        button("btn-disconnect").click();
        await vi.waitFor(() => expect(app.Disconnect).toHaveBeenCalledWith("one"));
        await vi.waitFor(() => expect(job().hidden).toBe(true));
        pending.resolve({ host: "host", user: "user", serverJob: "123456/USER/JOB" });
        await pending.promise;
        await Promise.resolve();
        expect(job().hidden).toBe(true);
        expect(job().textContent).toBe("");
    });
});