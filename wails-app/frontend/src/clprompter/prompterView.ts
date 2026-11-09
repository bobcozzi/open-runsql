// CL prompter form: renders a CmdDescriptor as an HTML form and produces a CL
// command string. Styled by style.css (.prompter-*).
//
// Ported smarts from cozzi-cl-prompter prompter.ts:
// - Type-aware widgets (LGL select, DspInput=NO password, CMD/CMDSTR/long CHAR
//   textarea, choice dropdown vs datalist by Rstd)
// - Defaults are real values: fields prefill with Dft (not a placeholder),
//   restricted selects preselect the matching option, ELEM children get the
//   composite-Dft / first-allowed-value form default (getElemFormDefault)
// - Blur + submit validation (validateField), inline error spans, dep banner
// - Constraint hints to the right of fields (5250-style)
// - Dep/PmtCtl show-hide on input; Val→MapTo internal resolution for
//   Dep/PmtCtl comparisons (valToMapToMap)
// - Multi-instance add/remove rows with SNGVAL exclusivity
// - Footer: Enter (write command back, close) + Cancel

import { t } from "../l10n";
import { parseCLParms } from "./parseCL";
import { rewritePositionalParms } from "./positional";
import { isContainerType } from "./promptHelpers";
import type { CmdDescriptor, DepConstraint, DepParmEntry, ParmDescriptor, PmtCtlEntry, PmtCtlGroup } from "./prompterModel";
import { validateField, validateSngValExclusivity } from "./validate";

export interface PrompterCallbacks {
    onRun(commandText: string): void;
    onClose(): void;
    /** Nested prompt: user asked to prompt a command typed into a CMD/CMDSTR field. */
    onPromptNested?(commandText: string, applyBack: (newText: string) => void): void;
    /** Raw command XML from the host — shown behind the <xml> copy button. */
    cmdXml?: string;
}

const TEXTAREA_TYPES = new Set(["CMD", "CMDSTR"]);

/** Range/Rel/RelKwd/RangeKwd constraint hint (port of the extension's
    buildConstraintHint): ACS operator symbols, comma-joined. A lone GE/NL 0
    (baseline domain check, e.g. CCSID Rel=GE RelVal=0) is suppressed — not
    user guidance — so the Choice text shows instead. */
function rangeRelHint(p: ParmDescriptor): string {
    const rels = p.rel ?? [];
    const hasRange = p.rangeMin != null || p.rangeMax != null;
    // Suppress a permanent ">= 0" for optional numerics (extension parity).
    if (!hasRange && rels.length === 1 && !rels[0].kwd) {
        const n = Number(rels[0].value);
        if ((rels[0].op === "GE" || rels[0].op === "NL") && Number.isFinite(n) && n === 0) {
            return "";
        }
    }
    const sym = (op: string): string =>
        op === "GE" || op === "NL" ? ">=" : op === "LE" || op === "NG" ? "<=" :
            op === "GT" ? ">" : op === "LT" ? "<" : op === "EQ" ? "=" : op === "NE" ? "<>" : op;
    const parts: string[] = [];
    if (hasRange) {
        parts.push(`${p.rangeMin ?? ""} to ${p.rangeMax ?? ""}`.trim());
    }
    for (const r of rels) {
        parts.push(`${sym(r.op)} ${r.kwd ?? r.value}`);
    }
    if (p.rangeMinKwd != null || p.rangeMaxKwd != null) {
        parts.push(`${p.rangeMinKwd ?? ""} to ${p.rangeMaxKwd ?? ""}`.trim());
    }
    return parts.filter(Boolean).join(", ");
}

/** Type word (from the Choice attribute) + the special values, 5250-style:
    "Name, *LIBL, *CURLIB", "Name, *SAME, *USRPRF...". The Choice attribute is
    the type word ("Name", "Date", "1-366"); the SpcVal/SngVal values append
    after it. "..." marks a truncated tail. Values already named inside the
    Choice text are not repeated (dedup). */
export function fieldHint(p: ParmDescriptor): string {
    return choiceHintText(p) || rangeRelHint(p) || constraintHint(p);
}

/** Choice type word + special values. Values already present as tokens inside
    the Choice string (e.g. "*SAME, *SYSVAL...") are not re-appended; a trailing
    "..." in the Choice text is lifted to the very end. */
