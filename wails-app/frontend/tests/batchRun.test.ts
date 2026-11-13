import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { EditorView } from "@codemirror/view";

const app = vi.hoisted(() => ({
    Connect: vi.fn(async () => ({ connectionId: "test", host: "host", user: "user", databaseProduct: "IBM i", databaseVersion: "7.5", driverName: "driver", driverVersion: "1" })),
    Run: vi.fn(async (_request: { connectionId: string; text: string; fetchSize: number }) => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false })),
    Fetch: vi.fn(async (_request: { connectionId: string; cursorId: string; fetchSize: number }) => ({ kind: "rows", rows: [[3]], cursorId: "cursor", more: false, elapsedMs: 1 })),
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
    SetAppSetting: vi.fn(async () => {}),
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
        expect(document.querySelector("#message-list .msg-statement.msg-cl-command")).toBeNull();
        await vi.waitFor(() => expect((document.querySelector("#btn-run-from") as HTMLButtonElement).disabled).toBe(false));
        expect(editor.state.selection.main.head).toBe(script.length);
    });

    it("renders indented CHAR cells without collapsing leading spaces or padding the right edge", async () => {
        const previousText = editor.state.doc.toString();
        app.Run.mockClear();
        app.Run.mockImplementationOnce(async () => ({
            kind: "rows", elapsedMs: 1, messages: [], rows: [["  source line  "]],
            columns: [{ name: "SRCDTA", label: "SRCDTA", type: 1, typeName: "CHAR", precision: 100, scale: 0 }],
            more: false,
        }) as never);
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "select SRCDTA from SOURCE" }, selection: { anchor: 0 } });
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(app.Run).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(document.querySelector("#result-body tr td:nth-child(2)")?.textContent).toBe("  source line"));
        const cell = document.querySelector<HTMLTableCellElement>("#result-body tr td:nth-child(2)")!;
        expect(cell.classList.contains("preserve-whitespace")).toBe(true);
        await vi.waitFor(() => expect((document.querySelector("#btn-run") as HTMLButtonElement).disabled).toBe(false));
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: previousText } });
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

    it("shows enhanced result rows and expandable messages without another execution", async () => {
        app.Run.mockReset();
        app.Run.mockImplementationOnce(async () => ({ kind: "cl", command: "DSPJOB", ok: true, elapsedMs: 1,
            messages: [{ id: "CPC0001", text: "Done", severity: 0, typeName: "*COMP", kind: "info", secondLevelText: "Help", fromProgram: "<img src=x>" }],
            resultSet: { kind: "rows", columns: [{ name: "SENT_TIMESTAMP", label: "SENT_TIMESTAMP", type: 93, typeName: "TIMESTAMP", precision: 26, scale: 6 }], rows: [["2026-11-13 12:34:56.123456"], [null]], more: false, elapsedMs: 1 },
        }) as never);
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "CL: DSPJOB;" }, selection: { anchor: 2 } });
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector("#result-body")?.textContent).toContain("2026-11-13"));
        expect(app.Run).toHaveBeenCalledTimes(1);
        expect([...document.querySelectorAll("#message-list .msg-cl-command")].some((line) => line.textContent === "CL: DSPJOB")).toBe(true);
        expect(document.querySelectorAll("#result-body tr")).toHaveLength(2);
        expect(document.querySelector("#message-list details summary")?.textContent).toContain("CPC0001");
        expect(document.querySelector("#message-list details summary")?.textContent).toBe("CPC0001 0 *COMP - Done");
        expect(document.querySelector("#message-list img")).toBeNull();
        expect(document.querySelector("#message-list .msg-second-level")?.textContent).toBe("Help");
        expect(document.querySelector<HTMLButtonElement>("#btn-pin-result")!.disabled).toBe(false);
    });

    it("restores expanded message HTML and pinned results after switching connections", async () => {
        const detail = document.querySelector<HTMLDetailsElement>("#message-list details")!;
        detail.open = true;
        document.querySelector<HTMLButtonElement>("#btn-pin-result")!.click();
        expect(app.UpdatePinnedResults).toHaveBeenCalled();
        document.querySelector<HTMLButtonElement>("#btn-new-conn")!.click();
        document.querySelector<HTMLButtonElement>(".conn-tab")!.click();
        expect(document.querySelector<HTMLDetailsElement>("#message-list details")?.open).toBe(true);
        expect(document.querySelector("#result-body")?.textContent).toContain("2026-11-13");
        expect(document.querySelector("#result-subtabs")?.textContent).toContain("Pin 1");
    });

    it("exposes the global enhanced CL results setting, initially off", async () => {
        document.querySelector<HTMLButtonElement>("#work-tab-settings")!.click();
        const group = [...document.querySelectorAll<HTMLElement>(".settings-key")].find((item) => item.textContent === "Enhanced CL Support");
        expect(group).toBeDefined();
        group!.click();
        const toggle = document.querySelector<HTMLElement>('#setting-showCLMessagesInResults')!;
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(document.querySelector('label[for="setting-enhancedSupportLibrary"]')?.textContent).toBe("Function Library");
        const notifications = document.querySelector<HTMLSelectElement>("#setting-functionUpdateNotifications")!;
        expect(document.querySelector('label[for="setting-functionUpdateNotifications"]')?.textContent).toBe("Function update notifications");
        expect([...notifications.options].map((option) => option.textContent)).toEqual(["Always", "New only", "Updates only", "No notifications, auto install and update", "No notifications, no installs or updates"]);
        expect(notifications.value).toBe("always");
        notifications.value = "newOnly";
        notifications.dispatchEvent(new Event("change", { bubbles: true }));
        await vi.waitFor(() => expect(app.SetAppSetting).toHaveBeenCalledWith("functionUpdateNotifications", "newOnly"));
        for (const policy of ["noneAuto", "noneSkip"]) {
            notifications.value = policy;
            notifications.dispatchEvent(new Event("change", { bubbles: true }));
            await vi.waitFor(() => expect(app.SetAppSetting).toHaveBeenCalledWith("functionUpdateNotifications", policy));
        }
        toggle.click();
        await vi.waitFor(() => expect(app.SetAppSetting).toHaveBeenCalledWith("showCLMessagesInResults", "on"));
        toggle.click();
        await vi.waitFor(() => expect(app.SetAppSetting).toHaveBeenCalledWith("showCLMessagesInResults", "off"));
    });

    it("preserves existing results for an empty enhanced response and clears for standard CL", async () => {
        app.Run.mockReset();
        app.Run.mockImplementationOnce(async () => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[42]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false }) as never);
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "values 42;" }, selection: { anchor: 0 } });
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector("#result-body")?.textContent).toContain("42"));

        app.Run.mockImplementationOnce(async () => ({ kind: "cl", command: "OVRDBF", ok: true, elapsedMs: 1,
            messages: [{ id: "CPC0001", text: "Override complete", severity: 0, typeName: "*COMP", kind: "info" }],
            preserveResults: true }) as never);
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "CL: OVRDBF;" }, selection: { anchor: 2 } });
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector("#message-list")?.textContent).toContain("Override complete"));
        expect(document.querySelector("#result-head")?.textContent).toContain("ID");
        expect(document.querySelector("#result-body")?.textContent).toContain("42");
        app.Run.mockImplementationOnce(async () => ({ kind: "cl", command: "DSPJOB", ok: true, elapsedMs: 1,
            messages: [{ id: "CPCSTANDARD", text: "Standard", severity: 0, typeName: "*COMP", kind: "info", secondLevelText: "Standard help" }] }) as never);
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector("#message-list")?.textContent).toContain("CPCSTANDARD"));
        expect(document.querySelector("#result-head")?.textContent).not.toContain("MSGID");
        const standard = [...document.querySelectorAll("#message-list li")].find((item) => item.textContent?.includes("CPCSTANDARD"))!;
        const standardDetails = standard.querySelector<HTMLDetailsElement>("details")!;
        expect(standardDetails.open).toBe(false);
        expect(standardDetails.querySelector("summary")?.textContent).toBe("CPCSTANDARD 0 *COMP - Standard");
        expect(standardDetails.querySelector(".msg-second-level")?.textContent).toBe("Standard help");
        expect(app.Run).toHaveBeenCalledTimes(3);
    });

    it("scrolls to the latest message when the Messages tab is activated", async () => {
        const list = document.querySelector<HTMLElement>("#message-list")!;
        Object.defineProperty(list, "scrollHeight", { configurable: true, value: 500 });
        list.scrollTop = 0;
        document.querySelector<HTMLButtonElement>('.work-tab[data-pane="messages"]')!.click();
        await vi.waitFor(() => expect(list.scrollTop).toBe(500));
    });

    it("keeps CL errors on Results only when a message result set is present", async () => {
        const message = { id: "CPF0001", text: "Command failed", severity: 40, typeName: "*ESCAPE", kind: "error", secondLevelText: "Help" };
        app.Run.mockReset();
        app.Run.mockImplementationOnce(async () => ({ kind: "cl", command: "BADCOMMAND", ok: false, elapsedMs: 1, messages: [message],
            resultSet: { kind: "rows", columns: [{ name: "MSGID", label: "MSGID", type: 12, typeName: "VARCHAR", precision: 7, scale: 0 }], rows: [["CPF0001"]], more: false, elapsedMs: 1 } }) as never);
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "CL: BADCOMMAND;" }, selection: { anchor: 2 } });
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector("#result-body")?.textContent).toContain("CPF0001"));
        expect(document.querySelector<HTMLElement>("#pane-results")!.hidden).toBe(false);
        expect(document.querySelector<HTMLElement>("#pane-messages")!.hidden).toBe(true);
        expect(document.querySelector("#message-list")?.textContent).toContain("Command failed");
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#btn-run")!.disabled).toBe(false));
        app.Run.mockImplementationOnce(async () => ({ kind: "cl", command: "BADCOMMAND", ok: false, elapsedMs: 1, messages: [message] }) as never);
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#pane-messages")!.hidden).toBe(false));
        expect(app.Run).toHaveBeenCalledTimes(2);
    });

    it("ignores a stale fetch after a new SQL result", async () => {
        app.Run.mockReset();
        app.Run.mockImplementationOnce(async () => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[1]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], cursorId: "cursor", more: true }) as never);
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "values 1;" }, selection: { anchor: 0 } });
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#btn-load-more")!.hidden).toBe(false));
        let release: (() => void) | undefined;
        app.Fetch.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            return { kind: "rows", rows: [["STALE"]], cursorId: "cursor", more: false, elapsedMs: 1 } as never;
        });
        document.querySelector<HTMLButtonElement>("#btn-load-more")!.click();
        await vi.waitFor(() => expect(release).toBeDefined());
        app.Run.mockImplementationOnce(async () => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [["FRESH"]], columns: [{ name: "ID", label: "ID", type: 12, typeName: "VARCHAR", precision: 10, scale: 0 }], more: false }));
        document.querySelector<HTMLButtonElement>("#btn-run")!.click();
        await vi.waitFor(() => expect(document.querySelector("#result-body")?.textContent).toContain("FRESH"));
        release!();
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#btn-load-more")!.disabled).toBe(false));
        expect(document.querySelector("#result-body")?.textContent).not.toContain("STALE");
    });

    it("keeps an in-flight batch on its original tab and restores its messages", async () => {
        app.Run.mockReset();
        let release: (() => void) | undefined;
        app.Run.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            return { kind: "cl", command: "DSPJOB", ok: true, elapsedMs: 1,
                messages: [{ id: "CPC1234", text: "Origin result", severity: 0, typeName: "*COMP", kind: "info", fromProgram: "PGM" }] } as never;
        });
        app.Run.mockImplementationOnce(async () => ({ kind: "rows", elapsedMs: 1, messages: [], rows: [[2]], columns: [{ name: "ID", label: "ID", type: 4, typeName: "INTEGER", precision: 10, scale: 0 }], more: false }));
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: "CL: DSPJOB; values 2;" }, selection: { anchor: 0 } });
        document.querySelector<HTMLButtonElement>("#btn-run-from")!.click();
        await vi.waitFor(() => expect(release).toBeDefined());
        document.querySelector<HTMLButtonElement>("#btn-new-conn")!.click();
        release!();
        await vi.waitFor(() => expect(app.Run).toHaveBeenCalledTimes(2));
        expect(app.Run.mock.calls.map(([request]) => request.connectionId)).toEqual(["test", "test"]);
        expect(document.querySelector("#message-list")?.textContent).not.toContain("Origin result");
        document.querySelector<HTMLButtonElement>(".conn-tab")!.click();
        await vi.waitFor(() => expect(document.querySelector("#message-list")?.textContent).toContain("Origin result"));
        expect([...document.querySelectorAll("#message-list details summary")].some((summary) => summary.textContent?.includes("CPC1234"))).toBe(true);
        expect(document.querySelector("#result-body")?.textContent).toContain("2");
    });
});