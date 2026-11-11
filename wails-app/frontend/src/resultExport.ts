// Save the Results grid to a file: CSV / TSV / JSON / Markdown.
// Pure client-side formatting; Go's SaveSpooledFile handles the write to the
// configured download folder.

export interface ResultColumn {
    name: string;
    label: string;
}

export type TextSaveFormat = "csv" | "tsv" | "json" | "md";
export type SaveFormat = TextSaveFormat | "xlsx";

/** Interpret common backslash escapes in a delimiter box value: \t tab,
 * \n newline, \r carriage return, \\ backslash, \s space, \| pipe, \; and \:
 * (harmless for chars that need no escaping). Everything else passes through
 * literally, so a raw ";" or "|" works unchanged. */
export function unescapeDelimiter(raw: string): string {
    return raw.replace(/\\(.)/g, (_, ch: string) => {
        switch (ch) {
            case "t": return "\t";
            case "n": return "\n";
            case "r": return "\r";
            case "s": return " ";
            case "\\": return "\\";
            case "|": return "|";
            case ";": return ";";
            case ":": return ":";
            case ",": return ",";
            default: return ch; // "\x" -> "x"
        }
    });
}

export const SAVE_FORMATS: { id: SaveFormat; label: string; ext: string }[] = [
    { id: "csv", label: "CSV (comma-separated)", ext: "csv" },
    { id: "tsv", label: "TSV (tab-separated)", ext: "tsv" },
    { id: "json", label: "JSON", ext: "json" },
    { id: "md", label: "Markdown table", ext: "md" },
    { id: "xlsx", label: "XLSX", ext: "xlsx" },
];

const SAVE_FORMAT_STORAGE_KEY = "ibmi-runsql-save-format";

export function loadPreferredSaveFormat(): SaveFormat | undefined {
    try {
        const value = localStorage.getItem(SAVE_FORMAT_STORAGE_KEY);
        return SAVE_FORMATS.some((format) => format.id === value) ? value as SaveFormat : undefined;
    } catch {
        return undefined;
    }
}

export function persistPreferredSaveFormat(format: string): void {
    if (!SAVE_FORMATS.some((entry) => entry.id === format)) return;
    try {
        localStorage.setItem(SAVE_FORMAT_STORAGE_KEY, format);
    } catch {
        // Storage may be unavailable in restricted webview contexts.
    }
}

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

export function formatResultData(cols: ResultColumn[], rows: unknown[][], format: TextSaveFormat, delimOverride?: string): string {
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
    // Delimited text (csv/tsv): an explicit delimiter override wins (single or
    // multi-char); else the format default. delimitField quotes against this
    // same delimiter, so any separator (pipe, semicolon, ...) round-trips.
    const delim = (delimOverride && delimOverride.length > 0) ? delimOverride
        : format === "tsv" ? "\t" : ",";
    const lines = [heads.map((h) => delimitField(h, delim)).join(delim)];
    for (const r of rows) {
        lines.push(r.map((v) => delimitField(cellText(v), delim)).join(delim));
    }
    return lines.join("\n") + "\n";
}
