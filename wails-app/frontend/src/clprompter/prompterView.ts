// CL prompter form: renders a CmdDescriptor as an HTML form and produces a CL
// command string. Styled by style.css (.prompter-*).
//
// Ported smarts from cozzi-cl-prompter prompter.ts:
// - Type-aware widgets (LGL select, DspInput=NO password, CMD/CMDSTR/long CHAR
//   textarea, choice dropdown vs datalist by Rstd)
// - Blur + submit validation (validateField), inline error spans, dep banner
// - Constraint hints to the right of fields (5250-style)
// - Dep/PmtCtl show-hide on input
// - Multi-instance add/remove rows with SNGVAL exclusivity

import { t } from "../l10n";
import { isContainerType } from "./promptHelpers";
import type { CmdDescriptor, DepConstraint, DepParmEntry, ParmDescriptor, PmtCtlEntry, PmtCtlGroup } from "./prompterModel";
import { validateField, validateSngValExclusivity } from "./validate";

export interface PrompterCallbacks {
    onRun(commandText: string): void;
    onInsert(commandText: string): void;
    onClose(): void;
    /** Nested prompt: user asked to prompt a command typed into a CMD/CMDSTR field. */
    onPromptNested?(commandText: string, applyBack: (newText: string) => void): void;
}

const TEXTAREA_TYPES = new Set(["CMD", "CMDSTR"]);

function constraintHint(p: ParmDescriptor): string {
    const parts: string[] = [];
    if (p.full && p.len) parts.push(t("prompter.hintExactChars", "exactly {len} chars").replace("{len}", String(p.len)));
    else if (p.len) parts.push(t("prompter.hintMaxChars", "max {len} chars").replace("{len}", String(p.len)));
    if (p.rangeMin != null || p.rangeMax != null) {
        parts.push(t("prompter.hintRange", "{min} to {max}").replace("{min}", String(p.rangeMin ?? "")).replace("{max}", String(p.rangeMax ?? "")).trim().replace(/^to$/, ""));
    }
    for (const r of p.rel ?? []) {
        parts.push(r.kwd ? `${r.op} ${r.kwd}` : `${r.op} ${r.value}`);
    }
    if (p.sngVals.length) parts.push(t("prompter.hintOrAlone", "or {values} alone").replace("{values}", p.sngVals.join("/")));
    if (p.rtnVal) parts.push(t("prompter.hintClVarOnly", "CL variable only"));
    if (!p.alwVar) parts.push(t("prompter.hintNoVariable", "no &variable"));
    return parts.filter(Boolean).join("; ");
}

function makeErrorSpan(): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "prompter-error-msg";
    return span;
}

/** Shrink a <select> to its longest option instead of stretching full width. */
function sizeSelect(sel: HTMLSelectElement): void {
    const longest = Array.from(sel.options).reduce((m, o) => Math.max(m, o.textContent?.length ?? 0), 0);
    const ch = Math.min(Math.max(longest + 4, 12), 60);
    sel.style.flex = "0 0 auto";
    sel.style.width = `calc(${ch}ch + 24px)`;
}

function setFieldError(wrap: HTMLElement, msg: string | undefined): void {
    let span = wrap.querySelector<HTMLSpanElement>(".prompter-error-msg");
    if (!msg) {
        span?.remove();
        wrap.classList.remove("has-error");
        return;
    }
    if (!span) {
        span = makeErrorSpan();
        wrap.appendChild(span);
    }
    span.textContent = msg;
    wrap.classList.add("has-error");
}

interface FieldCtx {
    cmd: CmdDescriptor;
    getValue: (kwd: string) => string;
    applyDependencies: () => void;
    onPromptNested?: (commandText: string, applyBack: (newText: string) => void) => void;
}

