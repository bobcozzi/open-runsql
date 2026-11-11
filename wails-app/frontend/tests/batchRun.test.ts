import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { EditorView } from "@codemirror/view";

const app = vi.hoisted(() => ({
    Connect: vi.fn(async () => ({ connectionId: "test", host: "host", user: "user", databaseProduct: "IBM i", databaseVersion: "7.5", driverName: "driver", driverVersion: "1" })),
    Run: vi.fn(async (_request: { connectionId: string; text: string; fetchSize: number }) => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false })),
    GetAppSettings: vi.fn(async () => ({})),
    ListConnectionProfiles: vi.fn(async () => []),
    SaveConnectionProfile: vi.fn(async () => {}),
    SetInitialEditorText: vi.fn(async () => {}),
    GetConnectionIdentity: vi.fn(async () => ({ host: "host", user: "user" })),
    AddStatementHistory: vi.fn(async () => []),
    CancelSQL: vi.fn(async () => {}),
    CancelSpoolList: vi.fn(async () => {}),
    UpdateEditorText: vi.fn(async () => {}),
    UpdateMessagesHTML: vi.fn(async () => {}),
    UpdateStatusText: vi.fn(async () => {}),
    UpdatePinnedResults: vi.fn(async () => {}),
    ListDetached: vi.fn(async () => []),
    Version: vi.fn(async () => "test"),
}));

vi.mock("../src/types", () => ({ App: () => app }));
vi.mock("@wailsio/runtime", () => ({ Events: { On: vi.fn() } }));