function choiceHintText(p: ParmDescriptor): string {
    let typeWord = (p.choice ?? "").trim();
    // A trailing "..." in the Choice text marks "more values follow" — lift it
    // so appended values sit before the ellipsis.
    let ellipsis = "";
    if (/\.{3}\s*$/.test(typeWord)) {
        ellipsis = "...";
        typeWord = typeWord.replace(/\.{3}\s*$/, "").replace(/[,\s]+$/, "");
    }
    // Tokens already named in the Choice text (specials like *SAME, *SYSVAL,
    // or a bare "*"). Match *WORD plus a lone *.
    const named = new Set(
        (typeWord.match(/\*[A-Z0-9]*|\*(?![A-Z0-9])/gi) ?? []).map((s) => s.toUpperCase()),
    );
    const vals: string[] = [];
    const seen = new Set<string>();
    const push = (v: string) => {
        const k = v.toUpperCase();
        if (!v || seen.has(k)) return;
        // Skip values already named in the Choice text, or equal to the type word.
        if (named.has(k) || k === typeWord.toUpperCase()) return;
        seen.add(k);
        vals.push(v);
    };
    for (const c of p.choices) push(c.value);
    for (const s of p.sngVals) push(s);
    // ChoicePgmValues are the choice-program's code list (e.g. CCSID numbers) —
    // they fill the dropdown, not the hint text (the resolved ChoicePgmText
    // already names the headline specials and ends with "...").
    if (!typeWord) {
        for (const c of p.choicePgmValues) push(c.value);
    }
    if (!typeWord && vals.length === 0) return "";
    // No type word → don't let bare special values stand in as the "hint";
    // a range/rel constraint is more informative (e.g. "1 to 366").
    if (!typeWord) return "";
    const shown = vals.slice(0, 3);
    if (vals.length > 3 && !ellipsis) ellipsis = "...";
    return [typeWord, ...shown].filter(Boolean).join(", ") + ellipsis;
}

function constraintHint(p: ParmDescriptor): string {
    const parts: string[] = [];
    if (p.full && p.len) parts.push(t("prompter.hintExactChars", "exactly {len} chars").replace("{len}", String(p.len)));
    else if (p.len) parts.push(t("prompter.hintMaxChars", "max {len} chars").replace("{len}", String(p.len)));
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
    /** Base keywords the user has edited (input/change events). */
    touched: Set<string>;
}

function attachValidation(input: HTMLElement, p: ParmDescriptor, wrap: HTMLElement, ctx: FieldCtx): void {
    // Touch tracking: QUAL/ELEM subfields (dotted data-kwd) normalize to the
    // base keyword, like the extension's _QUALn/_INSTn_ELEMn normalization.
    const markTouched = () => {
        const kwd = (input as HTMLElement).dataset?.kwd;
        if (kwd) ctx.touched.add(kwd.split(".")[0].toUpperCase());
    };
    input.addEventListener("blur", () => {
        const v = (input as HTMLInputElement).value;
        setFieldError(wrap, validateField(p, v, ctx.getValue));
    });
    input.addEventListener("input", () => {
        markTouched();
        ctx.applyDependencies();
    });
    // <select> elements fire change without input on some engines — PmtCtl
    // re-show depends on this firing when a restricted dropdown changes.
    input.addEventListener("change", () => {
        markTouched();
        ctx.applyDependencies();
    });
}

/**
 * Canonicalize a value against the parm's choice/single values (CI match →
 * canonical casing), mirroring the extension's normalizeValue. Quoted strings
 * are never modified.
 */
function normalizeChoiceValue(p: ParmDescriptor, v: string): string {
    if (!v) return v;
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) return v;
    const match = [...p.choices.map((c) => c.value), ...p.sngVals]
        .find((a) => a.toUpperCase() === v.toUpperCase());
    return match ?? v;
}

/** First displayable allowed value (choices then single values), skipping *NULL. */
function firstAllowedValue(p: ParmDescriptor): string {
    for (const v of [...p.choices.map((c) => c.value), ...p.sngVals]) {
        if (v && v !== "*NULL") return v;
    }
    return "";
}

/**
 * Preselect the option matching the parm default (case-insensitive). With no
 * default, a leading blank option represents "no value". When the default is
 * not among the options, it is prepended as its own selected option so the
 * field still holds the default value.
 */