function attachValidation(input: HTMLElement, p: ParmDescriptor, wrap: HTMLElement, ctx: FieldCtx): void {
    input.addEventListener("blur", () => {
        const v = (input as HTMLInputElement).value;
        setFieldError(wrap, validateField(p, v, ctx.getValue));
    });
    input.addEventListener("input", () => {
        ctx.applyDependencies();
    });
}

function baseInput(p: ParmDescriptor, name: string): HTMLInputElement | HTMLTextAreaElement {
    const type = (p.type ?? "").toUpperCase();
    const useTextarea = TEXTAREA_TYPES.has(type) || (!p.choices.length && (p.len ?? 0) > 72);
    const input = useTextarea
        ? document.createElement("textarea")
        : document.createElement("input");
    if (input instanceof HTMLInputElement) {
        input.type = p.dspInput ? "text" : "password";
    } else {
        input.rows = 3;
    }
    input.name = name;
    input.dataset.kwd = p.kwd;
    input.className = "prompter-input";
    input.placeholder = p.dft ?? "";
    // No maxLength: Len only bounds plain literals (enforced at validation).
    // CL variables, expressions, and %BIFs may legitimately exceed Len.
    const longestChoice = [...p.choices, ...p.sngVals.map((s) => ({ value: s }))]
        .reduce((m, c) => Math.max(m, c.value.length), 0);
    applyDisplayWidth(input, p, longestChoice);
    return input;
}

/** Size the control like 5250/ACS: InlPmtLen (or Len) chars, not full width. */
function applyDisplayWidth(
    input: HTMLInputElement | HTMLTextAreaElement,
    p: ParmDescriptor,
    longestChoice: number,
): void {
    if (input instanceof HTMLTextAreaElement) return; // textareas size via CSS
    // InlPmtLen governs display width; *CALC/absent falls back to Len.
    let inl = p.inlPmtLen;
    if (inl != null && inl <= 0) inl = undefined;
    const baseLen = inl ?? p.len ?? 0;
    const minCh = Math.max(4, baseLen, longestChoice) + 1;
    input.size = minCh;
    input.style.flex = "0 1 auto";
    input.style.width = `calc(${minCh}ch + 16px)`;
    input.style.minWidth = "120px";
}

