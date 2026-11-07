import "./style.css";
// @ts-ignore: @wailsio/runtime ships untyped JS
import { Events } from "@wailsio/runtime";
import {
    columnHeaderLines,
    columnTooltip,
    formatCellText,
    shouldRightAlign,
    sortValue,
} from "./sqltypes";
import {
    App,
    type CLMessage,
    type CLResult,
    type ColumnInfo,
    type ConnectionProfile,
    type ConnectResponse,
    type SqlMessage,
    type SqlResult,
} from "./types";
import { splitStatements, statementAt, statementsFrom } from "./statements";
import { parseCmdXml } from "./clprompter/prompterModel";
import { showPrompter } from "./clprompter/prompterView";

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`missing element #${id}`);
    return node as T;
}

const els = {
    badge: el<HTMLSpanElement>("conn-badge"),
    connectPanel: el<HTMLDivElement>("connect-panel"),
    connectError: el<HTMLDivElement>("connect-error"),
    btnConnect: el<HTMLButtonElement>("btn-connect"),
    btnDisconnect: el<HTMLButtonElement>("btn-disconnect"),
    btnRun: el<HTMLButtonElement>("btn-run"),
    btnRunAll: el<HTMLButtonElement>("btn-run-all"),
    btnRunFrom: el<HTMLButtonElement>("btn-run-from"),
    btnCancel: el<HTMLButtonElement>("btn-cancel"),
    btnPrompt: el<HTMLButtonElement>("btn-prompt"),
    sqlInput: el<HTMLTextAreaElement>("sql-input"),
    workArea: el<HTMLElement>("work-area"),
    workTabs: el<HTMLDivElement>("work-tabs"),
    messageList: el<HTMLUListElement>("message-list"),
    paneResults: el<HTMLElement>("pane-results"),
    paneMessages: el<HTMLElement>("pane-messages"),
    emptyState: el<HTMLElement>("empty-state"),
    resultHead: el<HTMLTableSectionElement>("result-head"),
    resultBody: el<HTMLTableSectionElement>("result-body"),
    statusText: el<HTMLSpanElement>("status-text"),
    btnLoadMore: el<HTMLButtonElement>("btn-load-more"),
    btnLoadAll: el<HTMLButtonElement>("btn-load-all"),
};

// --- Work-area panes (bottom tabs): results, messages, dynamic prompter panes ---
let activePane = "results";
// Prompter panes form a chain: each pane records its depth. Activating a
// prompter tab closes all deeper nested prompters (going back to a parent
// dismisses its children). Depth is unbounded.
let prompterSeq = 0;

function paneEl(name: string): HTMLElement | undefined {
    return els.workArea.querySelector<HTMLElement>(`.work-pane[data-pane="${name}"]`) ?? undefined;
}

function prompterDepth(name: string): number {
    const tab = els.workTabs.querySelector<HTMLElement>(`.work-tab[data-pane="${name}"]`);
    return tab ? Number(tab.dataset.depth ?? "0") : 0;
}

function closePrompterPanesBelow(depth: number): void {
    for (const tab of Array.from(els.workTabs.querySelectorAll<HTMLElement>(".work-tab[data-pane^='prompter-']"))) {
        const d = Number(tab.dataset.depth ?? "0");
        if (d > depth) {
            const paneName = tab.dataset.pane ?? "";
            paneEl(paneName)?.remove();
            tab.remove();
            if (activePane === paneName) activePane = `prompter-${depth}`;
        }
    }
}

function showPane(name: string): void {
    // Going back to a shallower prompter closes anything nested below it.
    if (name.startsWith("prompter-")) {
        closePrompterPanesBelow(prompterDepth(name));
    }
    activePane = name;
    for (const pane of Array.from(els.workArea.querySelectorAll<HTMLElement>(".work-pane"))) {
        pane.hidden = pane.dataset.pane !== name;
    }
    for (const tab of Array.from(els.workTabs.querySelectorAll<HTMLElement>(".work-tab"))) {
        tab.classList.toggle("active", tab.dataset.pane === name);
    }
    const anyVisible = els.workArea.querySelector(".work-pane:not([hidden])") != null;
    els.emptyState.hidden = anyVisible;
}

els.workTabs.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement).closest<HTMLElement>(".work-tab");
    if (tab?.dataset.pane) showPane(tab.dataset.pane);
});

function openPrompterPane(label: string): { pane: HTMLElement; close: () => void; paneName: string } {
    prompterSeq += 1;
    const paneName = `prompter-${prompterSeq}`;
    const depth = activePane.startsWith("prompter-") ? prompterDepth(activePane) + 1 : 0;
    const pane = document.createElement("div");
    pane.className = "work-pane prompter";
    pane.dataset.pane = paneName;
    els.workArea.appendChild(pane);

    const tab = document.createElement("button");
    tab.className = "work-tab";
    tab.dataset.pane = paneName;
    tab.dataset.depth = String(depth);
    tab.type = "button";
    tab.textContent = depth > 0 ? `${"\u00A0".repeat(depth * 2)}${label}` : label;
    const close = document.createElement("span");
    close.className = "work-tab-close";
    close.textContent = "\u00D7";
    close.title = "Close prompter";
    tab.appendChild(close);
    els.workTabs.insertBefore(tab, els.workTabs.querySelector(".spacer"));

    const closePane = () => {
        // Closing a pane also closes anything nested below it.
        closePrompterPanesBelow(depth);
        pane.remove();
        tab.remove();
        if (activePane === paneName || activePane.startsWith("prompter-")) {
            showPane(depth > 0 ? `prompter-${depth - 1 >= 0 ? prompterTabNameAtDepth(depth - 1) : "results"}` : "results");
        }
    };
    close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closePane();
    });
    showPane(paneName);
    return { pane, close: closePane, paneName };
}

function prompterTabNameAtDepth(depth: number): string {
    const tab = els.workTabs.querySelector<HTMLElement>(`.work-tab[data-pane^='prompter-'][data-depth="${depth}"]`);
    return tab?.dataset.pane ?? "results";
}

