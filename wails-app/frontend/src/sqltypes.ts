// SQL type classification and cell formatting for IBM i result sets.
// Ported from cozzi-cl-prompter src/sqlResultPanel.ts (profileColumn,
// isNumericMetadataType, isExactNumericType, formatTooltipType, formatCell).

import type { ColumnInfo } from "./types";

export const JDBC = {
    BIT: -7,
    TINYINT: -6,
    SMALLINT: 5,
    INTEGER: 4,
    BIGINT: -5,
    FLOAT: 6,
    REAL: 7,
    DOUBLE: 8,
    NUMERIC: 2,
    DECIMAL: 3,
    CHAR: 1,
    VARCHAR: 12,
    LONGVARCHAR: -1,
    DATE: 91,
    TIME: 92,
    TIMESTAMP: 93,
    TIME_WITH_TIMEZONE: 2013,
    TIMESTAMP_WITH_TIMEZONE: 2014,
    BINARY: -2,
    VARBINARY: -3,
    LONGVARBINARY: -4,
    BOOLEAN: 16,
    NCHAR: -15,
    NVARCHAR: -9,
    LONGNVARCHAR: -16,
    CLOB: 2005,
    NCLOB: 2011,
    BLOB: 2004,
    DATALINK: 70,
    XML: 2009,
    ROWID: -8,
    OTHER: 1111,
} as const;

export type ColumnKind = "number" | "date" | "time" | "timestamp" | "text";

const NUMERIC_BASES = new Set([
    "SMALLINT", "INTEGER", "INT", "BIGINT", "DEC", "DECIMAL", "NUM", "NUMERIC",
    "DECFLOAT", "REAL", "DOUBLE", "DOUBLE PRECISION", "FLOAT",
]);

const EXACT_BASES = new Set(["DECIMAL", "NUMERIC", "DEC", "NUM"]);
const INTEGER_BASES = new Set(["SMALLINT", "INTEGER", "INT", "BIGINT"]);
const DECIMAL_BASES = new Set(["NUMERIC", "DECIMAL", "DEC", "DECFLOAT", "NUM"]);
const CHAR_LIKE_BASES = new Set([
    "CHAR", "CHARACTER", "VARCHAR", "CLOB", "DBCLOB", "GRAPHIC", "VARGRAPHIC",
    "BINARY", "VARBINARY", "NCHAR", "NVARCHAR",
]);

const NUMERIC_CODES = new Set([-6, -5, 5, 4, 2, 3, 6, 7, 8]);
const EXACT_CODES = new Set([2, 3]);

export function typeBase(typeName: string | undefined): string {
    return String(typeName ?? "")
        .trim()
        .toUpperCase()
        .replace(/\(.*\)$/, "")
        .replace(/\s+/g, " ");
}

export function isNumericColumn(column: ColumnInfo | undefined): boolean {
    if (!column) return false;
    const base = typeBase(column.typeName);
    if (NUMERIC_BASES.has(base)) return true;
    return NUMERIC_CODES.has(Number(column.type));
}

export function isExactNumericColumn(column: ColumnInfo | undefined): boolean {
    if (!column) return false;
    const base = typeBase(column.typeName);
    if (EXACT_BASES.has(base)) return true;
    return EXACT_CODES.has(Number(column.type));
}

function isFixedCharacterColumn(column: ColumnInfo): boolean {
    const base = typeBase(column.typeName);
    return base === "CHAR" || base === "CHARACTER" || base === "NCHAR" || base === "GRAPHIC"
        || Number(column.type) === JDBC.CHAR || Number(column.type) === JDBC.NCHAR;
}

export function columnKind(column: ColumnInfo | undefined): ColumnKind {
    const base = typeBase(column?.typeName);
    if (base === "DATE") return "date";
    if (base === "TIME") return "time";
    if (base.startsWith("TIMESTAMP") || base === "TIMESTMP") return "timestamp";
    if (isNumericColumn(column)) return "number";
    return "text";
}

export function shouldRightAlign(column: ColumnInfo | undefined): boolean {
    const kind = columnKind(column);
    return kind === "number" || kind === "date" || kind === "time" || kind === "timestamp";
}

// Port of sqlResultPanel.ts formatTooltipType().
export function formatTooltipType(column: ColumnInfo | undefined): string {
    const typeName = String(column?.typeName ?? "").trim() || "UNKNOWN";
    const base = typeBase(typeName);
    const precision = Number(column?.precision);
    const displaySize = Number(column?.displaySize);
    const scale = Number(column?.scale);
    const size = precision > 0 ? precision : displaySize > 0 ? displaySize : undefined;

    if (size) {
        if (INTEGER_BASES.has(base)) return typeName;
        if (DECIMAL_BASES.has(base)) {
            if (Number.isInteger(scale) && scale >= 0) {
                if (base === "NUMERIC" || base === "NUM") return `Zoned(${size}, ${scale})`;
                if (base === "DECIMAL" || base === "DEC") return `Dec(${size}, ${scale})`;
                return `${typeName}(${size}, ${scale})`;
            }
            if (base === "NUMERIC" || base === "NUM") return `Zoned(${size})`;
            if (base === "DECIMAL" || base === "DEC") return `Dec(${size})`;
            return `${typeName}(${size})`;
        }
        if (CHAR_LIKE_BASES.has(base)) return `${typeName}(${size})`;
    }
    return typeName;
}