function inputForParm(p: ParmDescriptor, ctx: FieldCtx): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "prompter-field";
    wrap.dataset.parmKwd = p.kwd;

    const label = document.createElement("label");
    label.className = "prompter-label";
    // 5250/ACS style: prompt text followed by the keyword in parens; the
    // keyword span is what lights up when the field has focus.
    label.textContent = p.prompt || p.kwd;
    label.title = `${p.kwd}${p.type ? ` — ${p.type}${p.len ? `(${p.len})` : ""}` : ""}${p.min > 0 ? `  ${t("prompter.required", "(required)")}` : ""}${p.max > 1 ? `  ${t("prompter.upTo", "(up to {max})").replace("{max}", String(p.max))}` : ""}`;
    if (p.prompt && p.prompt !== p.kwd) {
        const kwdSpan = document.createElement("span");
        kwdSpan.className = "prompter-kwd";
        kwdSpan.textContent = ` (${p.kwd})`;
        label.appendChild(kwdSpan);
    }
    if (p.min > 0) label.classList.add("required");
    wrap.appendChild(label);

    const fieldCell = document.createElement("div");
    fieldCell.className = "prompter-field-cell";
    wrap.appendChild(fieldCell);

    // Focus arrow (▶) marks the field holding the caret; highlight keyword too.
    // Sits at the LEFT edge of the input area (5250-style selection cursor).
    const arrow = document.createElement("span");
    arrow.className = "prompter-focus-arrow";
    arrow.textContent = "\u25B6";
    arrow.setAttribute("aria-hidden", "true");
    wrap.addEventListener("focusin", () => {
        wrap.classList.add("focused");
        fieldCell.insertBefore(arrow, fieldCell.firstChild);
    });
    wrap.addEventListener("focusout", () => {
        wrap.classList.remove("focused");
        arrow.remove();
    });

    const name = `parm-${p.kwd}`;

    if (p.choices.length > 0 && p.rstd) {
        const sel = document.createElement("select");
        sel.name = name;
        sel.dataset.kwd = p.kwd;
        sel.className = "prompter-input";
        const blank = document.createElement("option");
        blank.value = "";
        // Blank = parm default; show the default value itself, no wrapper text.
        blank.textContent = p.dft ?? "";
        sel.appendChild(blank);
        for (const c of p.choices) {
            const opt = document.createElement("option");
            opt.value = c.value;
            opt.textContent = c.text ? `${c.value} — ${c.text}` : c.value;
            sel.appendChild(opt);
        }
        // SNGVAL options selectable but exclusive — validated on submit.
        for (const s of p.sngVals) {
            if (p.choices.some((c) => c.value === s)) continue;
            const opt = document.createElement("option");
            opt.value = s;
            opt.textContent = `${s} ${t("prompter.alone", "(alone)")}`;
            sel.appendChild(opt);
        }
        sizeSelect(sel);
        fieldCell.appendChild(sel);
        attachValidation(sel, p, wrap, ctx);
    } else if ((p.type ?? "").toUpperCase() === "LGL" && !p.choices.length) {
        const sel = document.createElement("select");
        sel.name = name;
        sel.dataset.kwd = p.kwd;
        sel.className = "prompter-input";
        for (const v of ["", "1", "0", "*YES", "*NO", ...p.sngVals]) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v === "" ? (p.dft ?? "") : v;
            sel.appendChild(opt);
        }
        sizeSelect(sel);
        fieldCell.appendChild(sel);
        attachValidation(sel, p, wrap, ctx);
    } else {
        const hasChoices = p.choices.length > 0 || p.sngVals.length > 0;
        if (hasChoices) {
            // Visible combo: dropdown of choices + "Other…" swaps to free input.
            const combo = document.createElement("div");
            combo.className = "prompter-combo";
            const sel = document.createElement("select");
            sel.className = "prompter-combo-select"; // picker only; no data-kwd
            sel.dataset.kwdPicker = p.kwd;
            const blank = document.createElement("option");
            blank.value = "";
            blank.textContent = p.dft ?? "";
            sel.appendChild(blank);
            for (const c of [...p.choices, ...p.sngVals.map((s) => ({ value: s, text: undefined as string | undefined }))]) {
                const opt = document.createElement("option");
                opt.value = c.value;
                opt.textContent = c.text ? `${c.value} — ${c.text}` : c.value;
                sel.appendChild(opt);
            }
            const otherOpt = document.createElement("option");
            otherOpt.value = "\u0001OTHER";
            otherOpt.textContent = t("prompter.other", "Other…");
            sel.appendChild(otherOpt);
            sizeSelect(sel);

            const free = baseInput(p, name);
            free.hidden = true;

            sel.addEventListener("change", () => {
                if (sel.value === "\u0001OTHER") {
                    sel.hidden = true;
                    free.hidden = false;
                    free.focus();
                } else {
                    free.value = sel.value;
                }
                ctx.applyDependencies();
            });
            free.addEventListener("blur", () => {
                if (!free.value.trim()) {
                    free.hidden = true;
                    sel.hidden = false;
                    sel.value = "";
                }
            });
            // free is the field that carries the value for buildCommand/validation;
            // the select is a pure picker (never validated directly).
            attachValidation(free, p, wrap, ctx);
            combo.appendChild(sel);
            combo.appendChild(free);
            fieldCell.appendChild(combo);
        } else {
            const input = baseInput(p, name);
            fieldCell.appendChild(input);
            attachValidation(input, p, wrap, ctx);
        }
    }

    // CMD/CMDSTR fields: nested prompt button (Prompt the command in the field).
    if (TEXTAREA_TYPES.has((p.type ?? "").toUpperCase()) && ctx.onPromptNested) {
        const promptBtn = document.createElement("button");
        promptBtn.type = "button";
        promptBtn.className = "btn prompter-nested";
        promptBtn.textContent = t("prompter.nested", "Prompt…");
        promptBtn.title = t("prompter.nested.title", "Prompt the command in this field (nested)");
        promptBtn.addEventListener("click", () => {
            const field = wrap.querySelector<HTMLInputElement | HTMLTextAreaElement>(".prompter-input");
            const current = field?.value?.trim() ?? "";
            ctx.onPromptNested!(current, (newText) => {
                if (field) {
                    field.value = newText;
                    field.dispatchEvent(new Event("input", { bubbles: true }));
                }
            });
        });
        fieldCell.appendChild(promptBtn);
    }

    const hint = constraintHint(p);
    if (hint) {
        const hintSpan = document.createElement("span");
        hintSpan.className = "prompter-hint";
        hintSpan.textContent = hint;
        fieldCell.appendChild(hintSpan);
    }

    if (p.max > 1) {
        const add = document.createElement("button");
        add.type = "button";
        add.className = "btn prompter-add";
        add.textContent = "+";
        add.title = t("prompter.addAnother", "Add another value (max {max})").replace("{max}", String(p.max));
        add.addEventListener("click", () => {
            const fieldParent = wrap.parentElement;
            if (!fieldParent) return;
            const siblings = fieldParent.querySelectorAll(`.prompter-input[data-kwd="${p.kwd}"]`).length;
            if (siblings >= p.max) return;
            const cloneWrap = document.createElement("div");
            cloneWrap.className = "prompter-field prompter-field-extra";
            const emptyLabel = document.createElement("label");
            emptyLabel.className = "prompter-label";
            cloneWrap.appendChild(emptyLabel);
            const cell = document.createElement("div");
            cell.className = "prompter-field-cell";
            const cloneInput = baseInput(p, name);
            attachValidation(cloneInput, p, cloneWrap, ctx);
            cell.appendChild(cloneInput);
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "btn prompter-remove";
            remove.textContent = "−";
            remove.title = t("prompter.removeValue", "Remove this value");
            remove.addEventListener("click", () => {
                cloneWrap.remove();
                ctx.applyDependencies();
            });
            cell.appendChild(remove);
            cloneWrap.appendChild(cell);
            fieldParent.insertBefore(cloneWrap, wrap.nextSibling);
            cloneInput.focus();
            ctx.applyDependencies();
        });
        label.appendChild(document.createTextNode(" "));
        label.appendChild(add);
    }
    return wrap;
}

