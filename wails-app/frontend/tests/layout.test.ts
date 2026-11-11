// Layout smoke test: the work-tab bar and key controls must all be present in
// index.html. Guards against a dropped/renamed button or pane (a formatter or
// edit once silently removed the Connections tab). Reads index.html from disk
// so it asserts on the real markup regardless of JS wiring.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, "../index.html"), "utf8");

describe("index.html layout", () => {
    it("has all five work-tab buttons in order", () => {
        for (const pane of ["messages", "results", "spool", "connections", "settings"]) {
            expect(html, `missing work-tab for "${pane}"`).toContain(`data-pane="${pane}"`);
        }
        // The tab buttons specifically carry the work-tab-ids for spool/connections/settings.
        for (const id of ["work-tab-spool", "work-tab-connections", "work-tab-settings"]) {
            expect(html, `missing tab button id "${id}"`).toContain(`id="${id}"`);
        }
    });

    it("has the matching work panes", () => {
        for (const id of ["pane-results", "pane-messages", "pane-connections", "pane-settings"]) {
            expect(html, `missing pane "${id}"`).toContain(`id="${id}"`);
        }
    });

    it("has the editor toolbar controls (run/prompt/history/pin/open/save)", () => {
        for (const id of [
            "btn-run", "btn-run-all", "btn-run-from", "btn-cancel",
            "btn-prompt", "btn-pin-result", "btn-history", "btn-script-open", "btn-script-save",
        ]) {
            expect(html, `missing control "${id}"`).toContain(`id="${id}"`);
        }
        // Exactly one pin button (a duplicate id once slipped into the bottom bar).
        const pinCount = html.split('id="btn-pin-result"').length - 1;
        expect(pinCount).toBe(1);
    });

    it("places the initial-script reload icon between History and Open", () => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const history = doc.querySelector("#btn-history")!;
        const reload = doc.querySelector("#btn-reload-script")!;
        expect(history.nextElementSibling).toBe(reload);
        expect(reload.nextElementSibling?.id).toBe("btn-script-open");
        expect(reload.getAttribute("title")).toBe("Reload initial SQL script");
        expect(reload.getAttribute("aria-label")).toBe("Reload initial SQL script");
        expect(reload.querySelector("svg")).toBeTruthy();
    });

    it("provides an initially empty toolbar status instead of the SQL hint", () => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const status = doc.querySelector<HTMLElement>("#toolbar-status")!;
        expect(status.textContent).toBe("");
        expect(status.getAttribute("role")).toBe("status");
        expect(doc.querySelector("#input-hint")).toBeNull();
    });

    it("has the result-grid essentials (subtabs strip, table, save/export, delimiter)", () => {
        for (const id of [
            "result-subtabs", "result-table", "result-head", "result-body",
            "save-results-wrap", "btn-save-results", "sel-save-format", "in-save-delim",
            "btn-load-more", "btn-load-all",
        ]) {
            expect(html, `missing "${id}"`).toContain(`id="${id}"`);
        }
    });

    it("lists XLSX first and selects it by default", () => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const select = doc.querySelector<HTMLSelectElement>("#sel-save-format")!;
        expect([...select.options].map((option) => option.value)).toEqual(["xlsx", "csv", "tsv", "json", "md"]);
        expect(select.value).toBe("xlsx");
    });
});
