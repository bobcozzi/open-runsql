// Settings pane: INI-style two-pane editor. Left is a listbox of setting keys
// (no input); right shows the editor for the selected key, chosen by the
// setting's type: text / number / folder (text + "..." browse helper).
// Values are applied immediately on change/commit via the provided saver.

import { t } from "./l10n";
import type { AppSettings } from "./types";

export type SettingType = "text" | "number" | "folder" | "choice";

export interface SettingDef {
    /** Stable key; also the l10n suffix (settings.<key>.label / .desc). */
    key: string;
    type: SettingType;
    /** Placeholder for empty text/folder inputs. */
    placeholder?: string;
    /** Number constraints. */
    min?: number;
    max?: number;
    /** Choice options: [value, label] pairs (labels may be l10n keys). */
    options?: [string, string][];
    /** Read the current value out of AppSettings ("" when unset). */
    get: (s: AppSettings) => string;
    /** Produce the settings object to persist with the new value applied. */
    withValue: (s: AppSettings, value: string) => AppSettings;
    /** Folder-type helper: "..." opens the OS folder picker; returns the
     * chosen path ("" = canceled, input untouched). Picking a path commits. */
    browse?: () => Promise<string>;
    /** Per-key persistence override. When set, called instead of opts.save
     * (for keys persisted outside the AppSettings document). */
    persist?: (value: string) => Promise<void>;
}

export interface SettingsPaneOptions {
    load: () => Promise<AppSettings>;
    save: (next: AppSettings) => Promise<void>;
    onSaved?: () => void;
    onError?: (message: string) => void;
    /** Called after a value is persisted (useful for in-app side effects,
     * e.g. applying a theme choice immediately). */
    onChanged?: (key: string, value: string) => void;
}

export interface SettingsPaneHandle {
    root: HTMLElement;
}

export function createSettingsPane(opts: SettingsPaneOptions, defs: SettingDef[]): SettingsPaneHandle {
    const root = document.createElement("div");
    root.className = "work-pane settings";
    root.dataset.pane = "settings";
    root.hidden = true;

    const list = document.createElement("ul");
    list.className = "settings-keys";
    list.setAttribute("role", "listbox");

    const editor = document.createElement("div");
    editor.className = "settings-editor";

    root.appendChild(list);
    root.appendChild(editor);

    let settings: AppSettings = {};
    let selectedKey = "";

    const itemFor = new Map<string, HTMLLIElement>();

    function current(def: SettingDef): string {
        return def.get(settings);
    }

    function renderEditor(def: SettingDef): void {
        editor.innerHTML = "";
        const title = document.createElement("div");
        title.className = "settings-editor-title";
        title.textContent = t(`settings.${def.key}.label`, def.key);
        editor.appendChild(title);

        const row = document.createElement("div");
        row.className = "settings-editor-row";

        const input: HTMLInputElement | HTMLSelectElement = def.type === "choice"
            ? document.createElement("select")
            : document.createElement("input");
        input.className = "settings-input";
        if (input instanceof HTMLSelectElement) {
            for (const [value, label] of def.options ?? []) {
                const o = document.createElement("option");
                o.value = value;
                o.textContent = label;
                input.appendChild(o);
            }
            input.value = current(def);
        } else {
            input.spellcheck = false;
            input.autocapitalize = "off";
            input.autocomplete = "off";
            input.value = current(def);
            if (def.type === "number") {
                input.type = "number";
                input.inputMode = "numeric";
                if (def.min !== undefined) input.min = String(def.min);
                if (def.max !== undefined) input.max = String(def.max);
            } else {
                input.type = "text";
                if (def.placeholder) input.placeholder = def.placeholder;
            }
        }

        const commit = async () => {
            let value = input.value.trim();
            if (def.type === "number" && value !== "") {
                const n = Number(value);
                if (!Number.isFinite(n)) return;
                const clamped = Math.min(def.max ?? n, Math.max(def.min ?? n, n));
                value = String(clamped);
                input.value = value;
            }
            if (value === current(def)) return;
            try {
                if (def.persist) {
                    await def.persist(value);
                } else {
                    await opts.save(def.withValue({ ...settings }, value));
                }
                settings = def.withValue({ ...settings }, value);
                opts.onSaved?.();
                opts.onChanged?.(def.key, value);
            } catch (err) {
                opts.onError?.(String((err as Error)?.message ?? err));
            }
        };

        input.addEventListener("change", () => void commit());
        input.addEventListener("keydown", (ev: Event) => {
            if ((ev as KeyboardEvent).key === "Enter") {
                ev.preventDefault();
                void commit();
            }
        });
        row.appendChild(input);

        if (def.type === "folder" && def.browse) {
            const browse = document.createElement("button");
            browse.type = "button";
            browse.className = "btn settings-browse";
            browse.textContent = "...";
            browse.title = t("settings.browseTitle", "Choose a folder");
            browse.addEventListener("click", () => {
                void def.browse!().then((p) => {
                    if (!p) return; // canceled
                    input.value = p;
                    void commit();
                }).catch((err) => opts.onError?.(String((err as Error)?.message ?? err)));
            });
            row.appendChild(browse);
        }
        editor.appendChild(row);

        const desc = document.createElement("div");
        desc.className = "settings-desc";
        desc.textContent = t(`settings.${def.key}.desc`, "");
        if (desc.textContent) editor.appendChild(desc);
    }

    function select(key: string): void {
        selectedKey = key;
        for (const [k, li] of itemFor) li.classList.toggle("selected", k === key);
        const def = defs.find((d) => d.key === key);
        if (def) renderEditor(def);
    }

    for (const def of defs) {
        const li = document.createElement("li");
        li.className = "settings-key";
        li.setAttribute("role", "option");
        li.tabIndex = 0;
        li.textContent = t(`settings.${def.key}.label`, def.key);
        li.addEventListener("click", () => select(def.key));
        li.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                select(def.key);
            } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                ev.preventDefault();
                const idx = defs.findIndex((d) => d.key === selectedKey);
                const next = defs[idx + (ev.key === "ArrowDown" ? 1 : -1)];
                if (next) {
                    select(next.key);
                    itemFor.get(next.key)?.focus();
                }
            }
        });
        itemFor.set(def.key, li);
        list.appendChild(li);
    }

    void opts.load().then((s) => {
        settings = s;
        if (defs.length > 0) select(defs[0].key);
    }).catch(() => {
        if (defs.length > 0) select(defs[0].key);
    });

    return { root };
}
