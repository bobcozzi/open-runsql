import { describe, expect, it } from "vitest";
import { createToolbarStatus } from "../src/toolbarStatus";

describe("transient toolbar status", () => {
    it("clears on the next user interaction", () => {
        const doc = document.implementation.createHTMLDocument();
        const status = doc.createElement("span");
        const button = doc.createElement("button");
        doc.body.append(status, button);
        const toolbar = createToolbarStatus(status, () => "connection", doc);
        for (const type of ["pointerdown", "click", "keydown", "input", "change", "wheel", "touchstart", "contextmenu"]) {
            toolbar.show("23 rows in 7 ms", "connection");
            expect(status.textContent).toBe("23 rows in 7 ms");
            button.dispatchEvent(new Event(type, { bubbles: true }));
            expect(status.textContent).toBe("");
        }
    });

    it("clears before an interaction handler can publish a new message", () => {
        const doc = document.implementation.createHTMLDocument();
        const status = doc.createElement("span");
        const button = doc.createElement("button");
        doc.body.append(status, button);
        const toolbar = createToolbarStatus(status, () => "connection", doc);
        button.addEventListener("click", () => toolbar.show("new status", "connection"));
        toolbar.show("old status", "connection");
        button.click();
        expect(status.textContent).toBe("new status");
    });

    it("does not show results from another or disconnected connection", () => {
        const doc = document.implementation.createHTMLDocument();
        const status = doc.createElement("span");
        let current: string | null = "first";
        const toolbar = createToolbarStatus(status, () => current, doc);
        toolbar.show("first result", "first");
        current = "second";
        toolbar.sync();
        expect(status.textContent).toBe("");
        toolbar.show("late first result", "first");
        expect(status.textContent).toBe("");
        toolbar.show("second result", "second");
        expect(status.textContent).toBe("second result");
        current = null;
        toolbar.sync();
        toolbar.show("late second result", "second");
        expect(status.textContent).toBe("");
    });
});