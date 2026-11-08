import { describe, expect, it } from "vitest";
import {
    buildSpooledFileRequest,
    compareSpooledFiles,
    createSpoolPane,
    DEFAULT_SPOOL_FILTERS,
    spoolCellText,
    spoolEmptyText,
} from "../src/spool";
import type { SpooledFileInfo } from "../src/types";

function mkFile(over: Partial<SpooledFileInfo> = {}): SpooledFileInfo {
    return {
        name: "QPRINT",
        number: "1",
        jobName: "QPADEV0001",
        jobUser: "COZZI",
        jobNumber: "123456",
        userData: "",
        outqName: "QPRINT",
        outqLib: "QGPL",
        createDate: "2026-11-07",
        createTime: "10:30:00",
        pages: 1,
        size: 4096,
        status: "*READY",
        holdStatus: "*NO",
        ...over,
    };
}

describe("buildSpooledFileRequest", () => {
    it("defaults: blank user -> current user, no queue filter", () => {
        const req = buildSpooledFileRequest("conn-1", { ...DEFAULT_SPOOL_FILTERS });
        expect(req).toEqual({
            connectionId: "conn-1",
            user: "",
            allUsers: false,
            outqLib: "",
            outq: "",
            allOutqs: false,
        });
    });

    it("trims text inputs", () => {
        const req = buildSpooledFileRequest("c", {
            user: "  cozzi ", allUsers: false, outqLib: " qgpl ", outq: " qprint ", allOutqs: false,
        });
        expect(req.user).toBe("cozzi");
        expect(req.outqLib).toBe("qgpl");
        expect(req.outq).toBe("qprint");
    });

    it("All users wins over and blanks the user input", () => {
        const req = buildSpooledFileRequest("c", {
            user: "cozzi", allUsers: true, outqLib: "", outq: "", allOutqs: false,
        });
        expect(req.user).toBe("");
        expect(req.allUsers).toBe(true);
    });

    it("All output queues blanks outq lib/name", () => {
        const req = buildSpooledFileRequest("c", {
            user: "", allUsers: false, outqLib: "QGPL", outq: "QPRINT", allOutqs: true,
        });
        expect(req.outqLib).toBe("");
        expect(req.outq).toBe("");
        expect(req.allOutqs).toBe(true);
    });

    it("All users + All output queues combine", () => {
        const req = buildSpooledFileRequest("c", {
            user: "cozzi", allUsers: true, outqLib: "QGPL", outq: "QPRINT", allOutqs: true,
        });
        expect(req).toMatchObject({ user: "", allUsers: true, outqLib: "", outq: "", allOutqs: true });
    });

    it("blank outq library stays blank (bridge maps it to *LIBL)", () => {
        const req = buildSpooledFileRequest("c", {
            user: "", allUsers: false, outqLib: "", outq: "QPRINT", allOutqs: false,
        });
        expect(req.outqLib).toBe("");
        expect(req.outq).toBe("QPRINT");
    });
});

describe("spoolCellText", () => {
    it("composes outq as LIB/NAME", () => {
        expect(spoolCellText(mkFile({ outqLib: "QGPL", outqName: "QPRINT" }), "outq")).toBe("QGPL/QPRINT");
    });

    it("outq is empty when both parts are empty", () => {
        expect(spoolCellText(mkFile({ outqLib: "", outqName: "" }), "outq")).toBe("");
    });

    it("combines ISO date + time for Created", () => {
        expect(spoolCellText(mkFile({ createDate: "2026-11-07", createTime: "10:30:00" }), "created"))
            .toBe("2026-11-07 10:30:00");
        expect(spoolCellText(mkFile({ createDate: "", createTime: "" }), "created")).toBe("");
    });

    it("pages/size render as plain numbers", () => {
        expect(spoolCellText(mkFile({ pages: 42 }), "pages")).toBe("42");
        expect(spoolCellText(mkFile({ size: 12345 }), "size")).toBe("12345");
    });
});

describe("compareSpooledFiles", () => {
    it("sorts pages numerically, not lexically", () => {
        const two = mkFile({ pages: 2 });
        const ten = mkFile({ pages: 10 });
        // Numeric: 2 < 10 (lexical "10" < "2" would flip this).
        expect(compareSpooledFiles(two, ten, "pages", 1)).toBeLessThan(0);
        expect(compareSpooledFiles(two, ten, "pages", -1)).toBeGreaterThan(0);
    });

    it("sorts spooled-file number numerically", () => {
        const two = mkFile({ number: "2" });
        const ten = mkFile({ number: "10" });
        expect(compareSpooledFiles(two, ten, "number", 1)).toBeLessThan(0);
    });

    it("sorts name alphabetically with dir flip", () => {
        const a = mkFile({ name: "ABC" });
        const b = mkFile({ name: "XYZ" });
        expect(compareSpooledFiles(a, b, "name", 1)).toBeLessThan(0);
        expect(compareSpooledFiles(a, b, "name", -1)).toBeGreaterThan(0);
    });

    it("sorts created as ISO text", () => {
        const older = mkFile({ createDate: "2026-01-01", createTime: "00:00:01" });
        const newer = mkFile({ createDate: "2026-11-07", createTime: "10:30:00" });
        expect(compareSpooledFiles(older, newer, "created", 1)).toBeLessThan(0);
    });

    it("sorts outq by LIB/NAME composite", () => {
        const a = mkFile({ outqLib: "QGPL", outqName: "QPRINT" });
        const b = mkFile({ outqLib: "ZLIB", outqName: "QPRINT" });
        expect(compareSpooledFiles(a, b, "outq", 1)).toBeLessThan(0);
    });

    it("empty values sort last in both directions", () => {
        const filled = mkFile({ userData: "DATA" });
        const blank = mkFile({ userData: "" });
        expect(compareSpooledFiles(blank, filled, "userData", 1)).toBeGreaterThan(0);
        expect(compareSpooledFiles(blank, filled, "userData", -1)).toBeGreaterThan(0);
        expect(compareSpooledFiles(blank, mkFile({ userData: "" }), "userData", 1)).toBe(0);
    });
});