function applySelectDefault(sel: HTMLSelectElement, dft: string | undefined): void {
    if (!dft) {
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "";
        sel.insertBefore(blank, sel.firstChild);
        sel.value = "";
    } else {
        const match = Array.from(sel.options).find((o) => o.value.toUpperCase() === dft.toUpperCase());
        if (match) {
            match.selected = true;
        } else {
            const opt = document.createElement("option");
            opt.value = dft;
            opt.textContent = dft;
            opt.selected = true;
            sel.insertBefore(opt, sel.firstChild);
        }
    }
    // The value the form was prefilled with — the "unchanged" marker.
    sel.dataset.default = sel.value;
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
    // Defaults are real values, not placeholders (extension parity): the field
    // starts holding the default; dataset.default records the prefill so
    // buildCommand/isParmSpecified can tell "unchanged" from "user-entered".
    input.value = normalizeChoiceValue(p, p.dft ?? "");
    input.dataset.default = input.value;
    // No maxLength: Len only bounds plain literals (enforced at validation).
    // CL variables, expressions, and %BIFs may legitimately exceed Len.
    const longestChoice = [...p.choices, ...p.sngVals.map((s) => ({ value: s })), ...p.choicePgmValues]
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

    // Container children carry PARENT.N internally — display the parent kwd.
    const displayKwd = p.kwd.includes(".") ? p.kwd.split(".")[0] : p.kwd;

    const label = document.createElement("label");
    label.className = "prompter-label";
    // 5250/ACS style: prompt text followed by the keyword in parens; the
    // keyword span is what lights up when the field has focus.
    label.textContent = p.prompt || displayKwd;
    label.title = `${displayKwd}${p.type ? ` — ${p.type}${p.len ? `(${p.len})` : ""}` : ""}${p.min > 0 ? `  ${t("prompter.required", "(required)")}` : ""}${p.max > 1 ? `  ${t("prompter.upTo", "(up to {max})").replace("{max}", String(p.max))}` : ""}`;
    if (p.prompt && p.prompt !== p.kwd && p.prompt !== displayKwd) {
        const kwdSpan = document.createElement("span");
        kwdSpan.className = "prompter-kwd";
        kwdSpan.textContent = ` (${displayKwd})`;
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
        applySelectDefault(sel, p.dft);
        sizeSelect(sel);
        fieldCell.appendChild(sel);
        attachValidation(sel, p, wrap, ctx);
    } else if ((p.type ?? "").toUpperCase() === "LGL" && !p.choices.length) {
        const sel = document.createElement("select");
        sel.name = name;
        sel.dataset.kwd = p.kwd;
        sel.className = "prompter-input";
        for (const v of ["1", "0", "*YES", "*NO", ...p.sngVals]) {
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = v;
            sel.appendChild(opt);
        }
        applySelectDefault(sel, p.dft);
        sizeSelect(sel);
        fieldCell.appendChild(sel);
        attachValidation(sel, p, wrap, ctx);
    } else {
        const hasChoices = p.choices.length > 0 || p.sngVals.length > 0 || p.choicePgmValues.length > 0;
        if (hasChoices) {
            // Rstd=NO: text input with the special values as datalist
            // suggestions — type CUSTMAST freely, or pick *ALL/*ALLUSR off
            // the list. The input itself carries data-kwd.
            const input = baseInput(p, name);
            const listId = `dl-${p.kwd.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
            const dl = document.createElement("datalist");
            dl.id = listId;
            const seen = new Set<string>();
            for (const c of [...p.choices, ...p.sngVals.map((s) => ({ value: s, text: undefined as string | undefined }))]) {
                seen.add(c.value.toUpperCase());
                const opt = document.createElement("option");
                opt.value = c.value;
                if (c.text) opt.label = c.text;
                dl.appendChild(opt);
            }
            // Inline choice-program values (Choice="__PGM"): advisory only,
            // appended after the declared special values. Value is the leading
            // token; the description becomes the option label.
            for (const c of p.choicePgmValues) {
                if (seen.has(c.value.toUpperCase())) continue;
                const opt = document.createElement("option");
                opt.value = c.value;
                if (c.text) opt.label = c.text;
                dl.appendChild(opt);
            }
            input.setAttribute("list", listId);
            fieldCell.appendChild(input);
            fieldCell.appendChild(dl);
            attachValidation(input, p, wrap, ctx);
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

    // Right-hand hint slot: range/rel constraints, then the host-sent Choice
    // text, then length/misc constraints (extension parity).
    const hint = fieldHint(p);
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
    // The input's own prefill (dataset.default) is the authoritative
    // "unchanged" marker; dftLookup (parm/child Dft from the XML) is the
    // fallback for hand-built forms that never went through the renderer.
    const direct = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        `.prompter-input[data-kwd="${kwd}"]`,
    );
    const raw = direct?.value?.trim() ?? "";
    if (raw) {
        const dft = direct?.dataset.default ?? dftLookup(kwd);
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
        const qd = qual0.dataset.default ?? dftLookup(`${kwd}.0`);
        return qd === undefined || qv !== qd;
    }
    // ELEM/container: any input in the group with a non-empty, non-default value.
    const row = form.querySelector<HTMLElement>(
        `.prompter-field[data-parm-kwd="${kwd}"], .prompter-group[data-parm-kwd="${kwd}"]`,
    );
    if (row) {
        for (const input of Array.from(row.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".prompter-input"))) {
            const v = input.value?.trim() ?? "";
            if (v && v !== (input.dataset.default ?? "")) return true;
        }
    }
    return false;
}

export interface DepEvalContext {
    form: HTMLElement;
    getValue: (kwd: string) => string;
    dftLookup: (kwd: string) => string | undefined;
    /** Val→MapTo translation: Dep/PmtCtl compare internal values. */
    resolveToInternal?: (kwd: string, val: string) => string;
    /** "View All Parameters" toggle: bypass PmtCtl/PMTRQS hiding. */
    showAllParms?: boolean;
}

/** Identity fallback when the context carries no MapTo map. */
function toInternal(ctx: DepEvalContext, kwd: string, val: string): string {
    return ctx.resolveToInternal ? ctx.resolveToInternal(kwd, val) : val;
}

/**
 * Translate a user-visible value (e.g. "*NO") to its internal MapTo form
 * (e.g. "N") via the valToInternal map extracted from the XML, with a
 * case-insensitive fallback. Returns val unchanged when unmapped.
 * Ported from the extension's resolveToInternal.
 */
export function resolveValToInternal(map: Record<string, Record<string, string>>, kwd: string, val: string): string {
    const kwdMap = map[kwd] ?? map[kwd.toUpperCase()];
    if (!kwdMap) return val;
    if (kwdMap[val] !== undefined) return kwdMap[val];
    const upper = val.toUpperCase();
    for (const [k, v] of Object.entries(kwdMap)) {
        if (k.toUpperCase() === upper) return v;
    }
    return val;
}

function evalDepParm(dp: DepParmEntry, ctx: DepEvalContext): boolean {
    // Dep comparisons run on internal (MapTo) values.
    const val = toInternal(ctx, dp.kwd, ctx.getValue(dp.kwd));
    if (dp.rel === "SPCFD") {
        return isParmSpecified(ctx.form, dp.kwd, ctx.dftLookup);
    }
    if (dp.cmpKwd) {
        return compareDepValues(val, dp.rel, toInternal(ctx, dp.cmpKwd, ctx.getValue(dp.cmpKwd)));
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
                const val = toInternal(ctx, dep.ctlKwd, ctx.getValue(dep.ctlKwd));
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
    const ctlVal = toInternal(ctx, group.ctlKwd, ctlRaw);
    let trueCount = 0;
    for (const cond of group.conds) {
        let met: boolean;
        if (cond.rel === "SPCFD") {
            // Default-aware: a field still holding its default is NOT specified.
            met = isParmSpecified(ctx.form, group.ctlKwd, ctx.dftLookup);
        } else if (cond.rel === "UNSPCFD") {
            met = !isParmSpecified(ctx.form, group.ctlKwd, ctx.dftLookup);
        } else {
            const cmp = resolveHexLiteral(cond.cmpVal ?? "");
            met = compareDepValues(ctlVal === "" ? " " : ctlVal, cond.rel, cmp);
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
    /** Existing command text to populate the form from (round-trip). */
    initialCommandText?: string,
): void {
    container.innerHTML = "";
    container.hidden = false;

    const head = document.createElement("div");
    head.className = "prompter-head";
    const title = document.createElement("span");
    title.className = "prompter-title";
    title.textContent = `${cmd.name}${cmd.library ? ` (${cmd.library})` : ""} — ${cmd.prompt}`;
    head.appendChild(title);
    // <xml> button (top-right): copies the raw command XML to the clipboard.
    if (callbacks.cmdXml) {
        const xmlBtn = document.createElement("button");
        xmlBtn.type = "button";
        xmlBtn.className = "btn prompter-xml";
        xmlBtn.textContent = "<xml>";
        xmlBtn.title = t("prompter.copyXml", "Copy command XML to clipboard");
        xmlBtn.addEventListener("click", () => {
            void navigator.clipboard.writeText(callbacks.cmdXml ?? "").then(() => {
                xmlBtn.textContent = t("prompter.xmlCopied", "Copied!");
                setTimeout(() => { xmlBtn.textContent = "<xml>"; }, 1200);
            });
        });
        head.appendChild(xmlBtn);
    }
    // The command string being built lives in the header (top, always
    // visible) — not at the bottom of a scrolled form.
    const preview = document.createElement("code");
    preview.className = "prompter-preview";
    head.appendChild(preview);
    // Error banner also pinned in the header so validation failures can't
    // hide below the fold of the scrollable form.
    const banner = document.createElement("div");
    banner.className = "prompter-error-banner";
    banner.hidden = true;
    head.appendChild(banner);
    container.appendChild(head);

    const form = document.createElement("div");
    form.className = "prompter-form";
    container.appendChild(form);

    const getValue = (kwd: string): string => {
        const node = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `.prompter-input[data-kwd="${kwd}"]`,
        );
        if (node) return node.value?.trim() ?? "";
        // Container parms (QUAL/ELEM) have no direct input: proxy on the
        // first child (extension getFieldRawValue QUAL0/instance fallback).
        const child = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `.prompter-input[data-kwd="${kwd}.0"]`,
        );
        return child?.value?.trim() ?? "";
    };

    // Default lookup for SPCFD "specified" checks: kwd → Dft. Container
    // children are keyed PARENT.INDEX (e.g. OUTQ.0).
    const dftLookup = (kwd: string): string | undefined => {
        const [parent, childIdx] = kwd.split(".");
        const parm = cmd.parms.find((p) => p.kwd.toUpperCase() === parent.toUpperCase());
        if (childIdx === undefined) return parm?.dft;
        return parm?.children[Number(childIdx)]?.dft;
    };

    const depCtx: DepEvalContext = {
        form,
        getValue,
        dftLookup,
        resolveToInternal: (kwd, val) => resolveValToInternal(cmd.valToInternal, kwd, val),
        showAllParms: false,
    };

    // Touched-field tracking (extension parity): input/change on any
    // .prompter-input marks its base keyword. Dep constraints are evaluated at
    // submit (validateAll) regardless of touch — atSubmit semantics only.
    const touchedFields = new Set<string>();

    const applyDependencies = () => {
        // PmtCtl controls visibility; Dep violations surface in the banner on
        // submit, not as hidden fields. Covers both simple fields and
        // QUAL/ELEM group containers (both carry data-parm-kwd).
        for (const wrap of Array.from(form.querySelectorAll<HTMLElement>(".prompter-field[data-parm-kwd], .prompter-group[data-parm-kwd], .prompter-qual-band[data-parm-kwd]"))) {
            const kwd = wrap.dataset.parmKwd ?? "";
            const base = kwd.split(".")[0];
            wrap.hidden = !isParmVisible(cmd.pmtCtl.get(base), base, depCtx);
        }
    };

    const ctx: FieldCtx = { cmd, getValue, applyDependencies, onPromptNested: callbacks.onPromptNested, touched: touchedFields };

    // Render in sorted parm order — containers stay inline at their position
    // instead of being pushed to the bottom of the form.
    const renderContainerChild = (c: ParmDescriptor, child: ParmDescriptor, formDft: string | undefined, idx: number): HTMLElement => {
        const childCtx: FieldCtx = {
            cmd,
            getValue,
            applyDependencies,
            onPromptNested: callbacks.onPromptNested,
            touched: touchedFields,
        };
        const childParm: ParmDescriptor = { ...child, kwd: `${c.kwd}.${child.kwd}`, dft: formDft };
        // First QUAL part doubles as the whole-value slot (type *SAME etc.
        // there). MERGE the parent's value set with the part's own (deduped) —
        // part 0 can carry its own SpcVal too — and show the parent's
        // whole-value Choice text with the part's type word when it has one.
        if (idx === 0 && c.isQual && c.sngVals.length > 0) {
            const seen = new Set(childParm.sngVals.map((s) => s.toUpperCase()));
            for (const v of c.sngVals) {
                if (!seen.has(v.toUpperCase())) {
                    seen.add(v.toUpperCase());
                    childParm.sngVals.push(v);
                }
            }
            if (c.choice) {
                childParm.choice = childParm.choice
                    ? `${childParm.choice}, ${c.choice}`
                    : c.choice;
            }
        }
        return inputForParm(childParm, childCtx);
    };

    const renderContainer = (c: ParmDescriptor): HTMLElement => {
        // div, not fieldset: WebKit drops the top border right of a <legend>
        // when the fieldset is display:flex. A heading in normal flow gives the
        // same look without the rendering quirk.
        const box = document.createElement("div");
        box.className = "prompter-group";
        // PmtCtl/applyDependencies hides whole containers by this key.
        box.dataset.parmKwd = c.kwd;
        const legend = document.createElement("div");
        legend.className = "prompter-group-title";
        // Same label format as simple parms: "Prompt text (KWD)".
        legend.textContent = c.prompt
            ? `${c.prompt} (${c.kwd})`
            : `${c.isQual ? t("prompter.qualifiedName", "Qualified name") : t("prompter.list", "List")} (${c.kwd})`;
        box.appendChild(legend);
        // ELEM form defaults (extension getElemFormDefault parity): explicit
        // Dft wins; then the parent composite Dft ("KWD(v1 v2)" / "(v1 v2)")
        // split per part; then, for restricted children, the first allowed
        // value.
        let compositeParts: string[] = [];
        if (c.isElem && c.dft) {
            let s = c.dft.trim();
            const km = s.match(/^[A-Z][A-Z0-9]*\(/i);
            if (km) s = s.substring(km[0].length - 1);
            if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
            compositeParts = s.split(/\s+/);
        }
        let elemIdx = 0;
        for (const child of c.children) {
            let formDft = child.dft;
            if (c.isElem) {
                const i = elemIdx++;
                if (formDft === undefined && i < compositeParts.length) {
                    formDft = compositeParts[i] || undefined;
                }
                if (formDft === undefined && child.rstd) {
                    const first = firstAllowedValue(child);
                    if (first) formDft = first;
                }
            }
            box.appendChild(renderContainerChild(c, child, formDft, c.children.indexOf(child)));
        }
        return box;
    };

    // QUAL-only parms (no nested ELEM/QUAL parts) render as plain inline
    // fields — no fieldset box. A shaded band groups the parts visually
    // (replaces the box). ELEM blocks keep the box: the parent parm owns the
    // composite value semantics.
    const isInlineQual = (c: ParmDescriptor): boolean =>
        c.isQual && c.children.every((ch) => ch.children.length === 0);

    for (const p of cmd.parms) {
        if (p.type && isContainerType(p.type)) {
            if (isInlineQual(p)) {
                const band = document.createElement("div");
                band.className = "prompter-qual-band";
                // PmtCtl hides the band with its parts (base keyword).
                band.dataset.parmKwd = p.kwd;
                p.children.forEach((child, i) => band.appendChild(renderContainerChild(p, child, child.dft, i)));
                form.appendChild(band);
                continue;
            }
            form.appendChild(renderContainer(p));
            continue;
        }
        form.appendChild(inputForParm(p, ctx));
    }

    const actions = document.createElement("div");
    actions.className = "prompter-actions";
    const update = () => {
        preview.textContent = buildCommand(cmdInput, form, cmd, touchedFields);
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
        if (errors.length > 0) {
            // Don't fail silently: banner into view, first bad field focused.
            // (jsdom lacks scrollIntoView; optional call keeps tests clean.)
            banner.scrollIntoView?.({ block: "nearest" });
            const firstBad = form.querySelector<HTMLElement>(".prompter-field.has-error .prompter-input");
            firstBad?.focus();
        }
        return errors.length === 0;
    };

    // Footer: Enter writes the built command back to the caller and closes;
    // Cancel just closes. No separate Run — the caller decides what to do
    // with the string (write to editor; nested prompts write into the parent
    // CMD/CMDSTR field).
    const enterBtn = document.createElement("button");
    enterBtn.className = "btn primary";
    enterBtn.textContent = t("prompter.enter", "Enter");
    const submitForm = () => {
        if (!validateAll()) return;
        callbacks.onRun(preview.textContent || cmdInput);
    };
    enterBtn.addEventListener("click", submitForm);

    // Enter inside a field: submit like the Enter button — but when the entry
    // flips a PmtCtl/Dep visibility condition (the form the user is looking
    // at would change under them) or produces errors, stay on the form and
    // surface the change instead.
    const visibilitySignature = (): string =>
        Array.from(form.querySelectorAll<HTMLElement>(".prompter-field[data-parm-kwd], .prompter-group[data-parm-kwd]"))
            .map((el) => `${el.dataset.parmKwd}:${el.hidden ? 0 : 1}`)
            .join("|");
    form.addEventListener("keydown", (ev: KeyboardEvent) => {
        if (ev.key !== "Enter") return;
        const target = ev.target as HTMLElement;
        if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) return;
        // Textareas keep Enter for newlines.
        ev.preventDefault();
        const before = visibilitySignature();
        applyDependencies();
        if (visibilitySignature() !== before) {
            // Conditional prompt change — show the new form, don't submit.
            return;
        }
        submitForm();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn";
    cancelBtn.textContent = t("prompter.cancel", "Cancel");
    cancelBtn.addEventListener("click", () => {
        container.hidden = true;
        callbacks.onClose();
    });

    actions.appendChild(enterBtn);
    actions.appendChild(cancelBtn);
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
    if (initialCommandText) populateFromCommandText(form, cmd, initialCommandText);
    applyDependencies();
    update();
}

function flattenLeaf(v: unknown): string {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(flattenLeaf).join("/");
    return "";
}

/** Walk parsed values and set matching inputs; returns kwds that were set. */
function applyParsedValues(form: HTMLElement, values: Record<string, unknown>): void {
    const setInput = (kwd: string, value: string) => {
        const el = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            `.prompter-input[data-kwd="${kwd}"]`,
        );
        if (!el) return;
        if (el instanceof HTMLSelectElement) {
            // Select the matching option if present (case-insensitive); else
            // leave as-is — restricted selects can't hold unlisted values.
            const match = Array.from(el.options).find((o) => o.value.toUpperCase() === value.toUpperCase());
            if (match) el.value = match.value;
        } else {
            el.value = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
    };

    for (const [kwd, raw] of Object.entries(values)) {
        const instances: unknown[] = Array.isArray(raw) ? raw : [raw];
        // Multi-instance simple parms: [[v1],[v2]] → first input gets v1;
        // extra instances need "+" rows, which don't exist yet — set first
        // instance and leave a console note (multi-instance populate TODO).
        const first = instances[0];
        if (Array.isArray(first)) {
            // Container or array-wrapped simple: each element maps to KWD.N
            if (first.length === 1 && typeof first[0] === "string") {
                setInput(kwd, first[0]);
                continue;
            }
            first.forEach((part, idx) => {
                setInput(`${kwd}.${idx}`, flattenLeaf(part));
            });
        } else if (typeof first === "string") {
            setInput(kwd, first);
        }
    }
}

/** Public entry: parse an existing command string into the form. */
export function populateFromCommandText(form: HTMLElement, cmd: CmdDescriptor, commandText: string): void {
    const metas = extractParmMetasFromCmd(cmd);
    // Leading positional values (DSPOBJD QIWS/QCUSTCDT *FILE) are rewritten to
    // KWD(value) form first — IBM i binds them by PARM arrival order (capped at
    // MaxPos), not PosNbr. Keyword-only and label-prefixed commands pass through.
    const rewritten = rewritePositionalParms(commandText, cmd.parms, cmd.maxPos);
    const parsed = parseCLParms(rewritten, metas);
    // parseCLParms keys echo the source text's case ("output(...)" → "output");
    // canonicalize to the meta's Kwd so they match the form's data-kwd casing.
    const canonicalKwd = new Map(metas.map((m) => [m.Kwd.toUpperCase(), m.Kwd]));
    const values: Record<string, unknown> = {};
    for (const [kwd, v] of Object.entries(parsed)) {
        values[canonicalKwd.get(kwd.toUpperCase()) ?? kwd] = v;
    }
    applyParsedValues(form, values);
}

/** Rebuild ParmMeta[] from a CmdDescriptor (parseCLParms needs the meta list). */
function extractParmMetasFromCmd(cmd: CmdDescriptor) {
    return cmd.parms.map((p) => ({
        Kwd: p.kwd,
        Type: p.type,
        Max: p.max,
        Case: p.caseMixed ? "MIXED" : undefined,
        Quals: p.isQual ? p.children.map((c) => ({ Prompt: c.prompt, Type: c.type })) : undefined,
        Elems: p.isElem ? p.children.map((c) => ({ Prompt: c.prompt, Type: c.type })) : undefined,
        PosNbr: p.posNbr,
    }));
}

export function buildCommand(cmdInput: string, form: HTMLElement, cmd: CmdDescriptor, touched?: Set<string>): string {
    const parts: string[] = [cmdInput.trim().split(/\s+/)[0] || cmd.name];
    const values = new Map<string, string[]>();

    // A field's default: its recorded prefill (dataset.default), else the
    // parm/child Dft from the descriptor for hand-built forms.
    const dftOf = (el: HTMLElement): string | undefined => {
        const dd = el.dataset.default;
        if (dd !== undefined) return dd === "" ? undefined : dd;
        const kwd = el.dataset.kwd ?? "";
        const [parent, childIdx] = kwd.split(".");
        const parm = cmd.parms.find((p) => p.kwd.toUpperCase() === parent.toUpperCase());
        if (!parm) return undefined;
        if (childIdx === undefined || childIdx === "") return parm.dft;
        return parm.children[Number(childIdx)]?.dft;
    };

    // Two-pass for containers: collect ALL visible child inputs (even at
    // default), because once a later part is specified, every earlier part
    // must emit its current value to keep the positional slots aligned
    // (LOG(*SAME *SAME *SECLVL) — not LOG(*SECLVL)).
    const childInputs = new Map<string, { el: HTMLElement; value: string; dft: string | undefined }[]>();
    for (const el of Array.from(form.querySelectorAll<HTMLElement>(".prompter-input[data-kwd]"))) {
        // Skip hidden fields AND hidden group containers (PmtCtl-hidden
        // containers must not emit).
        const wrap = el.closest<HTMLElement>(".prompter-field");
        const group = el.closest<HTMLElement>(".prompter-group");
        if (wrap?.hidden || group?.hidden) continue;
        if (el.closest(".prompter-field")?.hasAttribute("hidden")) continue;
        const kwd = el.dataset.kwd ?? "";
        const value = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).value?.trim() ?? "";
        if (!kwd) continue;
        if (kwd.includes(".")) {
            const parent = kwd.split(".")[0];
            const arr = childInputs.get(parent) ?? [];
            arr.push({ el, value, dft: dftOf(el) });
            childInputs.set(parent, arr);
            continue;
        }
        if (!value) continue;
        // Defaults are not emitted: KWD(default) adds nothing to the command.
        const dft = dftOf(el);
        if (dft !== undefined && value === dft) continue;
        const list = values.get(kwd) ?? [];
        list.push(value);
        values.set(kwd, list);
    }

    // Container emission: parts sorted by index; emit up to the last part
    // that is "set": filled and (non-default OR the container was touched —
    // touched = user typed or round-trip populate wrote it, i.e. its current
    // values are semantically part of the command even when they equal the
    // default). Everything before that index emits its CURRENT value.
    for (const [parent, arr] of childInputs) {
        const sorted = [...arr].sort(
            (a, b) => Number(a.el.dataset.kwd?.split(".")[1]) - Number(b.el.dataset.kwd?.split(".")[1]),
        );
        const wasTouched = touched?.has(parent.toUpperCase()) ?? false;
        const isSet = (c: { value: string; dft: string | undefined }) =>
            c.value !== "" && (wasTouched || !(c.dft !== undefined && c.value === c.dft));
        let lastSet = -1;
        sorted.forEach((c, i) => { if (isSet(c)) lastSet = i; });
        if (lastSet < 0) continue;
        const vals = sorted.slice(0, lastSet + 1).map((c) => c.value);
        values.set(parent + "\u0000container", vals); // keyed apart from child kwds
    }

    const emitted = new Set<string>();
    for (const el of Array.from(form.querySelectorAll<HTMLElement>(".prompter-input[data-kwd]"))) {
        const wrap = el.closest<HTMLElement>(".prompter-field");
        const group = el.closest<HTMLElement>(".prompter-group");
        if (wrap?.hidden || group?.hidden) continue;
        const kwd = el.dataset.kwd ?? "";
        if (!kwd) continue;
        if (kwd.includes(".")) {
            const parent = kwd.split(".")[0];
            if (emitted.has(parent)) continue;
            const parentParm = cmd.parms.find((p) => p.kwd.toUpperCase() === parent.toUpperCase());
            const vals = values.get(parent + "\u0000container") ?? [];
            const out = parentParm?.isQual ? [...vals].reverse() : vals;
            if (out.length) {
                const sep = parentParm?.isQual ? "/" : " ";
                parts.push(`${parent}(${out.map(quoteCL).join(sep)})`);
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