function quoteCL(v: string): string {
    if (/^'.*'$/.test(v)) return v;
    if (/\s|[(),]/.test(v)) return `'${v.replace(/'/g, "''")}'`;
    return v;
}

// ─── Dep / PmtCtl evaluation engine (ported from cozzi-cl-prompter prompter.ts) ───

/** X'40...' EBCDIC blank literal → single space; blank field == space literal. */
export function resolveHexLiteral(val: string): string {
    const m = val.match(/^X'([0-9A-Fa-f]+)'$/);
    if (!m) return val;
    const hex = m[1];
    if (hex.length % 2 !== 0) return val;
    if (/^(40)+$/i.test(hex)) return " ";
    if (hex.length !== 2) return val;
    const code = Number.parseInt(hex, 16);
    return String.fromCharCode(code === 0x40 ? 0x20 : code);
}

/** IBM i relational comparison: numeric when both sides parse, else CI string. */
export function compareDepValues(a: string, op: string, b: string): boolean {
    const numA = Number.parseFloat(a);
    const numB = Number.parseFloat(b);
    const isNumeric = !Number.isNaN(numA) && !Number.isNaN(numB);
    const [x, y] = isNumeric ? [numA, numB] : [a.toUpperCase(), b.toUpperCase()];
    switch (op.toUpperCase()) {
        case "EQ": return x === y;
        case "NE": return x !== y;
        case "GT": return x > y;
        case "LT": return x < y;
        case "GE": case "NL": return x >= y;
        case "LE": case "NG": return x <= y;
        default: return true;
    }
}

