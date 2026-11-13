import "./style.css";
// @ts-ignore: @wailsio/runtime ships untyped JS
import { Events } from "@wailsio/runtime";
import {
    columnHeaderLines,
    columnKind,
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
    type PinnedResult as PinnedResultType,
    type SqlMessage,
    type SqlResult,
} from "./types";
import { splitStatements, statementAt, statementsFrom, isStopStatement } from "./statements";
import { arrowRecallDirection, InputHistoryStore } from "./inputHistory";
import { parseCmdXml } from "./clprompter/prompterModel";
import { showPrompter } from "./clprompter/prompterView";
import { buildSpooledFileRequest, createSpoolPane, isAfpdsFile, type SpoolFilters } from "./spool";
import { createSettingsPane, createSwitch, type SettingDef } from "./settings";
import { appendEnhancedSupportLog, confirmEnhancedSupport, enhancedSupportAlternativeMessage, enhancedSupportInstallationMessages, enhancedSupportLogEntry, setupEnhancedSupport } from "./enhancedSupport";
import { createConnectionsPane, matchConnectionProfile } from "./connections";
import { renderScsBytes, formatOsVersion } from "./scsRender";
import { formatResultData, loadPreferredSaveFormat, persistPreferredSaveFormat, unescapeDelimiter, type SaveFormat } from "./resultExport";
import { confirmReloadInitialScript, reloadInitialScript, scriptForConnection } from "./sessionScript";
import { createToolbarStatus } from "./toolbarStatus";
import { applyClColorSetting, clColorSettings, restoreClColors } from "./clColors";
import { SqlEditor } from "./sqlEditor";
import { createSQLCompletionSource } from "./sqlCompletion";
import { showHistoryPicker } from "./stmtHistory";
import type { SpooledFileInfo } from "./types";
import { t } from "./l10n";
import { addCLMessageDetails } from "./clMessageDetails";
import { formatServerJob } from "./serverJob";

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
    serverJob: el<HTMLSpanElement>("server-job"),
    themeSelect: el<HTMLSelectElement>("sel-theme"),
    btnRun: el<HTMLButtonElement>("btn-run"),
    btnRunAll: el<HTMLButtonElement>("btn-run-all"),
    btnRunFrom: el<HTMLButtonElement>("btn-run-from"),
    btnCancel: el<HTMLButtonElement>("btn-cancel"),
    btnPrompt: el<HTMLButtonElement>("btn-prompt"),
    sqlInput: new SqlEditor(el<HTMLElement>("sql-input"), localStorage.getItem("ibmi-runsql-sql-highlighting") !== "off"),
    workArea: el<HTMLElement>("work-area"),
    workTabs: el<HTMLDivElement>("work-tabs"),
    messageList: el<HTMLUListElement>("message-list"),
    paneResults: el<HTMLElement>("pane-results"),
    paneMessages: el<HTMLElement>("pane-messages"),
    emptyState: el<HTMLElement>("empty-state"),
    resultHead: el<HTMLTableSectionElement>("result-head"),
    resultBody: el<HTMLTableSectionElement>("result-body"),
    statusText: el<HTMLSpanElement>("status-text"),
    runStatus: el<HTMLSpanElement>("run-status"),
    toolbarStatus: el<HTMLSpanElement>("toolbar-status"),
    btnLoadMore: el<HTMLButtonElement>("btn-load-more"),
    btnLoadAll: el<HTMLButtonElement>("btn-load-all"),
    saveResultsWrap: el<HTMLSpanElement>("save-results-wrap"),
    btnSaveResults: el<HTMLButtonElement>("btn-save-results"),
    btnPinResult: el<HTMLButtonElement>("btn-pin-result"),
    selSaveFormat: el<HTMLSelectElement>("sel-save-format"),
    resultSubtabs: el<HTMLDivElement>("result-subtabs"),
};

const toolbarStatus = createToolbarStatus(els.toolbarStatus, () => activeTab()?.connectionId ?? null);

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

// Tag the OS so CSS can pick platform-native switch colors (green on macOS,
// accent blue elsewhere). navigator.userAgent is reliable enough here.
document.documentElement.dataset.os =
    /mac/i.test(navigator.userAgent) ? "mac" : "other";

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
    // 2nd button now runs from selected to end; 3rd runs all.
    setTitle("btn-run-all", t("html.runFromTitle", "Run from Selected (cursor statement through the last)"));
    setTitle("btn-run-from", t("html.runAllTitle", "Run All (every statement, first to last)"));
    setText("btn-cancel", t("main.cancel", "Cancel"));
    setTitle("btn-cancel", t("html.cancelTitle", "Cancel running statement"));
    setText("btn-prompt", t("main.prompt", "Prompt"));
    setTitle("btn-prompt", t("html.promptTitle", "Prompt CL command (F4)"));
    setTitle("btn-script-open", t("html.openScriptTitle", "Open a .sql script into the editor (Ctrl/Cmd+O)"));
    setTitle("btn-reload-script", t("html.reloadInitialScript", "Reload initial SQL script"));
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

// Quick Connect switches: TLS + Save password as real switches (button
// role=switch) with the I/O state glyph and a live state hint. They keep the
// ids in-tls / in-save-password so all the existing .checked reads work
// unchanged (SwitchControl exposes `checked`).
// Quick Connect switches: TLS + Save password as real switches (button
// role=switch) with the I/O state glyph and a live state hint. They keep the
// ids in-tls / in-save-password so all the existing .checked reads work
// unchanged (SwitchControl exposes `checked`). persistKey makes the user's
// choice sticky across launches (localStorage) for first-time/new connections.
function mountQcSwitch(mountId: string, stateId: string, id: string, aria: string, onText: string, offText: string, persistKey: string): void {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    // Restore the sticky value (default off when never set).
    const sticky = persistKey ? localStorage.getItem(persistKey) === "1" : false;
    const sw = createSwitch(sticky, aria);
    sw.id = id;
    const hint = document.getElementById(stateId);
    const paint = () => {
        if (hint) hint.textContent = sw.checked ? onText : offText;
    };
    paint();
    sw.addEventListener("change", () => {
        paint();
        if (persistKey) localStorage.setItem(persistKey, sw.checked ? "1" : "0");
    });
    mount.appendChild(sw);
}
mountQcSwitch("in-tls-mount", "in-tls-state", "in-tls", t("conn.tls", "Secure (TLS)"),
    t("switch.on", "On"), t("switch.off", "Off"), "ibmi-runsql-qc-tls");
