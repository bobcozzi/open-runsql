// Standalone read-only window for a pinned (frozen) result set. The snapshot
// (label + columns + rows) is passed base64-encoded in the ?data= query param
// by App.OpenPinnedWindow, so this window is fully self-contained: no
// connection, cursor, or workspace involvement.
import "./style.css";
import {
    columnHeaderLines,
    columnTooltip,
    formatCellText,
    shouldRightAlign,
    sortValue,
} from "./sqltypes";
import { formatResultData, unescapeDelimiter, type SaveFormat } from "./resultExport";
import type { ColumnInfo } from "./types";

interface PinnedPayload {
    label: string;
    columns: ColumnInfo[];
    rows: unknown[][];
    sql?: string;
}

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

// Match the main window's theme (shared localStorage origin).
(function applyTheme(): void {
    const mode = localStorage.getItem("ibmi-runsql-theme") ?? "system";
    const dark = mode === "dark" ||
        (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();

// Match the main window's results font size.
(function applyFont(): void {
    const px = localStorage.getItem("ibmi-runsql-results-font");
    if (px) document.documentElement.style.setProperty("--results-font-size", `${px}px`);
})();

function decodePayload(): PinnedPayload {
    const raw = new URLSearchParams(window.location.search).get("data") ?? "";
    if (!raw) return { label: "Pinned result", columns: [], rows: [], sql: "" };
    try {
        const json = decodeURIComponent(escape(atob(raw)));
        const p = JSON.parse(json) as PinnedPayload;
        return {
            label: p.label ?? "Pinned result",
            columns: p.columns ?? [],
            rows: p.rows ?? [],
            sql: p.sql ?? "",
        };
    } catch {
        return { label: "Pinned result", columns: [], rows: [], sql: "" };
    }
}

const payload = decodePayload();
let sortCol = -1;
let sortDir: 1 | -1 = 1;

function columnLabel(c: ColumnInfo): string {
    return (c.label || c.name || "").trim() || c.name || "";
}

function render(): void {
    const head = el<HTMLTableSectionElement>("pinned-head");
    const body = el<HTMLTableSectionElement>("pinned-tbody");
    head.innerHTML = "";
    body.innerHTML = "";
    const cols = payload.columns;

    const headRow = document.createElement("tr");
    const rowNumTh = document.createElement("th");
    rowNumTh.className = "row-index";
    rowNumTh.textContent = "ROW";
    headRow.appendChild(rowNumTh);

    cols.forEach((c, idx) => {
        const th = document.createElement("th");
        const text = columnLabel(c);
        const stack = document.createElement("div");
        stack.className = "stacked-header";
        for (const line of columnHeaderLines(text)) {
            const span = document.createElement("span");
            span.textContent = line;
            stack.appendChild(span);
        }
        th.appendChild(stack);
        th.title = columnTooltip(c);
        th.classList.add("sortable");
        if (shouldRightAlign(c)) th.classList.add("num");
        if (sortCol === idx) th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
        th.addEventListener("click", () => {
            if (sortCol === idx) sortDir = sortDir === 1 ? -1 : 1;
            else { sortCol = idx; sortDir = 1; }
            render();
        });
        headRow.appendChild(th);
    });
    head.appendChild(headRow);

    const viewRows = [...payload.rows];
    if (sortCol >= 0) {
        const col = cols[sortCol];
        const dir = sortDir;
        const idx = sortCol;
        viewRows.sort((a, b) => {
            const ka = sortValue(a[idx], col);
            const kb = sortValue(b[idx], col);
            if (ka.kind === "null" && kb.kind === "null") return 0;
            if (ka.kind === "null") return 1;
            if (kb.kind === "null") return -1;
            if (ka.kind === "number" && kb.kind === "number") return (Number(ka.v) - Number(kb.v)) * dir;
            return String(ka.v).localeCompare(String(kb.v)) * dir;
        });
    }

    const frag = document.createDocumentFragment();
    viewRows.forEach((row, i) => {
        const tr = document.createElement("tr");
        const idxTd = document.createElement("td");
        idxTd.className = "row-index";
        idxTd.textContent = String(i + 1);
        tr.appendChild(idxTd);
        cols.forEach((c, ci) => {
            const td = document.createElement("td");
            const { text, isNull } = formatCellText(row[ci], c);
            if (isNull) {
                const span = document.createElement("span");
                span.className = "null-text";
                span.textContent = "NULL";
                td.appendChild(span);
            } else {
                td.textContent = text;
            }
            if (shouldRightAlign(c)) td.classList.add("num");
            tr.appendChild(td);
        });
        frag.appendChild(tr);
    });
    body.appendChild(frag);
}

el<HTMLSpanElement>("pinned-title").textContent = payload.label;
document.title = payload.label;
el<HTMLSpanElement>("pinned-count").textContent =
    `${payload.rows.length} ${payload.rows.length === 1 ? "row" : "rows"}`;

// Show the producing SQL (read-only) + a copy-icon button when we have it.
const sqlBox = el<HTMLTextAreaElement>("pinned-sql");
const btnCopySql = el<HTMLButtonElement>("btn-pinned-copy-sql");
if (payload.sql && payload.sql.trim()) {
    sqlBox.value = payload.sql;
    sqlBox.hidden = false;
    btnCopySql.hidden = false;
    // Auto-size to a few lines without a scrollbar until it gets long.
    sqlBox.rows = Math.min(4, Math.max(1, payload.sql.split("\n").length));
    btnCopySql.addEventListener("click", () => {
        navigator.clipboard.writeText(payload.sql ?? "").then(() => {
            btnCopySql.textContent = "✓";
            setTimeout(() => { btnCopySql.textContent = "⧉"; }, 1200);
        }).catch(() => { sqlBox.select(); document.execCommand("copy"); });
    });
}

// Delimiter override applies to CSV only (TAB/JSON/Markdown have fixed layouts).
const inDelim = el<HTMLInputElement>("in-pinned-delim");
const selFormat = el<HTMLSelectElement>("sel-pinned-format");
function syncDelim(): void {
    const isCsv = selFormat.value === "csv";
    inDelim.hidden = !isCsv;
    if (isCsv && !inDelim.dataset.touched) inDelim.value = ",";
}
selFormat.addEventListener("change", () => { delete inDelim.dataset.touched; syncDelim(); });
inDelim.addEventListener("input", () => { inDelim.dataset.touched = "1"; });
syncDelim();

el<HTMLButtonElement>("btn-pinned-save").addEventListener("click", () => {
    void (async () => {
        const { App } = await import("./types");
        const app = App();
        if (!app || payload.columns.length === 0 || payload.rows.length === 0) return;
        const format = selFormat.value as SaveFormat;
        const delim = (format === "csv" && inDelim.value.length > 0) ? unescapeDelimiter(inDelim.value) : undefined;
        const text = formatResultData(payload.columns, payload.rows, format, delim);
        const base = payload.label.replace(/[^A-Za-z0-9_.-]+/g, "_");
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const label = format.toUpperCase();
        try {
            await app.SaveFileAs(`${base}_${stamp}.${format}`,
                btoa(unescape(encodeURIComponent(text))), label, `*.${format}`);
        } catch { /* canceled or failed: nothing to surface in a static window */ }
    })();
});

render();
