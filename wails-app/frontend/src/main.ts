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
    type AppSettings,
    type CLMessage,
    type CLResult,
    type ColumnInfo,
    type ConnectionProfile,
    type ConnectResponse,
    type SqlMessage,
    type SqlResult,
} from "./types";
import { splitStatements, statementAt, statementsFrom } from "./statements";
import { arrowRecallDirection, InputHistoryStore } from "./inputHistory";
import { parseCmdXml } from "./clprompter/prompterModel";
import { showPrompter } from "./clprompter/prompterView";
import { buildSpooledFileRequest, createSpoolPane, isAfpdsFile, type SpoolFilters } from "./spool";
import { createSettingsPane, type SettingDef } from "./settings";
import { createConnectionsPane } from "./connections";
import { renderScsBytes, formatOsVersion } from "./scsRender";
import { formatResultData, type SaveFormat } from "./resultExport";
import { showHistoryPicker } from "./stmtHistory";
import type { SpooledFileInfo } from "./types";
import { t } from "./l10n";

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
    themeSelect: el<HTMLSelectElement>("sel-theme"),
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
    saveResultsWrap: el<HTMLSpanElement>("save-results-wrap"),
    btnSaveResults: el<HTMLButtonElement>("btn-save-results"),
    selSaveFormat: el<HTMLSelectElement>("sel-save-format"),
};

// --- Color mode (light/dark/system) ---
type ThemeMode = "light" | "dark" | "system";
const THEME_KEY = "ibmi-runsql-theme";

function applyTheme(mode: ThemeMode): void {
    const dark = mode === "dark" ||
        (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

function setTheme(mode: ThemeMode): void {
    localStorage.setItem(THEME_KEY, mode);
    els.themeSelect.value = mode;
    applyTheme(mode);
}

function currentTheme(): ThemeMode {
    return (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "system";
}

function initTheme(): void {
    applyTheme(currentTheme());
    els.themeSelect.value = currentTheme();
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (currentTheme() === "system") applyTheme("system");
    });
    els.themeSelect.addEventListener("change", () => {
        setTheme(els.themeSelect.value as ThemeMode);
    });
}
initTheme();

// Static index.html strings: the English markup is the fallback/pre-JS paint;
// overwrite textContent/title/placeholder from the catalog once at boot.
// Only elements that have ids in index.html are handled here.
function applyL10nToStaticDom(): void {
    const setText = (id: string, value: string) => {
        const node = document.getElementById(id);
        if (node) node.textContent = value;
    };
    const setTitle = (id: string, value: string) => {
        const node = document.getElementById(id);
        if (node) node.title = value;
    };
    const setPlaceholder = (id: string, value: string) => {
        const node = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
        if (node) node.placeholder = value;
    };
    setText("btn-reattach", t("html.reattach", "Reattach"));
    setTitle("btn-reattach", t("html.reattachTitle", "Close this window and keep the connection in the main window"));
    setText("btn-connect", t("main.connect", "Connect"));
    setText("btn-disconnect", t("main.disconnect", "Disconnect"));
    setTitle("btn-new-conn", t("html.newConnTitle", "New connection tab"));
    setPlaceholder("in-host", t("html.hostPlaceholder", "my.ibmi.host"));
    setPlaceholder("in-schema", t("html.schemaPlaceholder", "(optional)"));
    setTitle("btn-saved-hosts", t("main.savedConnections", "Quick Connect: saved connections"));
    setTitle("btn-run", t("html.runTitle", "Run Selected (statement at cursor; Cmd/Ctrl+Enter)"));
    setTitle("btn-run-all", t("html.runAllTitle", "Run All (every statement, first to last)"));
    setTitle("btn-run-from", t("html.runFromTitle", "Run from Selected (cursor statement through the last)"));
    setText("btn-cancel", t("main.cancel", "Cancel"));
    setTitle("btn-cancel", t("html.cancelTitle", "Cancel running statement"));
    setText("btn-prompt", t("main.prompt", "Prompt"));
    setTitle("btn-prompt", t("html.promptTitle", "Prompt CL command (F4)"));
    setTitle("btn-script-open", t("html.openScriptTitle", "Open a .sql script into the editor (Ctrl/Cmd+O)"));
    setTitle("btn-script-save", t("html.saveScriptTitle", "Save the editor as a .sql file (Ctrl/Cmd+S)"));
    setTitle("splitter", t("html.splitterTitle", "Drag to resize"));
    setText("btn-load-more", t("html.loadMore", "Load more"));
    setText("btn-load-all", t("html.loadAll", "Load all"));
    setText("btn-save-results", t("main.saveResults", "Save as..."));
    setText("btn-open-results-dir", t("main.openResultsDir", "Open Folder"));
    setText("work-tab-spool", t("spool.tab", "Spooled Files"));
    setText("work-tab-connections", t("conn.tab", "Connections"));
    setText("work-tab-settings", t("settings.tab", "Settings"));
}
applyL10nToStaticDom();

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

function syncEmptyState(): void {
    const anyVisible = els.workArea.querySelector(".work-pane:not([hidden])") != null;
    // display:none must accompany hidden: .empty-state's display:flex in
    // style.css outranks the UA [hidden] rule, so hidden alone is not enough.
    els.emptyState.style.display = anyVisible ? "none" : "";
    els.emptyState.hidden = anyVisible;
}

function showPane(name: string): void {
    // Going back to a shallower prompter closes anything nested below it.
    if (name.startsWith("prompter-")) {
        closePrompterPanesBelow(prompterDepth(name));
    }
    activePane = name;
    const disconnected = !activeTab()?.connectionId;
    // Connections/Settings are connection-independent: they open even when
    // disconnected. Everything else waits for a connection.
    const alwaysAvailable = name === "connections" || name === "settings";
    for (const pane of Array.from(els.workArea.querySelectorAll<HTMLElement>(".work-pane"))) {
        pane.hidden = (disconnected && !alwaysAvailable) ? true : pane.dataset.pane !== name;
    }
    for (const tab of Array.from(els.workTabs.querySelectorAll<HTMLElement>(".work-tab"))) {
        tab.classList.toggle("active", tab.dataset.pane === name);
    }
    syncEmptyState();
}

// --- Spooled Files pane (stage 1: list + filter + sort) ---
// Static "spool" work-pane; the tab lives in index.html next to Results.
// loadedFor tracks which connection the visible list came from so switching
// connection tabs and coming back re-fetches instead of showing stale files.
const spoolState = { loadedFor: "" };
const spool = createSpoolPane({
    onRefresh: (filters) => void refreshSpool(filters),
    onRowOpen: (f) => void spoolDblClick(f),
    onRowContext: (f, x, y, selected) => showSpoolContextMenu(f, x, y, selected),
    onAction: () => {
        App()?.OpenSpoolDownloadDir().catch((err) => showMessages([], String((err as Error)?.message ?? err)));
    },
});
els.workArea.appendChild(spool.root);

// --- Settings pane: INI-style key list + typed editor (settings.ts) ---
// Persisted values live in Go's settings.json; "theme" mirrors the titlebar
// dropdown via localStorage (front-end-only setting, onChanged applies it).
const SETTING_DEFS: SettingDef[] = [
    {
        key: "theme",
        type: "choice",
        options: [["system", "System"], ["light", "Light"], ["dark", "Dark"]],
        get: () => currentTheme(),
        withValue: (s) => s,
        persist: async (v) => { localStorage.setItem(THEME_KEY, v); },
    },
    {
        key: "spoolDownloadDir",
        type: "folder",
        placeholder: "~/Downloads (default)",
        get: (s) => s.spoolDownloadDir ?? "",
        withValue: (s, v) => ({ ...s, spoolDownloadDir: v }),
        browse: () => App()?.PickDirectory(t("settings.spoolDownloadDir.browseTitle", "Select download folder")) ?? Promise.resolve(""),
    },
    {
        key: "scriptsDir",
        type: "folder",
        placeholder: "~/Downloads (default)",
        get: (s) => s.scriptsDir ?? "",
        withValue: (s, v) => ({ ...s, scriptsDir: v }),
        browse: () => App()?.PickDirectory(t("settings.scriptsDir.browseTitle", "Select scripts folder")) ?? Promise.resolve(""),
        persist: (v) => App()?.SetAppSetting("scriptsDir", v) ?? Promise.resolve(),
    },
    {
        key: "fetchSize",
        type: "number",
        min: 10,
        max: 10000,
        placeholder: "200",
        get: (s) => String(s.fetchSize ?? ""),
        withValue: (s, v) => ({ ...s, fetchSize: v === "" ? undefined : Number(v) }),
        persist: (v) => App()?.SetAppSetting("fetchSize", v) ?? Promise.resolve(),
    },
    {
        key: "spoolDblClickAction",
        type: "choice",
        options: [
            ["view", "View"],
            ["dlPdf", "Download as PDF"],
            ["dlText", "Download as Text"],
            ["print", "Print locally"],
        ],
        get: (s) => s.spoolDblClickAction || "view",
        withValue: (s, v) => ({ ...s, spoolDblClickAction: v as AppSettings["spoolDblClickAction"] }),
        persist: (v) => App()?.SetAppSetting("spoolDblClickAction", v) ?? Promise.resolve(),
    },
    {
        key: "defaultNaming",
        type: "choice",
        options: [["sql", "SQL naming"], ["system", "System naming"]],
        get: (s) => s.defaultNaming || "sql",
        withValue: (s, v) => ({ ...s, defaultNaming: v as AppSettings["defaultNaming"] }),
        persist: (v) => App()?.SetAppSetting("defaultNaming", v) ?? Promise.resolve(),
    },
    {
        key: "resultsFontSize",
        type: "number",
        min: 9,
        max: 24,
        placeholder: "12",
        get: () => localStorage.getItem("ibmi-runsql-results-font") ?? "",
        withValue: (s) => s,
        persist: async (v) => { localStorage.setItem("ibmi-runsql-results-font", v); },
    },
    {
        key: "spoolMaxRows",
        type: "number",
        min: 0,
        max: 100000,
        placeholder: "5000",
        get: (s) => String(s.spoolMaxRows ?? ""),
        withValue: (s, v) => ({ ...s, spoolMaxRows: v === "" ? undefined : Number(v) }),
        persist: (v) => App()?.SetAppSetting("spoolMaxRows", v) ?? Promise.resolve(),
    },
    {
        key: "confirmSpoolDelete",
        type: "choice",
        options: [["on", "On"], ["off", "Off"]],
        get: (s) => (s.confirmSpoolDelete === false ? "off" : "on"),
        withValue: (s, v) => ({ ...s, confirmSpoolDelete: v !== "off" }),
        persist: (v) => App()?.SetAppSetting("confirmSpoolDelete", v) ?? Promise.resolve(),
    },
];
{
    const app = App();
    const host = document.getElementById("pane-settings");
    if (app && host) {
        const pane = createSettingsPane({
            load: async () => {
                const s = await app.GetAppSettings();
                appSettingsCache = s;
                if (s.fetchSize) state.fetchSize = s.fetchSize;
                spoolDblClickAction = (s.spoolDblClickAction || "view") as SpoolDblClickAction;
                confirmSpoolDelete = s.confirmSpoolDelete !== false;
                return s;
            },
            save: (next) => app.SetAppSetting("spoolDownloadDir", next.spoolDownloadDir ?? ""),
            onSaved: () => appendLogLine(t("settings.saved", "Settings saved"), "msg-info", true),
            onError: (msg) => showMessages([], msg),
            onChanged: (key, value) => {
                if (key === "theme") setTheme(value as ThemeMode);
                else if (key === "fetchSize") state.fetchSize = Number(value) || 200;
                else if (key === "spoolDblClickAction") spoolDblClickAction = (value || "view") as SpoolDblClickAction;
                else if (key === "defaultNaming") el<HTMLSelectElement>("in-naming").value = value || "sql";
                else if (key === "resultsFontSize") applyResultsFontSize(Number(value) || 12);
                else if (key === "spoolMaxRows") appSettingsCache = { ...appSettingsCache, spoolMaxRows: Number(value) || 0 };
                else if (key === "confirmSpoolDelete") confirmSpoolDelete = value !== "off";
            },
        }, SETTING_DEFS);
        host.appendChild(pane.root);
    }
    // Apply the persisted results font size at boot (no settings read needed —
    // it lives in localStorage like the theme).
    const savedFont = localStorage.getItem("ibmi-runsql-results-font");
    if (savedFont) applyResultsFontSize(Number(savedFont) || 12);
    // --- Connections pane: profile editor (connections.ts) ---
    const connHost = document.getElementById("pane-connections");
    if (app && connHost) {
        const pane = createConnectionsPane({
            load: () => app.ListConnectionProfiles(),
            save: (origName, p) => app.UpdateConnectionProfile(origName, p),
            remove: (name) => app.DeleteConnectionProfile(name),
            getPassword: (name) => app.GetProfilePassword(name),
            onChanged: () => void loadProfiles(),
            onError: (msg) => showMessages([], msg),
            onConnect: (p) => void connectToProfile(p),
            onReorder: (names) => app.ReorderConnectionProfiles(names),
        });
        connHost.appendChild(pane.root);
    }
}

/** Double-click dispatch for spool rows, per the Settings choice. */
type SpoolDblClickAction = "view" | "dlPdf" | "dlText" | "print";
let spoolDblClickAction: SpoolDblClickAction = "view";
async function spoolDblClick(f: SpooledFileInfo): Promise<void> {
    switch (spoolDblClickAction) {
        case "dlPdf": await downloadSpooledFile(f, "pdf"); break;
        case "dlText": await downloadSpooledFile(f, "text"); break;
        case "print": await printSpooledFile(f); break;
        default: await viewSpooledFile(f);
    }
}

/** Settings-backed toggles applied across the UI. */
let confirmSpoolDelete = true;
let preloadSpoolList = true;
let appSettingsCache: AppSettings = {};
function spoolMaxRowsSetting(): number {
    return appSettingsCache.spoolMaxRows ?? 0;
}
function applyResultsFontSize(px: number): void {
    document.documentElement.style.setProperty("--results-font-size", `${px}px`);
}

type SpoolTarget = { connectionId: string; name: string; number: string; jobName: string; jobUser: string; jobNumber: string; deviceType?: string };

function spoolTarget(f: SpooledFileInfo): SpoolTarget | null {
    const connectionId = activeTab()?.connectionId ?? "";
    if (!connectionId) return null;
    return { connectionId, name: f.name, number: f.number, jobName: f.jobName, jobUser: f.jobUser, jobNumber: f.jobNumber, deviceType: f.deviceType };
}

/** Download/print file name base: name + job number + splf number, so repeated
 * creations of the same file name in one job never overwrite each other. */
function spoolFileBaseName(f: SpooledFileInfo): string {
    return `${f.name.trim()}_${f.jobNumber.trim()}_${f.number.trim()}`;
}

/** Busy indication for spool fetch operations (View/Download/SaveRaw/Print):
 * contrast-colored pulsing status text in the bottom tab bar while the bridge
 * call runs. clearSpoolBusy removes the styling; callers set the follow-up
 * text (Saved..., or blank) themselves. */
function setSpoolBusy(name: string): void {
    setSpoolBusyText(t("spool.statusGetting", "Retrieving spooled file {name}...").replace("{name}", name));
}

/** Per-file progress during a multi-file operation: "Retrieving (2 of 5)...". */
function setSpoolBusyProgress(name: string, index: number, total: number): void {
    setSpoolBusyText(t("spool.statusGettingOf", "Retrieving spooled file {name} ({index} of {total})...")
        .replace("{name}", name).replace("{index}", String(index)).replace("{total}", String(total)));
}

function setSpoolBusyText(text: string): void {
    els.statusText.textContent = text;
    els.statusText.classList.add("status-busy");
}

function clearSpoolBusy(): void {
    els.statusText.classList.remove("status-busy");
}

function b64ToText(b64: string): string {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bin);
}