mountQcSwitch("in-save-password-mount", "in-save-password-state", "in-save-password", t("conn.savePassword", "Save password"),
    t("conn.savePwOn", "On — stored in the OS credential vault"), t("conn.savePwOff", "Off — not stored"), "ibmi-runsql-qc-savepw");

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
    if (name === "messages") {
        requestAnimationFrame(() => { els.messageList.scrollTop = els.messageList.scrollHeight; });
    }
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
        options: [["sql", "SQL"], ["system", "SYS"]],
        get: (s) => s.defaultNaming || "system",
        withValue: (s, v) => ({ ...s, defaultNaming: v as AppSettings["defaultNaming"] }),
        persist: (v) => App()?.SetAppSetting("defaultNaming", v) ?? Promise.resolve(),
    },
    {
        key: "enhancedSupport", type: "group", controls: [
            {
                key: "enhancedSupportLibrary", type: "text",
                get: (s) => s.enhancedSupportLibrary || "SQLTOOLS",
                withValue: (s, v) => ({ ...s, enhancedSupportLibrary: v.trim().toUpperCase() || "SQLTOOLS" }),
                persist: (v) => App()?.SetAppSetting("enhancedSupportLibrary", v) ?? Promise.resolve(),
            },
            {
                key: "functionUpdateNotifications", type: "choice",
                options: [["always", "Always"], ["newOnly", "New only"], ["updatesOnly", "Updates only"], ["noneAuto", "No notifications, auto install and update"], ["noneSkip", "No notifications, no installs or updates"]],
                get: (s) => s.functionUpdateNotifications || "always",
                withValue: (s, v) => ({ ...s, functionUpdateNotifications: v as AppSettings["functionUpdateNotifications"] }),
                persist: (v) => App()?.SetAppSetting("functionUpdateNotifications", v) ?? Promise.resolve(),
            },
            {
                key: "showCLMessagesInResults", type: "toggle",
                get: (s) => s.showCLMessagesInResults ? "on" : "off",
                withValue: (s, v) => ({ ...s, showCLMessagesInResults: v === "on" }),
                persist: (v) => App()?.SetAppSetting("showCLMessagesInResults", v) ?? Promise.resolve(),
            },
        ],
    },
    {
        key: "editorOptions",
        type: "group",
        get: () => "",
        withValue: (s) => s,
        controls: [
            {
                key: "editorSqlHighlighting",
                type: "toggle",
                get: () => localStorage.getItem("ibmi-runsql-sql-highlighting") === "off" ? "off" : "on",
                withValue: (s) => s,
                persist: async (value) => { localStorage.setItem("ibmi-runsql-sql-highlighting", value); },
            },
            {
                key: "editorFontSize",
                type: "number",
                min: 9,
                max: 24,
                get: () => localStorage.getItem("ibmi-runsql-editor-font-size") || "13",
                withValue: (s) => s,
                persist: async (value) => { localStorage.setItem("ibmi-runsql-editor-font-size", value); },
            },
            {
                key: "editorStopColor",
                type: "color",
                get: () => localStorage.getItem("ibmi-runsql-editor-stop-color") || (document.documentElement.dataset.theme === "dark" ? "#ff7777" : "#c62828"),
                withValue: (s) => s,
                persist: async (value) => { localStorage.setItem("ibmi-runsql-editor-stop-color", value); },
            },
            {
                key: "editorCommentColor",
                type: "color",
                get: () => localStorage.getItem("ibmi-runsql-editor-comment-color") || (document.documentElement.dataset.theme === "dark" ? "#76d18c" : "#18783a"),
                withValue: (s) => s,
                persist: async (value) => { localStorage.setItem("ibmi-runsql-editor-comment-color", value); },
            },
            ...clColorSettings(),
        ],
    },
    {
        key: "excelExportOptions",
        type: "group",
        get: () => "",
        withValue: (s) => s,
        controls: [
            {
                key: "excelColumnHeading",
                type: "choice",
                options: [["fieldName", "Field Name"], ["columnHeading", "Column Heading"]],
                get: (s) => s.excelColumnHeading || "columnHeading",
                withValue: (s, v) => ({ ...s, excelColumnHeading: v as AppSettings["excelColumnHeading"] }),
                persist: (v) => App()?.SetAppSetting("excelColumnHeading", v) ?? Promise.resolve(),
            },
            {
                key: "excelDateFormat",
                type: "choice",
                options: [
                    ["locale", "Locale default"],
                    ["iso", "ISO 8601 (YYYY-MM-DD)"],
                    ["us", "U.S. (MM/DD/YYYY)"],
                    ["eu", "Day-first (DD/MM/YYYY)"],
                    ["mdy", "*MDY (MM/DD/YY)"],
                    ["mdyy", "*MDYY (MM/DD/YYYY)"],
                    ["dmy", "*DMY (DD/MM/YY)"],
                    ["dmyy", "*DMYY (DD/MM/YYYY)"],
                    ["ymd", "*YMD (YY/MM/DD)"],
                    ["yymd", "*YYMD (YYYY/MM/DD)"],
                ],
                get: (s) => s.excelDateFormat || "locale",
                withValue: (s, v) => ({ ...s, excelDateFormat: v as AppSettings["excelDateFormat"] }),
                persist: (v) => App()?.SetAppSetting("excelDateFormat", v) ?? Promise.resolve(),
            },
            {
                key: "excelTimeFormat",
                type: "choice",
                options: [
                    ["locale", "Locale default"],
                    ["24h", "24-hour (HH:MM:SS)"],
                    ["12h", "12-hour (H:MM:SS AM/PM)"],
                    ["iso12", "*ISO12 (HH.MM.SS AM/PM)"],
                    ["iso", "*ISO (HH.MM.SS)"],
                ],
                get: (s) => s.excelTimeFormat || "locale",
                withValue: (s, v) => ({ ...s, excelTimeFormat: v as AppSettings["excelTimeFormat"] }),
                persist: (v) => App()?.SetAppSetting("excelTimeFormat", v) ?? Promise.resolve(),
            },
            {
                key: "excelTimestampFormat",
                type: "choice",
                options: [
                    ["locale", "Locale default"],
                    ["iso", "ISO 8601 (YYYY-MM-DDTHH:MM:SS.000)"],
                    ["us", "U.S. (MM/DD/YYYY H:MM:SS AM/PM)"],
                    ["eu", "Day-first (DD/MM/YYYY HH:MM:SS)"],
                    ["ibmi", "U.S. time separators (YYYY-MM-DD HH:MM:SS)"],
                    ["ibmiDot", "IBM i ISO (YYYY-MM-DD HH.MM.SS)"],
                ],
                get: (s) => s.excelTimestampFormat || "locale",
                withValue: (s, v) => ({ ...s, excelTimestampFormat: v as AppSettings["excelTimestampFormat"] }),
                persist: (v) => App()?.SetAppSetting("excelTimestampFormat", v) ?? Promise.resolve(),
            },
        ],
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
        type: "toggle",
        get: (s) => (s.confirmSpoolDelete === false ? "off" : "on"),
        withValue: (s, v) => ({ ...s, confirmSpoolDelete: v !== "off" }),
        persist: (v) => App()?.SetAppSetting("confirmSpoolDelete", v) ?? Promise.resolve(),
    },
    {
        key: "ctrlEnterRun",
        type: "toggle",
        get: (s) => (s.ctrlEnterRun ? "on" : "off"),
        withValue: (s, v) => ({ ...s, ctrlEnterRun: v === "on" }),
        persist: (v) => App()?.SetAppSetting("ctrlEnterRun", v) ?? Promise.resolve(),
    },
    {
        key: "connTabLabel",
        type: "choice",
        options: [
            ["userHost", "user@host"],
            ["nameHost", "name: host"],
            ["nameUserHost", "name: user@host"],
            ["nameUser", "name: user"],
            ["hostUser", "host: user"],
            ["name", "name"],
        ],
        get: (s) => s.connTabLabel || "userHost",
        withValue: (s, v) => ({ ...s, connTabLabel: v as AppSettings["connTabLabel"] }),
        persist: (v) => App()?.SetAppSetting("connTabLabel", v) ?? Promise.resolve(),
    },
];
let connectionsPane: ReturnType<typeof createConnectionsPane> | undefined;
let settingsPane: ReturnType<typeof createSettingsPane> | undefined;
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
                ctrlEnterRun = s.ctrlEnterRun === true;
                connTabLabelStyle = s.connTabLabel || "userHost";
                return s;
            },
            save: (next) => app.SetAppSetting("spoolDownloadDir", next.spoolDownloadDir ?? ""),
            onSaved: () => appendLogLine(t("settings.saved", "Settings saved"), "msg-info", true),
            onError: (msg) => showMessages([], msg),
            onChanged: (key, value) => {
                if (key === "theme") setTheme(value as ThemeMode);
                else if (key === "fetchSize") state.fetchSize = Number(value) || 200;
                else if (key === "spoolDblClickAction") spoolDblClickAction = (value || "view") as SpoolDblClickAction;
                else if (key === "defaultNaming") el<HTMLSelectElement>("in-naming").value = value || "system";
                else if (key === "resultsFontSize") applyResultsFontSize(Number(value) || 12);
                else if (key === "editorStopColor") document.documentElement.style.setProperty("--editor-stop-color", value);
                else if (key === "editorCommentColor") document.documentElement.style.setProperty("--editor-comment-color", value);
                else if (key === "editorClCommandColor" || key === "editorClKeywordColor" || key === "editorClValueColor") applyClColorSetting(key, value);
                else if (key === "editorFontSize") document.documentElement.style.setProperty("--editor-font-size", `${value}px`);
                else if (key === "editorSqlHighlighting") els.sqlInput.setSqlHighlighting(value === "on");
                else if (key === "spoolMaxRows") appSettingsCache = { ...appSettingsCache, spoolMaxRows: Number(value) || 0 };
                else if (key === "confirmSpoolDelete") confirmSpoolDelete = value !== "off";
                else if (key === "ctrlEnterRun") ctrlEnterRun = value === "on";
                else if (key === "connTabLabel") { connTabLabelStyle = value || "userHost"; renderTabs(); }
            },
        }, SETTING_DEFS);
        settingsPane = pane;
        host.appendChild(pane.root);
    }
    // Apply the persisted results font size at boot (no settings read needed —
    // it lives in localStorage like the theme).
    const savedFont = localStorage.getItem("ibmi-runsql-results-font");
    if (savedFont) applyResultsFontSize(Number(savedFont) || 12);
    const savedStopColor = localStorage.getItem("ibmi-runsql-editor-stop-color");
    const savedCommentColor = localStorage.getItem("ibmi-runsql-editor-comment-color");
    const savedEditorFont = localStorage.getItem("ibmi-runsql-editor-font-size");
    if (savedStopColor) document.documentElement.style.setProperty("--editor-stop-color", savedStopColor);
    if (savedCommentColor) document.documentElement.style.setProperty("--editor-comment-color", savedCommentColor);
    if (savedEditorFont) document.documentElement.style.setProperty("--editor-font-size", `${savedEditorFont}px`);
    restoreClColors();
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
        connectionsPane = pane;
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
// Ctrl+Enter (Cmd+Enter on Mac) runs the current statement. ACS has no such
// shortcut, so it's opt-in (default OFF) via Settings.
let ctrlEnterRun = false;
// Connection-tab label format (Settings): userHost | nameHost | nameUserHost | name.
let connTabLabelStyle = "userHost";
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
    resultStatement?: string;
    // Retained (pinned) result sets + which subtab was active.
    pinnedResults?: PinnedResult[];
    activePinnedId?: string;
    // Work pane the tab was last showing (results/messages/spool/...) —
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
    // Connected host/user + matched profile name (set at connect). Used for the
    // tab label format setting and tooltip.
    host?: string;
    user?: string;
    serverJob?: string;
    profileName?: string;
    selectedProfileName?: string;
    initialScriptReady?: boolean;
    snapshot?: ResultSnapshot;
    pendingMessagesHtml?: string;
    pendingMessagesReveal?: boolean;
    pendingResults?: Array<() => void>;
    resultVersion?: number;
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

// --- Pinned (retained) results ---
// A pinned result is a frozen snapshot kept beside the live "Latest" grid
// inside the Results pane. Never re-queried; closed via its subtab's ×.
type PinnedResult = PinnedResultType;
let pinnedResults: PinnedResult[] = [];
let activePinnedId = ""; // "" = Latest (the live result)
let pinnedSeq = 0;
const PIN_LABEL_MAX = 32;
// The SQL text that produced the current live result (set in runOne). Pinned
// snapshots carry it so the pop-out window can show/copy the statement.
let lastResultSql = "";
let runningTab: ConnectionTab | undefined;
// Pins currently popped out into their own window: hidden from the subtab
// strip (the window holds the data) but kept here so they restore on close.
const poppedOutPins = new Set<string>();

