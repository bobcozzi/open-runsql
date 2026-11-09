// Statement-history picker overlay: list a connection's logged SQL/CL entries,
// filter-as-you-type, Enter/click inserts at the editor cursor, Delete removes.
// Pure view — main.ts supplies load/delete callbacks and the inserter.

import { t } from "./l10n";

export interface HistoryEntry {
    text: string;
    at: number;
}

export interface HistoryPickerOptions {
    entries: HistoryEntry[];
    onInsert: (text: string) => void;
    onDelete: (index: number) => Promise<HistoryEntry[]>;
}

export function showHistoryPicker(opts: HistoryPickerOptions): void {
    const overlay = document.createElement("div");
    overlay.className = "spool-viewer-overlay";
    const box = document.createElement("div");
    box.className = "history-picker";

    const head = document.createElement("div");
    head.className = "history-picker-head";
    const title = document.createElement("span");
    title.className = "history-picker-title";
    title.textContent = t("history.title", "Statement History");
    const filter = document.createElement("input");
    filter.type = "text";
    filter.className = "history-filter";
    filter.placeholder = t("history.filter", "Type to filter...");
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "btn";
    closeBtn.textContent = t("spool.close", "Close");
    head.appendChild(title);
    head.appendChild(filter);
    head.appendChild(closeBtn);

    const list = document.createElement("div");
    list.className = "history-list";

    box.appendChild(head);
    box.appendChild(list);
    overlay.appendChild(box);

    let entries = opts.entries;
    let selected = 0;

    const close = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
    };

    const insert = (e: HistoryEntry) => {
        opts.onInsert(e.text);
        close();
    };

    function render(): void {
        list.innerHTML = "";
        const q = filter.value.trim().toLowerCase();
        const shown = q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
        if (shown.length === 0) {
            const empty = document.createElement("div");
            empty.className = "history-empty";
            empty.textContent = q
                ? t("history.noMatch", "No entries match.")
                : t("history.empty", "No statements logged for this connection yet.");
            list.appendChild(empty);
            return;
        }
        shown.forEach((e, i) => {
            const row = document.createElement("div");
            row.className = "history-row" + (i === selected ? " selected" : "");
            const stamp = document.createElement("span");
            stamp.className = "history-stamp";
            stamp.textContent = e.at > 0
                ? new Date(e.at * 1000).toLocaleString(undefined, {
                    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
                })
                : "";
            const txt = document.createElement("span");
            txt.className = "history-text";
            txt.textContent = e.text;
            txt.title = e.text;
            const del = document.createElement("button");
            del.type = "button";
            del.className = "btn history-del";
            del.textContent = "×";
            del.title = t("history.delete", "Remove from history");
            del.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const realIdx = entries.indexOf(e);
                if (realIdx >= 0) {
                    entries = await opts.onDelete(realIdx);
                    if (selected >= entries.length) selected = Math.max(0, entries.length - 1);
                    render();
                }
            });
            row.appendChild(txt);
            row.appendChild(stamp);
            row.appendChild(del);
            row.addEventListener("click", () => insert(e));
            list.appendChild(row);
        });
    }

    const onKey = (ev: KeyboardEvent) => {
        if (ev.key === "Escape") {
            ev.preventDefault();
            close();
            return;
        }
        const q = filter.value.trim().toLowerCase();
        const shown = q ? entries.filter((e) => e.text.toLowerCase().includes(q)) : entries;
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
            ev.preventDefault();
            if (shown.length === 0) return;
            selected = (selected + (ev.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length;
            render();
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            if (shown[selected]) insert(shown[selected]);
        }
    };

    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
    filter.addEventListener("input", () => { selected = 0; render(); });
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    render();
    filter.focus();
}