export function columnTooltip(column: ColumnInfo): string {
    const lines: string[] = [];
    // COLHDG text is fixed-width: compress runs of blanks between heading words.
    const label = String(column?.label ?? "").replace(/\s+/g, " ").trim();
    const name = String(column?.name ?? "").trim();
    if (label && label !== name) lines.push(`Heading: ${label}`);
    lines.push(`Column: ${name || "(unnamed)"}`);
    lines.push(`Type: ${formatTooltipType(column)}`);
    if (column?.autoIncrement) lines.push("Identity: Yes");
    if (column?.tableName) {
        lines.push(`Table: ${column.schemaName ? column.schemaName + "/" : ""}${column.tableName}`);
    }
    return lines.join("\n");
}

// Port of sqlResultPanel.ts renderColumnHeaderHtml(): heading split into up to
// 3 stacked word-lines (e.g. "Ordinal Position" -> "Ordinal" / "Position").
export function columnHeaderLines(displayText: string): string[] {
    const lines = displayText
        .replace(/\r?\n/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3);
    return lines.length > 0 ? lines : [displayText];
}

export interface CellText {
    text: string;
    isNull: boolean;
}

// Port of sqlResultPanel.ts formatCell() (text form).
export function formatCellText(value: unknown, column: ColumnInfo | undefined): CellText {
    if (value === null || value === undefined) return { text: "NULL", isNull: true };
    if (typeof value === "string" && column && isExactNumericColumn(column)) {
        const scale = Number(column.scale);
        if (Number.isInteger(scale) && scale >= 0) {
            return { text: normalizeNumericTextToScale(value, scale), isNull: false };
        }
        return { text: value, isNull: false };
    }
    if (typeof value === "string" && column && isFixedCharacterColumn(column)) {
        return { text: value.replace(/ +$/, ""), isNull: false };
    }
    if (typeof value === "number") {
        return { text: String(value), isNull: false };
    }
    if (typeof value === "boolean") return { text: value ? "true" : "false", isNull: false };
    if (Array.isArray(value) || typeof value === "object") {
        try {
            return { text: JSON.stringify(value), isNull: false };
        } catch {
            return { text: String(value), isNull: false };
        }
    }
    return { text: String(value), isNull: false };
}

function normalizeNumericTextToScale(value: string, scale: number): string {
    const trimmed = String(value).trim();
    const match = trimmed.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match) return value;
    const sign = match[1] || "";
    const integerPart = match[2] || "0";
    const fractionPart = match[3] || "";
    if (scale <= 0) return `${sign}${integerPart}`;
    if (fractionPart.length >= scale) return `${sign}${integerPart}.${fractionPart}`;
    return `${sign}${integerPart}.${fractionPart.padEnd(scale, "0")}`;
}

export interface SortKey {
    kind: "number" | "text" | "null";
    v: number | string;
}

// Sort keys mirroring buildSortKeys(): big integers and out-of-range numbers
// fall back to text sorting to avoid precision loss.
export function sortValue(value: unknown, column: ColumnInfo | undefined): SortKey {
    if (value === null || value === undefined) return { kind: "null", v: "" };
    const kind = columnKind(column);
    if (kind === "number") {
        if (typeof value === "number") {
            if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
                return { kind: "text", v: String(value) };
            }
            return { kind: "number", v: value };
        }
        const text = String(value).trim();
        if (/^[-+]?\d+$/.test(text) && text.length > 15) {
            return { kind: "text", v: text }; // bigint as text
        }
        if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) {
            return { kind: "number", v: Number(text) };
        }
        return { kind: "text", v: String(value) };
    }
    if (kind === "timestamp" || kind === "date") {
        const parsed = Date.parse(String(value));
        if (Number.isFinite(parsed)) return { kind: "number", v: parsed };
    }
    if (kind === "time") {
        const m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/);
        if (m) {
            const h = Number(m[1]);
            const min = Number(m[2]);
            const s = Number(m[3] || "0");
            const frac = String(m[4] || "").padEnd(6, "0").slice(0, 6);
            return { kind: "number", v: ((h * 60 + min) * 60 + s) * 1e6 + Number(frac || "0") };
        }
    }
    return { kind: "text", v: String(value) };
}