// The set the grid/export currently reflects: a pinned snapshot or Latest.
function displayedData(): { columns: ColumnInfo[]; rows: unknown[][]; pinned: boolean } {
    const p = activePinnedId ? pinnedResults.find((r) => r.id === activePinnedId) : undefined;
    return p ? { columns: p.columns, rows: p.rows, pinned: true } : { columns: state.columns, rows: state.rows, pinned: false };
}

function syncPinnedWorkspace(): void {
    const connId = activeTab()?.connectionId;
    if (connId) void App()?.UpdatePinnedResults(connId, pinnedResults.map((p) => ({ ...p })));
}

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

async function loadTabServerJob(tab: ConnectionTab, connectionId: string): Promise<void> {
    try {
        const identity = await App().GetConnectionIdentity(connectionId);
        if (!tabs.includes(tab) || tab.connectionId !== connectionId) return;
        tab.serverJob = formatServerJob(identity.serverJob);
        if (activeTab() === tab) syncConnectionUi();
    } catch {
        // A connection may disappear while its window is opening.
    }
}

// Connection-tab hover text. Connected tabs: the saved connection's Name first
// (matched by user@host), then user@host and the useful profile attributes, one
// per line. Falls back to Connected/Not connected when there's no profile match.
function tabTooltip(tab: ConnectionTab): string {
    if (!tab.connectionId) return t("main.notConnected", "Not connected");
    const user = tab.user ?? "";
    const host = tab.host ?? "";
    const prof = profiles.find((p) =>
        p.host.toLowerCase() === host.toLowerCase() && p.user.toLowerCase() === user.toLowerCase());
    const lines: string[] = [];
    if (prof?.name && prof.name.toLowerCase() !== host.toLowerCase()) lines.push(prof.name);
    if (user && host) lines.push(`${user}@${host}`);
    else lines.push(tab.label);
    if (prof) {
        if (prof.defaultSchema) lines.push(`${t("conn.schema", "Default schema")}: ${prof.defaultSchema}`);
        lines.push(`${t("conn.naming", "Naming")}: ${prof.naming === "system" ? "SYS" : "SQL"}`);
        lines.push(prof.tls ? "TLS: Yes" : "TLS: No");
        if (prof.bidiStringType) lines.push(`${t("conn.bidi", "Bidi string type")}: ${prof.bidiStringType}`);
    }
    lines.push(t("main.connected", "Connected"));
    return lines.join("\n");
}

// Tab label text per the connTabLabel setting. Falls back to user@host when a
// name-based option has no profile name to show.
function tabLabelText(tab: ConnectionTab): string {
    const userHost = tab.user && tab.host ? `${tab.user}@${tab.host}` : tab.label;
    const name = tab.profileName ?? "";
    switch (connTabLabelStyle) {
        case "name": return name || userHost;
        case "nameUser": return name ? `${name}: ${tab.user ?? ""}`.trim() : userHost;
        case "hostUser": return tab.host ? `${tab.host}: ${tab.user ?? ""}`.trim() : userHost;
        case "nameHost": return name ? `${name}: ${tab.host ?? ""}`.trim() : userHost;
        case "nameUserHost": return name ? `${name}: ${userHost}` : userHost;
        default: return userHost; // "userHost"
    }
}