describe("batch run buttons", () => {
    let editor: EditorView;
    beforeAll(async () => {
        document.documentElement.innerHTML = readFileSync(fileURLToPath(new NodeURL("../index.html", import.meta.url)), "utf8")
            .replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>[\s\S]*$/i, "");
        Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn() }) });
        Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        await import("../src/main");
        (document.querySelector("#in-host") as HTMLInputElement).value = "host";
        (document.querySelector("#in-user") as HTMLInputElement).value = "user";
        (document.querySelector("#btn-connect") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(app.SetInitialEditorText).toHaveBeenCalled());
        editor = EditorView.findFromDOM(document.querySelector(".cm-editor")!)!;
    });

    it("runs all statements in order", async () => {
        app.Run.mockClear();
        const script = "select * from aiddata.blnce limit 51;\nSELECT LOCAL_PORT, LOCAL_PORT_NAME, BIND_USER, IDLE_TIME \n FROM QSYS2.NETSTAT_INFO\n WHERE LOCAL_ADDRESS = '0.0.0.0'\n ORDER BY LOCAL_PORT;\nselect * from qiws.qcustcdt;";
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script } });
        (document.querySelector("#btn-run-from") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(app.Run).toHaveBeenCalledTimes(3));
        expect(app.Run.mock.calls.map(([request]) => request.text)).toEqual(["select * from aiddata.blnce limit 51", "SELECT LOCAL_PORT, LOCAL_PORT_NAME, BIND_USER, IDLE_TIME \n FROM QSYS2.NETSTAT_INFO\n WHERE LOCAL_ADDRESS = '0.0.0.0'\n ORDER BY LOCAL_PORT", "select * from qiws.qcustcdt"]);
        await vi.waitFor(() => expect((document.querySelector("#btn-run-from") as HTMLButtonElement).disabled).toBe(false));
        expect(editor.state.selection.main.head).toBe(script.length);
    });

    it("runs from the selected statement through the end", async () => {
        app.Run.mockClear();
        editor.dispatch({ selection: { anchor: editor.state.doc.toString().indexOf("SELECT LOCAL_PORT") } });
        (document.querySelector("#btn-run-all") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(app.Run).toHaveBeenCalledTimes(2));
        expect(app.Run.mock.calls.map(([request]) => request.text)).toEqual(["SELECT LOCAL_PORT, LOCAL_PORT_NAME, BIND_USER, IDLE_TIME \n FROM QSYS2.NETSTAT_INFO\n WHERE LOCAL_ADDRESS = '0.0.0.0'\n ORDER BY LOCAL_PORT", "select * from qiws.qcustcdt"]);
        await vi.waitFor(() => expect((document.querySelector("#btn-run-all") as HTMLButtonElement).disabled).toBe(false));
        expect(editor.state.selection.main.head).toBe(editor.state.doc.length);
    });

    it("highlights each running statement and advances the caret to STOP", async () => {
        app.Run.mockClear();
        const script = "values 1;\nvalues 2;\nSTOP;\nvalues 3;";
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script }, selection: { anchor: 4 } });
        const releases: Array<() => void> = [];
        app.Run.mockImplementation(async () => {
            await new Promise<void>((resolve) => { releases.push(resolve); });
            return { kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false };
        });
        (document.querySelector("#btn-run-from") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(releases).toHaveLength(1));
        expect([...document.querySelectorAll(".editor-running-statement")].map((node) => node.textContent).join("")).toBe("values 1;");
        expect(editor.state.selection.main.head).toBe(4);
        releases[0]();
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        expect([...document.querySelectorAll(".editor-running-statement")].map((node) => node.textContent).join("")).toBe("values 2;");
        expect(editor.state.selection.main.head).toBe(script.indexOf("values 2"));
        releases[1]();
        await vi.waitFor(() => expect((document.querySelector("#btn-run-from") as HTMLButtonElement).disabled).toBe(false));
        expect(app.Run).toHaveBeenCalledTimes(2);
        expect(editor.state.selection.main.head).toBe(script.indexOf("STOP"));
        expect(document.querySelector(".editor-running-statement")).toBeNull();
    });

    it("places the caret at STOP and handles Run Current locally", async () => {
        app.Run.mockReset();
        app.Run.mockImplementation(async () => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false }));
        const script = "values 1;\nSTOP;\nvalues 2;";
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script }, selection: { anchor: 2 } });
        (document.querySelector("#btn-run-from") as HTMLButtonElement).click();
        await vi.waitFor(() => expect((document.querySelector("#btn-run-from") as HTMLButtonElement).disabled).toBe(false));
        expect(app.Run.mock.calls.map(([request]) => request.text)).toEqual(["values 1"]);
        expect(editor.state.selection.main.head).toBe(script.indexOf("STOP"));
        app.Run.mockClear();
        (document.querySelector("#btn-run") as HTMLButtonElement).click();
        expect(app.Run).not.toHaveBeenCalled();
        await vi.waitFor(() => expect((document.querySelector("#btn-run") as HTMLButtonElement).disabled).toBe(false));
    });

    it("places the caret before STOP in the reported multiline script", async () => {
        app.Run.mockReset();
        app.Run.mockImplementation(async () => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false }));
        const script = "select * from aiddata.blnce limit 51;\nSELECT LOCAL_PORT, LOCAL_PORT_NAME, BIND_USER, IDLE_TIME \n FROM QSYS2.NETSTAT_INFO\n WHERE LOCAL_ADDRESS = '0.0.0.0'\n ORDER BY LOCAL_PORT;\nstop;\nselect * from qiws.qcustcdt;";
        const caret = script.indexOf("from") + 1;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script }, selection: { anchor: caret } });
        editor.focus();
        const runAll = document.querySelector<HTMLButtonElement>("#btn-run-from")!;
        runAll.focus();
        runAll.click();
        await vi.waitFor(() => expect(runAll.disabled).toBe(false));
        expect(app.Run.mock.calls.map(([request]) => request.text)).toEqual([
            "select * from aiddata.blnce limit 51",
            "SELECT LOCAL_PORT, LOCAL_PORT_NAME, BIND_USER, IDLE_TIME \n FROM QSYS2.NETSTAT_INFO\n WHERE LOCAL_ADDRESS = '0.0.0.0'\n ORDER BY LOCAL_PORT",
        ]);
        expect(editor.state.selection.main.head).toBe(script.indexOf("stop;"));
        expect(editor.hasFocus).toBe(true);
        app.Run.mockClear();
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        expect(app.Run).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#btn-run")!.disabled).toBe(false));
    });

    it("handles STOP locally when it is the current or selected statement", async () => {
        const script = "values 1;\nSTOP; -- stop here\nvalues 2;";
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script }, selection: { anchor: script.indexOf("STOP") } });
        app.Run.mockClear();
        (document.querySelector("#btn-run") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(document.querySelector("#status-text")?.textContent).toContain("STOP"));
        expect(app.Run).not.toHaveBeenCalled();
        editor.dispatch({ selection: { anchor: script.indexOf("STOP"), head: script.indexOf("values 2") } });
        (document.querySelector("#btn-run") as HTMLButtonElement).click();
        expect(app.Run).not.toHaveBeenCalled();
    });

    it("clears the running highlight when execution fails", async () => {
        app.Run.mockReset();
        app.Run.mockRejectedValueOnce(new Error("test failure"));
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "values 1; values 2;" } });
        (document.querySelector("#btn-run-from") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(app.Run).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect((document.querySelector("#btn-run-from") as HTMLButtonElement).disabled).toBe(false));
        expect(document.querySelector(".editor-running-statement")).toBeNull();
    });

    it("leaves the caret before the fourth statement when execution stops there", async () => {
        app.Run.mockReset();
        const script = "values 1;\nvalues 2;\nvalues 3;\nvalues 4;";
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script }, selection: { anchor: 0 } });
        app.Run.mockImplementation(async (request) => {
            if (request.text === "values 4") throw new Error("test failure");
            return { kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false };
        });
        const runAll = document.querySelector<HTMLButtonElement>("#btn-run-from")!;
        runAll.click();
        await vi.waitFor(() => expect(app.Run).toHaveBeenCalledTimes(4));
        await vi.waitFor(() => expect(runAll.disabled).toBe(false));
        expect(editor.state.selection.main.head).toBe(script.indexOf("values 4"));
    });

    it("highlights Run From Selected and clears immediately on Cancel", async () => {
        app.Run.mockReset();
        const script = "values 1;\nvalues 2;\nvalues 3;";
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: script }, selection: { anchor: script.indexOf("values 2") } });
        let release: (() => void) | undefined;
        app.Run.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            throw new Error("canceled");
        });
        (document.querySelector("#btn-run-all") as HTMLButtonElement).click();
        await vi.waitFor(() => expect(release).toBeDefined());
        expect([...document.querySelectorAll(".editor-running-statement")].map((node) => node.textContent).join("")).toBe("values 2;");
        (document.querySelector("#btn-cancel") as HTMLButtonElement).click();
        expect(document.querySelector(".editor-running-statement")).toBeNull();
        release!();
        await vi.waitFor(() => expect((document.querySelector("#btn-run-all") as HTMLButtonElement).disabled).toBe(false));
        expect(app.CancelSQL).toHaveBeenCalled();
        expect(document.querySelector(".editor-running-statement")).toBeNull();
    });
});