/** Clipboard fallback for non-secure contexts (execCommand copy). */
function legacyCopy(text: string): void {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* no-op */ }
    ta.remove();
}

/** Render the JT400 page stream to clean display text. Each record arrives
 * as "\u0000\u0094{" + one column byte + text; records are separated by
 * "\u0000\n" and pages by "\f". The column byte is the 1-based target column
 * (high-bit bytes are the stream's offset form: byte-106). Column moves pad
 * with blanks; pure-positioning segments are dropped. Returns { lines,
 * pageCount }. */
/** Render a spooled page stream to display text. Raw SCS bytes (Latin-1-mapped
 * char codes) go through the byte-level SCS interpreter; otherwise the text is
 * already decoded and split on \n / \f. Returns { lines, pageCount }. */
export function renderSpoolText(base64: string): { lines: string[]; pageCount: number } {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return renderScsBytes(bytes);
}

/** Build a minimal single-font text PDF from decoded spooled text, returned as
 * base64. No host print transform needed. */
export function textToPdfBase64(text: string): string {
    return linesToPdfBase64(renderSpoolText(text).lines);
}

/** True when the raw page-stream bytes are already a PDF document — a
 * *USERASCII spooled file produced by a PDF-generating tool (InfoPrint,
 * Transform Services, third-party forms packages). The bytes then pass
 * through untouched, graphics included, instead of being parsed as SCS. */
function isUserAsciiPdf(f: SpooledFileInfo, base64: string): boolean {
    return f.deviceType.toUpperCase() === "*USERASCII" && (base64 ?? "").startsWith("JVBERi0");
}

/** Build a PDF from pre-rendered spooled text lines ("\f" entries = page
 * ejects). Multi-file prints join files with a "\f" separator and call this. */
export function linesToPdfBase64(lines: string[]): string {
    const clean = lines.filter((l) => l !== "\f");
    // Classic SCS output is 132 columns; switch to landscape when any line is
    // wider than an 80-col portrait page fits. Courier 9pt char width ~5.4pt.
    const maxLen = clean.reduce((m, l) => Math.max(m, l.length), 0);
    const landscape = maxLen > 80;
    const pageW = landscape ? 792 : 612;
    const pageH = landscape ? 612 : 792;
    const marginX = 40;
    // Fit the longest line: shrink font if needed so it never truncates.
    const charW = 0.6; // Courier advance = 0.6 * fontSize
    let fontSize = 9;
    const usable = pageW - marginX * 2;
    if (maxLen > 0) {
        const fit = usable / (maxLen * charW);
        if (fit < fontSize) fontSize = Math.max(5, Math.floor(fit * 10) / 10);
    }
    const lineHeight = fontSize;
    const startY = pageH - 28;
    const perPage = Math.max(1, Math.floor((startY - 14) / lineHeight));
    // Honor the spooled file's own page ejects: the SCS renderer marks page
    // breaks with "\f" line entries. Split there; within a page, wrap to extra
    // PDF pages only if it overflows perPage lines.
    const pages: string[] = [];
    let cur: string[] = [];
    for (const ln of lines) {
        if (ln === "\f") {
            for (let i = 0; i < cur.length; i += perPage) pages.push(cur.slice(i, i + perPage).join("\n"));
            cur = [];
            continue;
        }
        cur.push(ln);
    }
    for (let i = 0; i < cur.length; i += perPage) pages.push(cur.slice(i, i + perPage).join("\n"));
    if (pages.length === 0) pages.push("");

    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    const objects: string[] = [];
    // 1 catalog, 2 pages, 3 font, then per-page: page obj + content obj.
    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    const pageCount = pages.length;
    const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
    objects[1] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
    objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
    pages.forEach((pg, i) => {
        const pageObj = 4 + i * 2;
        const contentObj = pageObj + 1;
        objects[pageObj - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObj} 0 R >>`;
        let stream = `BT /F1 ${fontSize} Tf ${marginX} ${startY} Td ${lineHeight} TL\n`;
        for (const ln of pg.split("\n")) stream += `(${esc(ln)}) Tj T*\n`;
        stream += "ET";
        objects[contentObj - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });

    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, idx) => {
        offsets.push(pdf.length);
        pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefPos = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    return btoa(pdf);
}

/** Text viewer overlay for a spooled file (View / double-click).
 * Multi-select: each file gets its own viewer; overlays open cascaded.
 * *AFPDS files delegate to the image viewer (host GIF page transform). */
async function viewSpooledFile(f: SpooledFileInfo, cascadeIndex = 0): Promise<void> {
    if (isAfpdsFile(f)) {
        await viewSpooledImageFile(f, cascadeIndex);
        return;
    }
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logView", "View {name}...").replace("{name}", f.name)}`, "msg-action");
    setSpoolBusy(f.name);
    try {
        const res = await app.GetSpooledFileData({ ...target, format: "raw" });
        const overlay = document.createElement("div");
        overlay.className = "spool-viewer-overlay";
        const box = document.createElement("div");
        box.className = "spool-viewer";
        if (cascadeIndex > 0) {
            // Stagger stacked viewers so the user can see more than one open.
            box.style.marginLeft = `${Math.min(cascadeIndex * 40, 300)}px`;
            box.style.marginTop = `${Math.min(cascadeIndex * 30, 180)}px`;
        }
        const head = document.createElement("div");
        head.className = "spool-viewer-head";
        const title = document.createElement("span");
        title.className = "spool-viewer-title";
        title.textContent = `${f.name}  ${f.jobNumber}/${f.jobUser}/${f.jobName}`;
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "btn spool-copy-btn";
        copyBtn.title = t("spool.copyTitle", "Copy to clipboard");
        copyBtn.textContent = "⧉";
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "btn";
        closeBtn.textContent = t("spool.close", "Close");
        const close = () => { overlay.remove(); document.removeEventListener("keydown", onEsc); };
        closeBtn.addEventListener("click", close);
        head.appendChild(title);
        head.appendChild(copyBtn);
        head.appendChild(closeBtn);
        const pre = document.createElement("pre");
        pre.className = "spool-viewer-content";
        // Raw SCS bytes -> byte-level renderer keeps exact column positions.
        pre.textContent = renderSpoolText(res.base64 ?? "").lines
            .map((l) => (l === "\f" ? "\n" : l)).join("\n");
        copyBtn.addEventListener("click", () => {
            const text = pre.textContent ?? "";
            const done = () => appendLogLine(t("spool.logCopied", "Copied to clipboard"), "msg-info", true);
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(() => { legacyCopy(text); done(); });
            } else {
                legacyCopy(text);
                done();
            }
        });
        box.appendChild(head);
        box.appendChild(pre);
        overlay.appendChild(box);
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
        const onEsc = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            // Topmost overlay handles Esc; deeper ones stay open.
            if (overlay !== document.body.lastElementChild) return;
            close();
        };
        document.addEventListener("keydown", onEsc);
        document.body.appendChild(overlay);
        els.statusText.textContent = "";
    } catch (err) {
        els.statusText.textContent = "";
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        clearSpoolBusy();
    }
}