interface AppState {
    running: boolean;
    columns: ColumnInfo[];
    rows: unknown[][];
    cursorId: string | null;
    more: boolean;
    fetchSize: number;
    sortCol: number;
    sortDir: 1 | -1;
}

interface ResultSnapshot {
    editorText: string;
    columns: ColumnInfo[];
    rows: unknown[][];
    cursorId: string | null;
    more: boolean;
    statusText: string;
    messagesHtml: string;
    messagesVisible: boolean;
    showingResults: boolean;
}

interface ConnectionTab {
    key: string;
    label: string;
    connectionId: string | null;
    cursorId: string | null;
    hasCursor: boolean;
    snapshot?: ResultSnapshot;
}

const state: AppState = {
    running: false,
    columns: [],
    rows: [],
    cursorId: null,
    more: false,
    fetchSize: 200,
    sortCol: -1,
    sortDir: 1,
};

// Connection tabs: each tab binds the shared editor/results pane to its own
// IBM i connection. Active tab's connectionId is what Run/Fetch use.
const tabs: ConnectionTab[] = [];
let activeTabKey = "";
let tabCounter = 0;

function activeTab(): ConnectionTab | undefined {
    return tabs.find((t) => t.key === activeTabKey);
}

function renderTabs(): void {
    const list = el<HTMLDivElement>("conn-tab-list");
    list.innerHTML = "";
    for (const tab of tabs) {
        const btn = document.createElement("button");
        btn.className = "conn-tab" + (tab.key === activeTabKey ? " active" : "");
        btn.textContent = tab.label;
        btn.title = tab.connectionId ? "Connected" : "Not connected";
        btn.addEventListener("click", () => switchTab(tab.key));
        if (tab.connectionId) {
            const detach = document.createElement("span");
            detach.className = "conn-tab-detach";
            detach.textContent = "\u2197"; // arrow out
            detach.title = "Detach to its own window";
            detach.addEventListener("click", (ev) => {
                ev.stopPropagation();
                void detachTab(tab);
            });
            btn.appendChild(detach);
        }
        const close = document.createElement("span");
        close.className = "conn-tab-close";
        close.textContent = "\u00D7";
        close.title = "Close tab";
        close.addEventListener("click", (ev) => {
            ev.stopPropagation();
            void closeTab(tab.key);
        });
        btn.appendChild(close);
        list.appendChild(btn);
    }
}

// Detach: hand this tab's connection to a new window, close the tab here.
async function detachTab(tab: ConnectionTab): Promise<void> {
    if (!tab.connectionId) return;
    const app = App();
    try {
        await app.DetachConnection(tab.connectionId, `${tab.label} — IBM i Run SQL`);
    } catch (err) {
        showMessages([], `Detach failed: ${String((err as Error)?.message ?? err)}`);
        return;
    }
    // The window owns the connection now; drop the tab locally (no disconnect).
    const idx = tabs.findIndex((t) => t.key === tab.key);
    if (idx >= 0) {
        tabs.splice(idx, 1);
    }
    if (tabs.length === 0) {
        addTab();
        return;
    }
    if (activeTabKey === tab.key) {
        activeTabKey = tabs[Math.max(0, idx - 1)].key;
    }
    restoreActiveTab();
    renderTabs();
    syncConnectionUi();
}

function snapshotActiveTab(): void {
    const outgoing = activeTab();
    if (!outgoing) return;
    outgoing.snapshot = {
        editorText: els.sqlInput.value,
        columns: [...state.columns],
        rows: state.rows.map((r) => [...r]),
        cursorId: state.cursorId,
        more: state.more,
        statusText: els.statusText.textContent ?? "",
        messagesHtml: els.messageList.innerHTML,
        messagesVisible: els.messageList.children.length > 0,
        showingResults: els.resultBody.children.length > 0 || els.resultHead.children.length > 0,
    };
}

function restoreActiveTab(): void {
    const snap = activeTab()?.snapshot;
    state.columns = snap ? [...snap.columns] : [];
    state.rows = snap ? snap.rows.map((r) => [...r]) : [];
    state.cursorId = snap?.cursorId ?? null;
    state.more = snap?.more ?? false;
    state.sortCol = -1;
    state.sortDir = 1;
    els.sqlInput.value = snap?.editorText ?? "";
    if (snap?.showingResults) {
        renderTable();
        els.statusText.textContent = snap.statusText;
        els.btnLoadMore.hidden = !state.more;
        els.btnLoadAll.hidden = !state.more;
        showPane("results");
    } else {
        els.resultHead.innerHTML = "";
        els.resultBody.innerHTML = "";
        els.statusText.textContent = "";
        els.btnLoadMore.hidden = true;
        els.btnLoadAll.hidden = true;
        showPane("results");
    }
    els.messageList.innerHTML = snap?.messagesHtml ?? "";
    closeAllPrompterPanes();
    pushWorkspaceState();
}

// Push the visible workspace state to the Go store (single source of truth for
// torn-off windows). Called after any user-visible change.
function pushWorkspaceState(): void {
    const tab = activeTab();
    if (!tab?.connectionId) return;
    const app = App();
    void app.UpdateEditorText(tab.connectionId, els.sqlInput.value);
    void app.UpdateMessagesHTML(tab.connectionId, els.messageList.innerHTML);
    void app.UpdateStatusText(tab.connectionId, els.statusText.textContent ?? "");
}

function closeAllPrompterPanes(): void {
    for (const pane of Array.from(els.workArea.querySelectorAll<HTMLElement>(".work-pane[data-pane^='prompter-']"))) {
        pane.remove();
    }
    for (const tab of Array.from(els.workTabs.querySelectorAll<HTMLElement>(".work-tab[data-pane^='prompter-']"))) {
        tab.remove();
    }
    if (activePane.startsWith("prompter-")) showPane("results");
}

function addTab(): ConnectionTab {
    snapshotActiveTab();
    tabCounter += 1;
    const tab: ConnectionTab = {
        key: `tab-${tabCounter}`,
        label: `Connection ${tabCounter}`,
        connectionId: null,
        cursorId: null,
        hasCursor: false,
    };
    tabs.push(tab);
    activeTabKey = tab.key;
    restoreActiveTab();
    renderTabs();
    syncConnectionUi();
    return tab;
}

