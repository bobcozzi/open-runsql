// Save the Results grid to a file: CSV / TSV / JSON / Markdown.
// Pure client-side formatting; Go's SaveSpooledFile handles the write to the
// configured download folder.

export interface ResultColumn {
    name: string;
    label: string;
}

export type SaveFormat = "csv" | "tsv" | "json" | "md";

export const SAVE_FORMATS: { id: SaveFormat; label: string; ext: string }[] = [
    { id: "csv", label: "CSV (comma-separated)", ext: "csv" },
    { id: "tsv", label: "TSV (tab-separated)", ext: "tsv" },
    { id: "json", label: "JSON", ext: "json" },
    { id: "md", label: "Markdown table", ext: "md" },
];

function cellText(v: unknown): string {
    if (v === null || v === undefined) return "";
    return String(v);
}

/** RFC-4180 CSV field: quote when the value contains the delimiter, a quote,
 * or a newline; double internal quotes. */
function delimitField(s: string, delim: string): string {
    if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function heading(c: ResultColumn): string {
    // Stacked headings arrive as "line1\nline2"; join them for export.
    return (c.label || c.name).replace(/\n+/g, " ").trim();
}

export function formatResultData(cols: ResultColumn[], rows: unknown[][], format: SaveFormat): string {
    const heads = cols.map(heading);
    if (format === "json") {
        const out = rows.map((r) => {
            const obj: Record<string, unknown> = {};
            cols.forEach((c, i) => { obj[heading(c)] = r[i]; });
            return obj;
        });
        return JSON.stringify(out, null, 2) + "\n";
    }
    if (format === "md") {
        const esc = (s: string) => s.replace(/\|/g, "\\|");
        const lines = [
            `| ${heads.map(esc).join(" | ")} |`,
            `| ${heads.map(() => "---").join(" | ")} |`,
            ...rows.map((r) => `| ${r.map((v) => esc(cellText(v))).join(" | ")} |`),
        ];
        return lines.join("\n") + "\n";
    }
    const delim = format === "tsv" ? "\t" : ",";
    const lines = [heads.map((h) => delimitField(h, delim)).join(delim)];
    for (const r of rows) {
        lines.push(r.map((v) => delimitField(cellText(v), delim)).join(delim));
    }
    return lines.join("\n") + "\n";
}