/** View each selected file in its own overlay (single fetch → open → next). */
async function viewSpooledFiles(files: SpooledFileInfo[]): Promise<void> {
    if (files.length === 0) return;
    if (files.length === 1) {
        await viewSpooledFile(files[0]);
        return;
    }
    setSpoolBusyText(t("spool.statusViewing", "Viewing {count} spooled files...").replace("{count}", String(files.length)));
    for (let i = 0; i < files.length; i++) {
        await viewSpooledFile(files[i], i);
    }
    els.statusText.textContent = "";
}

/** Image viewer overlay for *AFPDS spooled files: per-page GIF images from
 * the bridge's Host Print Transform path (QWPGIF WSCST), stacked and
 * scrollable. Degrades to a log message when the host lacks the transform. */
async function viewSpooledImageFile(f: SpooledFileInfo, cascadeIndex = 0): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logViewImg", "View {name} as images...").replace("{name}", f.name)}`, "msg-action");
    setSpoolBusy(f.name);
    try {
        const res = await app.GetSpooledFileData({ ...target, format: "image" });
        if (res.errorCode) {
            appendLogLine(t("spool.logNoImage", "AFP image view is not available on this system (host print transform missing); use Download Raw"), "msg-error", true);
            els.statusText.textContent = "";
            return;
        }
        const pages = res.pages ?? [];
        const contentType = res.contentType || "image/gif";
        const overlay = document.createElement("div");
        overlay.className = "spool-viewer-overlay";
        const box = document.createElement("div");
        box.className = "spool-viewer";
        if (cascadeIndex > 0) {
            box.style.marginLeft = `${Math.min(cascadeIndex * 40, 300)}px`;
            box.style.marginTop = `${Math.min(cascadeIndex * 30, 180)}px`;
        }
        const head = document.createElement("div");
        head.className = "spool-viewer-head";
        const title = document.createElement("span");
        title.className = "spool-viewer-title";
        title.textContent = `${f.name}  ${f.jobNumber}/${f.jobUser}/${f.jobName}`
            + `  (${t("spool.imgPages", "{count} page(s)").replace("{count}", String(pages.length))})`;
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "btn";
        closeBtn.textContent = t("spool.close", "Close");
        const close = () => { overlay.remove(); document.removeEventListener("keydown", onEsc); };
        closeBtn.addEventListener("click", close);
        head.appendChild(title);
        head.appendChild(closeBtn);
        const imgBox = document.createElement("div");
        imgBox.className = "spool-viewer-images";
        pages.forEach((b64) => {
            const img = document.createElement("img");
            img.src = `data:${contentType};base64,${b64}`;
            img.className = "spool-viewer-page";
            imgBox.appendChild(img);
        });
        if (pages.length === 0) {
            const empty = document.createElement("div");
            empty.className = "spool-outq-empty";
            empty.textContent = t("spool.imgEmpty", "No pages returned by the host transform.");
            imgBox.appendChild(empty);
        }
        box.appendChild(head);
        box.appendChild(imgBox);
        overlay.appendChild(box);
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
        const onEsc = (ev: KeyboardEvent) => {
            if (ev.key !== "Escape") return;
            if (overlay !== document.body.lastElementChild) return;
            close();
        };
        document.addEventListener("keydown", onEsc);
        document.body.appendChild(overlay);
        els.statusText.textContent = "";
    } catch (err) {
        els.statusText.textContent = "";
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        clearSpoolBusy();
    }
}

/** Download the raw spooled bytes (no rendering) to ~/Downloads. Extension by
 * data stream: .afp for *AFPDS, .pdf when the payload is already a PDF
 * (*USERASCII), .raw otherwise. format="raw" skips the bridge CCSID decode. */
async function saveRawSpooledFile(f: SpooledFileInfo, openAfter = true, idx = 0, total = 1): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logRaw", "Download raw {name}...").replace("{name}", f.name)}`, "msg-action");
    if (total > 1) setSpoolBusyProgress(f.name, idx + 1, total); else setSpoolBusy(f.name);
    try {
        const res = await app.GetSpooledFileData({ ...target, format: "raw" });
        const b64 = res.base64 ?? "";
        const dt = (f.deviceType ?? "").toUpperCase().trim();
        const ext = dt === "*AFPDS" ? "afp"
            : dt === "*USERASCII" && b64.startsWith("JVBERi0") ? "pdf"
                : "raw";
        const saved = await app.SaveSpooledFile(`${spoolFileBaseName(f)}.${ext}`, b64);
        appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
        els.statusText.textContent = t("spool.statusSaved", "Saved {path}").replace("{path}", saved);
        if (openAfter) await app.OpenSpooledFile(saved);
    } catch (err) {
        els.statusText.textContent = "";
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        clearSpoolBusy();
    }
}

/** Save raw for each selected file; auto-open only for a single file. */
async function saveRawSpooledFiles(files: SpooledFileInfo[]): Promise<void> {
    for (let i = 0; i < files.length; i++) await saveRawSpooledFile(files[i], files.length === 1, i, files.length);
}

/** Download a spooled file as PDF or text to ~/Downloads. */
async function downloadSpooledFile(f: SpooledFileInfo, format: "pdf" | "text", openAfter = true, idx = 0, total = 1): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logDownload", "Download {name} as {fmt}...").replace("{name}", f.name).replace("{fmt}", format.toUpperCase())}`, "msg-action");
    if (total > 1) setSpoolBusyProgress(f.name, idx + 1, total); else setSpoolBusy(f.name);
    try {
        let base64: string;
        if (format === "pdf") {
            // SCS text → client-rendered PDF (non-SCS types don't reach here:
            // their menu only offers Download Raw).
            const textRes = await app.GetSpooledFileData({ ...target, format: "raw" });
            base64 = textToPdfBase64(textRes.base64 ?? "");
        } else {
            // Text download: same cleaned rendering the viewer shows, then
            // re-encode as base64 for the Go save routine.
            const res = await app.GetSpooledFileData({ ...target, format: "raw" });
            const text = renderSpoolText(res.base64 ?? "").lines
                .map((l) => (l === "\f" ? "" : l)).join("\n");
            base64 = btoa(unescape(encodeURIComponent(text)));
        }
        const saved = await app.SaveSpooledFile(`${spoolFileBaseName(f)}.${format === "pdf" ? "pdf" : "txt"}`, base64);
        appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
        els.statusText.textContent = t("spool.statusSaved", "Saved {path}").replace("{path}", saved);
        // Open the download with the OS default handler so the user can view it.
        if (openAfter) await app.OpenSpooledFile(saved);
    } catch (err) {
        els.statusText.textContent = "";
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        clearSpoolBusy();
    }
}

/** Download each selected file; auto-open only for a single file. */
async function downloadSpooledFiles(files: SpooledFileInfo[], format: "pdf" | "text"): Promise<void> {
    for (let i = 0; i < files.length; i++) await downloadSpooledFile(files[i], format, files.length === 1, i, files.length);
}

/** Print locally: fetch the PDF and hand it to the OS (print dialog). */
async function printSpooledFile(f: SpooledFileInfo): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logPrint", "Print {name}...").replace("{name}", f.name)}`, "msg-action");
    setSpoolBusy(f.name);
    try {
        const textRes = await app.GetSpooledFileData({ ...target, format: "raw" });
        const base64 = textToPdfBase64(textRes.base64 ?? "");
        await app.PrintSpooledFile(`${spoolFileBaseName(f)}.pdf`, base64);
        appendLogLine(t("spool.logPrinted", "Sent {name} to the OS print handler").replace("{name}", f.name), "msg-info", true);
        els.statusText.textContent = "";
    } catch (err) {
        els.statusText.textContent = "";
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        clearSpoolBusy();
    }
}

/** Multi-print: combine into one PDF (page eject between files) so the OS
 * shows a single print dialog. */