// Re-absorb a connection whose detached window is closing: create a tab bound
// to the live connectionId and restore its workspace from the shared store.
async function addDetachedTab(connectionId: string): Promise<void> {
    if (tabs.some((t) => t.connectionId === connectionId)) return;
    const app = App();
    const tab = addTab();
    tab.connectionId = connectionId;
    let ws: {
        label?: string; editorText?: string; statusText?: string; messagesHtml?: string;
        columns?: ColumnInfo[]; rows?: unknown[][]; cursorId?: string; more?: boolean; showingResults?: boolean;
    } = {};
    try {
        ws = (await app.GetWorkspace(connectionId)) as typeof ws;
    } catch {
        // workspace gone: keep the bare tab
    }
    tab.label = ws.label ?? "Connection";
    const showingResults = !!ws.showingResults && !!ws.columns;
    tab.snapshot = {
        editorText: ws.editorText ?? "",
        columns: ws.columns ? [...ws.columns] : [],
        rows: (ws.rows ?? []).map((r) => [...r]),
        cursorId: ws.cursorId ?? null,
        more: !!ws.more,
        statusText: ws.statusText ?? "",
        messagesHtml: ws.messagesHtml ?? "",
        messagesVisible: !!ws.messagesHtml,
        showingResults,
    };
    restoreActiveTab();
    renderTabs();
    syncConnectionUi();
}

// --- Detached window mode: ?connection=<id> locks this window to that
// connection (set by App.DetachConnection's window URL). Declared early so
// module-level guards below can use it (const is in the temporal dead zone
// until this point).
const detachedConnId = new URLSearchParams(window.location.search).get("connection") || "";

// Only the main window hosts tabs; detached windows must ignore reattach events.
if (!detachedConnId) {
    Events.On("workspace:reattach", (ev: { data?: { connectionId?: string } }) => {
        const id = ev?.data?.connectionId;
        if (id) void addDetachedTab(id);
    });
}

function switchTab(key: string): void {
    if (activeTabKey === key) return;
    snapshotActiveTab();
    activeTabKey = key;
    restoreActiveTab();
    renderTabs();
    syncConnectionUi();
}

async function closeTab(key: string): Promise<void> {
    const idx = tabs.findIndex((t) => t.key === key);
    if (idx < 0) return;
    const tab = tabs[idx];
    const app = App();
    if (app && tab.connectionId) {
        try {
            await app.Disconnect(tab.connectionId);
        } catch {
            // best effort
        }
    }
    tabs.splice(idx, 1);
    if (tabs.length === 0) {
        addTab();
        return;
    }
    if (activeTabKey === key) {
        activeTabKey = tabs[Math.max(0, idx - 1)].key;
    }
    renderTabs();
    syncConnectionUi();
}

// True after the first connect attempt in this window: keeps the work area
// visible for failure feedback instead of re-hiding it when still disconnected.
let connectAttempted = false;

function syncConnectionUi(): void {
    const tab = activeTab();
    const connected = !!tab?.connectionId;
    els.badge.textContent = connected ? tab!.label : "Not connected";
    els.badge.className = `badge ${connected ? "connected" : "disconnected"}`;
    els.btnConnect.disabled = connected;
    els.btnDisconnect.disabled = !connected;
    els.btnRun.disabled = !connected;
    els.btnRunAll.disabled = !connected;
    els.btnRunFrom.disabled = !connected;
    els.btnPrompt.disabled = !connected;
    els.btnCancel.disabled = true;
    els.connectPanel.hidden = connected;
    // Results/Messages area + run buttons are meaningless without a connection;
    // editor stays usable. After a connect attempt the area stays up so the
    // failure is visible on the Messages pane.
    const showWork = connected || connectAttempted;
    els.workArea.hidden = !showWork;
    el<HTMLDivElement>("splitter").hidden = !showWork;
    el<HTMLSpanElement>("run-controls").hidden = !connected;
}

// Display settings — future per-connection/global config; heading default is ON
// (matches the cl-prompter SQL result panel).
const displaySettings = {
    stackedColumnHeadings: true,
};

type DisplayMessage = Partial<CLMessage & SqlMessage>;

function setConnected(info: ConnectResponse): void {
    const tab = activeTab();
    if (!tab) return;
    tab.connectionId = info.connectionId;
    tab.label = `${info.user}@${info.host}`;
    tab.cursorId = null;
    tab.hasCursor = false;
    state.cursorId = null;
    state.more = false;
    renderTabs();
    syncConnectionUi();
    els.badge.textContent = `${info.user}@${info.host} — ${info.databaseProduct} ${info.databaseVersion}`;
    els.connectError.hidden = true;
    els.sqlInput.focus();
    // ACS-style connection log line.
    const job = info.serverJob ? ` - ${info.serverJob}` : "";
    appendLogLine(`[ ${nowStamp()} ]  ${info.user}@${info.host} Connected`, "msg-action");
    appendLogLine(`Connected to relational database ${info.databaseProduct} on ${info.host} as ${info.user}${job} using JDBC driver '${info.driverName} ${info.driverVersion}'`, "msg-info", true);
}

function setDisconnected(): void {
    const tab = activeTab();
    if (tab) {
        tab.connectionId = null;
        tab.cursorId = null;
        tab.hasCursor = false;
        tab.label = `Connection ${tabs.indexOf(tab) + 1}`;
    }
    state.cursorId = null;
    state.more = false;
    // Clear the visible panes (the snapshot taken by the caller keeps the last
    // result set for the tab); the work area hides via syncConnectionUi.
    els.resultHead.innerHTML = "";
    els.resultBody.innerHTML = "";
    els.statusText.textContent = "";
    els.btnLoadMore.hidden = true;
    els.btnLoadAll.hidden = true;
    renderTabs();
    syncConnectionUi();
    closeAllPrompterPanes();
}

// Messages accumulate across statements within a batch (ACS-style). Every
// execution logs a timestamped action line + statement text + outcome.
let messageSeq = 0;

function clearMessages(): void {
    els.messageList.innerHTML = "";
    messageSeq = 0;
}

