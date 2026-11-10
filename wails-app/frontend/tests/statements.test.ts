import { describe, expect, it } from "vitest";
import { splitStatements, statementAt, statementsFrom, isStopStatement } from "../src/statements";

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

    it("treats // as a line comment and strips it from the text sent to the host", () => {
        const src = "select * from QIWS.QCUSTCDT; // Query test file\nselect 1 from sysibm.sysdummy1";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(2);
        expect(spans[0].text).toBe("select * from QIWS.QCUSTCDT");
        expect(spans[1].text).toBe("select 1 from sysibm.sysdummy1");
    });

    it("// comment on its own line produces no statement", () => {
        const src = "// just a comment\nselect 1 from sysibm.sysdummy1";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(1);
        expect(spans[0].text).toBe("select 1 from sysibm.sysdummy1");
    });

    it("// comment-only input yields nothing", () => {
        expect(splitStatements("// nothing here\n// or here")).toHaveLength(0);
    });

    it("// inside a string literal is NOT a comment", () => {
        const src = "select 'http://x' from sysibm.sysdummy1";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(1);
        expect(spans[0].text).toContain("'http://x'");
    });

    it("statement split across a comment line before its semicolon", () => {
        const src = "select a,b,c from qsysibm.sysdummy1  -- Dummy query\n;\n-- comment line\nselect 2 from sysibm.sysdummy1";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(2);
        expect(spans[0].text).toContain("select a,b,c from qsysibm.sysdummy1");
    });

    it("strips -- comments from the text sent to the host", () => {
        const src = "select * from QIWS.QCUSTCDT; -- Query test file\nselect 1 from sysibm.sysdummy1";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(2);
        expect(spans[0].text).toBe("select * from QIWS.QCUSTCDT");
    });

    it("strips /* */ block comments from the text", () => {
        const src = "select /* inline note */ a, b from qiws.qcustcdt";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(1);
        expect(spans[0].text).toBe("select  a, b from qiws.qcustcdt");
    });

    it("caret-follow: span.start skips leading comment lines to the first code token", () => {
        const src = "select * from aiddata.restocking;  -- get restockings\n  -- test file\nselect * from qiws.qcustcdt;";
        const spans = splitStatements(src);
        expect(spans).toHaveLength(2);
        // second span's start must land on the select, not the "--" lines
        expect(src.slice(spans[1].start)).toMatch(/^select \* from qiws/);
    });
});

describe("isStopStatement", () => {
    it("matches STOP and STOP; case-insensitively", () => {
        expect(isStopStatement("STOP")).toBe(true);
        expect(isStopStatement("stop")).toBe(true);
        expect(isStopStatement("STOP;")).toBe(true);
        expect(isStopStatement("  stop ;  ")).toBe(true);
        expect(isStopStatement("Stop")).toBe(true);
    });

    it("splitStatements yields STOP for both bare forms", () => {
        const src = "SELECT 1 FROM SYSIBM.SYSDUMMY1;\nSTOP;\nSELECT 2 FROM SYSIBM.SYSDUMMY1";
        const texts = splitStatements(src).map((s) => s.text);
        expect(texts).toHaveLength(3);
        expect(isStopStatement(texts[1])).toBe(true);
    });

    it("does not match STOP inside another statement or with extra text", () => {
        expect(isStopStatement("STOPPED")).toBe(false);
        expect(isStopStatement("SELECT 1")).toBe(false);
        expect(isStopStatement("STOP NOW")).toBe(false);
        expect(isStopStatement("")).toBe(false);
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
    it("caret just before the terminating semicolon still runs that statement", () => {
        const gap = splitStatements(src)[0].end; // offset OF the ';'
        expect(statementAt(src, gap)?.text).toBe("SELECT 1 FROM SYSIBM.SYSDUMMY1");
    });
    it("caret just after the terminating semicolon moves FORWARD to the next statement", () => {
        const semi = splitStatements(src)[0].end;
        expect(statementAt(src, semi + 1)?.text).toBe("SELECT 2 FROM SYSIBM.SYSDUMMY1");
    });
    it("caret just after a semicolon on a middle line moves FORWARD", () => {
        const second = splitStatements(src)[1];
        expect(statementAt(src, second.end + 1)?.text).toBe("SELECT 3 FROM SYSIBM.SYSDUMMY1");
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
    it("reported case: cursor just after the semicolon on line 2 moves forward to line 3", () => {
        const buf = "select * from table(sqltools.fd_list('aiddata','restock*'));\nselect * from aiddata.restocking;\nselect * from qiws.qcustcdt;\n";
        const second = splitStatements(buf)[1];
        expect(statementAt(buf, second.end + 1)?.text).toBe("select * from qiws.qcustcdt");
        // ...while a caret ON line 2's semicolon still runs line 2.
        expect(statementAt(buf, second.end)?.text).toBe("select * from aiddata.restocking");
    });
});
