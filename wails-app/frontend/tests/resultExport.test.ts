import { describe, expect, it } from "vitest";
import { formatResultData } from "../src/resultExport";

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
});