function renderTabs(): void {
    const list = el<HTMLDivElement>("conn-tab-list");
    list.innerHTML = "";
    for (const tab of tabs) {
        const btn = document.createElement("button");
        btn.className = "conn-tab" + (tab.key === activeTabKey ? " active" : "");
        btn.textContent = tabLabelText(tab);
        btn.title = tabTooltip(tab);
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
    if (!tab.connectionId || tab === runningTab) return;
    const app = App();
    try {
        if (tab.pendingResults?.length && activeTab() !== tab) switchTab(tab.key);
        if (activeTab() === tab) {
            await app.UpdateEditorText(tab.connectionId, els.sqlInput.value);
            await app.UpdateMessagesHTML(tab.connectionId, els.messageList.innerHTML);
            await app.UpdateStatusText(tab.connectionId, els.statusText.textContent ?? "");
        }
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
        resultStatement: lastResultSql,
        pinnedResults: pinnedResults.map((p) => ({ ...p, columns: [...p.columns], rows: p.rows.map((r) => [...r]) })),
        activePinnedId,
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
    const tab = activeTab();
    const snap = tab?.snapshot;
    state.columns = snap ? [...snap.columns] : [];
    state.rows = snap ? snap.rows.map((r) => [...r]) : [];
    state.cursorId = snap?.cursorId ?? null;
    state.more = snap?.more ?? false;
    lastResultSql = snap?.resultStatement ?? "";
    state.sortCol = -1;
    state.sortDir = 1;
    pinnedResults = (snap?.pinnedResults ?? []).map((p) => ({ ...p, columns: [...p.columns], rows: p.rows.map((r) => [...r]) }));
    activePinnedId = snap?.activePinnedId ?? "";
    els.sqlInput.value = snap?.editorText ?? "";
    // Restore the pane the tab was last showing (defaults to Results);
    // otherwise switching away from Spooled Files and back jumps to Results.
    const pane = tab?.pendingMessagesReveal ? "messages" : snap?.activePane ?? "results";
    if (snap?.showingResults) {
        renderResultSubtabs();
        renderTable();
        els.statusText.textContent = snap.statusText;
        const pinnedView = !!activePinnedId;
        els.btnLoadMore.hidden = pinnedView || !state.more;
        els.btnLoadAll.hidden = pinnedView || !state.more;
        els.saveResultsWrap.hidden = displayedData().rows.length === 0;
        els.btnPinResult.disabled = pinnedView || displayedData().rows.length === 0;
    } else {
        els.resultHead.innerHTML = "";
        els.resultBody.innerHTML = "";
        els.statusText.textContent = "";
        els.btnLoadMore.hidden = true;
        els.btnLoadAll.hidden = true;
        renderResultSubtabs();
    }
    if (!snap?.showingResults) els.btnPinResult.disabled = true;
    showPane(pane);
    // Spooled Files: refresh when the visible list belongs to a different
    // connection (mirrors the work-tab click handler's stale reload).
    if (pane === "spool" && spoolState.loadedFor !== (activeTab()?.connectionId ?? "")) {
        void refreshSpool(spool.filters());
    }
    els.messageList.innerHTML = (snap?.messagesHtml ?? "") + (tab?.pendingMessagesHtml ?? "");
    if (tab) { tab.pendingMessagesHtml = ""; tab.pendingMessagesReveal = false; }
    if (tab?.pendingResults?.length) {
        const pending = tab.pendingResults.splice(0);
        for (const apply of pending) apply();
    }
    closeAllPrompterPanes();
    // Quick Connect form: per-tab state; a fresh tab starts blank so the
    // suggest dropdown isn't pre-filtered by the previous tab's host.
    const cf = snap?.connForm;
    el<HTMLInputElement>("in-host").value = cf?.host ?? "";
    el<HTMLInputElement>("in-user").value = cf?.user ?? "";
    el<HTMLInputElement>("in-password").value = cf?.password ?? "";
    el<HTMLInputElement>("in-schema").value = cf?.schema ?? "";
    el<HTMLSelectElement>("in-naming").value = cf?.naming ?? "system";
    // TLS / Save password: a tab with its own form state wins; a fresh tab
    // falls back to the user's sticky localStorage choice (not a hard false).
    el<HTMLInputElement>("in-tls").checked = cf?.tls ?? (localStorage.getItem("ibmi-runsql-qc-tls") === "1");
    el<HTMLInputElement>("in-save-password").checked = cf?.savePassword ?? (localStorage.getItem("ibmi-runsql-qc-savepw") === "1");
    // A blank/fresh form means no saved profile is armed on this tab — disarm
    // GO. dataset.armed
    // lives on the shared button, so clear it or a prior tab's pick leaks over.
    if (!cf?.host) {
        const go = document.getElementById("btn-go") as HTMLButtonElement | null;
        if (go) { delete go.dataset.armed; go.disabled = true; go.hidden = false; }
    }
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
    void loadTabServerJob(tab, connectionId);
    syncConnectionUi();
    let ws: {
        label?: string; editorText?: string; initialEditorText?: string; statusText?: string; messagesHtml?: string;
        columns?: ColumnInfo[]; rows?: unknown[][]; cursorId?: string; more?: boolean; showingResults?: boolean;
        pinnedResults?: PinnedResult[]; resultStatement?: string;
    } = {};
    try {
        ws = (await app.GetWorkspace(connectionId)) as typeof ws;
    } catch {
        // workspace gone: keep the bare tab
    }
    if (!tabs.includes(tab) || tab.connectionId !== connectionId) return;
    tab.label = ws.label ?? t("main.connection", "Connection");
    tab.initialScriptReady = typeof ws.initialEditorText === "string";
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
        resultStatement: ws.resultStatement ?? "",
        pinnedResults: (ws.pinnedResults ?? []).map((p) => ({ ...p })),
        activePinnedId: "",
    };
    if (activeTab() === tab) restoreActiveTab();
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
    Events.On("enhancedSupport:progress", (ev: { data?: { connectionId?: string; message?: string } }) => {
        const connectionId = ev?.data?.connectionId;
        const message = ev?.data?.message;
        if (connectionId && message) appendConnectionLog(connectionId, message, "msg-info", false);
    });
    Events.On("workspace:reattach", (ev: { data?: { connectionId?: string } }) => {
        const id = ev?.data?.connectionId;
        if (id) void addDetachedTab(id);
    });
    // A popped-out pinned result window closed: restore its subtab in the strip.
    Events.On("pinned:closed", (ev: { data?: { pinId?: string } }) => {
        const pinId = ev?.data?.pinId;
        if (pinId && poppedOutPins.delete(pinId)) renderResultSubtabs();
    });
}

function switchTab(key: string): void {
    if (activeTabKey === key) return;
    els.sqlInput.clearRunningStatement();
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
    if (tab === runningTab) return;
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
    toolbarStatus.sync();
    const connected = !!tab?.connectionId;
    const job = connected ? formatServerJob(tab?.serverJob) : "";
    els.serverJob.hidden = !job;
    els.serverJob.textContent = job ? `${t("main.sqlJob", "SQL job")}: ${job}` : "";
    els.badge.textContent = connected
        ? `${tab!.label} - ${t("main.connected", "Connected")}`
        : t("main.notConnected", "Not connected");
    els.badge.className = `badge ${connected ? "connected" : "disconnected"}`;
    els.btnConnect.disabled = connected;
    // GO shows only when a saved profile is armed (picked from the dropdown);
    // new/unsaved connections use the Connect button, so GO hides for them.
    const goBtn = document.getElementById("btn-go") as HTMLButtonElement | null;
    if (goBtn) {
        goBtn.disabled = connected || !goBtn.dataset.armed;
        goBtn.hidden = connected;
    }
    els.btnDisconnect.disabled = !connected || tab === runningTab;
    els.btnRun.disabled = !connected || state.running;
    els.btnRunAll.disabled = !connected || state.running;
    els.btnRunFrom.disabled = !connected || state.running;
    els.btnPrompt.disabled = !connected;
    el<HTMLButtonElement>("btn-reload-script").disabled = !connected || !tab?.initialScriptReady;
    els.btnPinResult.disabled = !connected || state.running || !!activePinnedId || state.columns.length === 0 || state.rows.length === 0;
    els.btnCancel.disabled = !state.running || tab !== runningTab;
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
    tab.initialScriptReady = false;
    tab.host = info.host;
    tab.user = info.user;
    tab.serverJob = formatServerJob(info.serverJob);
    // Match the saved profile (for the tab name/tooltip) by host+user.
    tab.profileName = profiles.find((p) =>
        p.host.toLowerCase() === info.host.toLowerCase()
        && p.user.toLowerCase() === info.user.toLowerCase())?.name ?? "";
    tab.label = tabLabelText(tab);
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
    const job = tab.serverJob ? ` - ${t("main.sqlJob", "SQL job")}: ${tab.serverJob}` : "";
    appendLogLine(`[ ${nowStamp()} ]  ${info.user}@${info.host} ${t("main.connected", "Connected")}${job}`, "msg-action");
    appendLogLine(t("main.logConnectedDetail", "Connected to relational database {product} on {host} as {user}{job} using JDBC driver '{driver}'")
        .replace("{product}", info.databaseProduct)
        .replace("{host}", info.host)
        .replace("{user}", info.user)
        .replace("{job}", "")
        .replace("{driver}", `${info.driverName} ${info.driverVersion}`), "msg-info", true);
}

function setDisconnected(): void {
    const tab = activeTab();
    if (tab) {
        tab.connectionId = null;
        tab.serverJob = undefined;
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

function appendConnectionLog(connectionId: string, text: string, cls: string, reveal: boolean): void {
    const tab = tabs.find((entry) => entry.connectionId === connectionId);
    if (!tab) return;
    const active = activeTab() === tab;
    const html = appendEnhancedSupportLog(tab, active, els.messageList, text, cls, reveal);
    if (active && reveal) showPane("messages");
    if (html !== null) void App()?.UpdateMessagesHTML(connectionId, html);
}

function nowStamp(): string {
    return new Date().toLocaleString(undefined, {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
}

/** ACS-style execution log entry: action header + statement + outcome. */
function logExecution(action: string, statement: string, outcome: string, isCL = false): void {
    if (els.messageList.children.length > 0) {
        const sep = document.createElement("li");
        sep.className = "msg msg-separator";
        sep.textContent = "─".repeat(60);
        els.messageList.appendChild(sep);
    }
    appendLogLine(`[ ${nowStamp()} ]  ${action}`, "msg-action");
    for (const line of statement.split("\n")) {
        appendLogLine(line, isCL ? "msg-statement msg-cl-command" : "msg-statement", true);
    }
    appendLogLine(outcome, outcome.startsWith(t("main.statementRan", "Statement ran")) || outcome.includes(t("main.ok", "OK")) ? "msg-info" : "msg-warning", true);
}

function showMessages(items: DisplayMessage[] | undefined, failure?: string, revealErrors = true): void {
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
        const isCLMessage = !!m.id || !!m.typeName;
        const clMetadata = [m.id, m.severity != null ? String(m.severity) : "", m.typeName].filter(Boolean).join(" ");
        if (!idPart) {
            li.textContent = isCLMessage && clMetadata ? `${clMetadata} - ${textPart}` : textPart;
        } else if (m.id) {
            li.textContent = `${clMetadata} - ${textPart}`;
        } else {
            li.appendChild(document.createTextNode(idPart));
            li.appendChild(document.createElement("br"));
            li.appendChild(document.createTextNode(textPart));
        }
        li.classList.add("msg-indent");
        // The Go-side error string repeats the SQL message in [sqlState] [msgId]
        // form; if a messages entry already carries that text, drop the duplicate.
        if (failure && textPart && failure.includes(textPart)) coveredFailure = true;
        const tip: string[] = [];
        if (m.typeName) tip.push(t("main.msgTypeSeverity", "Type: {type}  Severity: {severity}").replace("{type}", m.typeName).replace("{severity}", String(m.severity)));
        if (m.secondLevelText) tip.push(m.secondLevelText);
        if (tip.length) li.title = tip.join("\n\n");
        if (isCLMessage) addCLMessageDetails(li, m);
        else if (m.secondLevelText) {
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
    if (hasError && revealErrors) showPane("messages");
}

function columnLabel(c: ColumnInfo): string {
    return (c.label || c.name || "").trim() || c.name || "";
}

function renderTable(): void {
    els.resultHead.innerHTML = "";
    els.resultBody.innerHTML = "";

    // Render the current view (live result or a pinned snapshot) WITHOUT
    // copying into shared state — the live result must survive pin browsing.
    const view = displayedData();
    const cols = view.columns;
    const rows = view.rows;

    const headRow = document.createElement("tr");
    const rowNumTh = document.createElement("th");
    rowNumTh.className = "row-index";
    rowNumTh.textContent = "ROW";
    headRow.appendChild(rowNumTh);

    cols.forEach((c, idx) => {
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

    const viewRows = [...rows];
    if (state.sortCol >= 0) {
        const col = cols[state.sortCol];
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
            if (columnKind(c) === "text") td.classList.add("preserve-whitespace");
            if (shouldRightAlign(c)) td.classList.add("num");
            tr.appendChild(td);
        });
        frag.appendChild(tr);
    });
    els.resultBody.appendChild(frag);
}

// --- Pinned-result subtabs ---------------------------------------------
// Rendered inside #pane-results, only when at least one pin exists. First
// subtab is always the live "Latest"; pinned subtabs follow with a × to
// close. Double-click / right-click a pinned subtab to rename (<=32 chars).
function renderResultSubtabs(): void {
    const strip = els.resultSubtabs;
    strip.innerHTML = "";
    if (pinnedResults.length === 0) {
        strip.hidden = true;
        return;
    }
    strip.hidden = false;

    const mk = (id: string, label: string, pinned: PinnedResult | undefined): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "result-subtab" + (activePinnedId === id ? " active" : "");
        b.dataset.pinId = id;
        const span = document.createElement("span");
        span.className = "result-subtab-label";
        span.textContent = label;
        b.appendChild(span);
        if (pinned) {
            b.title = t("result.pinTabTitle", "Pinned result — double-click or right-click to rename");
            // Pop out into a standalone read-only window for side-by-side.
            const pop = document.createElement("span");
            pop.className = "result-subtab-pop";
            pop.textContent = "↗"; // arrow out
            pop.title = t("result.popOut", "Open in its own window");
            pop.addEventListener("click", (ev) => {
                ev.stopPropagation();
                const connId = activeTab()?.connectionId ?? "";
                const app = App();
                if (!connId || !app || typeof app.OpenPinnedWindow !== "function") {
                    appendLogLine(t("result.popOutUnavailable", "Pop out is not available (no connection)."), "msg-error", true);
                    return;
                }
                appendLogLine(t("result.popOutOpening", "Opening \"{label}\" in its own window...").replace("{label}", pinned.label), "msg-info", true);
                void app.OpenPinnedWindow(connId, pinned.id, pinned.label)
                    .then(() => {
                        // Pop-out MOVES the pin into the window: hide its subtab
                        // (restored by the pinned:closed event when it closes).
                        poppedOutPins.add(pinned.id);
                        if (activePinnedId === pinned.id) selectResultSubtab("");
                        else renderResultSubtabs();
                    })
                    .catch((err) => showMessages([], String((err as Error)?.message ?? err)));
            });
            b.appendChild(pop);
            const x = document.createElement("span");
            x.className = "result-subtab-close";
            x.textContent = "×";
            x.title = t("result.closePin", "Close pinned result");
            x.addEventListener("click", (ev) => { ev.stopPropagation(); closePinned(pinned.id); });
            b.appendChild(x);
            b.addEventListener("dblclick", () => renamePinned(pinned, span));
            b.addEventListener("contextmenu", (ev) => { ev.preventDefault(); renamePinned(pinned, span); });
        } else {
            b.title = t("result.latestTabTitle", "Live result (replaced on each run)");
        }
        b.addEventListener("click", () => selectResultSubtab(id));
        return b;
    };

    strip.appendChild(mk("", t("result.latestTab", "Results"), undefined));
    for (const p of pinnedResults) {
        if (!poppedOutPins.has(p.id)) strip.appendChild(mk(p.id, p.label, p));
    }

    // "Close pinned..." opens a small scope dialog (windows / results / both).
    const spacer = document.createElement("span");
    spacer.className = "result-subtabs-spacer";
    strip.appendChild(spacer);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "result-subtab result-subtab-closeall";
    closeBtn.textContent = t("result.closePinned", "Close pinned…");
    closeBtn.title = t("result.closePinnedTitle", "Close pinned results and/or popped-out pinned windows");
    closeBtn.addEventListener("click", () => showClosePinnedDialog());
    strip.appendChild(closeBtn);
}

// Scope dialog for closing pinned items: checkboxes for windows + results
// (both default on). OK applies the chosen scope; Cancel/Esc dismisses.
function showClosePinnedDialog(): void {
    const app = App();
    const connId = activeTab()?.connectionId ?? "";

    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const box = document.createElement("div");
    box.className = "confirm-dialog";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");

    const title = document.createElement("div");
    title.className = "confirm-title";
    title.textContent = t("result.closePinnedDlgTitle", "Close pinned");
    box.appendChild(title);

    const mkCheck = (key: string, labelKey: string, fb: string): HTMLInputElement => {
        const lab = document.createElement("label");
        lab.className = "confirm-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.dataset.scope = key;
        const span = document.createElement("span");
        span.textContent = t(labelKey, fb);
        lab.appendChild(cb);
        lab.appendChild(span);
        box.appendChild(lab);
        return cb;
    };
    const cbWindows = mkCheck("windows", "result.closePinnedWindows", "Pinned windows (popped out)");
    const cbResults = mkCheck("results", "result.closePinnedResults", "Pinned results (tabs)");

    const btnRow = document.createElement("div");
    btnRow.className = "confirm-actions";
    const btnOk = document.createElement("button");
    btnOk.type = "button";
    btnOk.className = "btn primary";
    btnOk.textContent = t("confirm.ok", "OK");
    const btnCancel = document.createElement("button");
    btnCancel.type = "button";
    btnCancel.className = "btn";
    btnCancel.textContent = t("confirm.cancel", "Cancel");
    btnRow.appendChild(btnOk);
    btnRow.appendChild(btnCancel);
    box.appendChild(btnRow);
    overlay.appendChild(box);

    const close = () => overlay.remove();
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    overlay.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } });
    btnCancel.addEventListener("click", close);
    btnOk.addEventListener("click", () => {
        const doWindows = cbWindows.checked;
        const doResults = cbResults.checked;
        close();
        if (!doWindows && !doResults) return;
        if (doWindows && connId) {
            // Close this connection's pop-out windows; pinned:closed restores
            // their subtabs unless we're also clearing results below.
            void app?.ClosePinnedWindowsFor(connId).catch(() => { /* best effort */ });
        }
        if (doResults) {
            pinnedResults = [];
            poppedOutPins.clear();
            activePinnedId = "";
            renderResultSubtabs();
            selectResultSubtab("");
            syncPinnedWorkspace();
            appendLogLine(t("result.closedAllPins", "Closed all pinned results"), "msg-info", true);
        }
    });

    document.body.appendChild(overlay);
    btnOk.focus();
}

function selectResultSubtab(id: string): void {
    activePinnedId = id;
    // Do NOT copy into state.columns/rows — renderTable reads the current view
    // (live vs pinned) directly so the live result is never clobbered.
    state.sortCol = -1;
    state.sortDir = 1;
    renderTable();
    renderResultSubtabs();
    const view = displayedData();
    const pinned = !!id;
    const total = view.rows.length;
    els.btnLoadMore.hidden = true;
    els.btnLoadAll.hidden = true;
    if (!pinned) {
        els.btnLoadMore.hidden = !state.more;
        els.btnLoadAll.hidden = !state.more;
    }
    els.saveResultsWrap.hidden = total === 0;
    els.btnPinResult.disabled = pinned || total === 0;
    if (pinned) {
        els.statusText.textContent = t("result.pinnedStatus", "{count} row(s) (pinned)").replace("{count}", String(total));
    }
}

function pinCurrentResult(): void {
    if (state.columns.length === 0 || state.rows.length === 0) return;
    pinnedSeq += 1;
    const label = t("result.pinLabel", "Pin {n}").replace("{n}", String(pinnedSeq));
    pinnedResults.push({
        id: `pin-${Date.now()}-${pinnedSeq}`,
        label,
        columns: state.columns.map((c) => ({ ...c })),
        rows: state.rows.map((r) => [...r]),
        sql: lastResultSql || undefined,
    });
    activePinnedId = pinnedResults[pinnedResults.length - 1].id;
    renderResultSubtabs();
    selectResultSubtab(activePinnedId);
    syncPinnedWorkspace();
    appendLogLine(t("result.pinned", "Pinned result as \"{label}\"").replace("{label}", label), "msg-info", true);
}

function closePinned(id: string): void {
    pinnedResults = pinnedResults.filter((r) => r.id !== id);
    if (activePinnedId === id) selectResultSubtab("");
    else renderResultSubtabs();
    syncPinnedWorkspace();
}

function renamePinned(p: PinnedResult, span: HTMLElement): void {
    if (span.querySelector("input")) return; // already editing
    const input = document.createElement("input");
    input.type = "text";
    input.className = "result-subtab-rename";
    input.value = p.label;
    input.maxLength = PIN_LABEL_MAX;
    span.textContent = "";
    span.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
        const v = input.value.trim().slice(0, PIN_LABEL_MAX);
        if (v) { p.label = v; syncPinnedWorkspace(); }
        renderResultSubtabs();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") { input.removeEventListener("blur", commit); renderResultSubtabs(); }
    });
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
    els.saveResultsWrap.hidden = !(kind === "rows" && state.columns.length > 0);
    // Load more/all page the live cursor — not applicable to a frozen pin.
    const pinnedView = !!activePinnedId;
    if (pinnedView) { els.btnLoadMore.hidden = true; els.btnLoadAll.hidden = true; }
    els.btnPinResult.disabled = !(kind === "rows" && totalRows > 0) || pinnedView;
}

