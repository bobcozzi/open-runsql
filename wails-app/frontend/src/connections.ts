// Connections pane: INI-style two-pane editor for saved connection profiles.
// Left is a listbox of profile names; right is the edit form (Name, Host,
// User, Default schema, Naming, TLS, Save password) with Save/New/Delete.
// Passwords are never shown or edited here: keeping "Save password" checked
// preserves the stored password; unchecking clears it.

import { t } from "./l10n";
import type { ConnectionProfile } from "./types";

export interface ConnectionsPaneOptions {
    load: () => Promise<ConnectionProfile[]>;
    /** origName-keyed replace (rename-safe); empty origName = create. */
    save: (origName: string, p: ConnectionProfile) => Promise<void>;
    remove: (name: string) => Promise<void>;
    /** Called after any mutation so the connect panel dropdown refreshes. */
    onChanged?: () => void;
    onError?: (message: string) => void;
    /** Test hook / native confirm wrapper. */
    confirm?: (message: string) => boolean;
}

export interface ConnectionsPaneHandle {
    root: HTMLElement;
    reload(): Promise<void>;
}

export function createConnectionsPane(opts: ConnectionsPaneOptions): ConnectionsPaneHandle {
    const root = document.createElement("div");
    root.className = "work-pane connections";
    root.dataset.pane = "connections";
    root.hidden = true;

    const list = document.createElement("ul");
    list.className = "settings-keys conn-keys";
    list.setAttribute("role", "listbox");

    const form = document.createElement("div");
    form.className = "settings-editor conn-form";

    const leftCol = document.createElement("div");
    leftCol.className = "conn-left";
    leftCol.appendChild(list);
    // New/Duplicate live at the bottom of the list column.
    const listFooterEl = document.createElement("div");
    leftCol.appendChild(listFooterEl);

    root.appendChild(leftCol);
    root.appendChild(form);

    let profiles: ConnectionProfile[] = [];
    let origName = "";

    const inName = input("text");
    const inHost = input("text");
    const inUser = input("text");
    const inSchema = input("text");
    const inNaming = document.createElement("select");
    for (const [v, label] of [["sql", t("conn.namingSql", "SQL naming")], ["system", t("conn.namingSystem", "System naming")]] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        inNaming.appendChild(o);
    }
    const inTls = document.createElement("input");
    inTls.type = "checkbox";
    const inSavePw = document.createElement("input");
    inSavePw.type = "checkbox";

    function input(type: string): HTMLInputElement {
        const i = document.createElement("input");
        i.type = type;
        i.spellcheck = false;
        i.autocapitalize = "off";
        i.autocomplete = "off";
        i.className = "settings-input";
        return i;
    }

    function row(labelKey: string, fallback: string, field: HTMLElement): void {
        const label = document.createElement("label");
        label.className = "conn-field";
        const span = document.createElement("span");
        span.textContent = t(labelKey, fallback);
        label.appendChild(span);
        label.appendChild(field);
        form.appendChild(label);
    }

    const title = document.createElement("div");
    title.className = "settings-editor-title";
    form.appendChild(title);
    row("conn.name", "Name", inName);
    row("conn.host", "Host", inHost);
    row("conn.user", "User", inUser);
    row("conn.schema", "Default schema", inSchema);
    row("conn.naming", "Naming", inNaming);
    row("conn.tls", "Secure (TLS)", inTls);
    row("conn.savePassword", "Save password", inSavePw);

    const note = document.createElement("div");
    note.className = "settings-desc";
    note.textContent = t("conn.pwNote", "Passwords are not shown here. Keeping \"Save password\" checked preserves the stored password; unchecking clears it.");
    form.appendChild(note);

    const btnRow = document.createElement("div");
    btnRow.className = "settings-editor-row conn-buttons";
    const btnSave = button(t("conn.save", "Save"), "btn primary");
    const btnReset = button(t("conn.reset", "Reset"), "btn");
    const btnDelete = button(t("conn.delete", "Delete"), "btn danger");
    btnRow.appendChild(btnSave);
    btnRow.appendChild(btnReset);
    btnRow.appendChild(btnDelete);
    form.appendChild(btnRow);

    const listFooter = document.createElement("div");
    listFooter.className = "conn-list-footer";
    const btnNew = button(t("conn.new", "New"), "btn");
    const btnDuplicate = button(t("conn.duplicate", "Duplicate"), "btn");
    listFooter.appendChild(btnNew);
    listFooter.appendChild(btnDuplicate);

    function button(text: string, cls: string): HTMLButtonElement {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = text;
        return b;
    }

    const dirtyMarker = document.createElement("span");
    dirtyMarker.className = "conn-dirty";
    dirtyMarker.textContent = "•";
    dirtyMarker.title = t("conn.dirtyTitle", "Unsaved changes — saves automatically when you switch entries");
    dirtyMarker.hidden = true;
    title.appendChild(dirtyMarker);

    for (const field of [inName, inHost, inUser, inSchema]) {
        field.addEventListener("input", () => { dirtyMarker.hidden = false; });
    }
    inNaming.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inTls.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inSavePw.addEventListener("change", () => { dirtyMarker.hidden = false; });

    function formProfile(): ConnectionProfile {
        const host = inHost.value.trim();
        return {
            name: inName.value.trim() || host,
            host,
            user: inUser.value.trim(),
            defaultSchema: inSchema.value.trim(),
            naming: inNaming.value,
            tls: inTls.checked,
            savePassword: inSavePw.checked,
        };
    }

    function fill(p: ConnectionProfile | null): void {
        origName = p?.name ?? "";
        title.firstChild!.textContent = p ? (p.name || p.host) : t("conn.newTitle", "New connection");
        inName.value = p?.name ?? "";
        inHost.value = p?.host ?? "";
        inUser.value = p?.user ?? "";
        inSchema.value = p?.defaultSchema ?? "";
        inNaming.value = p?.naming || "sql";
        inTls.checked = !!p?.tls;
        inSavePw.checked = !!p?.savePassword;
        btnDelete.hidden = !p;
        btnDuplicate.disabled = !p;
        dirtyMarker.hidden = true;
    }

    function markSelected(name: string): void {
        for (const li of Array.from(list.querySelectorAll<HTMLElement>(".settings-key"))) {
            li.classList.toggle("selected", li.dataset.profileName === name);
        }
    }

    async function selectProfile(p: ConnectionProfile | null): Promise<void> {
        // Auto-save a dirty form before switching away.
        if (!dirtyMarker.hidden) await save();
        if (dirtyMarker.hidden) fill(p);
        markSelected(origName);
    }

    function renderList(): void {
        list.innerHTML = "";
        for (const p of profiles) {
            const li = document.createElement("li");
            li.className = "settings-key";
            li.setAttribute("role", "option");
            li.tabIndex = 0;
            li.dataset.profileName = p.name;
            li.textContent = `${p.name || p.host}  (${p.user}@${p.host})`;
            li.addEventListener("click", () => void selectProfile(p));
            li.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    void selectProfile(p);
                }
            });
            list.appendChild(li);
        }
        markSelected(origName);
    }

    async function reload(selectName = ""): Promise<void> {
        try {
            profiles = await opts.load();
        } catch (err) {
            opts.onError?.(String((err as Error)?.message ?? err));
            profiles = [];
        }
        const sel = profiles.find((p) => p.name === selectName) ?? profiles[0] ?? null;
        fill(sel);
        renderList();
    }

    /** Validate + persist the form. Returns true when the form is clean after
     * the attempt (saved, or nothing to do); false when validation failed and
     * the form must stay put. */
    async function save(): Promise<boolean> {
        const p = formProfile();
        if (!p.host || !p.user) {
            opts.onError?.(t("conn.needHostUser", "Host and User are required."));
            return false;
        }
        try {
            await opts.save(origName, p);
            await reload(p.name);
            opts.onChanged?.();
            return true;
        } catch (err) {
            opts.onError?.(String((err as Error)?.message ?? err));
            return false;
        }
    }

    btnSave.addEventListener("click", () => void save());

    btnReset.addEventListener("click", () => {
        fill(profiles.find((p) => p.name === origName) ?? null);
    });

    btnNew.addEventListener("click", () => {
        void selectProfile(null);
        inName.focus();
    });

    btnDuplicate.addEventListener("click", () => {
        const src = profiles.find((p) => p.name === origName);
        if (!src) return;
        fill({ ...src, name: `${src.name || src.host} copy` });
        dirtyMarker.hidden = false; // not persisted until save/auto-save
        inName.focus();
    });

    btnDelete.addEventListener("click", () => {
        const name = origName;
        if (!name) return;
        const ask = opts.confirm ?? ((m: string) => window.confirm(m));
        if (!ask(t("conn.confirmDelete", "Delete connection {name}?").replace("{name}", name))) return;
        void opts.remove(name)
            .then(() => reload())
            .then(() => opts.onChanged?.())
            .catch((err) => opts.onError?.(String((err as Error)?.message ?? err)));
    });

    // New/Duplicate buttons live at the bottom of the list column.
    listFooterEl.className = "conn-list-footer";
    listFooterEl.appendChild(btnNew);
    listFooterEl.appendChild(btnDuplicate);

    fill(null);
    void reload();

    return { root, reload: () => reload(origName) };
}
