// Connections pane: INI-style two-pane editor for saved connection profiles.
// Left is a listbox of profile names; right is the edit form (Name, Host,
// User, Default schema, Naming, TLS, Save password) with Save/New/Delete.
// Passwords are never shown or edited here: keeping "Save password" checked
// preserves the stored password; unchecking clears it.

import { t } from "./l10n";
import { createSwitch } from "./settings";
import type { ConnectionProfile } from "./types";

export interface ConnectionsPaneOptions {
    load: () => Promise<ConnectionProfile[]>;
    /** origName-keyed replace (rename-safe); empty origName = create. */
    save: (origName: string, p: ConnectionProfile) => Promise<void>;
    remove: (name: string) => Promise<void>;
    /** Fetch the stored password for a profile (OS vault). "" = none. */
    getPassword: (name: string) => Promise<string>;
    /** Called after any mutation so the connect panel dropdown refreshes. */
    onChanged?: () => void;
    onError?: (message: string) => void;
    /** Connect-in-new-tab action for the selected profile. */
    onConnect?: (p: ConnectionProfile) => void;
    /** Persist an explicit list order (names in sequence). */
    onReorder?: (names: string[]) => Promise<void>;
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
    const inPassword = document.createElement("input");
    inPassword.type = "password";
    inPassword.autocomplete = "off";
    inPassword.spellcheck = false;
    inPassword.autocapitalize = "off";
    inPassword.className = "settings-input";
    // True when a password is stored for the selected profile and the field
    // holds no user edit. Typed text replaces the stored password on save.
    let passwordStored = false;
    const inNaming = document.createElement("select");
    for (const [v, label] of [["sql", t("conn.namingSql", "SQL naming")], ["system", t("conn.namingSystem", "System naming")]] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label;
        inNaming.appendChild(o);
    }
    // Bidi string type: JT400 JDBC property for hosts storing Arabic/Hebrew
    // text (CCSID 420/424...). "" = driver default (no URL change); the rest
    // mirror BidiStringType: 4=visual/shaped (legacy 420), 5=implicit LTR,
    // 6=implicit RTL, -1=no bidi conversion.
    const inBidi = document.createElement("select");
    for (const [v, key, fb] of [
        ["", "conn.bidiDefault", "Driver default"],
        ["4", "conn.bidi4", "4 - Visual, shaped (legacy CCSID 420)"],
        ["5", "conn.bidi5", "5 - Implicit LTR (JT400 default)"],
        ["6", "conn.bidi6", "6 - Implicit RTL"],
        ["-1", "conn.bidiNone", "None - no bidi conversion"],
    ] as const) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t(key, fb);
        inBidi.appendChild(o);
    }
    const inTls = createSwitch(false, t("conn.tls", "Secure (TLS)"));
    const inSavePw = createSwitch(false, t("conn.savePassword", "Save password"));
    const inPreload = createSwitch(true, t("conn.preloadSpool", "Preload spooled files at connect"));
    const inSaveScript = createSwitch(true, t("conn.saveScript", "Save SQL/CL script between sessions"));
    const inScript = document.createElement("textarea");
    inScript.className = "settings-input conn-script";
    inScript.spellcheck = false;
    inScript.rows = 6;

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

    // A switch row with a live state hint to the right of the control. The hint
    // shows onText/offText (or generic On/Off when blank) and updates on change.
    function switchRow(labelKey: string, fallback: string, sw: HTMLElement, onText: string, offText: string): void {
        const label = document.createElement("label");
        label.className = "conn-field";
        const span = document.createElement("span");
        span.textContent = t(labelKey, fallback);
        label.appendChild(span);
        const wrap = document.createElement("div");
        wrap.className = "conn-switch-wrap";
        wrap.appendChild(sw);
        const hint = document.createElement("span");
        hint.className = "switch-state";
        wrap.appendChild(hint);
        const paintHint = () => {
            const on = (sw as { checked?: boolean }).checked === true;
            hint.textContent = on ? (onText || t("switch.on", "On")) : (offText || t("switch.off", "Off"));
        };
        paintHint();
        sw.addEventListener("change", paintHint);
        label.appendChild(wrap);
        form.appendChild(label);
    }

    const title = document.createElement("div");
    title.className = "settings-editor-title";
    form.appendChild(title);
    row("conn.name", "Name", inName);
    row("conn.host", "Host", inHost);
    row("conn.user", "User", inUser);
    row("conn.password", "Password", inPassword);
    row("conn.schema", "Default schema", inSchema);
    row("conn.naming", "Naming", inNaming);
    row("conn.bidi", "Bidi string type", inBidi);
    // Switches get a live state hint to the right (On/Off or a custom string).
    switchRow("conn.tls", "Secure (TLS)", inTls, t("conn.tls", "Secure (TLS)"), "");
    switchRow("conn.savePassword", "Save password", inSavePw, t("conn.savePwOn", "On — stored in the OS credential vault"), t("conn.savePwOff", "Off — not stored"));
    switchRow("conn.preloadSpool", "Preload spooled files at connect", inPreload, "", "");
    switchRow("conn.saveScript", "Save SQL/CL script between sessions", inSaveScript, "", "");
    row("conn.script", "SQL/CL script", inScript);

    const note = document.createElement("div");
    note.className = "settings-desc";
    note.textContent = t("conn.pwNote", "Passwords are stored in the OS credential vault (never in the profile file). A stored password shows as dots — type over it to replace. \"Save password\" off clears it.");
    form.appendChild(note);

    const btnRow = document.createElement("div");
    btnRow.className = "settings-editor-row conn-buttons";
    const btnSave = button(t("conn.save", "Save"), "btn primary");
    const btnReset = button(t("conn.reset", "Reset"), "btn");
    const btnConnectTab = button(t("conn.connectTab", "Connect in new Tab"), "btn");
    const btnDelete = button(t("conn.delete", "Delete"), "btn danger");
    btnRow.appendChild(btnSave);
    btnRow.appendChild(btnReset);
    btnRow.appendChild(btnConnectTab);
    btnRow.appendChild(btnDelete);
    form.appendChild(btnRow);

    // New/Duplicate/Sort live at the bottom of the list column.
    const btnNew = button(t("conn.new", "New"), "btn");
    const btnDuplicate = button(t("conn.duplicate", "Duplicate"), "btn");
    const btnSort = button("A-Z", "btn conn-sort");
    btnSort.title = t("conn.sortTitle", "Sort by name (toggles ascending/descending)");
    listFooterEl.className = "conn-list-footer";
    listFooterEl.appendChild(btnNew);
    listFooterEl.appendChild(btnDuplicate);
    listFooterEl.appendChild(btnSort);

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

    for (const field of [inName, inHost, inUser, inSchema, inPassword, inScript]) {
        field.addEventListener("input", () => { dirtyMarker.hidden = false; });
    }
    inBidi.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inNaming.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inTls.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inSavePw.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inPreload.addEventListener("change", () => { dirtyMarker.hidden = false; });
    inSaveScript.addEventListener("change", () => { dirtyMarker.hidden = false; });

    function formProfile(): ConnectionProfile {
        const host = inHost.value.trim();
        const typed = inPassword.value;
        const pwChanged = typed !== "" && !(passwordStored && typed === STORED_MASK);
        return {
            name: inName.value.trim() || host,
            host,
            user: inUser.value.trim(),
            bidiStringType: inBidi.value,
            defaultSchema: inSchema.value.trim(),
            naming: inNaming.value,
            tls: inTls.checked,
            preloadSpool: inPreload.checked,
            saveScript: inSaveScript.checked,
            script: inScript.value,
            // Keeping "Save password" on preserves the stored password unless a
            // new one was typed; turning it off clears it.
            savePassword: inSavePw.checked,
            passwordB64: pwChanged && inSavePw.checked ? btoa(typed) : undefined,
        };
    }

    // Mask shown when a password is stored; matched on save to distinguish
    // "unchanged" from "user typed dots".
    const STORED_MASK = "••••••••";

    function fill(p: ConnectionProfile | null): void {
        origName = p?.name ?? "";
        // Always render the title text (rebuild the leading text node — the
        // dirty-marker span stays put after it).
        const label = p ? (p.name || p.host) : t("conn.newTitle", "New connection");
        if (title.firstChild && title.firstChild.nodeType === Node.TEXT_NODE) {
            title.firstChild.textContent = label;
        } else {
            title.insertBefore(document.createTextNode(label), title.firstChild);
        }
        inName.value = p?.name ?? "";
        inHost.value = p?.host ?? "";
        inUser.value = p?.user ?? "";
        inPassword.value = "";
        inPassword.placeholder = "";
        passwordStored = false;
        if (p?.savePassword && p.name) {
            void opts.getPassword(p.name).then((pw) => {
                // Only apply if the form still shows this profile.
                if (origName !== p.name) return;
                passwordStored = pw !== "";
                inPassword.value = passwordStored ? STORED_MASK : "";
            }).catch(() => { /* vault miss: leave empty */ });
        }
        inBidi.value = p?.bidiStringType ?? "";
        inSchema.value = p?.defaultSchema ?? "";
        inNaming.value = p?.naming || "system";
        inTls.checked = !!p?.tls;
        inSavePw.checked = !!p?.savePassword;
        inPreload.checked = p?.preloadSpool !== false;
        inSaveScript.checked = p?.saveScript !== false;
        inScript.value = p?.script ?? "";
        btnDelete.hidden = !p;
        btnDuplicate.disabled = !p;
        btnConnectTab.disabled = !p;
        dirtyMarker.hidden = true;
    }

    function markSelected(name: string): void {
        for (const li of Array.from(list.querySelectorAll<HTMLElement>(".settings-key"))) {
            const on = li.dataset.profileName === name;
            li.classList.toggle("selected", on);
            li.tabIndex = on ? 0 : -1;
        }
    }

    async function selectProfile(p: ConnectionProfile | null): Promise<void> {
        // Auto-save a dirty form before switching away.
        if (!dirtyMarker.hidden) await save();
        if (dirtyMarker.hidden) fill(p);
        markSelected(origName);
        // Focus the selected row (jsdom lacks CSS.escape; fall back to a
        // simple match when it isn't available).
        const focusSel = typeof CSS !== "undefined" && CSS.escape
            ? `.settings-key[data-profile-name="${CSS.escape(origName)}"]`
            : "";
        const target = focusSel
            ? list.querySelector<HTMLElement>(focusSel)
            : Array.from(list.querySelectorAll<HTMLElement>(".settings-key"))
                .find((li) => li.dataset.profileName === origName);
        target?.focus();
    }

    function renderList(): void {
        list.innerHTML = "";
        for (const p of profiles) {
            const li = document.createElement("li");
            li.className = "settings-key";
            li.setAttribute("role", "option");
            li.tabIndex = 0;
            li.dataset.profileName = p.name;
            li.draggable = true;
            li.textContent = `${p.name || p.host}  (${p.user}@${p.host})`;
            li.addEventListener("click", () => void selectProfile(p));
            li.addEventListener("dragstart", (ev) => {
                ev.dataTransfer?.setData("text/plain", p.name);
                ev.dataTransfer?.setDragImage(li, 10, 10);
            });
            li.addEventListener("dragover", (ev) => {
                ev.preventDefault();
                li.classList.add("conn-drop-target");
            });
            li.addEventListener("dragleave", () => li.classList.remove("conn-drop-target"));
            li.addEventListener("drop", (ev) => {
                ev.preventDefault();
                li.classList.remove("conn-drop-target");
                const draggedName = ev.dataTransfer?.getData("text/plain") ?? "";
                if (!draggedName || draggedName === p.name) return;
                void applyOrder(moveName(profiles.map((x) => x.name), draggedName, p.name));
            });
            li.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    void selectProfile(p);
                } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
                    // Walk from the FOCUSED row (not origName) so auto-save's
                    // reload can't misplace the moving selection.
                    ev.preventDefault();
                    const currentName = (ev.currentTarget as HTMLElement).dataset.profileName ?? "";
                    const idx = profiles.findIndex((x) => x.name === currentName);
                    if (idx < 0) return;
                    const step = ev.key === "ArrowDown" ? 1 : -1;
                    const next = profiles[(idx + step + profiles.length) % profiles.length];
                    if (next) void selectProfile(next);
                }
            });
            list.appendChild(li);
        }
        markSelected(origName);
    }

    /** Move `name` to sit directly before `beforeName` in the sequence. */
    function moveName(names: string[], name: string, beforeName: string): string[] {
        const out = names.filter((n) => n !== name);
        const at = out.indexOf(beforeName);
        out.splice(at < 0 ? out.length : at, 0, name);
        return out;
    }

    let sortAsc = true;
    async function applyOrder(names: string[]): Promise<void> {
        if (!opts.onReorder) return;
        try {
            await opts.onReorder(names);
            await reload(origName);
            opts.onChanged?.();
        } catch (err) {
            opts.onError?.(String((err as Error)?.message ?? err));
        }
    }

    btnSort.addEventListener("click", () => {
        const names = profiles.map((p) => p.name).sort((a, b) =>
            sortAsc ? a.localeCompare(b) : b.localeCompare(a));
        sortAsc = !sortAsc;
        btnSort.textContent = sortAsc ? "A-Z" : "Z-A";
        void applyOrder(names);
    });

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

    btnConnectTab.addEventListener("click", () => {
        const src = profiles.find((p) => p.name === origName);
        if (src && opts.onConnect) opts.onConnect(src);
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

    // (list footer buttons appended at construction time above)

    fill(null);
    void reload();

    return { root, reload: () => reload(origName) };
}
