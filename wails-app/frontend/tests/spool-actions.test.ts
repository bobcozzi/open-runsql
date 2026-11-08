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

describe("spool row context menu", () => {
    it("right-click selects the row and reports file + coords", () => {
        const onRowContext = vi.fn();
        const pane = createSpoolPane({ onRefresh: () => { }, onRowContext });
        pane.setFiles([FILE_A, FILE_B]);
        const rows = pane.root.querySelectorAll("tbody tr");
        rows[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }));
        expect(onRowContext).toHaveBeenCalledWith(expect.objectContaining({ name: "QSYSPRT" }), 40, 50);
        expect(rows[1].classList.contains("spool-selected")).toBe(true);
        // Selecting another row moves the selection.
        rows[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
        expect(rows[0].classList.contains("spool-selected")).toBe(true);
        expect(rows[1].classList.contains("spool-selected")).toBe(false);
    });
});