// Save the result grid: native Save dialog (name + location), chosen format.
// Delimiter override applies to CSV only (TAB/JSON/Markdown have fixed layouts).
const inSaveDelim = el<HTMLInputElement>("in-save-delim");
const preferredSaveFormat = loadPreferredSaveFormat();
if (preferredSaveFormat) els.selSaveFormat.value = preferredSaveFormat;
function syncSaveDelimVisibility(): void {
    const isCsv = els.selSaveFormat.value === "csv";
    inSaveDelim.hidden = !isCsv;
    if (isCsv && !inSaveDelim.dataset.touched) inSaveDelim.value = ",";
}
els.selSaveFormat.addEventListener("change", () => {
    persistPreferredSaveFormat(els.selSaveFormat.value);
    // Reset to the comma default on switch unless the user typed a custom one.
    delete inSaveDelim.dataset.touched;
    syncSaveDelimVisibility();
});
inSaveDelim.addEventListener("input", () => { inSaveDelim.dataset.touched = "1"; });
syncSaveDelimVisibility();

els.btnSaveResults.addEventListener("click", () => {
    void (async () => {
        const app = App();
        const { columns, rows } = displayedData();
        if (!app || columns.length === 0) return;
        const format = els.selSaveFormat.value as SaveFormat;
        const pinned = pinnedResults.find((r) => r.id === activePinnedId);
        const base = pinned ? pinned.label.replace(/[^A-Za-z0-9_.-]+/g, "_") : `results_${activeTab()?.label?.split("@")[1] || "results"}`;
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        try {
            if (format === "xlsx") {
                const saved = await app.SaveXLSXAs(`${base}_${stamp}.xlsx`, columns, rows);
                if (!saved) return;
                appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
                els.statusText.textContent = t("spool.statusSaved", "Saved {path}").replace("{path}", saved);
                return;
            }
            const delim = (format === "csv" && inSaveDelim.value.length > 0) ? unescapeDelimiter(inSaveDelim.value) : undefined;
            const text = formatResultData(columns, rows, format, delim);
            const saved = await app.SaveFileAs(
                `${base}_${stamp}.${format}`,
                btoa(unescape(encodeURIComponent(text))),
                format.toUpperCase(), `*.${format}`);
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

// Pin the live result into its own retained subtab inside the Results pane.
els.btnPinResult.addEventListener("click", () => pinCurrentResult());

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
        // A fresh run always lands on the live "Latest" subtab.
        activePinnedId = "";
        renderResultSubtabs();
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
    if (result.preserveResults) {
        showMessages(result.messages, result.ok ? undefined : t("main.clCommandFailed", "CL command failed."), false);
        return;
    }
    if (result.resultSet) {
        const table = result.resultSet;
        state.rows = table.rows ?? [];
        lastResultSql = result.command;
        showSqlResult({ ...table, kind: "rows", elapsedMs: result.elapsedMs });
        showMessages(result.messages, result.ok ? undefined : t("main.clCommandFailed", "CL command failed."), false);
        return;
    }
    state.columns = [];
    state.rows = [];
    state.cursorId = null;
    state.more = false;
    lastResultSql = "";
    els.resultHead.innerHTML = "";
    els.resultBody.innerHTML = "";
    showMessages(result.messages, result.ok ? undefined : t("main.clCommandFailed", "CL command failed."));
    els.statusText.textContent = `CL: ${result.command} — ${result.ok ? t("main.ok", "OK") : t("main.failed", "failed")}${t("main.elapsedIn", " in {ms} ms").replace("{ms}", String(result.elapsedMs))}`;
    els.btnLoadMore.hidden = true;
    els.btnLoadAll.hidden = true;
    els.saveResultsWrap.hidden = true;
    els.btnPinResult.disabled = true;
}

async function doConnect(): Promise<void> {
    const app = App();
    if (!app) return;
    if (connectionsPane && !await connectionsPane.commit()) return;
    await loadProfiles();
    els.connectError.hidden = true;
    els.btnConnect.disabled = true;
    // Connecting status on the profile-hint line under GO (dominant styling).
    const hint = el<HTMLSpanElement>("profile-hint");
    const hintText = hint.textContent ?? "";
    const connectingTo = `${el<HTMLInputElement>("in-user").value.trim()}@${el<HTMLInputElement>("in-host").value.trim()}`;
    hint.textContent = t("main.connecting", "Connecting to {target}...").replace("{target}", connectingTo);
    hint.classList.add("connecting");
    try {
        // Bidi string type lives on the saved profile (Connections pane), not
        // the quick-connect form — resolve it from the host/user match.
        const hostVal = el<HTMLInputElement>("in-host").value;
        const userVal = el<HTMLInputElement>("in-user").value;
        const matchProf = matchConnectionProfile(profiles, hostVal, userVal, activeTab()?.selectedProfileName);
        const info = await app.Connect({
            host: hostVal,
            user: userVal,
            password: el<HTMLInputElement>("in-password").value,
            tls: el<HTMLInputElement>("in-tls").checked,
            naming: el<HTMLSelectElement>("in-naming").value,
            defaultSchema: el<HTMLInputElement>("in-schema").value,
            fetchSize: state.fetchSize,
            bidiStringType: matchProf?.bidiStringType ?? "",
            clExecutionMode: matchProf?.clExecutionMode || (matchProf?.useEnhancedCLSupport === true ? "enhanced" : "standard"),
        });
        setConnected(info);
        const tab = activeTab();
        if (tab && matchProf) { tab.profileName = matchProf.name; tab.label = tabLabelText(tab); renderTabs(); }
        // Auto-save (MRU) on successful connect — no Save button needed.
        await saveProfile(matchProf);
        const prof = matchProf && profiles.find((p) => p.name === matchProf.name) || matchProf;
        els.sqlInput.value = scriptForConnection(prof, els.sqlInput.value);
        await app.SetInitialEditorText(info.connectionId, els.sqlInput.value);
        const connectedTab = tabs.find((tab) => tab.connectionId === info.connectionId);
        if (connectedTab) connectedTab.initialScriptReady = true;
        syncConnectionUi();
        // Spooled Files: preload at connect when the setting is on; otherwise
        // leave the list empty so opening the tab (or Refresh) fetches it.
        spoolState.loadedFor = "";
        spool.clear();
        if (preloadSpoolList) {
            void refreshSpool(spool.filters());
        }
        toolbarStatus.show(t("main.connectedTo", "Connected to {target}").replace("{target}", `${info.user}@${info.host}`), info.connectionId);
        let automaticOperation: string | undefined;
        let additionalInstallationsLogged = false;
        const appendAdditionalInstallations = (lines: string[], cls: string, reveal: boolean) => {
            lines.forEach((line, index) => appendConnectionLog(info.connectionId, line, cls, reveal && index === 0));
        };
        try {
            const settings = await app.GetAppSettings();
            const outcome = await setupEnhancedSupport(settings, info.host,
                (library) => app.CheckEnhancedSupport(info.connectionId, library),
                (library) => {
                    if (!automaticOperation) appendConnectionLog(info.connectionId, `Installing enhanced support in ${library} on ${info.host}...`, "msg-action", true);
                    return app.InstallEnhancedSupport(info.connectionId, library);
                },
                confirmEnhancedSupport, matchProf?.clExecutionMode === "enhanced" || matchProf?.useEnhancedCLSupport === true,
                (library, expectedVersion) => {
                    if (!automaticOperation) appendConnectionLog(info.connectionId, `Upgrading ${library}.CMD_RUN on ${info.host} from version ${expectedVersion}...`, "msg-action", true);
                    return app.UpgradeEnhancedSupport(info.connectionId, library, expectedVersion);
                },
                (status) => {
                    if (status.versionStatus === "older") {
                        appendConnectionLog(info.connectionId, `Detected ${status.library}.CMD_RUN version ${status.installedVersion || "unknown"}. Upgrade required before CL processing.`, "msg-warning", false);
                        const alternative = enhancedSupportAlternativeMessage(status);
                        if (alternative) {
                            appendAdditionalInstallations(alternative, "msg-info", false);
                            additionalInstallationsLogged = true;
                        }
                    }
                },
                (library) => {
                    if (!automaticOperation) appendConnectionLog(info.connectionId, `Repairing ${library}/CMD_RUN on ${info.host}...`, "msg-action", true);
                    return app.RepairEnhancedSupport(info.connectionId, library);
                },
                (library) => app.SelectEnhancedSupport(info.connectionId, library),
                (library) => {
                    appSettingsCache = { ...appSettingsCache, enhancedSupportLibrary: library };
                    settingsPane?.updateSetting("enhancedSupportLibrary", library);
                },
                (operation, library, alternatives) => {
                    automaticOperation = operation;
                    appendConnectionLog(info.connectionId, `Starting automatic ${operation} of ${library}.CMD_RUN on ${info.host} (Function update notifications).`, "msg-action", true);
                    if (!additionalInstallationsLogged && alternatives.length) {
                        const lines = enhancedSupportInstallationMessages(alternatives, undefined, `not selected; ${library} is configured`);
                        appendAdditionalInstallations(lines, "msg-warning", true);
                        additionalInstallationsLogged = true;
                    }
                });
            const message = enhancedSupportLogEntry(outcome, info.host);
            if (message) appendConnectionLog(info.connectionId, message.text, message.cls, message.reveal);
            if (!additionalInstallationsLogged && "status" in outcome) {
                const alternative = enhancedSupportAlternativeMessage(outcome.status);
                if (alternative) {
                    appendAdditionalInstallations(alternative, "msg-info", false);
                    additionalInstallationsLogged = true;
                }
            }
        } catch (error) {
            appendConnectionLog(info.connectionId, `${automaticOperation ? `Automatic ${automaticOperation} failed` : "Enhanced support"}: ${String((error as Error)?.message ?? error)}`, "msg-error", true);
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
    const tab = activeTab();
    if (tab) tab.selectedProfileName = p.name;
    el<HTMLInputElement>("in-host").value = p.host;
    el<HTMLInputElement>("in-user").value = p.user;
    el<HTMLInputElement>("in-schema").value = p.defaultSchema ?? "";
    el<HTMLSelectElement>("in-naming").value = p.naming || "system";
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

// "New connection" dropdown item: clear the Quick Connect form to blank and
// reset the switches to the user's sticky localStorage state. GO hides (nothing
// armed); Connect handles the new connection.
function clearConnectForm(): void {
    const tab = activeTab();
    if (tab) tab.selectedProfileName = undefined;
    el<HTMLInputElement>("in-host").value = "";
    el<HTMLInputElement>("in-user").value = "";
    el<HTMLInputElement>("in-password").value = "";
    el<HTMLInputElement>("in-schema").value = "";
    el<HTMLSelectElement>("in-naming").value = appSettingsCache.defaultNaming || "system";
    el<HTMLInputElement>("in-tls").checked = localStorage.getItem("ibmi-runsql-qc-tls") === "1";
    el<HTMLInputElement>("in-save-password").checked = localStorage.getItem("ibmi-runsql-qc-savepw") === "1";
    const go = document.getElementById("btn-go") as HTMLButtonElement | null;
    if (go) { delete go.dataset.armed; go.disabled = true; go.hidden = false; }
    el<HTMLInputElement>("in-host").focus();
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

async function saveProfile(selectedProfile?: ConnectionProfile): Promise<void> {
    const app = App();
    if (!app) return;
    const p = formProfile();
    if (selectedProfile) {
        p.name = selectedProfile.name;
        p.clExecutionMode = selectedProfile.clExecutionMode || (selectedProfile.useEnhancedCLSupport === true ? "enhanced" : "standard");
    } else {
        p.clExecutionMode = "standard";
    }
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
    if (!app || !tab?.connectionId || tab === runningTab) return;
    if (connectionsPane && !await connectionsPane.commit()) return;
    await loadProfiles();
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
async function runOne(text: string, actionLabel = t("main.logRunSelected", "Run Selected..."), tab = activeTab()): Promise<boolean> {
    const app = App();
    const connectionId = tab?.connectionId;
    if (!app || !connectionId || !tab) return false;
    tab.resultVersion = (tab.resultVersion ?? 0) + 1;
    inputHistories.for(connectionId).push(text);
    if (activeTab() === tab) await persistEditorScript();
    // Persisted per-connection history (powers the picker; survives restarts).
    // Store the terminating semicolon so recall/picker round-trip the exact
    // runnable statement.
    const logged = /;\s*$/.test(text) ? text : `${text};`;
    void app.AddStatementHistory(connectionId, logged).catch(() => { /* best effort */ });
    if (activeTab() === tab) {
        if (/^\s*CL\s*:/i.test(text)) {
            showPane("messages");
        } else {
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
            if (activePinnedId !== "") {
                activePinnedId = "";
                renderResultSubtabs();
            }
            showPane("results");
        }
    }
    const started = performance.now();
    try {
        const result = await app.Run({
            connectionId,
            text,
            fetchSize: state.fetchSize,
        });
        const elapsed = Math.round(performance.now() - started);
        const apply = () => {
            if ((result as CLResult).kind === "cl") {
                const cl = result as CLResult;
                logExecution(actionLabel, text,
                    cl.ok ? t("main.logCommandRan", "Command ran successfully   ({ms} ms)").replace("{ms}", String(cl.elapsedMs))
                        : t("main.logCommandFailed", "Command failed   ({ms} ms)").replace("{ms}", String(cl.elapsedMs)), true);
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
                lastResultSql = sqlResult.kind === "rows" ? text : "";
                showSqlResult(sqlResult);
            }
            const status = (result as SqlResult).kind === "error"
                ? t("main.statementFailed", "Statement failed")
                : els.statusText.textContent ?? "";
            toolbarStatus.show(status, connectionId);
            pushWorkspaceState();
        };
        if (activeTab() === tab) apply();
        else (tab.pendingResults ??= []).push(apply);
        return (result as CLResult).kind === "cl" ? (result as CLResult).ok : (result as SqlResult).kind !== "error";
    } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        const apply = () => {
            logExecution(actionLabel, text, t("main.logStatementFailed", "Statement failed{state}   ({ms} ms)").replace("{state}", "").replace("{ms}", String(elapsed)), /^\s*CL(?:\s*:|\s+)/i.test(text));
            showMessages([], String((err as Error)?.message ?? err));
            els.statusText.textContent = t("main.error", "Error");
            toolbarStatus.show(t("main.statementFailed", "Statement failed"), connectionId);
            pushWorkspaceState();
        };
        if (activeTab() === tab) apply();
        else (tab.pendingResults ??= []).push(apply);
        throw err;
    }
}

function setRunning(on: boolean): void {
    state.running = on;
    runningTab = on ? activeTab() : undefined;
    const connected = !!activeTab()?.connectionId;
    els.btnRun.disabled = on || !connected;
    els.btnRunAll.disabled = on || !connected;
    els.btnRunFrom.disabled = on || !connected;
    els.btnDisconnect.disabled = !connected || (on && activeTab() === runningTab);
    // Pinning a result mid-run would snapshot the cleared/refreshing grid.
    els.btnPinResult.disabled = on || !connected || !!activePinnedId || state.columns.length === 0 || state.rows.length === 0;
    els.btnCancel.disabled = !on || activeTab() !== runningTab;
}

// Live busy indicator: status-busy styling + an elapsed-time ticker on the
// status line so a long-running statement (slow host link) is obviously in
// flight. Cancel stays enabled (setRunning). Ticker stops on runTimerStop.
let runTimerId: ReturnType<typeof setInterval> | undefined;
let runTimerBase = "";
let runTimerStart = 0;
let runTimerTotalStart = 0; // 0 = no continuous total (single Run Selected)

function fmtElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function runTimerTick(): void {
    const now = performance.now();
    const stmt = fmtElapsed(now - runTimerStart);
    const total = runTimerTotalStart > 0 ? ` ${t("main.totalTime", "Total: {time}").replace("{time}", fmtElapsed(now - runTimerTotalStart))}` : "";
    els.runStatus.textContent = `${runTimerBase} ${stmt}${total}`;
}

// totalStart: pass performance.now() on the FIRST statement of a batch to show
// a continuous "Total:"; omit (0) on later statements / Run Selected.
function runTimerStartNow(base: string, totalStart = 0): void {
    // Re-callable per statement: reset the per-statement clock, reuse the
    // single interval. The total clock only moves when a new totalStart is
    // passed (batch start) — later per-statement calls leave it alone.
    runTimerBase = base;
    runTimerStart = performance.now();
    if (totalStart > 0) runTimerTotalStart = totalStart;
    els.runStatus.hidden = false;
    els.toolbarStatus.hidden = true;
    runTimerTick();
    if (runTimerId === undefined) {
        runTimerId = setInterval(runTimerTick, 500);
    }
}

function runTimerStop(): void {
    if (runTimerId !== undefined) {
        clearInterval(runTimerId);
        runTimerId = undefined;
    }
    runTimerTotalStart = 0;
    els.runStatus.hidden = true;
    els.runStatus.textContent = "";
    els.toolbarStatus.hidden = false;
}

// Run Selected: selection if any, else statement at caret; nothing in empty space.
async function doRun(): Promise<void> {
    if (!activeTab()?.connectionId || state.running) return;
    const src = els.sqlInput.value;
    const selStart = els.sqlInput.selectionStart ?? 0;
    const selEnd = els.sqlInput.selectionEnd ?? 0;
    let text: string;
    let start: number;
    let end: number;
    if (selEnd > selStart) {
        text = src.slice(selStart, selEnd).trim();
        start = selStart;
        end = selEnd;
    } else {
        const stmt = statementAt(src, selStart);
        if (!stmt) return; // caret in empty space: nothing runs
        text = stmt.text;
        start = stmt.start;
        end = stmt.end + (src[stmt.end] === ";" ? 1 : 0);
    }
    if (!text) return;
    const selectedStatements = splitStatements(text);
    if (selectedStatements.length === 1 && isStopStatement(selectedStatements[0].text)) {
        logStop();
        els.statusText.textContent = t("main.stopCurrent", "STOP encountered — no statement run.");
        toolbarStatus.show(els.statusText.textContent, activeTab()?.connectionId ?? "");
        return;
    }
    setRunning(true);
    runTimerStartNow(t("main.running", "Running..."));
    try {
        els.sqlInput.highlightRunningStatement(start, end);
        await runOne(text, t("main.logRunSelected", "Run Selected..."));
    } finally {
        els.sqlInput.clearRunningStatement();
        runTimerStop();
        setRunning(false);
    }
}

// Run All: every statement in order; stops on first failure.
// A bare STOP statement (STOP or STOP;, the only thing on its line) ends the
// batch — ACS RUNSQL parity.
function logStop(): void {
    appendLogLine(`[ ${nowStamp()} ]  ${t("main.logStop", "STOP encountered — ending the run.")}`, "msg-info");
}

function moveBatchCaret(source: string, connectionId: string | null | undefined, offset: number): void {
    if (activeTab()?.connectionId !== connectionId || els.sqlInput.value !== source) return;
    els.sqlInput.setSelectionRange(offset, offset);
    els.sqlInput.scrollToOffset(offset);
}

function focusBatchCaret(source: string, connectionId: string | null | undefined): void {
    if (activeTab()?.connectionId !== connectionId || els.sqlInput.value !== source) return;
    const focused = document.activeElement;
    if (focused === document.body || focused === null || els.sqlInput.view.hasFocus || document.getElementById("run-controls")?.contains(focused)) {
        els.sqlInput.focus();
    }
}

async function doRunAll(): Promise<void> {
    if (!activeTab()?.connectionId || state.running) return;
    const source = els.sqlInput.value;
    const connectionId = activeTab()?.connectionId;
    const tab = activeTab();
    const stmts = splitStatements(source);
    if (!stmts.length) return;
    setRunning(true);
    const batchStart = performance.now();
    try {
        for (let i = 0; i < stmts.length; i += 1) {
            if (isStopStatement(stmts[i].text)) {
                moveBatchCaret(source, connectionId, stmts[i].start);
                logStop();
                els.statusText.textContent = t("main.stoppedAt", "Stopped at STOP (statement {current} of {total}).").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length));
                return;
            }
            const label = t("main.runningStatementOf", "Running statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length));
            runTimerStartNow(label, i === 0 ? batchStart : 0);
            if (activeTab()?.connectionId === connectionId && els.sqlInput.value === source) {
                els.sqlInput.highlightRunningStatement(stmts[i].start, stmts[i].end + (source[stmts[i].end] === ";" ? 1 : 0));
            }
            try {
                const succeeded = await runOne(stmts[i].text, t("main.logRunAllStatement", "Run All — statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length)), tab);
                if (!succeeded) return;
                moveBatchCaret(source, connectionId, stmts[i + 1]?.start ?? (stmts[i].end + (source[stmts[i].end] === ";" ? 1 : 0)));
            } finally {
                els.sqlInput.clearRunningStatement();
            }
        }
        if (activeTab() === tab) els.statusText.textContent = t("main.statementsCompleted", "{count} statements completed.").replace("{count}", String(stmts.length));
    } catch {
        // runOne already surfaced the error; stop the batch.
    } finally {
        els.sqlInput.clearRunningStatement();
        runTimerStop();
        setRunning(false);
        focusBatchCaret(source, connectionId);
    }
}

// Run from Selected: caret statement through the last; stops on first failure.
async function doRunFromSelected(): Promise<void> {
    if (!activeTab()?.connectionId || state.running) return;
    const src = els.sqlInput.value;
    const connectionId = activeTab()?.connectionId;
    const tab = activeTab();
    const pos = els.sqlInput.selectionStart ?? 0;
    const stmts = statementsFrom(src, pos);
    if (!stmts.length) return;
    setRunning(true);
    const batchStart = performance.now();
    try {
        for (let i = 0; i < stmts.length; i += 1) {
            if (isStopStatement(stmts[i].text)) {
                moveBatchCaret(src, connectionId, stmts[i].start);
                logStop();
                els.statusText.textContent = t("main.stoppedAt", "Stopped at STOP (statement {current} of {total}).").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length));
                return;
            }
            const label = t("main.runningStatementOf", "Running statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length));
            runTimerStartNow(label, i === 0 ? batchStart : 0);
            if (activeTab()?.connectionId === connectionId && els.sqlInput.value === src) {
                els.sqlInput.highlightRunningStatement(stmts[i].start, stmts[i].end + (src[stmts[i].end] === ";" ? 1 : 0));
            }
            try {
                const succeeded = await runOne(stmts[i].text, t("main.logRunFromStatement", "Run from Selected — statement {current} of {total}...").replace("{current}", String(i + 1)).replace("{total}", String(stmts.length)), tab);
                if (!succeeded) return;
                moveBatchCaret(src, connectionId, stmts[i + 1]?.start ?? (stmts[i].end + (src[stmts[i].end] === ";" ? 1 : 0)));
            } finally {
                els.sqlInput.clearRunningStatement();
            }
        }
        if (activeTab() === tab) els.statusText.textContent = t("main.statementsCompleted", "{count} statements completed.").replace("{count}", String(stmts.length));
    } catch {
        // stop batch on failure
    } finally {
        els.sqlInput.clearRunningStatement();
        runTimerStop();
        setRunning(false);
        focusBatchCaret(src, connectionId);
    }
}

async function doFetch(all: boolean): Promise<void> {
    const app = App();
    const tab = activeTab();
    const connectionId = tab?.connectionId;
    const cursorId = state.cursorId;
    const version = tab?.resultVersion ?? 0;
    if (!app || !tab || !connectionId || !cursorId || !state.more) return;
    els.btnLoadMore.disabled = true;
    els.btnLoadAll.disabled = true;
    try {
        do {
            const page = await app.Fetch({
                connectionId,
                cursorId,
                fetchSize: state.fetchSize,
            });
            if ((tab.resultVersion ?? 0) !== version || tab.connectionId !== connectionId) return;
            if (activeTab() !== tab) {
                if (tab.snapshot && page.kind === "rows") {
                    tab.snapshot.rows.push(...(page.rows ?? []));
                    tab.snapshot.cursorId = page.cursorId ?? tab.snapshot.cursorId;
                    tab.snapshot.more = !!page.more;
                }
                return;
            }
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
        if (activeTab() === tab && (tab.resultVersion ?? 0) === version) showMessages([], String((err as Error)?.message ?? err));
    } finally {
        els.btnLoadMore.disabled = false;
        els.btnLoadAll.disabled = false;
    }
}

async function doCancel(): Promise<void> {
    const app = App();
    const connId = activeTab()?.connectionId;
    if (!app || !connId) return;
    els.sqlInput.clearRunningStatement();
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
// Order/sequence: Run Selected, Run-from-Selected-to-end, Run All. The 2nd and
// 3rd buttons keep their icons but the actions are swapped to match that order.
els.btnRunAll.addEventListener("click", () => void doRunFromSelected());
els.btnRunFrom.addEventListener("click", () => void doRunAll());
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
            const pos = ta.selectionStart ?? 0;
            // Insert at a statement boundary, never mid-token:
            //  - caret at 0 (or empty input) -> insert at the very start.
            //  - caret inside a statement -> insert right after that
            //    statement's end (its semicolon / end of the span).
            //  - caret not on a statement -> append at the end of input.
            let insertAt: number;
            if (pos === 0 || ta.value.trim() === "") {
                insertAt = 0;
            } else {
                const cur = statementAt(ta.value, pos);
                // StatementSpan.end is the offset OF the terminating ';' (not
                // after it), so step past a trailing semicolon to land after it.
                insertAt = cur ? (ta.value[cur.end] === ";" ? cur.end + 1 : cur.end) : ta.value.length;
            }
            // Keep statements separated: newline before/after as needed.
            const before = ta.value.slice(0, insertAt);
            const after = ta.value.slice(insertAt);
            const needLeadNl = insertAt > 0 && !/[\r\n]$/.test(before);
            const needTrailNl = after.trim() !== "" && !/^[\r\n]/.test(after);
            const insertText = (needLeadNl ? "\n" : "") + stmt + (needTrailNl ? "\n" : "");
            ta.value = before + insertText + after;
            // Caret goes to the START of the inserted statement so Run/Run
            // Selected immediately finds it (a caret after the trailing ';'
            // belongs to no statement).
            const caret = insertAt + (needLeadNl ? 1 : 0);
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
    const text = els.sqlInput.value;
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
    if ((prof.sessionScript ?? "") === text) return;
    try {
        await app.SaveConnectionSessionScript(host, user, text);
        prof.sessionScript = text;
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

document.getElementById("btn-reload-script")?.addEventListener("click", () => {
    const connectionId = activeTab()?.connectionId;
    if (!connectionId) return;
    void reloadInitialScript(
        confirmReloadInitialScript,
        async () => ((await App().GetWorkspace(connectionId)) as { initialEditorText: string }).initialEditorText,
        (text) => {
            if (activeTab()?.connectionId !== connectionId) return;
            els.sqlInput.value = text;
            pushWorkspaceState();
            els.sqlInput.focus();
        },
    ).catch((err) => showMessages([], String((err as Error)?.message ?? err)));
});
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
    // Ctrl+Enter (Cmd+Enter on Mac) runs the current statement — opt-in via
    // Settings (ctrlEnterRun, default off; ACS has no such shortcut).
    if (ctrlEnterRun && !history.hasHistory) return;
    const recalled = direction === "prev" ? history.prev(els.sqlInput.value) : history.next();
    if (recalled === undefined) return;
    ev.preventDefault();
    els.sqlInput.value = recalled;
    els.sqlInput.setSelectionRange(recalled.length, recalled.length);
    pushWorkspaceState();
}

els.sqlInput.setCompletionSource(createSQLCompletionSource(() => {
    const tab = activeTab();
    if (!tab?.connectionId) return null;
    const profile = profiles.find((entry) => entry.name === tab.profileName);
    const schema = profile?.defaultSchema || el<HTMLInputElement>("in-schema").value.trim() || tab.user || "";
    return { connectionId: tab.connectionId, defaultSchema: schema.startsWith('"') ? schema.slice(1, -1).replace(/""/g, '"') : schema.toUpperCase() };
}, (connectionId, kind, schema, object, prefix) => App().GetSQLCompletions(connectionId, kind, schema, object, prefix)));

els.sqlInput.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (els.sqlInput.consumeCompletionKey(ev)) return;
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

// Disable the quick-connect GO button once the user edits the form
// manually (GO is only for a picked saved profile; new connections use Connect).
["in-host", "in-user", "in-password"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => {
        const go = document.getElementById("btn-go") as HTMLButtonElement | null;
        if (go) {
            delete go.dataset.armed;
            go.disabled = true;
            go.hidden = false;
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
    // "New connection" first: clears the form back to blank + sticky switch
    // state for starting a connection that isn't one of the saved ones.
    const newItem = document.createElement("button");
    newItem.type = "button";
    newItem.className = "combo-item combo-new";
    newItem.textContent = t("main.newConnection", "+ New connection");
    newItem.title = t("main.newConnectionTitle", "Clear the form to start a new connection");
    newItem.addEventListener("click", () => {
        clearConnectForm();
        popup.hidden = true;
    });
    popup.appendChild(newItem);
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
                go.hidden = false;
            }
        });
        popup.appendChild(item);
    };
    if (matches.length === 0) {
        // Nothing to pick — don't leave an empty popup covering the GO button.
        popup.hidden = true;
        return;
    }
    matches.forEach(addItem);
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
hostInput.addEventListener("keydown", (ev) => {
    // Escape closes the saved-connections dropdown so it can't cover GO.
    if (ev.key === "Escape") el<HTMLDivElement>("saved-hosts-popup").hidden = true;
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
    void loadTabServerJob(tab, detachedConnId);
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
        label?: string; editorText?: string; initialEditorText?: string; statusText?: string; messagesHtml?: string;
        columns?: ColumnInfo[]; rows?: unknown[][]; cursorId?: string; more?: boolean; showingResults?: boolean;
        pinnedResults?: PinnedResult[]; resultStatement?: string;
    }

    // Apply a workspace snapshot pushed from the Go store. Editor text is only
    // overwritten when it differs, so our own keystrokes (echoed back via
    // UpdateEditorText) never reset the caret.
    const applyWorkspace = (ws: WorkspaceMirror): void => {
        if (tab.connectionId !== detachedConnId) return;
        if (typeof ws.initialEditorText === "string" && !tab.initialScriptReady) {
            tab.initialScriptReady = true;
            syncConnectionUi();
        }
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
        if (ws.pinnedResults) {
            pinnedResults = ws.pinnedResults.map((p) => ({ ...p }));
            renderResultSubtabs();
        }
        if (ws.showingResults && ws.columns) {
            lastResultSql = ws.resultStatement ?? "";
            state.columns = [...ws.columns];
            state.rows = (ws.rows ?? []).map((r) => [...r]);
            state.cursorId = ws.cursorId ?? null;
            state.more = !!ws.more;
            renderTable();
            const pinnedView = !!activePinnedId;
            els.btnLoadMore.hidden = pinnedView || !state.more;
            els.btnLoadAll.hidden = pinnedView || !state.more;
            els.saveResultsWrap.hidden = displayedData().rows.length === 0;
            els.btnPinResult.disabled = pinnedView || displayedData().rows.length === 0;
            showPane("results");
        } else if (ws.showingResults === false) {
            state.columns = [];
            state.rows = [];
            state.cursorId = null;
            state.more = false;
            activePinnedId = "";
            renderResultSubtabs();
            lastResultSql = "";
            els.resultHead.innerHTML = "";
            els.resultBody.innerHTML = "";
            els.btnLoadMore.hidden = true;
            els.btnLoadAll.hidden = true;
            els.saveResultsWrap.hidden = true;
            els.btnPinResult.disabled = true;
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