async function printSpooledFiles(files: SpooledFileInfo[]): Promise<void> {
    const app = App();
    if (!app || files.length === 0) return;
    if (files.length === 1) {
        await printSpooledFile(files[0]);
        return;
    }
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logPrintMulti", "Print {count} spooled files...").replace("{count}", String(files.length))}`, "msg-action");
    try {
        const allLines: string[] = [];
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const target = spoolTarget(f);
            if (!target) continue;
            setSpoolBusyProgress(f.name, i + 1, files.length);
            const res = await app.GetSpooledFileData({ ...target, format: "raw" });
            if (allLines.length > 0) allLines.push("\f");
            allLines.push(...renderSpoolText(res.base64 ?? "").lines);
        }
        setSpoolBusyText(t("spool.statusPrinting", "Sending {count} spooled files to print...").replace("{count}", String(files.length)));
        await app.PrintSpooledFile("spooled_files.pdf", linesToPdfBase64(allLines));
        appendLogLine(t("spool.logPrintedMulti", "Sent {count} spooled files to the OS print handler").replace("{count}", String(files.length)), "msg-info", true);
        els.statusText.textContent = "";
    } catch (err) {
        els.statusText.textContent = "";
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        clearSpoolBusy();
    }
}

/** Run hold/release/delete on each file sequentially; one refresh at the end. */
async function spoolActions(files: SpooledFileInfo[], action: "hold" | "release" | "delete"): Promise<void> {
    const app = App();
    if (!app || files.length === 0) return;
    for (const f of files) {
        const target = spoolTarget(f);
        if (!target) continue;
        appendLogLine(`[ ${nowStamp()} ]  ${action} ${f.name}...`, "msg-action");
        try {
            const res = await app.SpooledFileAction({ ...target, action });
            appendLogLine(`${res.message}   (${res.elapsedMs} ms)`, res.ok ? "msg-info" : "msg-error", true);
        } catch (err) {
            showMessages([], String((err as Error)?.message ?? err));
        }
    }
    void refreshSpool(spool.filters());
}

let contextMenuEl: HTMLDivElement | undefined;
function closeContextMenu(): void {
    contextMenuEl?.remove();
    contextMenuEl = undefined;
}

/** CL-style "Move to Output Queue" dialog: Output queue + Library fields,
 * MOVE/CANCEL buttons, and F4/Select to open a filtered queue picker.
 * Multi-selection: one dialog, files moved sequentially to the same queue. */
function moveSpooledFilesDialog(files: SpooledFileInfo[]): void {
    const app = App();
    const f0 = files[0];
    const target0 = f0 ? spoolTarget(f0) : null;
    if (!app || !f0 || !target0) return;
    const overlay = document.createElement("div");
    overlay.className = "spool-viewer-overlay";
    const box = document.createElement("div");
    box.className = "spool-move-dialog";
    box.innerHTML = `<div class="spool-move-title">${t("spool.moveTitle", "Move to Output Queue")}</div>
        <label>${t("spool.moveFile", "Spooled file:")}<input id="mv-file" type="text" readonly tabindex="-1" /></label>
        <label>${t("spool.moveNumber", "Spooled File Nbr:")}<input id="mv-filenum" type="text" readonly tabindex="-1" /></label>
        <label>${t("spool.moveQueue", "Output queue:")}<input id="mv-outq" type="text" maxlength="10" autocapitalize="off" spellcheck="false" /></label>
        <label>${t("spool.moveLibrary", "Library:")}<input id="mv-outqlib" type="text" maxlength="10" autocapitalize="off" spellcheck="false" placeholder="*LIBL" /></label>
        <label class="spool-move-hold">${t("spool.moveHold", "Hold on output queue:")}<select id="mv-hold" class="spool-move-holdfield"><option value="yes">*YES</option><option value="no" selected>*NO</option></select></label>
        <div class="spool-move-buttons">
            <span class="spool-f4-hint" id="mv-f4">${t("spool.moveSelect", "F4=List")}</span>
            <button type="button" id="mv-ok" class="btn primary">${t("spool.moveOk", "Move")}</button>
            <button type="button" id="mv-cancel" class="btn">${t("spool.moveCancel", "Cancel")}</button>
        </div>`;
    // Read-only context: the file(s) being moved + current queue prefilled.
    (box.querySelector("#mv-file") as HTMLInputElement).value = files.length > 1
        ? t("spool.moveFileMulti", "{count} spooled files").replace("{count}", String(files.length))
        : f0.name.trim();
    const numRow = (box.querySelector("#mv-filenum") as HTMLInputElement).closest("label") as HTMLElement;
    if (files.length > 1) {
        numRow.hidden = true;
    } else {
        (box.querySelector("#mv-filenum") as HTMLInputElement).value = f0.number.trim();
    }
    (box.querySelector("#mv-outq") as HTMLInputElement).value = f0.outqName.trim();
    (box.querySelector("#mv-outqlib") as HTMLInputElement).value = f0.outqLib.trim();
    // Reflect the file's current hold state in the Hold dropdown.
    const held = /^(yes|\*yes|hld|held)/i.test(f0.holdStatus.trim());
    (box.querySelector("#mv-hold") as HTMLSelectElement).value = held ? "yes" : "no";
    overlay.appendChild(box);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    const outq = box.querySelector<HTMLInputElement>("#mv-outq")!;
    const outqLib = box.querySelector<HTMLInputElement>("#mv-outqlib")!;
    const holdSel = box.querySelector<HTMLSelectElement>("#mv-hold")!;
    box.querySelector("#mv-cancel")!.addEventListener("click", close);
    const doMove = async () => {
        const toQueue = outq.value.trim();
        if (!toQueue) { outq.focus(); return; }
        const okBtn = box.querySelector<HTMLButtonElement>("#mv-ok")!;
        okBtn.disabled = true;
        // Hold first when *YES so the file cannot print on arrival.
        const holdFirst = holdSel.value === "yes";
        for (const f of files) {
            const target = spoolTarget(f);
            if (!target) continue;
            try {
                const res = await app.MoveSpooledFile({ ...target, toLibrary: outqLib.value.trim(), toQueue, holdFirst });
                appendLogLine(`${res.message}   (${res.elapsedMs} ms)`, res.ok ? "msg-info" : "msg-error", true);
            } catch (err) {
                appendLogLine(String((err as Error)?.message ?? err), "msg-error", true);
            }
        }
        close();
        void refreshSpool(spool.filters());
    };
    box.querySelector("#mv-ok")!.addEventListener("click", () => void doMove());
    box.querySelector("#mv-f4")!.addEventListener("click", () => openOutqPicker(target0.connectionId, (lib, name) => {
        outqLib.value = lib; outq.value = name;
    }));
    overlay.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") close();
        if (ev.key === "F4") openOutqPicker(target0.connectionId, (lib, name) => { outqLib.value = lib; outq.value = name; });
        if (ev.key === "Enter" && (ev.target as HTMLElement).tagName === "INPUT") void doMove();
    });
    document.body.appendChild(overlay);
    outq.focus();
}

/** Filterable output-queue picker (F4). Type-to-narrow name/library, capped
 * result list so large systems stay responsive. */
function openOutqPicker(connectionId: string, onPick: (lib: string, name: string) => void): void {
    const app = App();
    if (!app) return;
    const overlay = document.createElement("div");
    overlay.className = "spool-viewer-overlay";
    const box = document.createElement("div");
    box.className = "spool-outq-picker";
    box.innerHTML = `<div class="spool-move-title">${t("spool.pickOutq", "Select an output queue")}</div>
        <div class="spool-outq-filters">
            <input id="oq-name" type="text" maxlength="10" placeholder="${t("spool.pickName", "Name (blank = all)")}" autocapitalize="off" spellcheck="false" />
            <input id="oq-lib" type="text" maxlength="10" placeholder="${t("spool.pickLibrary", "Library (blank = all)")}" autocapitalize="off" spellcheck="false" />
            <button type="button" id="oq-refresh" class="btn">${t("spool.pickRefresh", "List")}</button>
        </div>
        <div id="oq-list" class="spool-outq-list"></div>
        <div class="spool-move-buttons"><button type="button" id="oq-close" class="btn">${t("spool.moveCancel", "Cancel")}</button></div>`;
    overlay.appendChild(box);
    const close = () => overlay.remove();
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    box.querySelector("#oq-close")!.addEventListener("click", close);
    const nameIn = box.querySelector<HTMLInputElement>("#oq-name")!;
    const libIn = box.querySelector<HTMLInputElement>("#oq-lib")!;
    const list = box.querySelector<HTMLDivElement>("#oq-list")!;
    const load = async () => {
        list.textContent = t("spool.pickLoading", "Loading...");
        try {
            const res = await app.ListOutputQueues({
                connectionId, nameFilter: nameIn.value.trim(), libraryFilter: libIn.value.trim(), limit: 500,
            });
            list.textContent = "";
            if (res.queues.length === 0) {
                const d = document.createElement("div");
                d.className = "spool-outq-empty";
                d.textContent = t("spool.pickNone", "No output queues match.");
                list.appendChild(d);
            }
            for (const q of res.queues) {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "spool-outq-item";
                const desc = q.description && q.description !== "*BLANK" ? `  ${q.description}` : "";
                item.textContent = `${q.library}/${q.name}${desc}`;
                item.addEventListener("click", () => { onPick(q.library, q.name); close(); });
                list.appendChild(item);
            }
        } catch (err) {
            list.textContent = String((err as Error)?.message ?? err);
        }
    };
    box.querySelector("#oq-refresh")!.addEventListener("click", () => void load());
    nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") void load(); });
    libIn.addEventListener("keydown", (e) => { if (e.key === "Enter") void load(); });
    overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") close(); });
    document.body.appendChild(overlay);
    nameIn.focus();
    void load();
}