function appendLogLine(text: string, cls = "msg-info", indent = false): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `msg ${cls}${indent ? " msg-indent" : ""}`;
    li.textContent = text;
    els.messageList.appendChild(li);
    return li;
}

function nowStamp(): string {
    return new Date().toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
}

/** ACS-style execution log entry: action header + statement + outcome. */
function logExecution(action: string, statement: string, outcome: string): void {
    if (els.messageList.children.length > 0) {
        const sep = document.createElement("li");
        sep.className = "msg msg-separator";
        sep.textContent = "─".repeat(60);
        els.messageList.appendChild(sep);
    }
    appendLogLine(`[ ${nowStamp()} ]  ${action}`, "msg-action");
    for (const line of statement.split("\n")) {
        appendLogLine(line, "msg-statement", true);
    }
    appendLogLine(outcome, outcome.startsWith("Statement ran") || outcome.includes("OK") ? "msg-info" : "msg-warning", true);
}

function showMessages(items: DisplayMessage[] | undefined, failure?: string): void {
    const hasContent = (items?.length ?? 0) > 0 || !!failure;
    if (!hasContent) return;

    messageSeq += 1;
    let hasError = false;
    let coveredFailure = false;
    for (const m of items ?? []) {
        const li = document.createElement("li");
        li.className = `msg msg-${m.kind ?? "info"}`;
        if (m.kind === "error") hasError = true;
        // ACS-style: SQL State / SQL Code labeled for non-JDBC developers —
        // CL messages keep id/type/severity. SQL errors put the id part on its
        // own line (a real <br>, so no reliance on whitespace CSS).
        const idPart = m.id
            ? m.id
            : m.sqlState
                ? `SQL State: ${m.sqlState}${m.vendorCode != null && m.vendorCode !== 0 ? `, SQL Code: ${m.vendorCode}` : ""}`
                : "";
        const textPart = m.text || m.message || "";
        const sevPart = m.severity != null && m.typeName ? ` [${m.typeName} ${m.severity}]` : "";
        if (!idPart) {
            li.textContent = textPart + sevPart;
        } else if (m.id) {
            li.textContent = `${idPart}: ${textPart}` + sevPart;
        } else {
            li.appendChild(document.createTextNode(idPart));
            li.appendChild(document.createElement("br"));
            li.appendChild(document.createTextNode(textPart + sevPart));
        }
        li.classList.add("msg-indent");
        // The Go-side error string repeats the SQL message in [sqlState] [msgId]
        // form; if a messages entry already carries that text, drop the duplicate.
        if (failure && textPart && failure.includes(textPart)) coveredFailure = true;
        const tip: string[] = [];
        if (m.typeName) tip.push(`Type: ${m.typeName}  Severity: ${m.severity}`);
        if (m.secondLevelText) tip.push(m.secondLevelText);
        if (tip.length) li.title = tip.join("\n\n");
        if (m.secondLevelText) {
            const sub = document.createElement("div");
            sub.className = "msg-second-level";
            sub.textContent = m.secondLevelText;
            li.appendChild(sub);
        }
        els.messageList.appendChild(li);
    }
    if (failure && !coveredFailure) {
        const li = document.createElement("li");
        li.className = "msg msg-error msg-indent";
        li.textContent = failure;
        els.messageList.appendChild(li);
        hasError = true;
    }
    // Auto-switch to Messages only when something failed; info messages stay
    // out of the way on the Results pane.
    if (hasError) showPane("messages");
}

function columnLabel(c: ColumnInfo): string {
    return (c.label || c.name || "").trim() || c.name || "";
}