/** NbrTrueRel/NbrTrue threshold check. */
export function nbrTruePasses(rel: string, nbrTrue: number, trueCount: number, total: number): boolean {
    switch (rel.toUpperCase()) {
        case "ALL": return trueCount === total && total > 0;
        case "GT": return trueCount > nbrTrue;
        case "GE": case "NL": return trueCount >= nbrTrue;
        case "EQ": return trueCount === nbrTrue;
        case "LE": case "NG": return trueCount <= nbrTrue;
        case "LT": return trueCount < nbrTrue;
        case "NE": return trueCount !== nbrTrue;
        default: return trueCount >= nbrTrue;
    }
}

/**
 * SPCFD semantics: a parm counts as "specified" when it has a non-empty value
 * that differs from its default. QUAL parms look at the first part (QUAL0),
 * which holds the object name or the single-value alternative (e.g. *NONE).
 */
export function isParmSpecified(
    form: HTMLElement,
    kwd: string,
    dftLookup: (kwd: string) => string | undefined,
): boolean {
    const direct = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        `.prompter-input[data-kwd="${kwd}"]`,
    );
    const raw = direct?.value?.trim() ?? "";
    const dft = dftLookup(kwd);
    if (raw) {
        if (dft !== undefined && raw === dft) return false;
        return true;
    }
    // QUAL: proxy on the first part; compare against that part's default.
    const qual0 = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        `.prompter-input[data-kwd="${kwd}.0"]`,
    );
    if (qual0) {
        const qv = qual0.value?.trim() ?? "";
        if (!qv) return false;
        const qd = dftLookup(`${kwd}.0`);
        return qd === undefined || qv !== qd;
    }
    // ELEM/container: any input in the row with a non-empty, non-default value.
    const row = form.querySelector<HTMLElement>(`.prompter-field[data-parm-kwd="${kwd}"]`);
    if (row) {
        for (const input of Array.from(row.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".prompter-input"))) {
            const v = input.value?.trim() ?? "";
            if (v && v !== (input.placeholder ?? "")) return true;
        }
    }
    return false;
}

export interface DepEvalContext {
    form: HTMLElement;
    getValue: (kwd: string) => string;
    dftLookup: (kwd: string) => string | undefined;
    /** "View All Parameters" toggle: bypass PmtCtl/PMTRQS hiding. */
    showAllParms?: boolean;
}

function evalDepParm(dp: DepParmEntry, ctx: DepEvalContext): boolean {
    const val = ctx.getValue(dp.kwd);
    if (dp.rel === "SPCFD") {
        return isParmSpecified(ctx.form, dp.kwd, ctx.dftLookup);
    }
    if (dp.cmpKwd) {
        return compareDepValues(val, dp.rel, ctx.getValue(dp.cmpKwd));
    }
    if (dp.cmpVal !== undefined) {
        const cmp = resolveHexLiteral(dp.cmpVal);
        return compareDepValues(val === "" ? " " : val, dp.rel, cmp);
    }
    return true;
}