function showSpoolContextMenu(f: SpooledFileInfo, x: number, y: number, selected: SpooledFileInfo[]): void {
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
        item.addEventListener("click", () => { closeContextMenu(); action(); });
        menu.appendChild(item);
    };
    const sep = () => {
        const d = document.createElement("div");
        d.className = "context-sep";
        menu.appendChild(d);
    };
    // The right-clicked row is always part of the selection (pane guarantees
    // it); actions apply to the whole selection.
    const targets = selected.length > 0 ? selected : [f];
    // Data-stream-aware menu: *SCS (or unknown) is text-renderable —
    // View/Text/PDF/Print. Everything else (*USERASCII, *AFPDS, ...) is a
    // binary payload: only Download Raw applies.
    const allScs = targets.every((g) => {
        const dt = (g.deviceType ?? "").toUpperCase().trim();
        return dt === "" || dt === "*SCS";
    });
    if (allScs) {
        addItem(t("spool.act.view", "View"), () => void viewSpooledFiles(targets));
        addItem(t("spool.act.copyRow", "Copy row"), () => {
            const text = targets.map((g) => [g.name, g.number, g.jobName, g.jobUser, g.jobNumber, g.userData,
            (g.outqLib || g.outqName ? `${g.outqLib}/${g.outqName}` : ""),
            `${g.createDate} ${g.createTime}`.trim(), String(g.pages), String(g.size),
            g.status, g.holdStatus].join("\t")).join("\n");
            // navigator.clipboard needs a secure context; fall back to execCommand.
            const done = () => appendLogLine(t("spool.logCopied", "Copied row to clipboard"), "msg-info", true);
            if (navigator.clipboard?.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(() => { legacyCopy(text); done(); });
            } else {
                legacyCopy(text);
                done();
            }
        });
        addItem(t("spool.act.dlPdf", "Download as PDF"), () => void downloadSpooledFiles(targets, "pdf"));
        addItem(t("spool.act.dlText", "Download as Text"), () => void downloadSpooledFiles(targets, "text"));
        addItem(t("spool.act.print", "Print locally"), () => void printSpooledFiles(targets));
    }
    // *AFPDS is a binary stream, but the host print transform can image it:
    // offer the page-image viewer alongside Download Raw.
    if (!allScs && targets.every(isAfpdsFile)) {
        addItem(t("spool.act.viewImages", "View as images"), () => void viewSpooledFiles(targets));
    }
    addItem(t("spool.act.saveRaw", "Download Raw"), () => void saveRawSpooledFiles(targets));
    sep();
    addItem(t("spool.act.move", "Move..."), () => moveSpooledFilesDialog(targets));
    addItem(t("spool.act.hold", "Hold"), () => void spoolActions(targets, "hold"));
    addItem(t("spool.act.release", "Release"), () => void spoolActions(targets, "release"));
    addItem(t("spool.act.delete", "Delete"), () => {
        if (!confirmSpoolDelete) {
            void spoolActions(targets, "delete");
            return;
        }
        const msg = targets.length > 1
            ? t("spool.confirmDeleteMulti", "Delete {count} spooled files?").replace("{count}", String(targets.length))
            : t("spool.confirmDelete", "Delete spooled file {name}?").replace("{name}", f.name);
        if (window.confirm(msg)) void spoolActions(targets, "delete");
    }, true);
    // Clamp inside the viewport — right-clicking a right-most column near
    // the window's right/bottom edge would otherwise clip the menu.
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (x + rect.width > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
        if (y + rect.height > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
    });
    document.body.appendChild(menu);
    contextMenuEl = menu;
}

async function refreshSpool(filters: SpoolFilters): Promise<void> {
    const app = App();
    const connectionId = activeTab()?.connectionId ?? "";
    if (!app || !connectionId) {
        showMessages([], t("spool.notConnected", "Connect to an IBM i to list spooled files."));
        return;
    }
    spool.setBusy(true);
    els.btnCancel.disabled = false;
    const started = performance.now();
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logList", "List Spooled Files...")}`, "msg-action");
    try {
        const cap = spoolMaxRowsSetting();
        const req = buildSpooledFileRequest(connectionId, filters);
        // The cap goes to the bridge: enumeration stops at maxRows and the
        // host open list closes, so giant queues never hit the 16MB
        // user-space limit ("list is too large for user space").
        req.maxRows = cap;
        const result = await app.ListSpooledFiles(req);
        const files = result.files ?? [];
        const count = files.length;
        const renderStart = performance.now();
        spool.setFiles(files);
        const renderMs = Math.round(performance.now() - renderStart);
        spoolState.loadedFor = connectionId;
        appendLogLine(t("spool.logListed", "Listed {count} spooled file(s)   ({ms} ms)")
            .replace("{count}", String(count)).replace("{ms}", String(result.elapsedMs)) + " "
            + t("spool.logTiming", "(open {open} ms, fetch {fetch} ms, render {render} ms)")
                .replace("{open}", String(result.openMs)).replace("{fetch}", String(result.iterateMs))
                .replace("{render}", String(renderMs))
            + (result.cancelled ? " " + t("spool.logCancelled", "(cancelled)")
                : result.truncated ? " " + t("spool.logCapped", "(capped at {cap} by Settings)").replace("{cap}", String(cap)) : ""), "msg-info", true);
        els.statusText.textContent = t("spool.statusCount", "{count} spooled file(s) in {ms} ms")
            .replace("{count}", String(count)).replace("{ms}", String(result.elapsedMs));
    } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        appendLogLine(t("spool.logFailed", "List spooled files failed   ({ms} ms)").replace("{ms}", String(elapsed)), "msg-error", true);
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        spool.setBusy(false);
        // Only re-disable Cancel when nothing else is running.
        if (!state.running) els.btnCancel.disabled = true;
    }
}

els.workTabs.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement).closest<HTMLElement>(".work-tab");
    if (tab?.dataset.pane) {
        showPane(tab.dataset.pane);
        // Spooled Files: load on first open; reload when the visible
        // connection changed since the list was last fetched.
        if (tab.dataset.pane === "spool" && spoolState.loadedFor !== (activeTab()?.connectionId ?? "")) {
            void refreshSpool(spool.filters());
        }
    }
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
    close.title = t("main.closePrompter", "Close prompter");
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
    // Work pane the tab was last showing (results/messages/spool/...) —
    // restored on tab switch so e.g. Spooled Files stays put.
    activePane?: string;
    // Last-opened/saved .sql filename for Save As prefill (per tab).
    scriptFile?: string;
    // Quick Connect form state (per-tab).
    connForm?: {
        host: string; user: string; password: string; schema: string;
        naming: string; tls: boolean; savePassword: boolean;
    };
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

// Per-connection statement history for editor recall (F9/F8, ArrowUp/ArrowDown).
// In-memory per session; keyed by the active tab's connectionId.
const inputHistories = new InputHistoryStore();

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
        btn.title = tab.connectionId ? t("main.connected", "Connected") : t("main.notConnected", "Not connected");
        btn.addEventListener("click", () => switchTab(tab.key));
        if (tab.connectionId) {
            const detach = document.createElement("span");
            detach.className = "conn-tab-detach";
            detach.textContent = "\u2197"; // arrow out
            detach.title = t("main.detachToWindow", "Detach to its own window");
            detach.addEventListener("click", (ev) => {
                ev.stopPropagation();
                void detachTab(tab);
            });
            btn.appendChild(detach);
        }
        const close = document.createElement("span");
        close.className = "conn-tab-close";
        close.textContent = "\u00D7";
        close.title = t("main.closeTab", "Close tab");
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
        await app.DetachConnection(tab.connectionId, t("main.detachedWindowTitle", "{label} — IBM i Run SQL").replace("{label}", tab.label));
    } catch (err) {
        showMessages([], t("main.detachFailed", "Detach failed: {message}").replace("{message}", String((err as Error)?.message ?? err)));
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
        activePane,
        connForm: {
            host: el<HTMLInputElement>("in-host").value,
            user: el<HTMLInputElement>("in-user").value,
            password: el<HTMLInputElement>("in-password").value,
            schema: el<HTMLInputElement>("in-schema").value,
            naming: el<HTMLSelectElement>("in-naming").value,
            tls: el<HTMLInputElement>("in-tls").checked,
            savePassword: el<HTMLInputElement>("in-save-password").checked,
        },
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
    // Restore the pane the tab was last showing (defaults to Results);
    // otherwise switching away from Spooled Files and back jumps to Results.
    const pane = snap?.activePane ?? "results";
    if (snap?.showingResults) {
        renderTable();
        els.statusText.textContent = snap.statusText;
        els.btnLoadMore.hidden = !state.more;
        els.btnLoadAll.hidden = !state.more;
    } else {
        els.resultHead.innerHTML = "";
        els.resultBody.innerHTML = "";
        els.statusText.textContent = "";
        els.btnLoadMore.hidden = true;
        els.btnLoadAll.hidden = true;
    }
    showPane(pane);
    // Spooled Files: refresh when the visible list belongs to a different
    // connection (mirrors the work-tab click handler's stale reload).
    if (pane === "spool" && spoolState.loadedFor !== (activeTab()?.connectionId ?? "")) {
        void refreshSpool(spool.filters());
    }
    els.messageList.innerHTML = snap?.messagesHtml ?? "";
    closeAllPrompterPanes();
    // Quick Connect form: per-tab state; a fresh tab starts blank so the
    // suggest dropdown isn't pre-filtered by the previous tab's host.
    const cf = snap?.connForm;
    el<HTMLInputElement>("in-host").value = cf?.host ?? "";
    el<HTMLInputElement>("in-user").value = cf?.user ?? "";
    el<HTMLInputElement>("in-password").value = cf?.password ?? "";
    el<HTMLInputElement>("in-schema").value = cf?.schema ?? "";
    el<HTMLSelectElement>("in-naming").value = cf?.naming ?? "sql";
    el<HTMLInputElement>("in-tls").checked = cf?.tls ?? false;
    el<HTMLInputElement>("in-save-password").checked = cf?.savePassword ?? false;
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
        label: t("main.connectionN", "Connection {n}").replace("{n}", String(tabCounter)),
        connectionId: null,
        cursorId: null,
        hasCursor: false,
    };
    tabs.push(tab);
    activeTabKey = tab.key;
    restoreActiveTab();
    // Settings "default naming mode" preselects the connect form's Naming
    // (restoreActiveTab resets it to the per-tab default first).
    if (appSettingsCache.defaultNaming && !tab.snapshot?.connForm) {
        el<HTMLSelectElement>("in-naming").value = appSettingsCache.defaultNaming;
    }
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
    tab.label = ws.label ?? t("main.connection", "Connection");
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
    void persistEditorScript();
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
        if (tab.key === activeTabKey) await persistEditorScript();
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