function renderTable(): void {
    els.resultHead.innerHTML = "";
    els.resultBody.innerHTML = "";

    const headRow = document.createElement("tr");
    const rowNumTh = document.createElement("th");
    rowNumTh.className = "row-index";
    rowNumTh.textContent = "ROW";
    headRow.appendChild(rowNumTh);

    state.columns.forEach((c, idx) => {
        const th = document.createElement("th");
        const text = columnLabel(c);
        if (displaySettings.stackedColumnHeadings) {
            const stack = document.createElement("div");
            stack.className = "stacked-header";
            for (const line of columnHeaderLines(text)) {
                const span = document.createElement("span");
                span.textContent = line;
                stack.appendChild(span);
            }
            th.appendChild(stack);
        } else {
            th.textContent = text;
        }
        th.title = columnTooltip(c);
        th.classList.add("sortable");
        if (shouldRightAlign(c)) th.classList.add("num");
        if (state.sortCol === idx) {
            th.classList.add(state.sortDir === 1 ? "sort-asc" : "sort-desc");
        }
        th.addEventListener("click", () => {
            if (state.sortCol === idx) {
                state.sortDir = state.sortDir === 1 ? -1 : 1;
            } else {
                state.sortCol = idx;
                state.sortDir = 1;
            }
            renderTable();
        });
        headRow.appendChild(th);
    });
    els.resultHead.appendChild(headRow);

    const viewRows = [...state.rows];
    if (state.sortCol >= 0) {
        const col = state.columns[state.sortCol];
        const dir = state.sortDir;
        const sortIdx = state.sortCol;
        viewRows.sort((a, b) => {
            const ka = sortValue(a[sortIdx], col);
            const kb = sortValue(b[sortIdx], col);
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
        state.columns.forEach((c, ci) => {
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
    els.resultBody.appendChild(frag);
}

function updateStatus(kind: string, result: SqlResult | undefined, totalRows: number): void {
    const elapsed = result?.elapsedMs != null ? ` in ${result.elapsedMs} ms` : "";
    if (kind === "rows") {
        const moreText = state.more ? " (more available)" : "";
        els.statusText.textContent = `${totalRows} row${totalRows === 1 ? "" : "s"}${moreText}${elapsed}`;
    } else if (kind === "count") {
        const n = result?.updateCount ?? 0;
        els.statusText.textContent = `${n} row${n === 1 ? "" : "s"} affected${elapsed}`;
    } else if (kind === "none") {
        els.statusText.textContent = `Statement completed${elapsed}`;
    } else {
        els.statusText.textContent = elapsed ? `Completed${elapsed}` : "";
    }
    els.btnLoadMore.hidden = !state.more;
    els.btnLoadAll.hidden = !state.more;
}

function showSqlResult(result: SqlResult): void {
    if (result.kind === "error") {
        showMessages(result.messages, result.error);
        updateStatus("error", result, 0);
        // Results pane shows the failure too — no hidden trip to Messages.
        els.resultHead.innerHTML = "";
        els.resultBody.innerHTML = "";
        const banner = document.createElement("div");
        banner.className = "result-error";
        const first = result.messages?.[0];
        banner.textContent = first
            ? `SQL State: ${first.sqlState}${first.vendorCode ? `, SQL Code: ${first.vendorCode}` : ""}: ${first.message}`
            : result.error ?? "Statement failed";
        els.resultBody.appendChild(banner);
        if (!activePane.startsWith("prompter-")) showPane("results");
        return;
    }
    showMessages(result.messages);
    if (result.kind === "rows") {
        // Always replace columns from the new result — never inherit a
        // previous tab's (or statement's) column layout.
        state.columns = result.columns ?? [];
        state.cursorId = result.cursorId ?? null;
        state.more = !!result.more;
        renderTable();
        updateStatus("rows", result, state.rows.length);
        if (!activePane.startsWith("prompter-")) showPane("results");
    } else {
        state.columns = [];
        state.rows = [];
        state.cursorId = null;
        state.more = false;
        els.resultHead.innerHTML = "";
        els.resultBody.innerHTML = "";
        updateStatus(result.kind, result, 0);
    }
}

function showCLResult(result: CLResult): void {
    state.columns = [];
    state.rows = [];
    state.cursorId = null;
    state.more = false;
    els.resultHead.innerHTML = "";
    els.resultBody.innerHTML = "";
    showMessages(result.messages, result.ok ? undefined : "CL command failed.");
    els.statusText.textContent = `CL: ${result.command} — ${result.ok ? "OK" : "failed"} in ${result.elapsedMs} ms`;
    els.btnLoadMore.hidden = true;
    els.btnLoadAll.hidden = true;
}

async function doConnect(): Promise<void> {
    const app = App();
    if (!app) return;
    els.connectError.hidden = true;
    els.btnConnect.disabled = true;
    connectAttempted = true;
    syncConnectionUi(); // reveal work area for the attempt
    try {
        const info = await app.Connect({
            host: el<HTMLInputElement>("in-host").value,
            user: el<HTMLInputElement>("in-user").value,
            password: el<HTMLInputElement>("in-password").value,
            tls: el<HTMLInputElement>("in-tls").checked,
            naming: el<HTMLSelectElement>("in-naming").value,
            defaultSchema: el<HTMLInputElement>("in-schema").value,
            fetchSize: state.fetchSize,
        });
        setConnected(info);
        // Auto-save (MRU) on successful connect — no Save button needed.
        void saveProfile();
    } catch (err) {
        els.btnConnect.disabled = false;
        els.connectError.textContent = String((err as Error)?.message ?? err);
        els.connectError.hidden = false;
        // Connect failures must be visible: open Messages with the error.
        appendLogLine(`[ ${nowStamp()} ]  Connect`, "msg-action");
        appendLogLine(`Connection failed: ${String((err as Error)?.message ?? err)}`, "msg-error", true);
        showPane("messages");
    }
}

// --- Saved connection profiles (dropdown "memory" on the Host field) ---

let profiles: ConnectionProfile[] = [];

function formProfile(): ConnectionProfile {
    const host = el<HTMLInputElement>("in-host").value.trim();
    const password = el<HTMLInputElement>("in-password").value;
    const savePassword = el<HTMLInputElement>("in-save-password").checked;
    return {
        name: host,
        host,
        user: el<HTMLInputElement>("in-user").value.trim(),
        defaultSchema: el<HTMLInputElement>("in-schema").value.trim(),
        naming: el<HTMLSelectElement>("in-naming").value,
        tls: el<HTMLInputElement>("in-tls").checked,
        savePassword,
        passwordB64: savePassword && password ? btoa(password) : undefined,
    };
}

function fillFormFromProfile(p: ConnectionProfile): void {
    el<HTMLInputElement>("in-host").value = p.host;
    el<HTMLInputElement>("in-user").value = p.user;
    el<HTMLInputElement>("in-schema").value = p.defaultSchema ?? "";
    el<HTMLSelectElement>("in-naming").value = p.naming || "sql";
    el<HTMLInputElement>("in-tls").checked = !!p.tls;
    el<HTMLInputElement>("in-save-password").checked = !!p.savePassword;
    const pwField = el<HTMLInputElement>("in-password");
    if (p.savePassword && p.passwordB64) {
        try {
            pwField.value = atob(p.passwordB64);
        } catch {
            pwField.value = "";
        }
        el<HTMLButtonElement>("btn-connect").focus();
    } else {
        pwField.value = "";
        pwField.focus();
    }
}

function renderProfileOptions(): void {
    // Rebuilt on demand by toggleSavedHosts(); nothing to pre-render.
}

async function loadProfiles(): Promise<void> {
    const app = App();
    if (!app) return;
    try {
        profiles = await app.ListConnectionProfiles();
        renderProfileOptions();
    } catch {
        profiles = [];
    }
}

async function saveProfile(): Promise<void> {
    const app = App();
    if (!app) return;
    const p = formProfile();
    if (!p.host) {
        els.connectError.textContent = "Enter a host before saving.";
        els.connectError.hidden = false;
        return;
    }
    try {
        await app.SaveConnectionProfile(p);
        await loadProfiles();
    } catch (err) {
        els.connectError.textContent = String((err as Error)?.message ?? err);
        els.connectError.hidden = false;
    }
}

async function doDisconnect(): Promise<void> {
    const app = App();
    const tab = activeTab();
    if (!app || !tab?.connectionId) return;
    const connId = tab.connectionId;
    try {
        await app.Disconnect(connId);
    } catch {
        // ignore
    }
    // Multi-tab: close this tab and fall back to the prior one. Single tab:
    // snapshot the workspace first (result set survives the disconnect), then
    // reset the tab to the not-connected state.
    if (tabs.length > 1) {
        const idx = tabs.findIndex((t) => t.key === tab.key);
        tab.connectionId = null; // already closed on the host
        tabs.splice(idx, 1);
        activeTabKey = tabs[Math.max(0, idx - 1)].key;
        restoreActiveTab();
        renderTabs();
        syncConnectionUi();
        return;
    }
    snapshotActiveTab();
    setDisconnected();
}

// Execute one statement text on the active tab; shared by all run modes.
// actionLabel is the ACS-style verb for the log ("Run Selected...", etc.).
async function runOne(text: string, actionLabel = "Run Selected..."): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    state.sortCol = -1;
    state.sortDir = 1;
    state.columns = [];
    state.rows = [];
    state.cursorId = null;
    state.more = false;
    els.resultHead.innerHTML = "";
    els.resultBody.innerHTML = "";
    els.btnLoadMore.hidden = true;
    els.btnLoadAll.hidden = true;
    showPane("results");
    const started = performance.now();
    try {
        const result = await app.Run({
            connectionId: activeTab()?.connectionId ?? "",
            text,
            fetchSize: state.fetchSize,
        });
        const elapsed = Math.round(performance.now() - started);
        if ((result as CLResult).kind === "cl") {
            const cl = result as CLResult;
            logExecution(actionLabel, text,
                cl.ok ? `Command ran successfully   (${cl.elapsedMs} ms)`
                    : `Command failed   (${cl.elapsedMs} ms)`);
            showCLResult(cl);
        } else {
            const sqlResult = result as SqlResult;
            if (sqlResult.kind === "error") {
                const stateText = sqlResult.messages?.[0]?.sqlState ? `  SQLState ${sqlResult.messages[0].sqlState}` : "";
                logExecution(actionLabel, text, `Statement failed${stateText}   (${sqlResult.elapsedMs ?? elapsed} ms)`);
            } else if (sqlResult.kind === "count") {
                logExecution(actionLabel, text, `Statement ran successfully   (${sqlResult.elapsedMs ?? elapsed} ms) — ${sqlResult.updateCount} row(s) affected`);
            } else {
                logExecution(actionLabel, text, `Statement ran successfully   (${sqlResult.elapsedMs ?? elapsed} ms)`);
            }
            state.rows = sqlResult.kind === "rows" ? sqlResult.rows ?? [] : [];
            showSqlResult(sqlResult);
        }
    } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        logExecution(actionLabel, text, `Statement failed   (${elapsed} ms)`);
        showMessages([], String((err as Error)?.message ?? err));
        els.statusText.textContent = "Error";
        throw err;
    }
}

function setRunning(on: boolean): void {
    state.running = on;
    els.btnRun.disabled = on;
    els.btnRunAll.disabled = on;
    els.btnRunFrom.disabled = on;
    els.btnCancel.disabled = !on;
}

// Run Selected: selection if any, else statement at caret; nothing in empty space.
async function doRun(): Promise<void> {
    if (!activeTab()?.connectionId || state.running) return;
    const src = els.sqlInput.value;
    const selStart = els.sqlInput.selectionStart ?? 0;
    const selEnd = els.sqlInput.selectionEnd ?? 0;
    let text: string;
    if (selEnd > selStart) {
        text = src.slice(selStart, selEnd).trim();
    } else {
        const stmt = statementAt(src, selStart);
        if (!stmt) return; // caret in empty space: nothing runs
        text = stmt.text;
    }
    if (!text) return;
    setRunning(true);
    els.statusText.textContent = "Running...";
    try {
        await runOne(text, "Run Selected...");
    } finally {
        setRunning(false);
    }
}

// Run All: every statement in order; stops on first failure.
async function doRunAll(): Promise<void> {
    if (!activeTab()?.connectionId || state.running) return;
    const stmts = splitStatements(els.sqlInput.value);
    if (!stmts.length) return;
    clearMessages();
    setRunning(true);
    els.statusText.textContent = `Running ${stmts.length} statements...`;
    try {
        for (let i = 0; i < stmts.length; i += 1) {
            els.statusText.textContent = `Running statement ${i + 1} of ${stmts.length}...`;
            await runOne(stmts[i].text, `Run All — statement ${i + 1} of ${stmts.length}...`);
        }
        els.statusText.textContent = `${stmts.length} statements completed.`;
    } catch {
        // runOne already surfaced the error; stop the batch.
    } finally {
        setRunning(false);
    }
}

// Run from Selected: caret statement through the last; stops on first failure.
async function doRunFromSelected(): Promise<void> {
    if (!activeTab()?.connectionId || state.running) return;
    const src = els.sqlInput.value;
    const pos = els.sqlInput.selectionStart ?? 0;
    const stmts = statementsFrom(src, pos);
    if (!stmts.length) return;
    clearMessages();
    setRunning(true);
    els.statusText.textContent = `Running ${stmts.length} statements from cursor...`;
    try {
        for (let i = 0; i < stmts.length; i += 1) {
            els.statusText.textContent = `Running statement ${i + 1} of ${stmts.length}...`;
            await runOne(stmts[i].text, `Run from Selected — statement ${i + 1} of ${stmts.length}...`);
        }
        els.statusText.textContent = `${stmts.length} statements completed.`;
    } catch {
        // stop batch on failure
    } finally {
        setRunning(false);
    }
}

async function doFetch(all: boolean): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId || !state.more) return;
    els.btnLoadMore.disabled = true;
    els.btnLoadAll.disabled = true;
    try {
        do {
            const page = await app.Fetch({
                connectionId: activeTab()?.connectionId ?? "",
                cursorId: state.cursorId ?? "",
                fetchSize: state.fetchSize,
            });
            if (page.kind === "error") {
                showMessages(page.messages, page.error);
                state.more = false;
                break;
            }
            state.rows.push(...(page.rows ?? []));
            state.cursorId = page.cursorId ?? state.cursorId;
            state.more = !!page.more;
        } while (all && state.more);
        renderTable();
        updateStatus("rows", undefined, state.rows.length);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        els.btnLoadMore.disabled = false;
        els.btnLoadAll.disabled = false;
    }
}

async function doCancel(): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    try {
        await app.CancelSQL(activeTab()?.connectionId ?? "");
    } catch {
        // best effort
    }
}