/** Evaluate one Dep block; returns an error message when violated, else null. */
export function evaluateDepConstraint(dep: DepConstraint, ctx: DepEvalContext): string | null {
    if (dep.ctlKwdRel !== "ALWAYS") {
        if (!dep.ctlKwd) return null;
        let met: boolean;
        switch (dep.ctlKwdRel) {
            case "EQ":
            case "NE": {
                const cmp = resolveHexLiteral(dep.cmpVal ?? "");
                const val = ctx.getValue(dep.ctlKwd);
                met = compareDepValues(val === "" ? " " : val, dep.ctlKwdRel, cmp);
                break;
            }
            case "SPCFD":
                met = isParmSpecified(ctx.form, dep.ctlKwd, ctx.dftLookup);
                break;
            default:
                return null;
        }
        if (!met) return null; // control condition not met → constraint inert
    }

    const trueCount = dep.depParms.filter((dp) => evalDepParm(dp, ctx)).length;
    if (nbrTruePasses(dep.nbrTrueRel, dep.nbrTrue, trueCount, dep.depParms.length)) return null;

    const names = [...new Set(dep.depParms.map((dp) => dp.kwd))].join(", ");
    const detail = (dep.msgId ? t("prompter.depNotSatisfiedMsg", "{msgId}: dependency between {names} not satisfied ({met} of {total} conditions met)") : t("prompter.depNotSatisfied", "Dependency between {names} not satisfied ({met} of {total} conditions met)"))
        .replace("{msgId}", dep.msgId ?? "")
        .replace("{names}", names)
        .replace("{met}", String(trueCount))
        .replace("{total}", String(dep.depParms.length));
    return detail;
}

function evalPmtCtlGroup(group: PmtCtlGroup, ctx: DepEvalContext): boolean {
    const ctlRaw = ctx.getValue(group.ctlKwd);
    let trueCount = 0;
    for (const cond of group.conds) {
        let met: boolean;
        if (cond.rel === "SPCFD") {
            met = ctlRaw !== "" && ctlRaw !== " ";
        } else if (cond.rel === "UNSPCFD") {
            met = ctlRaw === "" || ctlRaw === " ";
        } else {
            const cmp = resolveHexLiteral(cond.cmpVal ?? "");
            met = compareDepValues(ctlRaw === "" ? " " : ctlRaw, cond.rel, cmp);
        }
        if (met) trueCount++;
    }
    return nbrTruePasses(group.nbrTrueRel, group.nbrTrue, trueCount, group.conds.length);
}

/** Should the controlled parm be visible? Chains groups with LglRel AND/OR. */
export function isParmVisible(entry: PmtCtlEntry | undefined, kwd: string, ctx: DepEvalContext): boolean {
    if (ctx.showAllParms) return true;
    if (!entry) return true;
    if (entry.groups.length === 0) {
        // PMTRQS: show only once the user supplied a value.
        return isParmSpecified(ctx.form, kwd, ctx.dftLookup);
    }
    let result = evalPmtCtlGroup(entry.groups[0], ctx);
    for (let i = 1; i < entry.groups.length; i++) {
        const g = entry.groups[i];
        const r = evalPmtCtlGroup(g, ctx);
        result = (g.lglRel ?? "AND").toUpperCase() === "OR" ? result || r : result && r;
    }
    return result;
}