function syncConnectionUi(): void {
    const tab = activeTab();
    const connected = !!tab?.connectionId;
    els.badge.textContent = connected
        ? `${tab!.label} - ${t("main.connected", "Connected")}`
        : t("main.notConnected", "Not connected");
    els.badge.className = `badge ${connected ? "connected" : "disconnected"}`;
    els.btnConnect.disabled = connected;
    // GO mirrors Connect: enabled when a saved profile was picked and this
    // tab is not connected (re-arms after a failed connect or disconnect).
    const goBtn = document.getElementById("btn-go") as HTMLButtonElement | null;
    if (goBtn) goBtn.disabled = connected || !goBtn.dataset.armed;
    els.btnDisconnect.disabled = !connected;
    els.btnRun.disabled = !connected;
    els.btnRunAll.disabled = !connected;
    els.btnRunFrom.disabled = !connected;
    els.btnPrompt.disabled = !connected;
    els.btnCancel.disabled = true;
    els.connectPanel.hidden = connected;
    // The bottom tab bar is ALWAYS visible/clickable. Connections/Settings
    // open even disconnected; Results/Messages/Spooled Files hide until
    // connected. The SQL editor hides when disconnected.
    const panes = els.workArea.querySelectorAll<HTMLElement>(".work-pane");
    panes.forEach((p) => {
        const alwaysAvailable = p.dataset.pane === "connections" || p.dataset.pane === "settings";
        p.hidden = connected ? p.dataset.pane !== activePane : !(alwaysAvailable && p.dataset.pane === activePane);
    });
    // Connect/disconnect changes pane visibility without going through
    // showPane — keep the splash in sync or it stacks above the pane.
    syncEmptyState();
    el<HTMLDivElement>("splitter").hidden = !connected;
    el<HTMLSpanElement>("run-controls").hidden = !connected;
    document.querySelector<HTMLElement>(".editor-wrap")!.hidden = !connected;
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
    els.badge.textContent = `${info.user}@${info.host} — ${info.databaseProduct} ${formatOsVersion(info.databaseVersion)} - ${t("main.connected", "Connected")}`;
    els.connectError.hidden = true;
    els.sqlInput.focus();
    // ACS-style connection log line.
    const job = info.serverJob ? ` - ${info.serverJob}` : "";
    appendLogLine(`[ ${nowStamp()} ]  ${info.user}@${info.host} ${t("main.connected", "Connected")}`, "msg-action");
    appendLogLine(t("main.logConnectedDetail", "Connected to relational database {product} on {host} as {user}{job} using JDBC driver '{driver}'")
        .replace("{product}", info.databaseProduct)
        .replace("{host}", info.host)
        .replace("{user}", info.user)
        .replace("{job}", job)
        .replace("{driver}", `${info.driverName} ${info.driverVersion}`), "msg-info", true);
}

function setDisconnected(): void {
    const tab = activeTab();
    if (tab) {
        tab.connectionId = null;
        tab.cursorId = null;
        tab.hasCursor = false;
        tab.label = t("main.connectionN", "Connection {n}").replace("{n}", String(tabs.indexOf(tab) + 1));
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
    // Back to Results: leaving Connections/Settings visible would stack that
    // pane under the reappearing Quick Connect panel.
    showPane("results");
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
    appendLogLine(outcome, outcome.startsWith(t("main.statementRan", "Statement ran")) || outcome.includes(t("main.ok", "OK")) ? "msg-info" : "msg-warning", true);
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
                ? t("main.sqlState", "SQL State: {state}").replace("{state}", m.sqlState) +
                (m.vendorCode != null && m.vendorCode !== 0
                    ? t("main.sqlCode", ", SQL Code: {code}").replace("{code}", String(m.vendorCode))
                    : "")
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
        if (m.typeName) tip.push(t("main.msgTypeSeverity", "Type: {type}  Severity: {severity}").replace("{type}", m.typeName).replace("{severity}", String(m.severity)));
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
    const elapsed = result?.elapsedMs != null ? t("main.elapsedIn", " in {ms} ms").replace("{ms}", String(result.elapsedMs)) : "";
    const rowWord = (n: number) => (n === 1 ? t("main.row", "row") : t("main.rows", "rows"));
    if (kind === "rows") {
        const moreText = state.more ? t("main.moreAvailable", " (more available)") : "";
        els.statusText.textContent = `${totalRows} ${rowWord(totalRows)}${moreText}${elapsed}`;
    } else if (kind === "count") {
        const n = result?.updateCount ?? 0;
        els.statusText.textContent = `${n} ${rowWord(n)} ${t("main.affected", "affected")}${elapsed}`;
    } else if (kind === "none") {
        els.statusText.textContent = `${t("main.statementCompleted", "Statement completed")}${elapsed}`;
    } else {
        els.statusText.textContent = elapsed ? `${t("main.completed", "Completed")}${elapsed}` : "";
    }
    els.btnLoadMore.hidden = !state.more;
    els.btnLoadAll.hidden = !state.more;
    // Save-as: only meaningful with rows on screen.
    els.saveResultsWrap.hidden = !(kind === "rows" && totalRows > 0);
}

// Save the result grid: native Save dialog (name + location), chosen format.
els.btnSaveResults.addEventListener("click", () => {
    void (async () => {
        const app = App();
        if (!app || state.columns.length === 0 || state.rows.length === 0) return;
        const format = els.selSaveFormat.value as SaveFormat;
        const text = formatResultData(state.columns, state.rows, format);
        const host = activeTab()?.label?.split("@")[1] || "results";
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const filterLabel = format.toUpperCase();
        try {
            const saved = await app.SaveFileAs(
                `results_${host}_${stamp}.${format}`,
                btoa(unescape(encodeURIComponent(text))),
                filterLabel, `*.${format}`);
            if (!saved) return; // canceled
            appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
            els.statusText.textContent = t("spool.statusSaved", "Saved {path}").replace("{path}", saved);
        } catch (err) {
            showMessages([], String((err as Error)?.message ?? err));
        }
    })();
});

// "Open" beside Save-as: reveal the download folder in the OS file manager.
document.getElementById("btn-open-results-dir")?.addEventListener("click", () => {
    App()?.OpenSpoolDownloadDir().catch((err) => showMessages([], String((err as Error)?.message ?? err)));
});

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
            ? `${t("main.sqlState", "SQL State: {state}").replace("{state}", String(first.sqlState))}${first.vendorCode ? t("main.sqlCode", ", SQL Code: {code}").replace("{code}", String(first.vendorCode)) : ""}: ${first.message}`
            : result.error ?? t("main.statementFailed", "Statement failed");
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
    showMessages(result.messages, result.ok ? undefined : t("main.clCommandFailed", "CL command failed."));
    els.statusText.textContent = `CL: ${result.command} — ${result.ok ? t("main.ok", "OK") : t("main.failed", "failed")}${t("main.elapsedIn", " in {ms} ms").replace("{ms}", String(result.elapsedMs))}`;
    els.btnLoadMore.hidden = true;
    els.btnLoadAll.hidden = true;
}

async function doConnect(): Promise<void> {
    const app = App();
    if (!app) return;
    els.connectError.hidden = true;
    els.btnConnect.disabled = true;
    // Connecting status on the profile-hint line under GO (dominant styling).
    const hint = el<HTMLSpanElement>("profile-hint");
    const hintText = hint.textContent ?? "";
    const connectingTo = `${el<HTMLInputElement>("in-user").value.trim()}@${el<HTMLInputElement>("in-host").value.trim()}`;
    hint.textContent = t("main.connecting", "Connecting to {target}...").replace("{target}", connectingTo);
    hint.classList.add("connecting");
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
        // Script recall: this connection's saved editor text returns when the
        // editor is blank and the profile's save-script toggle is on.
        const prof = profiles.find((p) =>
            p.host.toLowerCase() === info.host.toLowerCase()
            && p.user.toLowerCase() === info.user.toLowerCase());
        if (prof?.saveScript !== false && prof?.script && !els.sqlInput.value.trim()) {
            els.sqlInput.value = prof.script;
        }
        // Spooled Files: preload at connect when the setting is on; otherwise
        // leave the list empty so opening the tab (or Refresh) fetches it.
        spoolState.loadedFor = "";
        spool.clear();
        if (preloadSpoolList) {
            void refreshSpool(spool.filters());
        }
    } catch (err) {
        els.btnConnect.disabled = false;
        // Failed connect: re-arm GO so it can be pressed again immediately.
        const go = document.getElementById("btn-go") as HTMLButtonElement | null;
        if (go?.dataset.armed) go.disabled = false;
        els.connectError.textContent = String((err as Error)?.message ?? err);
        els.connectError.hidden = false;
        // Connect failures must be visible: open Messages with the error.
        appendLogLine(`[ ${nowStamp()} ]  ${t("main.connect", "Connect")}`, "msg-action");
        appendLogLine(t("main.connectionFailed", "Connection failed: {message}").replace("{message}", String((err as Error)?.message ?? err)), "msg-error", true);
        showPane("messages");
    } finally {
        hint.classList.remove("connecting");
        hint.textContent = hintText;
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
        preloadSpool: preloadSpoolList,
        savePassword,
        passwordB64: savePassword && password ? btoa(password) : undefined,
    };
}

function fillFormFromProfile(p: ConnectionProfile, password?: string): void {
    el<HTMLInputElement>("in-host").value = p.host;
    el<HTMLInputElement>("in-user").value = p.user;
    el<HTMLInputElement>("in-schema").value = p.defaultSchema ?? "";
    el<HTMLSelectElement>("in-naming").value = p.naming || "sql";
    el<HTMLInputElement>("in-tls").checked = !!p.tls;
    el<HTMLInputElement>("in-save-password").checked = !!p.savePassword;
    // Per-connection spool preload: this profile's value wins for this tab.
    preloadSpoolList = p.preloadSpool !== false;
    const pwField = el<HTMLInputElement>("in-password");
    if (p.savePassword && password) {
        pwField.value = password;
        el<HTMLButtonElement>("btn-connect").focus();
    } else {
        pwField.value = "";
        pwField.focus();
    }
}

/** Connections pane "Connect in new Tab": fill the form from the profile and
 * connect. Reuses the current tab when it has no connection yet (initial
 * unconnected tab), otherwise opens a fresh tab first. */
async function connectToProfile(p: ConnectionProfile): Promise<void> {
    if (activeTab()?.connectionId) addTab();
    const pw = p.savePassword ? await App()?.GetProfilePassword(p.name).catch(() => "") : "";
    fillFormFromProfile(p, pw ?? "");
    if (p.savePassword && pw) {
        void doConnect();
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
        els.connectError.textContent = t("main.enterHost", "Enter a host before saving.");
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
    await persistEditorScript();
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
        // The remaining tab may be a different system — drop the stale list.
        spool.clear();
        spoolState.loadedFor = "";
        return;
    }
    snapshotActiveTab();
    setDisconnected();
    spool.clear();
    spoolState.loadedFor = "";
}