// Extract a command name + optional library from the input's first token.
// Accepts: "DSPLIBL", "CL: DSPLIBL", "QSYS/DSPLIBL", with or without parms.
function extractCommandRef(text: string): { command: string; library?: string } | undefined {
    const stripped = text.trim().replace(/^CL\s*:\s*/i, "");
    const m = stripped.match(/^([A-Za-z0-9_#@$]+)(?:\/([A-Za-z0-9_#@$]+))?/);
    if (!m) return undefined;
    // LIB/CMD form vs CMD form: CMD(LIB/) is not valid CL, but LIB/CMD is.
    if (m[2]) return { command: m[2].toUpperCase(), library: m[1].toUpperCase() };
    return { command: m[1].toUpperCase() };
}

async function openCommandPrompter(
    ref: { command: string; library?: string },
    onInsert: (text: string) => void,
    onRunNow?: (text: string) => void,
    onPromptNestedCb?: (commandText: string, applyBack: (newText: string) => void) => void,
): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    const result = await app.GetCmdXml({
        connectionId: activeTab()?.connectionId ?? "",
        command: ref.command,
        library: ref.library,
    });
    const descriptor = parseCmdXml(result.xml);
    if (!descriptor.name) descriptor.name = ref.command;
    const { pane, close } = openPrompterPane(`Prompt: ${descriptor.name}`);
    showPrompter(pane, descriptor, ref.command, {
        onRun: (commandText) => {
            close();
            if (commandText) onRunNow ? onRunNow(commandText) : onInsert(commandText);
        },
        onInsert: (commandText) => {
            onInsert(commandText);
        },
        onClose: () => close(),
        onPromptNested: onPromptNestedCb,
    });
}

// Nested prompt recursion — unbounded depth. Each level's applyBack writes the
// finished command string into the parent pane's CMD/CMDSTR field.
function promptNestedRecursively(commandText: string, applyBack: (t: string) => void): void {
    const nestedRef = extractCommandRef(commandText);
    if (!nestedRef) {
        showMessages([], `No command found in field to prompt: "${commandText}"`);
        return;
    }
    void openCommandPrompter(
        nestedRef,
        (text) => applyBack(text),
        (text) => applyBack(text),
        (ct, ab) => promptNestedRecursively(ct, ab),
    );
}

async function doPrompt(): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    const ref = extractCommandRef(els.sqlInput.value);
    if (!ref) {
        showMessages([], "Enter a command name (e.g. DSPLIBL or CL: DSPLIBL) to prompt.");
        return;
    }
    els.btnPrompt.disabled = true;
    try {
        await openCommandPrompter(
            ref,
            (text) => {
                els.sqlInput.value = `CL: ${text}`;
                els.sqlInput.focus();
            },
            (text) => {
                els.sqlInput.value = `CL: ${text}`;
                void doRun();
            },
            // Nested: prompt the command typed into a CMD/CMDSTR field.
            (commandText, applyBack) => {
                promptNestedRecursively(commandText, applyBack);
            },
        );
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        els.btnPrompt.disabled = false;
    }
}

els.btnConnect.addEventListener("click", () => void doConnect());
els.btnDisconnect.addEventListener("click", () => void doDisconnect());
els.btnRun.addEventListener("click", () => void doRun());
els.btnRunAll.addEventListener("click", () => void doRunAll());
els.btnRunFrom.addEventListener("click", () => void doRunFromSelected());
els.btnCancel.addEventListener("click", () => void doCancel());
els.btnPrompt.addEventListener("click", () => void doPrompt());
el<HTMLButtonElement>("btn-new-conn").addEventListener("click", () => addTab());
els.btnLoadMore.addEventListener("click", () => void doFetch(false));
els.btnLoadAll.addEventListener("click", () => void doFetch(true));

els.sqlInput.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        void doRun();
    }
    if (ev.key === "F4") {
        ev.preventDefault();
        void doPrompt();
    }
});
els.sqlInput.addEventListener("input", () => pushWorkspaceState());