export function showPrompter(
    container: HTMLElement,
    cmd: CmdDescriptor,
    cmdInput: string,
    callbacks: PrompterCallbacks,
): void {
    container.innerHTML = "";
    container.hidden = false;

    const head = document.createElement("div");
    head.className = "prompter-head";
    const title = document.createElement("span");
    title.className = "prompter-title";
    title.textContent = `${cmd.name}${cmd.library ? ` (${cmd.library})` : ""} — ${cmd.prompt}`;
    head.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.className = "btn";
    closeBtn.textContent = t("prompter.close", "Close");
    closeBtn.addEventListener("click", () => {
        container.hidden = true;
        callbacks.onClose();
    });
    head.appendChild(closeBtn);
    container.appendChild(head);

    const form = document.createElement("div");
    form.className = "prompter-form";
    container.appendChild(form);

    const getValue = (kwd: string): string => {
        const node = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `.prompter-input[data-kwd="${kwd}"]`,
        );
        return node?.value?.trim() ?? "";
    };

    // Default lookup for SPCFD "specified" checks: kwd → Dft. Container
    // children are keyed PARENT.INDEX (e.g. OUTQ.0).
    const dftLookup = (kwd: string): string | undefined => {
        const [parent, childIdx] = kwd.split(".");
        const parm = cmd.parms.find((p) => p.kwd.toUpperCase() === parent.toUpperCase());
        if (childIdx === undefined) return parm?.dft;
        return parm?.children[Number(childIdx)]?.dft;
    };

    const depCtx: DepEvalContext = { form, getValue, dftLookup, showAllParms: false };

    const applyDependencies = () => {
        // PmtCtl controls visibility; Dep violations surface in the banner on
        // submit, not as hidden fields.
        for (const wrap of Array.from(form.querySelectorAll<HTMLElement>(".prompter-field[data-parm-kwd]"))) {
            const kwd = wrap.dataset.parmKwd ?? "";
            const base = kwd.split(".")[0];
            wrap.hidden = !isParmVisible(cmd.pmtCtl.get(base), base, depCtx);
        }
    };

    const ctx: FieldCtx = { cmd, getValue, applyDependencies, onPromptNested: callbacks.onPromptNested };

    // Render in sorted parm order — containers stay inline at their position
    // instead of being pushed to the bottom of the form.
    const renderContainer = (c: ParmDescriptor): HTMLElement => {
        const box = document.createElement("fieldset");
        box.className = "prompter-group";
        const legend = document.createElement("legend");
        // Same label format as simple parms: "Prompt text (KWD)".
        legend.textContent = c.prompt
            ? `${c.prompt} (${c.kwd})`
            : `${c.isQual ? t("prompter.qualifiedName", "Qualified name") : t("prompter.list", "List")} (${c.kwd})`;
        box.appendChild(legend);
        for (const child of c.children) {
            const childCtx: FieldCtx = {
                cmd,
                getValue,
                applyDependencies,
                onPromptNested: callbacks.onPromptNested,
            };
            const childParm: ParmDescriptor = { ...child, kwd: `${c.kwd}.${child.kwd}` };
            box.appendChild(inputForParm(childParm, childCtx));
        }
        return box;
    };

    for (const p of cmd.parms) {
        if (p.type && isContainerType(p.type)) {
            form.appendChild(renderContainer(p));
            continue;
        }
        form.appendChild(inputForParm(p, ctx));
    }

    // Error banner for submit-level failures (Min/required, SNGVAL, Dep).
    const banner = document.createElement("div");
    banner.className = "prompter-error-banner";
    banner.hidden = true;
    container.appendChild(banner);

    const actions = document.createElement("div");
    actions.className = "prompter-actions";
    const preview = document.createElement("code");
    preview.className = "prompter-preview";
    const update = () => {
        preview.textContent = buildCommand(cmdInput, form, cmd);
    };
    form.addEventListener("input", update);

    const validateAll = (): boolean => {
        const errors: string[] = [];
        for (const wrap of Array.from(form.querySelectorAll<HTMLElement>(".prompter-field[data-parm-kwd]"))) {
            if (wrap.hidden) continue;
            const kwd = wrap.dataset.parmKwd ?? "";
            const parm = [...cmd.parms, ...cmd.parms.flatMap((p) => p.children)]
                .find((p) => p.kwd.toUpperCase() === kwd.toUpperCase() || `${p.kwd}.${kwd.split(".").pop()}` === kwd);
            const inputs = Array.from(wrap.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(".prompter-input"));
            for (const input of inputs) {
                const msg = parm ? validateField(parm, input.value, getValue) : undefined;
                setFieldError(wrap, msg);
                if (msg) errors.push(msg);
            }
            // SNGVAL exclusivity across multi-instance inputs
            if (parm && parm.max > 1) {
                const vals = inputs.map((i) => i.value);
                const msg = validateSngValExclusivity(parm, vals);
                if (msg) {
                    setFieldError(wrap, msg);
                    errors.push(msg);
                }
            }
        }
        // Cross-parameter Dep constraints (hidden-field values count as
        // unspecified for SPCFD checks since hidden fields hold no input).
        for (const dep of cmd.deps) {
            const err = evaluateDepConstraint(dep, depCtx);
            if (err) errors.push(err);
        }
        banner.hidden = errors.length === 0;
        banner.textContent = errors.length
            ? t("prompter.errorSummary", "{count} error(s): {first}").replace("{count}", String(errors.length)).replace("{first}", errors[0]) + (errors.length > 1 ? t("prompter.moreErrors", " …") : "")
            : "";
        return errors.length === 0;
    };

    const runBtn = document.createElement("button");
    runBtn.className = "btn primary";
    runBtn.textContent = t("prompter.run", "Run");
    runBtn.addEventListener("click", () => {
        if (!validateAll()) return;
        callbacks.onRun(preview.textContent || cmdInput);
    });

    const insertBtn = document.createElement("button");
    insertBtn.className = "btn";
    insertBtn.textContent = t("prompter.insert", "Insert into editor");
    insertBtn.addEventListener("click", () => {
        if (!validateAll()) return;
        callbacks.onInsert(preview.textContent || cmdInput);
    });

    actions.appendChild(runBtn);
    actions.appendChild(insertBtn);
    actions.appendChild(preview);
    // "View All Parameters": toggle between PmtCtl-filtered and everything.
    if (cmd.pmtCtl.size > 0) {
        const viewAll = document.createElement("button");
        viewAll.className = "btn";
        viewAll.textContent = t("prompter.viewAll", "View all parameters");
        viewAll.title = t("prompter.viewAll.title", "Show parameters hidden by prompt-control conditions");
        viewAll.addEventListener("click", () => {
            depCtx.showAllParms = !depCtx.showAllParms;
            viewAll.textContent = depCtx.showAllParms ? t("prompter.viewAll.active", "Show prompted parameters") : t("prompter.viewAll", "View all parameters");
            viewAll.classList.toggle("active", !!depCtx.showAllParms);
            applyDependencies();
        });
        actions.appendChild(viewAll);
    }
    container.appendChild(actions);
    applyDependencies();
    update();
}