// Execute one statement text on the active tab; shared by all run modes.
// actionLabel is the ACS-style verb for the log ("Run Selected...", etc.).
async function runOne(text: string, actionLabel = t("main.logRunSelected", "Run Selected...")): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    inputHistories.for(activeTab()?.connectionId).push(text);
    await persistEditorScript(); // keep the per-connection script current on every run
    // Persisted per-connection history (powers the picker; survives restarts).
    // Store the terminating semicolon so recall/picker round-trip the exact
    // runnable statement.
    const logged = /;\s*$/.test(text) ? text : `${text};`;
    void app.AddStatementHistory(activeTab()!.connectionId!, logged).catch(() => { /* best effort */ });
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
    // CL commands have no result set — their output is the Messages pane
    // (action log + CPF/CPC messages). SQL stays on Results.
    showPane(/^\s*CL\s*:/i.test(text) ? "messages" : "results");
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
                cl.ok ? t("main.logCommandRan", "Command ran successfully   ({ms} ms)").replace("{ms}", String(cl.elapsedMs))
                    : t("main.logCommandFailed", "Command failed   ({ms} ms)").replace("{ms}", String(cl.elapsedMs)));
            showCLResult(cl);
        } else {
            const sqlResult = result as SqlResult;
            if (sqlResult.kind === "error") {
                const stateText = sqlResult.messages?.[0]?.sqlState ? `  ${t("main.sqlStateTag", "SQLState {state}").replace("{state}", sqlResult.messages[0].sqlState!)}` : "";
                logExecution(actionLabel, text, t("main.logStatementFailed", "Statement failed{state}   ({ms} ms)").replace("{state}", stateText).replace("{ms}", String(sqlResult.elapsedMs ?? elapsed)));
            } else if (sqlResult.kind === "count") {
                logExecution(actionLabel, text, t("main.logStatementRanCount", "Statement ran successfully   ({ms} ms) — {count} row(s) affected").replace("{ms}", String(sqlResult.elapsedMs ?? elapsed)).replace("{count}", String(sqlResult.updateCount)));
            } else {
                logExecution(actionLabel, text, t("main.logStatementRan", "Statement ran successfully   ({ms} ms)").replace("{ms}", String(sqlResult.elapsedMs ?? elapsed)));
            }
            state.rows = sqlResult.kind === "rows" ? sqlResult.rows ?? [] : [];
            showSqlResult(sqlResult);
        }
    } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        logExecution(actionLabel, text, t("main.logStatementFailed", "Statement failed{state}   ({ms} ms)").replace("{state}", "").replace("{ms}", String(elapsed)));
        showMessages([], String((err as Error)?.message ?? err));
        els.statusText.textContent = t("main.error", "Error");
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
    els.statusText.textContent = t("main.running", "Running...");
    try {
        await runOne(text, t("main.logRunSelected", "Run Selected..."));
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
    els.statusText.textContent = t("main.runningStatements", "Running {count} statements...").replace("{count}", String(stmts.length));
    try {
        for (let i = 0; i < stmts.length; i += 1) {
            els.statusText.textContent = t("main.runningStatementOf", "Running statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length));
            await runOne(stmts[i].text, t("main.logRunAllStatement", "Run All — statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length)));
        }
        els.statusText.textContent = t("main.statementsCompleted", "{count} statements completed.").replace("{count}", String(stmts.length));
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
    els.statusText.textContent = t("main.runningStatementsFromCursor", "Running {count} statements from cursor...").replace("{count}", String(stmts.length));
    try {
        for (let i = 0; i < stmts.length; i += 1) {
            els.statusText.textContent = t("main.runningStatementOf", "Running statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length));
            await runOne(stmts[i].text, t("main.logRunFromStatement", "Run from Selected — statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length)));
        }
        els.statusText.textContent = t("main.statementsCompleted", "{count} statements completed.").replace("{count}", String(stmts.length));
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
    const connId = activeTab()?.connectionId;
    if (!app || !connId) return;
    try {
        await app.CancelSQL(connId);
    } catch {
        // best effort
    }
    // Also stop any in-flight spooled-file list on this connection.
    try {
        await app.CancelSpoolList(connId);
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
    /** Existing command text for round-trip populate of the form. */
    initialText?: string,
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
    const { pane, close } = openPrompterPane(t("main.promptTitle", "Prompt: {name}").replace("{name}", descriptor.name));
    showPrompter(pane, descriptor, ref.command, {
        onRun: (commandText) => {
            close();
            if (commandText) onRunNow ? onRunNow(commandText) : onInsert(commandText);
        },
        onClose: () => close(),
        onPromptNested: onPromptNestedCb,
        cmdXml: result.xml,
    }, initialText);
}

// Nested prompt recursion — unbounded depth. Each level's applyBack writes the
// finished command string into the parent pane's CMD/CMDSTR field.
function promptNestedRecursively(commandText: string, applyBack: (t: string) => void): void {
    const nestedRef = extractCommandRef(commandText);
    if (!nestedRef) {
        showMessages([], t("main.noCommandInField", "No command found in field to prompt: \"{command}\"").replace("{command}", commandText));
        return;
    }
    void openCommandPrompter(
        nestedRef,
        (text) => applyBack(text),
        (text) => applyBack(text),
        (ct, ab) => promptNestedRecursively(ct, ab),
        commandText,
    );
}

async function doPrompt(): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    // Prompt the statement under the caret (or the selection), exactly like
    // Run Selected — a leading `CL:` prefix is stripped by extractCommandRef.
    const src = els.sqlInput.value;
    const selStart = els.sqlInput.selectionStart ?? 0;
    const selEnd = els.sqlInput.selectionEnd ?? 0;
    let text: string;
    let replaceFrom: number;
    let replaceTo: number;
    if (selEnd > selStart) {
        text = src.slice(selStart, selEnd).trim();
        const lead = src.slice(selStart, selEnd).length - src.slice(selStart, selEnd).trimStart().length;
        replaceFrom = selStart + lead;
        replaceTo = replaceFrom + text.length;
    } else {
        const stmt = statementAt(src, selStart);
        if (!stmt) {
            showMessages([], t("main.promptPlaceCursor", "Place the cursor on a command line (e.g. CL: DSPLIBL) to prompt."));
            return;
        }
        text = stmt.text;
        replaceFrom = stmt.start;
        replaceTo = stmt.end;
    }
    const ref = extractCommandRef(text);
    if (!ref) {
        showMessages([], t("main.promptEnterCommand", "Enter a command name (e.g. DSPLIBL or CL: DSPLIBL) to prompt."));
        return;
    }
    els.btnPrompt.disabled = true;
    try {
        // Replace only the prompted statement span — the rest of the buffer
        // (other SQL/CL statements) must survive Insert/Run.
        const replaceSpan = (newText: string) => {
            const cur = els.sqlInput.value;
            els.sqlInput.value = `${cur.slice(0, replaceFrom)}CL: ${newText}${cur.slice(replaceTo)}`;
            els.sqlInput.focus();
            els.sqlInput.selectionStart = replaceFrom;
            els.sqlInput.selectionEnd = replaceFrom + newText.length + 4;
        };
        await openCommandPrompter(
            ref,
            (text) => replaceSpan(text),
            // Enter writes back only — the user presses Run themselves.
            (text) => replaceSpan(text),
            // Nested: prompt the command typed into a CMD/CMDSTR field.
            (commandText, applyBack) => {
                promptNestedRecursively(commandText, applyBack);
            },
            // Round-trip: prefill the form from the existing statement text.
            text,
        );
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        els.btnPrompt.disabled = false;
    }
}

els.btnConnect.addEventListener("click", () => void doConnect());
els.btnDisconnect.addEventListener("click", () => void doDisconnect());
document.getElementById("btn-go")?.addEventListener("click", () => void doConnect());
els.btnRun.addEventListener("click", () => void doRun());
els.btnRunAll.addEventListener("click", () => void doRunAll());
els.btnRunFrom.addEventListener("click", () => void doRunFromSelected());
els.btnCancel.addEventListener("click", () => void doCancel());
els.btnPrompt.addEventListener("click", () => void doPrompt());
el<HTMLButtonElement>("btn-new-conn").addEventListener("click", () => addTab());
els.btnLoadMore.addEventListener("click", () => void doFetch(false));
els.btnLoadAll.addEventListener("click", () => void doFetch(true));

// Statement-history picker: per-connection persisted log (history.json via
// Go). F6 or the History button opens it; Enter/click inserts at the cursor,
// × removes an entry, the filter box narrows the list.
async function openHistoryPicker(): Promise<void> {
    const app = App();
    const connId = activeTab()?.connectionId;
    if (!app || !connId) return;
    let entries;
    try {
        entries = await app.ListStatementHistory(connId);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
        return;
    }
    showHistoryPicker({
        entries,
        onInsert: (text) => {
            const ta = els.sqlInput;
            const stmt = /;\s*$/.test(text) ? text : `${text};`;
            const start = ta.selectionStart ?? ta.value.length;
            const end = ta.selectionEnd ?? start;
            ta.value = ta.value.slice(0, start) + stmt + ta.value.slice(end);
            const caret = start + stmt.length;
            ta.focus();
            ta.setSelectionRange(caret, caret);
            pushWorkspaceState();
        },
        onDelete: async (index) => {
            try {
                return await app.DeleteStatementHistory(connId, index);
            } catch {
                return entries;
            }
        },
    });
}

document.getElementById("btn-history")?.addEventListener("click", () => void openHistoryPicker());

// Persist the editor text onto the matching profile (session continuity).
// Keyed on the LIVE connection's host/user (authoritative from Go), gated by
// the profile's "save script" toggle (default on). Async; fire-and-forget at
// blur/close, awaited at run/disconnect so it lands before the state change.
async function persistEditorScript(): Promise<void> {
    const tab = activeTab();
    const app = App();
    if (!app || !tab?.connectionId) return;
    let host = "";
    let user = "";
    try {
        const id = await app.GetConnectionIdentity(tab.connectionId);
        host = (id.host ?? "").toLowerCase();
        user = (id.user ?? "").toLowerCase();
    } catch {
        return;
    }
    if (!host || !user) return;
    const prof = profiles.find((p) =>
        p.host.toLowerCase() === host && p.user.toLowerCase() === user);
    if (!prof || prof.saveScript === false) return;
    if ((prof.script ?? "") === els.sqlInput.value) return;
    try {
        await app.UpdateConnectionProfile(prof.name, { ...prof, script: els.sqlInput.value });
        prof.script = els.sqlInput.value;
    } catch { /* best effort */ }
}

// Editor session continuity: save the script for the active connection when
// the window closes (best effort — the page may be mid-teardown).
window.addEventListener("beforeunload", () => persistEditorScript());

// Also save on editor blur (debounced) so a crash/force-quit doesn't lose it.
let scriptSaveTimer: ReturnType<typeof setTimeout> | undefined;
els.sqlInput.addEventListener("blur", () => {
    clearTimeout(scriptSaveTimer);
    scriptSaveTimer = setTimeout(() => void persistEditorScript(), 400);
});

// Open / Save As: Word-style editor file actions. The current script's
// filename is tracked per tab so Save As prefills it (Word behavior).
const scriptFileByTab = new Map<string, string>();

function scriptFileName(): string {
    const key = activeTab()?.key;
    return (key && scriptFileByTab.get(key)) || "ibmi-runsql.sql";
}

async function openScriptIntoEditor(): Promise<void> {
    const app = App();
    if (!app) return;
    try {
        // OpenFileAs returns "<path>\n<text>" so we can track the filename
        // for later Save As prefill.
        const payload = await app.OpenFileAs("SQL Script", "*.sql");
        if (!payload) return;
        const nl = payload.indexOf("\n");
        const path = nl >= 0 ? payload.slice(0, nl) : "";
        const text = nl >= 0 ? payload.slice(nl + 1) : payload;
        els.sqlInput.value = text;
        pushWorkspaceState();
        const key = activeTab()?.key;
        if (key && path) scriptFileByTab.set(key, path.split(/[\\/]/).pop() ?? path);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

async function saveEditorScriptAs(): Promise<void> {
    const app = App();
    if (!app) return;
    try {
        const saved = await app.SaveFileAs(scriptFileName(),
            btoa(unescape(encodeURIComponent(els.sqlInput.value))),
            "SQL Script", "*.sql");
        if (!saved) return;
        appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
        const key = activeTab()?.key;
        if (key) scriptFileByTab.set(key, saved.split(/[\\/]/).pop() ?? saved);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

document.getElementById("btn-script-open")?.addEventListener("click", () => void openScriptIntoEditor());
document.getElementById("btn-script-save")?.addEventListener("click", () => void saveEditorScriptAs());
document.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    if (ev.key.toLowerCase() === "o") {
        ev.preventDefault();
        void openScriptIntoEditor();
    } else if (ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void saveEditorScriptAs();
    }
});

// Statement-history recall in the editor. F9 = previous (older), F8 = next
// (newer) — same keys as the cozzi-cl-prompter Command Entry. ArrowUp/ArrowDown
// recall only when the caret sits on the first/last line with no selection and
// no modifiers, so normal caret movement and Cmd/Ctrl/Alt+Arrow (e.g. macOS
// document jumps) are untouched. Cursor lands at the end of the recalled text.
function handleHistoryKeydown(ev: KeyboardEvent): void {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const connId = activeTab()?.connectionId;
    const history = inputHistories.for(connId);
    let direction: "prev" | "next" | undefined;
    if (ev.key === "F9") direction = "prev";
    else if (ev.key === "F8") direction = "next";
    else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        direction = arrowRecallDirection(
            ev.key,
            els.sqlInput.value,
            els.sqlInput.selectionStart ?? 0,
            els.sqlInput.selectionEnd ?? 0,
        );
    }
    if (!direction) return;
    // First recall after launch: seed from the persisted per-connection log.
    if (!history.hasHistory && connId) {
        ev.preventDefault();
        void App()?.ListStatementHistory(connId).then((entries) => {
            for (let i = entries.length - 1; i >= 0; i--) history.push(entries[i].text);
            const recalled = direction === "prev" ? history.prev(els.sqlInput.value) : history.next();
            if (recalled === undefined) return;
            els.sqlInput.value = recalled;
            els.sqlInput.setSelectionRange(recalled.length, recalled.length);
            pushWorkspaceState();
        }).catch(() => { /* no history */ });
        return;
    }
    if (!history.hasHistory) return;
    const recalled = direction === "prev" ? history.prev(els.sqlInput.value) : history.next();
    if (recalled === undefined) return;
    ev.preventDefault();
    els.sqlInput.value = recalled;
    els.sqlInput.setSelectionRange(recalled.length, recalled.length);
    pushWorkspaceState();
}

els.sqlInput.addEventListener("keydown", (ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        void doRun();
    }
    if (ev.key === "F4") {
        ev.preventDefault();
        void doPrompt();
    }
    if (ev.key === "F6") {
        ev.preventDefault();
        void openHistoryPicker();
    }
    // Home/End: text-editor semantics — column 1 / end of the caret's line.
    // (WKWebView textarea leaves these as no-ops on macOS.)
    if ((ev.key === "Home" || ev.key === "End") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        const ta = els.sqlInput;
        const pos = ta.selectionStart ?? 0;
        const text = ta.value;
        const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
        const nl = text.indexOf("\n", pos);
        const lineEnd = nl === -1 ? text.length : nl;
        const target = ev.key === "Home" ? lineStart : lineEnd;
        ev.preventDefault();
        if (ev.shiftKey) {
            // Shift extends the selection from the existing anchor.
            const anchor = ta.selectionDirection === "backward" ? ta.selectionEnd : ta.selectionStart;
            const [a, b] = anchor === pos ? [Math.min(pos, target), Math.max(pos, target)] : [Math.min(anchor, target), Math.max(anchor, target)];
            ta.setSelectionRange(a, b);
        } else {
            ta.setSelectionRange(target, target);
        }
        return;
    }
    handleHistoryKeydown(ev);
});
els.sqlInput.addEventListener("input", () => {
    // Typing exits history-browse mode and drops the stashed draft (same as
    // the extension's Command Entry input handler).
    inputHistories.for(activeTab()?.connectionId).reset();
    pushWorkspaceState();
});

el<HTMLInputElement>("in-password").addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.key === "Enter") void doConnect();
});

// Disable the quick-connect GO button once the user edits the form manually.
["in-host", "in-user", "in-password"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
        const go = document.getElementById("btn-go") as HTMLButtonElement | null;
        if (go) {
            delete go.dataset.armed;
            go.disabled = true;
        }
    });
});

// Saved-connections dropdown: explicit arrow button + popup list.
// Right-clicking an item opens a context menu (Forget / Move to top).
// (contextMenuEl/closeContextMenu declared above — hoisted for spool menu)

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

    addItem(t("main.forgetHost", "Forget {host}").replace("{host}", p.host), () => void forgetProfileByName(p.name), true);
    addItem(t("main.moveToTop", "Move to top of list"), () => void bumpProfile(p.name));

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

// Quick Connect saved-connections dropdown: opens on the arrow button or when
// the Host field gains focus; typing filters the list (name/host/user,
// case-insensitive). No MRU section — the Connections pane owns ordering
// (drag/A-Z), and filtering replaces recency.
function renderSavedHosts(filter = ""): void {
    const popup = el<HTMLDivElement>("saved-hosts-popup");
    popup.innerHTML = "";
    const q = filter.trim().toLowerCase();
    const matches = q
        ? profiles.filter((p) =>
            (p.name || "").toLowerCase().includes(q)
            || p.host.toLowerCase().includes(q)
            || p.user.toLowerCase().includes(q))
        : profiles;
    const addItem = (p: ConnectionProfile) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "combo-item";
        item.dataset.profileName = p.name;
        // Match the Connections pane list entry: "Name (user@host)".
        item.textContent = `${p.name || p.host}  (${p.user}@${p.host})`;
        item.title = t("main.savedHostItemTitle", "Click to fill form; right-click for options");
        item.addEventListener("click", () => {
            void App()?.GetProfilePassword(p.name)
                .catch(() => "")
                .then((pw) => fillFormFromProfile(p, pw ?? ""));
            popup.hidden = true;
            // Enable the quick-connect GO button for the selected profile.
            const go = document.getElementById("btn-go") as HTMLButtonElement | null;
            if (go && !activeTab()?.connectionId) {
                go.dataset.armed = "1";
                go.disabled = false;
            }
        });
        popup.appendChild(item);
    };
    if (matches.length === 0) {
        const empty = document.createElement("div");
        empty.className = "combo-item combo-empty";
        empty.textContent = q
            ? t("main.noMatchingConnections", "No connections match.")
            : t("main.noSavedConnections", "No saved connections yet — connect once and it will appear here.");
        popup.appendChild(empty);
    } else {
        matches.forEach(addItem);
    }
    popup.hidden = false;
}

function toggleSavedHosts(): void {
    const popup = el<HTMLDivElement>("saved-hosts-popup");
    if (!popup.hidden) {
        popup.hidden = true;
        return;
    }
    renderSavedHosts(el<HTMLInputElement>("in-host").value);
}

const hostInput = el<HTMLInputElement>("in-host");
const btnClearHost = el<HTMLButtonElement>("btn-clear-host");
const updateClearHost = () => { btnClearHost.hidden = hostInput.value === ""; };
// Catch programmatic .value writes (dropdown pick, profile fill, tab restore)
// — 'input' only fires on user typing.
{
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
    Object.defineProperty(hostInput, "value", {
        get: desc.get,
        set(v: string) { desc.set!.call(this, v); updateClearHost(); },
        configurable: true,
    });
}
hostInput.addEventListener("focus", () => {
    if (profiles.length > 0) renderSavedHosts(hostInput.value);
});
hostInput.addEventListener("input", () => {
    updateClearHost();
    const popup = el<HTMLDivElement>("saved-hosts-popup");
    if (!popup.hidden || profiles.length > 0) renderSavedHosts(hostInput.value);
});
btnClearHost.addEventListener("click", () => {
    hostInput.value = "";
    updateClearHost();
    el<HTMLDivElement>("saved-hosts-popup").hidden = true;
    hostInput.focus();
});
updateClearHost();

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
    const HEIGHT_KEY = "ibmi-runsql-editor-height";
    // Restore the persisted editor height (survives launch/disconnect).
    const saved = Number(localStorage.getItem(HEIGHT_KEY) ?? "0");
    if (saved > 0) {
        editor.style.height = `${saved}px`;
        editor.style.flex = "none";
    }
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
        localStorage.setItem(HEIGHT_KEY, String(Math.round(editor.getBoundingClientRect().height)));
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
        label: t("main.detached", "Detached"),
        connectionId: detachedConnId,
        cursorId: null,
        hasCursor: false,
    };
    tabs.push(tab);
    activeTabKey = tab.key;
    // Set all buttons consistently from the tab's connected state (Connect
    // disabled, Disconnect enabled, Run/Prompt enabled).
    syncConnectionUi();
    els.badge.textContent = t("main.detachedWindow", "Detached window");
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
            els.badge.textContent = t("main.detachedBadge", "{label} (detached)").replace("{label}", ws.label);
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
