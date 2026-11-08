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
import { arrowRecallDirection, InputHistoryStore } from "./inputHistory";
import { parseCmdXml } from "./clprompter/prompterModel";
import { showPrompter } from "./clprompter/prompterView";
import { buildSpooledFileRequest, createSpoolPane, type SpoolFilters } from "./spool";
import { renderScsBytes } from "./scsRender";
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
    setTitle("btn-saved-hosts", t("main.savedConnections", "Saved connections"));
    setTitle("btn-run", t("html.runTitle", "Run Selected (statement at cursor; Cmd/Ctrl+Enter)"));
    setTitle("btn-run-all", t("html.runAllTitle", "Run All (every statement, first to last)"));
    setTitle("btn-run-from", t("html.runFromTitle", "Run from Selected (cursor statement through the last)"));
    setText("btn-cancel", t("main.cancel", "Cancel"));
    setTitle("btn-cancel", t("html.cancelTitle", "Cancel running statement"));
    setText("btn-prompt", t("main.prompt", "Prompt"));
    setTitle("btn-prompt", t("html.promptTitle", "Prompt CL command (F4)"));
    setTitle("splitter", t("html.splitterTitle", "Drag to resize"));
    setText("btn-load-more", t("html.loadMore", "Load more"));
    setText("btn-load-all", t("html.loadAll", "Load all"));
    setText("work-tab-spool", t("spool.tab", "Spooled Files"));
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

// --- Spooled Files pane (stage 1: list + filter + sort) ---
// Static "spool" work-pane; the tab lives in index.html next to Results.
// loadedFor tracks which connection the visible list came from so switching
// connection tabs and coming back re-fetches instead of showing stale files.
const spoolState = { loadedFor: "" };
const spool = createSpoolPane({
    onRefresh: (filters) => void refreshSpool(filters),
    onRowOpen: (f) => void viewSpooledFile(f),
    onRowContext: (f, x, y) => showSpoolContextMenu(f, x, y),
});
els.workArea.appendChild(spool.root);

type SpoolTarget = { connectionId: string; name: string; number: string; jobName: string; jobUser: string; jobNumber: string };

