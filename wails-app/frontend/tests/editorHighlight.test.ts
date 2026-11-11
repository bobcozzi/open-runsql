import { describe, expect, it } from "vitest";
import { editorHighlightRanges } from "../src/editorHighlight";

function highlights(source: string) {
    return editorHighlightRanges(source).map((range) => [range.kind, source.slice(range.start, range.end)]);
}

describe("editor highlighting", () => {
    it("highlights real STOP statements and comments without matching quoted text", () => {
        const source = "-- note STOP\nSELECT 'STOP -- not a comment', \"//name\";\n stop; // tail\nSELECT STOP FROM T;\n/* block */ STOP";
        expect(highlights(source)).toEqual([
            ["comment", "-- note STOP"], ["stop", "stop"], ["comment", "// tail"],
            ["comment", "/* block */"], ["stop", "STOP"],
        ]);
    });

    it("handles escaped quotes, incomplete comments and comment-only input", () => {
        expect(highlights("SELECT 'it''s // text', \"a\"\"--b\"; -- yes\r\n/* unfinished"))
            .toEqual([["comment", "-- yes"], ["comment", "/* unfinished"]]);
        expect(highlights("// STOP\n-- STOP")).toEqual([["comment", "// STOP"], ["comment", "-- STOP"]]);
    });

    it("does not treat quoted STOP or an identifier as the STOP operation", () => {
        expect(highlights("'STOP'; SELECT STOP; STOPPED; STOP;")) .toEqual([["cl-command", "STOPPED"], ["stop", "STOP"]]);
    });

    it("highlights explicit and implicit CL commands and their parameters", () => {
        const source = "CL: ADDLIBLE LIB(SQLTOOLS);\nQSYS/DSPLIB LIB(*LIBL) OUTPUT(*PRINT);";
        expect(highlights(source)).toEqual([
            ["cl-command", "CL:"], ["cl-command", "ADDLIBLE"], ["cl-keyword", "LIB"], ["cl-value", "SQLTOOLS"],
            ["cl-command", "QSYS/DSPLIB"], ["cl-keyword", "LIB"], ["cl-value", "*LIBL"],
            ["cl-keyword", "OUTPUT"], ["cl-value", "*PRINT"],
        ]);
    });

    it("keeps SQL, comments, escaped strings, and nested CL values distinct", () => {
        const source = "SELECT 'CL: TEST(X)' FROM T;\n-- CL: ignored\nCL: CMD PARM('it''s // fine' (*YES &VAR)) /* note */ OTHER(123);\nSQL: VALUES 1;";
        expect(highlights(source)).toEqual([
            ["comment", "-- CL: ignored"], ["cl-command", "CL:"], ["cl-command", "CMD"],
            ["cl-keyword", "PARM"], ["cl-value", "'it''s // fine'"], ["cl-value", "*YES"], ["cl-value", "&VAR"],
            ["comment", "/* note */"], ["cl-keyword", "OTHER"], ["cl-value", "123"],
        ]);
    });
});