el<HTMLInputElement>("in-password").addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter") void doConnect();
});

// Saved-connections dropdown: explicit arrow button + popup list.
// Right-clicking an item opens a context menu (Forget / Move to top).
let contextMenuEl: HTMLDivElement | undefined;

function closeContextMenu(): void {
    contextMenuEl?.remove();
    contextMenuEl = undefined;
}

function showProfileContextMenu(p: ConnectionProfile, x: number, y: number): void {
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const addItem = (label: string, action: () => void, danger = false) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "context-item" + (danger ? " danger" : "");
        item.textContent = label;
        item.addEventListener("click", () => {
            closeContextMenu();
            action();
        });
        menu.appendChild(item);
    };

    addItem(`Forget ${p.host}`, () => void forgetProfileByName(p.name), true);
    addItem("Move to top of list", () => void bumpProfile(p.name));

    document.body.appendChild(menu);
    contextMenuEl = menu;
}

document.addEventListener("click", (ev) => {
    if (contextMenuEl && !(ev.target as HTMLElement).closest(".context-menu")) {
        closeContextMenu();
    }
});
document.addEventListener("contextmenu", (ev) => {
    if (contextMenuEl && !(ev.target as HTMLElement).closest(".context-menu")) {
        closeContextMenu();
    }
});

async function forgetProfileByName(name: string): Promise<void> {
    const app = App();
    if (!app) return;
    try {
        await app.DeleteConnectionProfile(name);
        await loadProfiles();
    } catch {
        // best effort
    }
}

async function bumpProfile(name: string): Promise<void> {
    const app = App();
    if (!app) return;
    try {
        await app.MoveConnectionProfileToTop(name); // pins to the top
        await loadProfiles();
    } catch {
        // best effort
    }
}

// Word-font-dropdown style: with more than 5 saved profiles, the 5 most
// recently used appear on top above a separator; at 5 or fewer the list is
// stable (Go sorts pinned-first then creation/FILO order) so connections stop
// being moving targets.
const RECENT_SECTION_SIZE = 5;

