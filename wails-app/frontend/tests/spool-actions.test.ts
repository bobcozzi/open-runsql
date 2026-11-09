// Spooled Files stage 2: right-click row selection + action callback.
import { describe, expect, it, vi } from "vitest";
import { createSpoolPane } from "../src/spool";
import type { SpooledFileInfo } from "../src/types";

const FILE_A: SpooledFileInfo = {
    name: "QPRINT", number: "1", jobName: "JOB1", jobUser: "COZZI", jobNumber: "123456",
    userData: "", outqName: "QPRINT", outqLib: "QGPL", createDate: "2026-11-08",
    createTime: "10:00:00", pages: 1, size: 100, status: "RDY", holdStatus: "NO",
};
const FILE_B: SpooledFileInfo = { ...FILE_A, name: "QSYSPRT", number: "2" };
const FILE_C: SpooledFileInfo = { ...FILE_A, name: "QPRTJOB", number: "3" };

const click = (row: Element, init: MouseEventInit = {}) =>
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));

const rightClick = (row: Element, x = 40, y = 50) =>
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));

describe("spool row context menu", () => {
    it("right-click selects the row and reports file + coords", () => {
        const onRowContext = vi.fn();
        const pane = createSpoolPane({ onRefresh: () => { }, onRowContext });
        pane.setFiles([FILE_A, FILE_B]);
        const rows = pane.root.querySelectorAll("tbody tr");
        rightClick(rows[1]);
        expect(onRowContext).toHaveBeenCalledWith(
            expect.objectContaining({ name: "QSYSPRT" }), 40, 50,
            [expect.objectContaining({ name: "QSYSPRT" })]);
        expect(rows[1].classList.contains("spool-selected")).toBe(true);
        // Selecting another row moves the selection.
        rightClick(rows[0], 5, 6);
        expect(rows[0].classList.contains("spool-selected")).toBe(true);
        expect(rows[1].classList.contains("spool-selected")).toBe(false);
    });
});

describe("spool multi-select", () => {
    it("Ctrl/Cmd+click toggles rows; plain click collapses to one", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        pane.setFiles([FILE_A, FILE_B, FILE_C]);
        const rows = pane.root.querySelectorAll("tbody tr");
        click(rows[0]);
        click(rows[2], { ctrlKey: true });
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QPRINT", "QPRTJOB"]);
        // Cmd+click (macOS) behaves the same.
        click(rows[1], { metaKey: true });
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QPRINT", "QSYSPRT", "QPRTJOB"]);
        // Toggling a selected row off works too.
        click(rows[0], { ctrlKey: true });
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QSYSPRT", "QPRTJOB"]);
        // Plain click collapses back to a single selection.
        click(rows[2]);
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QPRTJOB"]);
    });

    it("Shift+click selects the range from the anchor row", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        pane.setFiles([FILE_A, FILE_B, FILE_C]);
        const rows = pane.root.querySelectorAll("tbody tr");
        click(rows[0]);
        click(rows[2], { shiftKey: true });
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QPRINT", "QSYSPRT", "QPRTJOB"]);
        // Reverse direction works from a new anchor.
        click(rows[2]);
        click(rows[0], { shiftKey: true });
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QPRINT", "QSYSPRT", "QPRTJOB"]);
    });

    it("right-click on a selected row keeps the multi-selection", () => {
        const onRowContext = vi.fn();
        const pane = createSpoolPane({ onRefresh: () => { }, onRowContext });
        pane.setFiles([FILE_A, FILE_B]);
        const rows = pane.root.querySelectorAll("tbody tr");
        click(rows[0]);
        click(rows[1], { ctrlKey: true });
        rightClick(rows[1], 10, 11);
        expect(onRowContext).toHaveBeenCalledWith(
            expect.objectContaining({ name: "QSYSPRT" }), 10, 11,
            [FILE_A, FILE_B]);
        expect(rows[0].classList.contains("spool-selected")).toBe(true);
        expect(rows[1].classList.contains("spool-selected")).toBe(true);
    });

    it("selection survives a re-sort but clears on reload", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        pane.setFiles([FILE_B, FILE_A]);
        let rows = pane.root.querySelectorAll("tbody tr");
        click(rows[0]); // FILE_B (first in unsorted view)
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QSYSPRT"]);
        // Sort by name: selection follows the object, not the row position.
        const nameTh = [...pane.root.querySelectorAll<HTMLElement>("th.sortable")]
            .find((th) => th.textContent === "SPLF Name")!;
        nameTh.click();
        rows = pane.root.querySelectorAll("tbody tr");
        expect(pane.selectedFiles().map((f) => f.name)).toEqual(["QSYSPRT"]);
        expect(rows[1].classList.contains("spool-selected")).toBe(true);
        pane.setFiles([FILE_A, FILE_B]);
        expect(pane.selectedFiles()).toEqual([]);
    });
});