function spoolTarget(f: SpooledFileInfo): SpoolTarget | null {
    const connectionId = activeTab()?.connectionId ?? "";
    if (!connectionId) return null;
    return { connectionId, name: f.name, number: f.number, jobName: f.jobName, jobUser: f.jobUser, jobNumber: f.jobNumber };
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
    const { lines } = renderSpoolText(text);
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

/** Text viewer overlay for a spooled file (View / double-click). */
async function viewSpooledFile(f: SpooledFileInfo): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logView", "View {name}...").replace("{name}", f.name)}`, "msg-action");
    try {
        const res = await app.GetSpooledFileData({ ...target, format: "raw" });
        const overlay = document.createElement("div");
        overlay.className = "spool-viewer-overlay";
        const box = document.createElement("div");
        box.className = "spool-viewer";
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
        closeBtn.addEventListener("click", () => overlay.remove());
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
        overlay.addEventListener("click", (ev) => { if (ev.target === overlay) overlay.remove(); });
        document.addEventListener("keydown", function onEsc(ev) {
            if (ev.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onEsc); }
        });
        document.body.appendChild(overlay);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

/** Save the raw page-stream bytes (no rendering) to ~/Downloads for SCS
 * debugging. format="raw" skips the bridge CCSID decode. */
async function saveRawSpooledFile(f: SpooledFileInfo): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logRaw", "Save raw {name}...").replace("{name}", f.name)}`, "msg-action");
    try {
        const res = await app.GetSpooledFileData({ ...target, format: "raw" });
        const saved = await app.SaveSpooledFile(`${f.name.trim()}_${f.jobNumber.trim()}.raw`, res.base64 ?? "");
        appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
        els.statusText.textContent = t("spool.statusSaved", "Saved {path}").replace("{path}", saved);
        await app.OpenSpooledFile(saved);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

/** Download a spooled file as PDF or text to ~/Downloads. */
async function downloadSpooledFile(f: SpooledFileInfo, format: "pdf" | "text"): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logDownload", "Download {name} as {fmt}...").replace("{name}", f.name).replace("{fmt}", format.toUpperCase())}`, "msg-action");
    try {
        let base64: string;
        if (format === "pdf") {
            // Build the PDF client-side from the decoded text — no host print
            // transform needed.
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
        const saved = await app.SaveSpooledFile(`${f.name.trim()}_${f.jobNumber.trim()}.${format === "pdf" ? "pdf" : "txt"}`, base64);
        appendLogLine(t("spool.logSaved", "Saved to {path}").replace("{path}", saved), "msg-info", true);
        els.statusText.textContent = t("spool.statusSaved", "Saved {path}").replace("{path}", saved);
        // Open the download with the OS default handler so the user can view it.
        await app.OpenSpooledFile(saved);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

/** Print locally: fetch the PDF and hand it to the OS (print dialog). */
async function printSpooledFile(f: SpooledFileInfo): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logPrint", "Print {name}...").replace("{name}", f.name)}`, "msg-action");
    try {
        const textRes = await app.GetSpooledFileData({ ...target, format: "raw" });
        const base64 = textToPdfBase64(textRes.base64 ?? "");
        await app.PrintSpooledFile(`${f.name.trim()}_${f.jobNumber.trim()}.pdf`, base64);
        appendLogLine(t("spool.logPrinted", "Sent {name} to the OS print handler").replace("{name}", f.name), "msg-info", true);
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

async function spoolAction(f: SpooledFileInfo, action: "hold" | "release" | "delete"): Promise<void> {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
    // Delete is destructive — require the row be the right-click-selected one
    // (the context menu only opens on the selected row, so this is the guard).
    appendLogLine(`[ ${nowStamp()} ]  ${action} ${f.name}...`, "msg-action");
    try {
        const res = await app.SpooledFileAction({ ...target, action });
        appendLogLine(`${res.message}   (${res.elapsedMs} ms)`, res.ok ? "msg-info" : "msg-error", true);
        void refreshSpool(spool.filters());
    } catch (err) {
        showMessages([], String((err as Error)?.message ?? err));
    }
}

let contextMenuEl: HTMLDivElement | undefined;
function closeContextMenu(): void {
    contextMenuEl?.remove();
    contextMenuEl = undefined;
}

/** CL-style "Move to Output Queue" dialog: Output queue + Library fields,
 * MOVE/CANCEL buttons, and F4/Select to open a filtered queue picker. */
function moveSpooledFileDialog(f: SpooledFileInfo): void {
    const app = App();
    const target = spoolTarget(f);
    if (!app || !target) return;
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
    // Read-only context: the file being moved + its current queue prefilled.
    (box.querySelector("#mv-file") as HTMLInputElement).value = f.name.trim();
    (box.querySelector("#mv-filenum") as HTMLInputElement).value = f.number.trim();
    (box.querySelector("#mv-outq") as HTMLInputElement).value = f.outqName.trim();
    (box.querySelector("#mv-outqlib") as HTMLInputElement).value = f.outqLib.trim();
    // Reflect the file's current hold state in the Hold dropdown.
    const held = /^(yes|\*yes|hld|held)/i.test(f.holdStatus.trim());
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
        try {
            // Hold first when *YES so the file cannot print on arrival.
            const holdFirst = holdSel.value === "yes";
            const res = await app.MoveSpooledFile({ ...target, toLibrary: outqLib.value.trim(), toQueue, holdFirst });
            appendLogLine(`${res.message}   (${res.elapsedMs} ms)`, res.ok ? "msg-info" : "msg-error", true);
            close();
            void refreshSpool(spool.filters());
        } catch (err) {
            showMessages([], String((err as Error)?.message ?? err));
        }
    };
    box.querySelector("#mv-ok")!.addEventListener("click", () => void doMove());
    box.querySelector("#mv-f4")!.addEventListener("click", () => openOutqPicker(target.connectionId, (lib, name) => {
        outqLib.value = lib; outq.value = name;
    }));
    overlay.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") close();
        if (ev.key === "F4") openOutqPicker(target.connectionId, (lib, name) => { outqLib.value = lib; outq.value = name; });
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

function showSpoolContextMenu(f: SpooledFileInfo, x: number, y: number): void {
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
    addItem(t("spool.act.view", "View"), () => void viewSpooledFile(f));
    addItem(t("spool.act.copyRow", "Copy row"), () => {
        const text = [f.name, f.number, f.jobName, f.jobUser, f.jobNumber, f.userData,
        (f.outqLib || f.outqName ? `${f.outqLib}/${f.outqName}` : ""),
        `${f.createDate} ${f.createTime}`.trim(), String(f.pages), String(f.size),
        f.status, f.holdStatus].join("\t");
        // navigator.clipboard needs a secure context; fall back to execCommand.
        const done = () => appendLogLine(t("spool.logCopied", "Copied row to clipboard"), "msg-info", true);
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => { legacyCopy(text); done(); });
        } else {
            legacyCopy(text);
            done();
        }
    });
    addItem(t("spool.act.dlPdf", "Download as PDF"), () => void downloadSpooledFile(f, "pdf"));
    addItem(t("spool.act.dlText", "Download as Text"), () => void downloadSpooledFile(f, "text"));
    addItem(t("spool.act.saveRaw", "Save Raw"), () => void saveRawSpooledFile(f));
    addItem(t("spool.act.print", "Print locally"), () => void printSpooledFile(f));
    sep();
    addItem(t("spool.act.move", "Move..."), () => moveSpooledFileDialog(f));
    addItem(t("spool.act.hold", "Hold"), () => void spoolAction(f, "hold"));
    addItem(t("spool.act.release", "Release"), () => void spoolAction(f, "release"));
    addItem(t("spool.act.delete", "Delete"), () => void spoolAction(f, "delete"), true);
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
    const started = performance.now();
    appendLogLine(`[ ${nowStamp()} ]  ${t("spool.logList", "List Spooled Files...")}`, "msg-action");
    try {
        const result = await app.ListSpooledFiles(buildSpooledFileRequest(connectionId, filters));
        const count = result.files?.length ?? 0;
        spool.setFiles(result.files ?? []);
        spoolState.loadedFor = connectionId;
        appendLogLine(t("spool.logListed", "Listed {count} spooled file(s)   ({ms} ms)")
            .replace("{count}", String(count)).replace("{ms}", String(result.elapsedMs)), "msg-info", true);
        els.statusText.textContent = t("spool.statusCount", "{count} spooled file(s) in {ms} ms")
            .replace("{count}", String(count)).replace("{ms}", String(result.elapsedMs));
    } catch (err) {
        const elapsed = Math.round(performance.now() - started);
        appendLogLine(t("spool.logFailed", "List spooled files failed   ({ms} ms)").replace("{ms}", String(elapsed)), "msg-error", true);
        showMessages([], String((err as Error)?.message ?? err));
    } finally {
        spool.setBusy(false);
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
        label: t("main.connectionN", "Connection {n}").replace("{n}", String(tabCounter)),
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
    els.badge.textContent = connected ? tab!.label : t("main.notConnected", "Not connected");
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
        appendLogLine(`[ ${nowStamp()} ]  ${t("main.connect", "Connect")}`, "msg-action");
        appendLogLine(t("main.connectionFailed", "Connection failed: {message}").replace("{message}", String((err as Error)?.message ?? err)), "msg-error", true);
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
async function runOne(text: string, actionLabel = t("main.logRunSelected", "Run Selected...")): Promise<void> {
    const app = App();
    if (!app || !activeTab()?.connectionId) return;
    inputHistories.for(activeTab()?.connectionId).push(text);
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

// Statement-history recall in the editor. F9 = previous (older), F8 = next
// (newer) — same keys as the cozzi-cl-prompter Command Entry. ArrowUp/ArrowDown
// recall only when the caret sits on the first/last line with no selection and
// no modifiers, so normal caret movement and Cmd/Ctrl/Alt+Arrow (e.g. macOS
// document jumps) are untouched. Cursor lands at the end of the recalled text.
function handleHistoryKeydown(ev: KeyboardEvent): void {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const history = inputHistories.for(activeTab()?.connectionId);
    if (!history.hasHistory) return;
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
        if (go) go.disabled = true;
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
        item.title = t("main.savedHostItemTitle", "Click to fill form; right-click for options");
        item.addEventListener("click", () => {
            fillFormFromProfile(p);
            popup.hidden = true;
            // Enable the quick-connect GO button for the selected profile.
            const go = document.getElementById("btn-go") as HTMLButtonElement | null;
            if (go) go.disabled = false;
        });
        popup.appendChild(item);
    };
    if (profiles.length === 0) {
        const empty = document.createElement("div");
        empty.className = "combo-item combo-empty";
        empty.textContent = t("main.noSavedConnections", "No saved connections yet — connect once and it will appear here.");
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
