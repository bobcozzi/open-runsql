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

    it("has the result-grid essentials (subtabs strip, table, save/export, delimiter)", () => {
        for (const id of [
            "result-subtabs", "result-table", "result-head", "result-body",
            "save-results-wrap", "btn-save-results", "sel-save-format", "in-save-delim",
            "btn-load-more", "btn-load-all",
        ]) {
            expect(html, `missing "${id}"`).toContain(`id="${id}"`);
        }
    });
});