describe("createSpoolPane (DOM)", () => {
    it("shows the empty-state text when there are no files", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        document.body.appendChild(pane.root);
        const empty = pane.root.querySelector<HTMLElement>(".spool-empty")!;
        expect(empty.hidden).toBe(false);
        expect(empty.textContent).toBe(spoolEmptyText());
        pane.root.remove();
    });

    it("renders rows with numbering and hides the empty state", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        document.body.appendChild(pane.root);
        pane.setFiles([mkFile({ name: "A" }), mkFile({ name: "B" })]);
        const rows = pane.root.querySelectorAll(".spool-body tr");
        expect(rows.length).toBe(2);
        expect(rows[0].querySelector(".row-index")!.textContent).toBe("1");
        expect(rows[1].querySelector(".row-index")!.textContent).toBe("2");
        expect(pane.root.querySelector<HTMLElement>(".spool-empty")!.hidden).toBe(true);
        pane.root.remove();
    });

    it("clicking a sortable header sorts; clicking again reverses", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        document.body.appendChild(pane.root);
        pane.setFiles([mkFile({ name: "B" }), mkFile({ name: "A" }), mkFile({ name: "C" })]);
        const nameTh = [...pane.root.querySelectorAll<HTMLElement>("th.sortable")]
            .find((th) => th.textContent === "Name")!;
        nameTh.click();
        let names = [...pane.root.querySelectorAll(".spool-body tr")]
            .map((tr) => tr.children[1].textContent);
        expect(names).toEqual(["A", "B", "C"]);
        nameTh.click();
        names = [...pane.root.querySelectorAll(".spool-body tr")]
            .map((tr) => tr.children[1].textContent);
        expect(names).toEqual(["C", "B", "A"]);
        pane.root.remove();
    });

    it("Refresh button passes current filters to onRefresh", () => {
        let got: unknown;
        const pane = createSpoolPane({ onRefresh: (f) => { got = f; } });
        document.body.appendChild(pane.root);
        pane.root.querySelector<HTMLInputElement>(".spool-user")!.value = "cozzi";
        pane.root.querySelector<HTMLButtonElement>(".spool-refresh")!.click();
        expect(got).toMatchObject({ user: "cozzi", allUsers: false });
        pane.root.remove();
    });

    it("All users checkbox disables the user input", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        document.body.appendChild(pane.root);
        const user = pane.root.querySelector<HTMLInputElement>(".spool-user")!;
        const all = pane.root.querySelector<HTMLInputElement>(".spool-all-users")!;
        expect(user.disabled).toBe(false);
        all.click();
        expect(user.disabled).toBe(true);
        all.click();
        expect(user.disabled).toBe(false);
        pane.root.remove();
    });

    it("Clear resets filters and empties the table", () => {
        const pane = createSpoolPane({ onRefresh: () => { } });
        document.body.appendChild(pane.root);
        pane.root.querySelector<HTMLInputElement>(".spool-user")!.value = "cozzi";
        pane.setFiles([mkFile()]);
        pane.root.querySelector<HTMLButtonElement>(".spool-clear")!.click();
        expect(pane.root.querySelector<HTMLInputElement>(".spool-user")!.value).toBe("");
        expect(pane.filters()).toEqual(DEFAULT_SPOOL_FILTERS);
        expect(pane.root.querySelectorAll(".spool-body tr").length).toBe(0);
        expect(pane.root.querySelector<HTMLElement>(".spool-empty")!.hidden).toBe(false);
        pane.root.remove();
    });

    it("double-click on a row fires onRowOpen (stage 2 hook)", () => {
        let opened: SpooledFileInfo | undefined;
        const pane = createSpoolPane({ onRefresh: () => { }, onRowOpen: (f) => { opened = f; } });
        document.body.appendChild(pane.root);
        pane.setFiles([mkFile({ name: "QSYSPRT" })]);
        const row = pane.root.querySelector<HTMLElement>(".spool-body tr")!;
        row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(opened?.name).toBe("QSYSPRT");
        pane.root.remove();
    });
});