function buildCommand(cmdInput: string, form: HTMLElement, cmd: CmdDescriptor): string {
    const parts: string[] = [cmdInput.trim().split(/\s+/)[0] || cmd.name];
    const values = new Map<string, string[]>();

    for (const el of Array.from(form.querySelectorAll<HTMLElement>(".prompter-input[data-kwd]"))) {
        if (el.closest(".prompter-field")?.hasAttribute("hidden")) continue;
        const wrap = el.closest<HTMLElement>(".prompter-field");
        if (wrap?.hidden) continue;
        const kwd = el.dataset.kwd ?? "";
        const value = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value?.trim() ?? "";
        if (!value || !kwd) continue;
        const list = values.get(kwd) ?? [];
        list.push(value);
        values.set(kwd, list);
    }

    const emitted = new Set<string>();
    for (const el of Array.from(form.querySelectorAll<HTMLElement>(".prompter-input[data-kwd]"))) {
        const wrap = el.closest<HTMLElement>(".prompter-field");
        if (wrap?.hidden) continue;
        const kwd = el.dataset.kwd ?? "";
        if (!kwd) continue;
        if (kwd.includes(".")) {
            const parent = kwd.split(".")[0];
            if (emitted.has(parent)) continue;
            const childKwds = [...values.keys()].filter((k) => k.startsWith(`${parent}.`));
            const vals = childKwds.flatMap((k) => values.get(k) ?? []).filter(Boolean);
            if (vals.length) {
                parts.push(`${parent}(${vals.map(quoteCL).join("/")})`);
            }
            emitted.add(parent);
            continue;
        }
        if (emitted.has(kwd)) continue;
        const vals = values.get(kwd) ?? [];
        if (vals.length) {
            parts.push(`${kwd}(${vals.map(quoteCL).join(" ")})`);
        }
        emitted.add(kwd);
    }
    return parts.join(" ");
}
