// Spooled Files pane (stage 1: list + filter + client-side sort).
// The pane is a static work-pane (data-pane="spool") built by JS so the DOM
// pieces are jsdom-testable; main.ts wires it to App().ListSpooledFiles.
// Later stages (viewer/download/hold/move/delete) plug into onRowOpen and the
// placeholder Actions column — intentionally not stubbed further here.

import { t } from "./l10n";
import type { SpooledFileInfo, SpooledFileRequest } from "./types";

export interface SpoolFilters {
    user: string;
    allUsers: boolean;
    outqLib: string;
    outq: string;
    allOutqs: boolean;
}

export const DEFAULT_SPOOL_FILTERS: SpoolFilters = {
    user: "",
    allUsers: false,
    outqLib: "",
    outq: "",
    allOutqs: false,
};

/** Build the bridge request from the filter row. "All" checkboxes win over
 * and blank their corresponding text inputs. */
export function buildSpooledFileRequest(connectionId: string, f: SpoolFilters): SpooledFileRequest {
    return {
        connectionId,
        user: f.allUsers ? "" : f.user.trim(),
        allUsers: f.allUsers,
        outqLib: f.allOutqs ? "" : f.outqLib.trim(),
        outq: f.allOutqs ? "" : f.outq.trim(),
        allOutqs: f.allOutqs,
    };
}

export type SpoolSortKey =
    | "name" | "number" | "jobName" | "jobUser" | "jobNumber" | "userData"
    | "outq" | "created" | "pages" | "size" | "status" | "holdStatus";

interface SpoolColumn {
    key: SpoolSortKey;
    labelKey: string;
    fallback: string;
    numeric?: boolean;
}

export const SPOOL_COLUMNS: SpoolColumn[] = [
    { key: "name", labelKey: "spool.col.name", fallback: "Name" },
    { key: "number", labelKey: "spool.col.number", fallback: "Number", numeric: true },
    { key: "jobName", labelKey: "spool.col.jobName", fallback: "Job" },
    { key: "jobUser", labelKey: "spool.col.jobUser", fallback: "User" },
    { key: "jobNumber", labelKey: "spool.col.jobNumber", fallback: "Job#", numeric: true },
    { key: "userData", labelKey: "spool.col.userData", fallback: "User Data" },
    { key: "outq", labelKey: "spool.col.outq", fallback: "Output Queue" },
    { key: "created", labelKey: "spool.col.created", fallback: "Created" },
    { key: "pages", labelKey: "spool.col.pages", fallback: "Pages", numeric: true },
    { key: "size", labelKey: "spool.col.size", fallback: "Size", numeric: true },
    { key: "status", labelKey: "spool.col.status", fallback: "Status" },
    { key: "holdStatus", labelKey: "spool.col.holdStatus", fallback: "Hold" },
];

const NUMERIC_KEYS = new Set<SpoolSortKey>(
    SPOOL_COLUMNS.filter((c) => c.numeric).map((c) => c.key),
);

/** Display text for a cell. Composite columns: outq = LIB/NAME, created =
 * date + time (already ISO from the bridge). */
export function spoolCellText(f: SpooledFileInfo, key: SpoolSortKey): string {
    switch (key) {
        case "outq":
            return f.outqLib || f.outqName ? `${f.outqLib}/${f.outqName}` : "";
        case "created":
            return `${f.createDate} ${f.createTime}`.trim();
        case "pages":
            return String(f.pages);
        case "size":
            return String(f.size);
        default:
            return f[key];
    }
}

/** Sort comparator. Numeric columns compare as numbers when both sides parse;
 * empty values always sort last (mirrors the results grid's NULL-last). */
export function compareSpooledFiles(a: SpooledFileInfo, b: SpooledFileInfo, key: SpoolSortKey, dir: 1 | -1): number {
    const ta = spoolCellText(a, key);
    const tb = spoolCellText(b, key);
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    if (NUMERIC_KEYS.has(key)) {
        const na = Number(ta);
        const nb = Number(tb);
        if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * dir;
    }
    return ta.localeCompare(tb) * dir;
}

export function spoolEmptyText(): string {
    return t("spool.empty", "No spooled files match the current filters.");
}

export interface SpoolPaneOptions {
    onRefresh: (filters: SpoolFilters) => void;
    /** Stage 2 hook: double-click a row to open the viewer. */
    onRowOpen?: (file: SpooledFileInfo) => void;
    /** Stage 2: right-click a row → select it and open the action menu. */
    onRowContext?: (file: SpooledFileInfo, x: number, y: number) => void;
}

export interface SpoolPaneHandle {
    root: HTMLElement;
    setFiles(files: SpooledFileInfo[]): void;
    clear(): void;
    filters(): SpoolFilters;
    setBusy(busy: boolean): void;
}

