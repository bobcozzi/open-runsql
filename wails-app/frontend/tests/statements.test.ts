import { describe, expect, it } from "vitest";
import { splitStatements, statementAt, statementsFrom } from "../src/statements";

describe("splitStatements", () => {
    it("splits on top-level semicolons", () => {
        const src = "SELECT 1 FROM SYSIBM.SYSDUMMY1;\nSELECT 2 FROM SYSIBM.SYSDUMMY1;";
        expect(splitStatements(src).map((s) => s.text)).toEqual([
            "SELECT 1 FROM SYSIBM.SYSDUMMY1",
            "SELECT 2 FROM SYSIBM.SYSDUMMY1",
        ]);
    });

    it("ignores semicolons inside strings", () => {
        const src = "SELECT 'a;b' FROM SYSIBM.SYSDUMMY1; SELECT 1 FROM SYSIBM.SYSDUMMY1";
        expect(splitStatements(src)).toHaveLength(2);
    });

    it("ignores semicolons in comments", () => {
        const src = "SELECT 1 FROM SYSIBM.SYSDUMMY1 -- comment ; here\n; SELECT 2 FROM SYSIBM.SYSDUMMY1";
        expect(splitStatements(src)).toHaveLength(2);
    });

    it("handles doubled quotes and double-quoted identifiers", () => {
        const src = `SELECT 'it''s;ok' FROM SYSIBM.SYSDUMMY1; SELECT "a;b" FROM SYSIBM.SYSDUMMY1`;
        expect(splitStatements(src)).toHaveLength(2);
    });

    it("no trailing empty statement", () => {
        expect(splitStatements("SELECT 1 FROM SYSIBM.SYSDUMMY1;")).toHaveLength(1);
    });
});

describe("statementAt / statementsFrom", () => {
    const src = "SELECT 1 FROM SYSIBM.SYSDUMMY1;\nSELECT 2 FROM SYSIBM.SYSDUMMY1;\nSELECT 3 FROM SYSIBM.SYSDUMMY1";
    it("finds statement at caret", () => {
        const spans = splitStatements(src);
        const mid2 = spans[1].start + 2;
        expect(statementAt(src, mid2)?.text).toBe("SELECT 2 FROM SYSIBM.SYSDUMMY1");
    });
    it("from caret to end", () => {
        const spans = splitStatements(src);
        const mid1 = spans[0].start + 1;
        expect(statementsFrom(src, mid1)).toHaveLength(3);
        const mid2 = spans[1].start + 1;
        expect(statementsFrom(src, mid2).map((s) => s.text)).toEqual([
            "SELECT 2 FROM SYSIBM.SYSDUMMY1",
            "SELECT 3 FROM SYSIBM.SYSDUMMY1",
        ]);
    });
    it("caret in whitespace between statements finds nothing", () => {
        const gap = splitStatements(src)[0].end; // right after first ';'
        expect(statementAt(src, gap)).toBeUndefined();
    });
    it("caret on the blank row after the last statement still runs it (no semicolon)", () => {
        // "select ...\n<caret>" — Enter pressed, no ';' anywhere (ACS look-back).
        const noSemi = "select * from qiws.qcustcdt\n";
        expect(statementAt(noSemi, noSemi.length)?.text).toBe("select * from qiws.qcustcdt");
    });
    it("caret after a semicolon-terminated statement at end of text still runs it", () => {
        const withSemi = "select * from qiws.qcustcdt;\n";
        expect(statementAt(withSemi, withSemi.length)?.text).toBe("select * from qiws.qcustcdt");
    });
    it("trailing CL command without semicolon is found from the next row", () => {
        const cl = "CL: WRKSYSSTS OUTPUT(*PRINT)\n";
        expect(statementAt(cl, cl.length)?.text).toBe("CL: WRKSYSSTS OUTPUT(*PRINT)");
    });
    it("whitespace fallback does not steal the caret from a following statement", () => {
        const two = "SELECT 1 FROM SYSIBM.SYSDUMMY1;\n\nSELECT 2 FROM SYSIBM.SYSDUMMY1";
        const second = splitStatements(two)[1];
        // caret at start of the second statement -> second statement, not the first
        expect(statementAt(two, second.start)?.text).toBe("SELECT 2 FROM SYSIBM.SYSDUMMY1");
    });
    it("caret on empty text matches nothing", () => {
        expect(statementAt("", 0)).toBeUndefined();
        expect(statementAt("   \n  ", 3)).toBeUndefined();
    });
});