function toggleSavedHosts(): void {
    const popup = el<HTMLDivElement>("saved-hosts-popup");
    if (!popup.hidden) {
        popup.hidden = true;
        return;
    }
    popup.innerHTML = "";
    const addItem = (p: ConnectionProfile) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "combo-item";
        item.dataset.profileName = p.name;
        item.textContent = `${p.host} — ${p.user}${p.tls ? " (TLS)" : ""}${p.defaultSchema ? ` [${p.defaultSchema}]` : ""}`;
        item.title = "Click to fill form; right-click for options";
        item.addEventListener("click", () => {
            fillFormFromProfile(p);
            popup.hidden = true;
        });
        popup.appendChild(item);
    };
    if (profiles.length === 0) {
        const empty = document.createElement("div");
        empty.className = "combo-item combo-empty";
        empty.textContent = "No saved connections yet — connect once and it will appear here.";
        popup.appendChild(empty);
    } else {
        const pinnedCount = profiles.filter((p) => (p.pinnedAt ?? 0) > 0).length;
        const recentCount = profiles.length > RECENT_SECTION_SIZE
            ? Math.max(pinnedCount, RECENT_SECTION_SIZE)
            : profiles.length;
        profiles.forEach((p, i) => {
            if (i === recentCount) {
                const sep = document.createElement("div");
                sep.className = "combo-separator";
                popup.appendChild(sep);
            }
            addItem(p);
        });
    }
    popup.hidden = false;
}

// Delegate contextmenu from the popup container with capture — more reliable
// in WKWebView than per-button listeners (buttons can swallow/retarget it).
document.addEventListener(
    "contextmenu",
    (ev) => {
        const target = (ev.target as HTMLElement).closest<HTMLElement>(".combo-item[data-profile-name]");
        if (!target) return;
        ev.preventDefault();
        ev.stopPropagation();
        const p = profiles.find((x) => x.name === target.dataset.profileName);
        if (p) showProfileContextMenu(p, ev.clientX, ev.clientY);
    },
    true,
);

el<HTMLButtonElement>("btn-saved-hosts").addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleSavedHosts();
});

document.addEventListener("click", (ev) => {
    const popup = el<HTMLDivElement>("saved-hosts-popup");
    if (!popup.hidden && !(ev.target as HTMLElement).closest(".host-combo")) {
        popup.hidden = true;
    }
});

void loadProfiles();

// --- Editor/results splitter (ACS-style vertical resize) ---
(() => {
    const splitter = el<HTMLDivElement>("splitter");
    const editor = document.querySelector<HTMLElement>(".editor-wrap");
    if (!editor) return;
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    const onMove = (ev: MouseEvent) => {
        if (!dragging) return;
        const delta = ev.clientY - startY;
        const minEditor = 70;
        const maxEditor = window.innerHeight - 220;
        editor.style.height = `${Math.min(maxEditor, Math.max(minEditor, startHeight + delta))}px`;
        editor.style.flex = "none";
    };
    const onUp = () => {
        dragging = false;
        document.body.classList.remove("resizing-v");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
    };
    splitter.addEventListener("mousedown", (ev) => {
        dragging = true;
        startY = ev.clientY;
        startHeight = editor.getBoundingClientRect().height;
        document.body.classList.add("resizing-v");
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        ev.preventDefault();
    });
})();

if (detachedConnId) {
    // Torn-off window: single connection, no tab strip, no connect form.
    // Boot from the Go workspace store (shared with the main window), then
    // subscribe to live updates via workspace:changed.
    document.getElementById("conn-tabs")!.style.display = "none";
    els.connectPanel.hidden = true;
    const tab: ConnectionTab = {
        key: "detached",
        label: "Detached",
        connectionId: detachedConnId,
        cursorId: null,
        hasCursor: false,
    };
    tabs.push(tab);
    activeTabKey = tab.key;
    // Set all buttons consistently from the tab's connected state (Connect
    // disabled, Disconnect enabled, Run/Prompt enabled).
    syncConnectionUi();
    els.badge.textContent = "Detached window";
    els.badge.className = "badge connected";
    const btnReattach = el<HTMLButtonElement>("btn-reattach");
    btnReattach.hidden = false;
    btnReattach.addEventListener("click", () => {
        void App().AttachConnection(detachedConnId);
    });

    interface WorkspaceMirror {
        label?: string; editorText?: string; statusText?: string; messagesHtml?: string;
        columns?: ColumnInfo[]; rows?: unknown[][]; cursorId?: string; more?: boolean; showingResults?: boolean;
    }

    // Apply a workspace snapshot pushed from the Go store. Editor text is only
    // overwritten when it differs, so our own keystrokes (echoed back via
    // UpdateEditorText) never reset the caret.
    const applyWorkspace = (ws: WorkspaceMirror): void => {
        if (ws.label) {
            tab.label = ws.label;
            els.badge.textContent = ws.label + " (detached)";
        }
        if (typeof ws.editorText === "string" && ws.editorText !== els.sqlInput.value) {
            els.sqlInput.value = ws.editorText;
        }
        if (typeof ws.statusText === "string" && ws.statusText !== els.statusText.textContent) {
            els.statusText.textContent = ws.statusText;
        }
        if (typeof ws.messagesHtml === "string" && ws.messagesHtml !== els.messageList.innerHTML) {
            els.messageList.innerHTML = ws.messagesHtml;
        }
        if (ws.showingResults && ws.columns) {
            state.columns = [...ws.columns];
            state.rows = (ws.rows ?? []).map((r) => [...r]);
            state.cursorId = ws.cursorId ?? null;
            state.more = !!ws.more;
            renderTable();
            els.btnLoadMore.hidden = !state.more;
            els.btnLoadAll.hidden = !state.more;
            showPane("results");
        }
    };

    void (async () => {
        const app = App();
        try {
            applyWorkspace((await app.GetWorkspace(detachedConnId)) as WorkspaceMirror);
        } catch {
            // workspace empty or not found: window starts blank on a live connection
        }
        // Live updates from either window after boot.
        Events.On(`workspace:changed:${detachedConnId}`, (ev: { data?: WorkspaceMirror }) => {
            if (ev?.data) applyWorkspace(ev.data);
        });
    })();
} else {
    addTab();
}