export function createSpoolPane(opts: SpoolPaneOptions): SpoolPaneHandle {
    const root = document.createElement("div");
    root.className = "work-pane spool";
    root.dataset.pane = "spool";
    root.hidden = true;

    // --- Filter row ---
    const filterRow = document.createElement("div");
    filterRow.className = "spool-filters";

    const userLabel = document.createElement("label");
    userLabel.textContent = t("spool.user", "User");
    const userInput = document.createElement("input");
    userInput.type = "text";
    userInput.className = "spool-user";
    userInput.placeholder = t("spool.userPlaceholder", "(current user)");
    userInput.maxLength = 10;
    userInput.autocapitalize = "off";
    userInput.spellcheck = false;
    userLabel.appendChild(userInput);

    const allUsersLabel = document.createElement("label");
    allUsersLabel.className = "spool-check";
    const allUsersInput = document.createElement("input");
    allUsersInput.type = "checkbox";
    allUsersInput.className = "spool-all-users";
    allUsersLabel.appendChild(allUsersInput);
    allUsersLabel.appendChild(document.createTextNode(t("spool.allUsers", "All users")));

    const outqLibLabel = document.createElement("label");
    outqLibLabel.textContent = t("spool.outqLib", "Output queue library");
    const outqLibInput = document.createElement("input");
    outqLibInput.type = "text";
    outqLibInput.className = "spool-outq-lib";
    outqLibInput.placeholder = t("spool.outqLibPlaceholder", "*LIBL");
    outqLibInput.maxLength = 10;
    outqLibInput.autocapitalize = "off";
    outqLibInput.spellcheck = false;
    outqLibLabel.appendChild(outqLibInput);

    const outqLabel = document.createElement("label");
    outqLabel.textContent = t("spool.outq", "Output queue");
    const outqInput = document.createElement("input");
    outqInput.type = "text";
    outqInput.className = "spool-outq";
    outqInput.maxLength = 10;
    outqInput.autocapitalize = "off";
    outqInput.spellcheck = false;
    outqLabel.appendChild(outqInput);

    const allOutqsLabel = document.createElement("label");
    allOutqsLabel.className = "spool-check";
    const allOutqsInput = document.createElement("input");
    allOutqsInput.type = "checkbox";
    allOutqsInput.className = "spool-all-outqs";
    allOutqsLabel.appendChild(allOutqsInput);
    allOutqsLabel.appendChild(document.createTextNode(t("spool.allOutqs", "All output queues")));

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "btn primary spool-refresh";
    refreshBtn.textContent = t("spool.refresh", "Refresh");

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn spool-clear";
    clearBtn.textContent = t("spool.clear", "Clear");

    filterRow.appendChild(userLabel);
    filterRow.appendChild(allUsersLabel);
    filterRow.appendChild(outqLabel);
    filterRow.appendChild(outqLibLabel);
    filterRow.appendChild(allOutqsLabel);
    filterRow.appendChild(refreshBtn);
    filterRow.appendChild(clearBtn);

    // --- Results table ---
    const wrap = document.createElement("div");
    wrap.className = "table-wrap spool-table-wrap";
    const table = document.createElement("table");
    table.className = "spool-table";
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    tbody.className = "spool-body";
    // Capture-phase: right-mousedown suppresses selection. Left-mousedown
    // enables drag-select and KEEPS it after release; the next left-press or
    // any right-press reverts cells to unselected.
    const setSel = (on: boolean) => {
        tbody.querySelectorAll("td").forEach((td) => td.classList.toggle("spool-textsel", on));
    };
    tbody.addEventListener("mousedown", (ev) => {
        const me = ev as MouseEvent;
        if (me.button === 2) {
            setSel(false);
            ev.preventDefault();
        } else if (me.button === 0) {
            // If already selectable from a prior drag, a fresh left press that
            // isn't a drag should clear it (handled on mouseup via drag detect).
            if (!tbody.querySelector("td.spool-textsel")) setSel(true);
        }
    }, true);
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    const empty = document.createElement("div");
    empty.className = "spool-empty";
    empty.hidden = true;
    wrap.appendChild(empty);

    root.appendChild(filterRow);
    root.appendChild(wrap);

    let files: SpooledFileInfo[] = [];
    let sortKey: SpoolSortKey | "" = "";
    let sortDir: 1 | -1 = 1;

    function currentFilters(): SpoolFilters {
        return {
            user: userInput.value,
            allUsers: allUsersInput.checked,
            outqLib: outqLibInput.value,
            outq: outqInput.value,
            allOutqs: allOutqsInput.checked,
        };
    }

    function renderHead(): void {
        thead.innerHTML = "";
        const headRow = document.createElement("tr");
        const rowNumTh = document.createElement("th");
        rowNumTh.className = "row-index";
        rowNumTh.textContent = "ROW";
        headRow.appendChild(rowNumTh);
        for (const col of SPOOL_COLUMNS) {
            const th = document.createElement("th");
            th.textContent = t(col.labelKey, col.fallback);
            th.classList.add("sortable");
            if (col.numeric) th.classList.add("num");
            if (sortKey === col.key) {
                th.classList.add(sortDir === 1 ? "sort-asc" : "sort-desc");
            }
            th.addEventListener("click", () => {
                if (sortKey === col.key) {
                    sortDir = sortDir === 1 ? -1 : 1;
                } else {
                    sortKey = col.key;
                    sortDir = 1;
                }
                render();
            });
            headRow.appendChild(th);
        }
        // Stage 2+ placeholder: viewer/download/hold/move/delete actions.
        const actionsTh = document.createElement("th");
        actionsTh.className = "spool-actions";
        actionsTh.textContent = t("spool.col.actions", "Actions");
        headRow.appendChild(actionsTh);
        thead.appendChild(headRow);
    }

    function render(): void {
        renderHead();
        tbody.innerHTML = "";
        const view = [...files];
        if (sortKey) {
            const key = sortKey;
            const dir = sortDir;
            view.sort((a, b) => compareSpooledFiles(a, b, key, dir));
        }
        const frag = document.createDocumentFragment();
        view.forEach((f, i) => {
            const tr = document.createElement("tr");
            const idxTd = document.createElement("td");
            idxTd.className = "row-index";
            idxTd.textContent = String(i + 1);
            tr.appendChild(idxTd);
            for (const col of SPOOL_COLUMNS) {
                const td = document.createElement("td");
                td.textContent = spoolCellText(f, col.key);
                if (col.numeric) td.classList.add("num");
                tr.appendChild(td);
            }
            const actionsTd = document.createElement("td");
            actionsTd.className = "spool-actions";
            tr.appendChild(actionsTd);
            tr.addEventListener("dblclick", () => opts.onRowOpen?.(f));
            const selectRow = () => {
                tbody.querySelectorAll("tr.spool-selected").forEach((r) => r.classList.remove("spool-selected"));
                tr.classList.add("spool-selected");
            };
            // Row highlight only on a clean click (no drag). A left-button
            // down+drag is the user's deliberate text selection — leave the
            // native selection alone and don't steal the row highlight.
            let downX = 0, downY = 0, dragged = false;
            tr.addEventListener("mousedown", (ev) => {
                const me = ev as MouseEvent;
                if (me.button === 2) return; // right-click handled at tbody capture
                downX = me.clientX; downY = me.clientY; dragged = false;
                const move = (e: Event) => {
                    const mm = e as MouseEvent;
                    if (Math.abs(mm.clientX - downX) > 4 || Math.abs(mm.clientY - downY) > 4) dragged = true;
                };
                const up = () => {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                };
                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
            });
            tr.addEventListener("click", () => {
                if (!dragged) {
                    selectRow();
                    // Clean click: revert cells to unselected for next time.
                    tbody.querySelectorAll("td.spool-textsel").forEach((td) => td.classList.remove("spool-textsel"));
                }
            });
            tr.addEventListener("contextmenu", (ev) => {
                if (!opts.onRowContext) return;
                ev.preventDefault();
                // Keep the document-level contextmenu closer from firing on
                // this same event and immediately closing the menu we open.
                ev.stopPropagation();
                // Select the row so the action target is unambiguous.
                selectRow();
                opts.onRowContext(f, ev.clientX, ev.clientY);
            });
            frag.appendChild(tr);
        });
        tbody.appendChild(frag);
        empty.textContent = spoolEmptyText();
        empty.hidden = view.length > 0;
        table.hidden = view.length === 0;
    }

    allUsersInput.addEventListener("change", () => {
        userInput.disabled = allUsersInput.checked;
    });
    allOutqsInput.addEventListener("change", () => {
        outqLibInput.disabled = allOutqsInput.checked;
        outqInput.disabled = allOutqsInput.checked;
    });
    refreshBtn.addEventListener("click", () => opts.onRefresh(currentFilters()));
    clearBtn.addEventListener("click", () => {
        userInput.value = DEFAULT_SPOOL_FILTERS.user;
        allUsersInput.checked = DEFAULT_SPOOL_FILTERS.allUsers;
        outqLibInput.value = DEFAULT_SPOOL_FILTERS.outqLib;
        outqInput.value = DEFAULT_SPOOL_FILTERS.outq;
        allOutqsInput.checked = DEFAULT_SPOOL_FILTERS.allOutqs;
        userInput.disabled = false;
        outqLibInput.disabled = false;
        outqInput.disabled = false;
        files = [];
        sortKey = "";
        sortDir = 1;
        render();
    });
    // Enter in any filter input refreshes.
    for (const input of [userInput, outqLibInput, outqInput]) {
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") opts.onRefresh(currentFilters());
        });
    }

    render();

    return {
        root,
        setFiles(next: SpooledFileInfo[]): void {
            files = next;
            render();
        },
        clear(): void {
            files = [];
            render();
        },
        filters: currentFilters,
        setBusy(busy: boolean): void {
            refreshBtn.disabled = busy;
        },
    };
}
