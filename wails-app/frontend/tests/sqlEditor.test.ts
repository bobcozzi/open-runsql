import { describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { SqlEditor } from "../src/sqlEditor";

describe("SQL editor", () => {
    it("marks the running statement without changing the selection and clears it on edit", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "SELECT 1;\nSELECT 2;";
        editor.setSelectionRange(2, 5);
        editor.highlightRunningStatement(10, 19);
        expect(host.querySelector(".editor-running-statement")?.textContent).toBe("SELECT 2;");
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 5]);
        editor.clearRunningStatement();
        expect(host.querySelector(".editor-running-statement")).toBeNull();
        editor.highlightRunningStatement(10, 19);
        editor.view.dispatch({ changes: { from: 0, insert: "-- edit\n" } });
        expect(host.querySelector(".editor-running-statement")).toBeNull();
        editor.view.destroy();
        host.remove();
    });
    it("renders CL command, keyword and value highlights in mixed scripts", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "SELECT 'CL: not a command' FROM T;\nCL: ADDLIBLE LIB(SQLTOOLS);\nQSYS/DSPLIB LIB(*LIBL); -- done";
        expect([...host.querySelectorAll(".editor-highlight-cl-command")].map((node) => node.textContent)).toEqual(["CL:", "ADDLIBLE", "QSYS/DSPLIB"]);
        expect([...host.querySelectorAll(".editor-highlight-cl-keyword")].map((node) => node.textContent)).toEqual(["LIB", "LIB"]);
        expect([...host.querySelectorAll(".editor-highlight-cl-value")].map((node) => node.textContent)).toEqual(["SQLTOOLS", "*LIBL"]);
        expect(host.querySelector(".editor-highlight-comment")?.textContent).toBe("-- done");
        editor.setSqlHighlighting(false);
        expect(host.querySelector(".sql-token-keyword")).toBeNull();
        expect(host.querySelectorAll(".editor-highlight-cl-command")).toHaveLength(3);
        editor.view.destroy();
        host.remove();
    });
    it("toggles SQL syntax highlighting without disabling STOP or comments", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "SELECT 'hello', 42 FROM MYTABLE;\nSTOP; -- note\n// other";
        expect([...host.querySelectorAll(".sql-token-keyword")].map((node) => node.textContent)).toContain("SELECT");
        expect([...host.querySelectorAll(".sql-token-string")].map((node) => node.textContent)).toContain("'hello'");
        expect([...host.querySelectorAll(".sql-token-literal")].map((node) => node.textContent)).toContain("42");
        editor.setSqlHighlighting(false);
        expect(host.querySelector(".sql-token-keyword")).toBeNull();
        expect(host.querySelector(".editor-highlight-stop")?.textContent).toBe("STOP");
        expect([...host.querySelectorAll(".editor-highlight-comment")].map((node) => node.textContent)).toEqual(["-- note", "// other"]);
        editor.setSqlHighlighting(true);
        expect(host.querySelector(".sql-token-keyword")?.textContent).toBe("SELECT");
        editor.view.destroy();
        host.remove();
    });
    it("moves Home and End to the current logical line boundaries", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "first\n  second line\nthird";
        editor.setSelectionRange(10, 10);
        const press = (key: string) => {
            const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            editor.view.contentDOM.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
        };
        press("Home");
        expect(editor.view.state.selection.main.head).toBe(6);
        press("End");
        expect(editor.view.state.selection.main.head).toBe(19);
        editor.view.destroy();
        host.remove();
    });

    it("extends from the existing anchor with Shift+Home and Shift+End", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "first\nsecond line\nthird";
        editor.view.dispatch({ selection: { anchor: 12, head: 8 } });
        editor.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", shiftKey: true, bubbles: true, cancelable: true }));
        expect(editor.view.state.selection.main.anchor).toBe(12);
        expect(editor.view.state.selection.main.head).toBe(6);
        editor.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "End", shiftKey: true, bubbles: true, cancelable: true }));
        expect(editor.view.state.selection.main.anchor).toBe(12);
        expect(editor.view.state.selection.main.head).toBe(17);
        editor.view.destroy();
        host.remove();
    });

    it("does not intercept modified Home and End keys", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "first\nsecond";
        editor.setSelectionRange(8, 8);
        for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
            const event = new KeyboardEvent("keydown", { key: "Home", ...modifier, bubbles: true, cancelable: true });
            editor.view.contentDOM.dispatchEvent(event);
            expect(editor.view.state.selection.main.head).not.toBe(6);
            editor.setSelectionRange(8, 8);
        }
        editor.view.destroy();
        host.remove();
    });
    it("lets application shortcuts consume keyboard events before editor keymaps", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "SELECT 1;";
        const shortcuts = vi.fn((event: KeyboardEvent) => { if (event.key === "F4") event.preventDefault(); });
        editor.addEventListener("keydown", shortcuts);
        const event = new KeyboardEvent("keydown", { key: "F4", bubbles: true, cancelable: true });
        editor.view.contentDOM.dispatchEvent(event);
        expect(shortcuts).toHaveBeenCalledOnce();
        expect(event.defaultPrevented).toBe(true);
        expect(editor.value).toBe("SELECT 1;");
        editor.view.destroy();
        host.remove();
    });
    it("highlights STOP and both comment styles in the editable surface", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        editor.value = "SELECT 'STOP // text';\n-- note\nSTOP; // done";
        expect(editor.value).toBe("SELECT 'STOP // text';\n-- note\nSTOP; // done");
        expect([...host.querySelectorAll(".editor-highlight-stop")].map((node) => node.textContent)).toEqual(["STOP"]);
        expect([...host.querySelectorAll(".editor-highlight-comment")].map((node) => node.textContent)).toEqual(["-- note", "// done"]);
        editor.view.destroy();
        host.remove();
    });

    it("preserves text and selection through edits and undo", () => {
        const host = document.createElement("div");
        document.body.append(host);
        const editor = new SqlEditor(host);
        const onInput = vi.fn();
        editor.addEventListener("input", onInput);
        editor.value = "SELECT 1;";
        expect(onInput).not.toHaveBeenCalled();
        editor.setSelectionRange(7, 8);
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([7, 8]);
        editor.view.dispatch({ changes: { from: 7, to: 8, insert: "2" } });
        expect(editor.value).toBe("SELECT 2;");
        expect(onInput).toHaveBeenCalledOnce();
        expect(undo(editor.view)).toBe(true);
        expect(editor.value).toBe("SELECT 1;");
        editor.view.destroy();
        host.remove();
    });
});