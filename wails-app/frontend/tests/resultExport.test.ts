import { describe, expect, it } from "vitest";
import {
    formatResultData,
    loadPreferredSaveFormat,
    persistPreferredSaveFormat,
    unescapeDelimiter,
} from "../src/resultExport";

const COLS = [
    { name: "ID", label: "ID" },
    { name: "NAME", label: "Customer\nName" }, // stacked heading
    { name: "NOTE", label: "NOTE" },
];
const ROWS: unknown[][] = [
    [1, "Acme", "plain"],
    [2, "A, B Co", 'has "quotes"'],
    [3, null, "line\nbreak"],
];

describe("formatResultData", () => {
    it("CSV quotes delimiters/quotes/newlines, joins stacked headings", () => {
        const out = formatResultData(COLS, ROWS, "csv");
        expect(out).toBe(
            'ID,Customer Name,NOTE\n' +
            '1,Acme,plain\n' +
            '2,"A, B Co","has ""quotes"""\n' +
            '3,,"line\nbreak"\n');
    });

    it("TSV uses tabs and quotes only tabs/quotes/newlines (not commas)", () => {
        const out = formatResultData(COLS, ROWS, "tsv");
        expect(out.split("\n")[0]).toBe("ID\tCustomer Name\tNOTE");
        // Comma in data stays unquoted under tab delimiting.
        expect(out).toContain('2\tA, B Co\t"has ""quotes"""');
    });

    it("JSON emits an array of row objects keyed by heading", () => {
        const out = JSON.parse(formatResultData(COLS, ROWS, "json"));
        expect(out).toHaveLength(3);
        expect(out[0]["Customer Name"]).toBe("Acme");
        expect(out[1].NOTE).toBe('has "quotes"');
        expect(out[2]["Customer Name"]).toBeNull();
    });

    it("Markdown escapes pipes and adds a separator row", () => {
        const out = formatResultData(
            [{ name: "A", label: "A" }], [["x|y"]], "md");
        expect(out).toBe("| A |\n| --- |\n| x\\|y |\n");
    });

    it("Custom delimiter override: pipe delimits and quotes against the pipe", () => {
        const out = formatResultData(
            [{ name: "A", label: "A" }, { name: "B", label: "B" }],
            [["x|y", "plain"]], "csv", "|");
        // Pipe in data is quoted; comma no longer special.
        expect(out).toBe('A|B\n"x|y"|plain\n');
    });

    it("Custom delimiter: semicolon and multi-char work; empty override ignored", () => {
        const semi = formatResultData([{ name: "A", label: "A" }, { name: "B", label: "B" }], [["1", "2"]], "csv", ";");
        expect(semi).toBe("A;B\n1;2\n");
        // Multi-char separator is allowed (rare but supported).
        const multi = formatResultData([{ name: "A", label: "A" }, { name: "B", label: "B" }], [["1", "2"]], "csv", "||");
        expect(multi).toBe("A||B\n1||2\n");
        // Empty override falls back to the format default.
        const empty = formatResultData([{ name: "A", label: "A" }, { name: "B", label: "B" }], [["1", "2"]], "tsv", "");
        expect(empty).toBe("A\tB\n1\t2\n");
    });

    it("unescapeDelimiter interprets backslash escapes", () => {
        expect(unescapeDelimiter("\\t")).toBe("\t");
        expect(unescapeDelimiter("\\n")).toBe("\n");
        expect(unescapeDelimiter("\\r")).toBe("\r");
        expect(unescapeDelimiter("\\s")).toBe(" ");
        expect(unescapeDelimiter("\\\\")).toBe("\\");
        expect(unescapeDelimiter("\\|")).toBe("|");
        expect(unescapeDelimiter("|")).toBe("|"); // raw passes through
        expect(unescapeDelimiter(";")).toBe(";");
        expect(unescapeDelimiter("||")).toBe("||"); // multi-char preserved
    });

    it("CSV honors an escaped tab delimiter typed into the box", () => {
        const out = formatResultData([{ name: "A", label: "A" }, { name: "B", label: "B" }], [["1", "2"]], "csv", unescapeDelimiter("\\t"));
        expect(out).toBe("A\tB\n1\t2\n");
    });
});

describe("preferred Save As format", () => {
    it("persists and restores a supported format", () => {
        localStorage.clear();
        expect(loadPreferredSaveFormat()).toBeUndefined();
        persistPreferredSaveFormat("xlsx");
        expect(loadPreferredSaveFormat()).toBe("xlsx");
    });

    it("ignores unsupported stored or requested formats", () => {
        localStorage.clear();
        persistPreferredSaveFormat("unknown");
        expect(localStorage.getItem("ibmi-runsql-save-format")).toBeNull();
        localStorage.setItem("ibmi-runsql-save-format", "unknown");
        expect(loadPreferredSaveFormat()).toBeUndefined();
    });
});
