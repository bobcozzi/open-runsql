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

import { isContainerType } from "./promptHelpers";
import type { CmdDescriptor, DepConstraint, ParmDescriptor, PmtCtlCond } from "./prompterModel";
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
    if (p.full && p.len) parts.push(`exactly ${p.len} chars`);
    else if (p.len) parts.push(`max ${p.len} chars`);
    if (p.rangeMin != null || p.rangeMax != null) {
        parts.push(`${p.rangeMin ?? ""} to ${p.rangeMax ?? ""}`.trim().replace(/^to$/, ""));
    }
    for (const r of p.rel ?? []) {
        parts.push(r.kwd ? `${r.op} ${r.kwd}` : `${r.op} ${r.value}`);
    }
    if (p.sngVals.length) parts.push(`or ${p.sngVals.join("/")} alone`);
    if (p.rtnVal) parts.push("CL variable only");
    if (!p.alwVar) parts.push("no &variable");
    return parts.filter(Boolean).join("; ");
}

function makeErrorSpan(): HTMLSpanElement {
    const span = document.createElement("span");
    span.className = "prompter-error-msg";
    return span;
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
    // Storage length clamps typed input — but never below the longest choice
    // value (CHGJOB LOG: Len=1 with SpcVal *SECLVL must accept 7 chars).
    if (p.len) {
        const longestChoice = [...p.choices, ...p.sngVals.map((s) => ({ value: s }))]
            .reduce((m, c) => Math.max(m, c.value.length), 0);
        const clamp = Math.max(p.len, longestChoice, 1);
        input.maxLength = clamp;
    }
    return input;
}

function inputForParm(p: ParmDescriptor, ctx: FieldCtx): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "prompter-field";
    wrap.dataset.parmKwd = p.kwd;

    const label = document.createElement("label");
    label.className = "prompter-label";
    label.textContent = p.prompt || p.kwd;
    label.title = `${p.kwd}${p.type ? ` — ${p.type}${p.len ? `(${p.len})` : ""}` : ""}${p.min > 0 ? "  (required)" : ""}${p.max > 1 ? `  (up to ${p.max})` : ""}`;
    if (p.min > 0) label.classList.add("required");
    wrap.appendChild(label);

    const fieldCell = document.createElement("div");
    fieldCell.className = "prompter-field-cell";
    wrap.appendChild(fieldCell);

    const name = `parm-${p.kwd}`;

    if (p.choices.length > 0 && p.rstd) {
        const sel = document.createElement("select");
        sel.name = name;
        sel.dataset.kwd = p.kwd;
        sel.className = "prompter-input";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = p.dft ? `(default ${p.dft})` : "";
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
            opt.textContent = `${s} (alone)`;
            sel.appendChild(opt);
        }
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
            opt.textContent = v === "" && p.dft ? `(default ${p.dft})` : v;
            sel.appendChild(opt);
        }
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
            blank.textContent = p.dft ? `(default ${p.dft})` : "";
            sel.appendChild(blank);
            for (const c of [...p.choices, ...p.sngVals.map((s) => ({ value: s, text: undefined as string | undefined }))]) {
                const opt = document.createElement("option");
                opt.value = c.value;
                opt.textContent = c.text ? `${c.value} — ${c.text}` : c.value;
                sel.appendChild(opt);
            }
            const otherOpt = document.createElement("option");
            otherOpt.value = "\u0001OTHER";
            otherOpt.textContent = "Other…";
            sel.appendChild(otherOpt);

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
        promptBtn.textContent = "Prompt…";
        promptBtn.title = "Prompt the command in this field (nested)";
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
        add.title = `Add another value (max ${p.max})`;
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
            remove.title = "Remove this value";
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

function evalDep(dep: DepConstraint, getValue: (k: string) => string): boolean {
    const ctl = getValue(dep.ctlKwd);
    // Dependency active when the control parm has a value; when CtlKwdRel is
    // present it would refine this — basic presence check for now.
    return ctl !== "" && dep.cmpKwd !== "";
}

function evalPmtCtl(pc: PmtCtlCond, getValue: (k: string) => string): boolean {
    return getValue(pc.ctlKwd) !== "";
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
    closeBtn.textContent = "Close";
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

    const applyDependencies = () => {
        // PmtCtl: parms listed as controlled show only when the control parm
        // has a value; Dep drives the same visibility per CMP pair.
        for (const wrap of Array.from(form.querySelectorAll<HTMLElement>(".prompter-field[data-parm-kwd]"))) {
            const kwd = wrap.dataset.parmKwd ?? "";
            let visible = true;
            for (const pc of cmd.pmtCtl) {
                if (pc.ctlKwd && pc.ctlKwd.toUpperCase() !== kwd.toUpperCase()) {
                    // this PmtCtl controls other parms — hide those parms when ctl empty
                    if (!evalPmtCtl(pc, getValue)) visible = false;
                }
            }
            for (const dep of cmd.deps) {
                if (dep.cmpKwd && dep.cmpKwd.toUpperCase() === kwd.toUpperCase()) {
                    if (evalDep(dep, getValue)) visible = false;
                }
            }
            wrap.hidden = !visible;
        }
    };

    const ctx: FieldCtx = { cmd, getValue, applyDependencies, onPromptNested: callbacks.onPromptNested };

    const containers: ParmDescriptor[] = [];
    for (const p of cmd.parms) {
        if (p.type && isContainerType(p.type)) {
            containers.push(p);
            continue;
        }
        form.appendChild(inputForParm(p, ctx));
    }

    for (const c of containers) {
        const box = document.createElement("fieldset");
        box.className = "prompter-group";
        const legend = document.createElement("legend");
        legend.textContent = `${c.kwd} — ${c.prompt || (c.isQual ? "Qualified name" : "List")}`;
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
        form.appendChild(box);
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
        banner.hidden = errors.length === 0;
        banner.textContent = errors.length ? `${errors.length} error(s): ${errors[0]}${errors.length > 1 ? " …" : ""}` : "";
        return errors.length === 0;
    };

    const runBtn = document.createElement("button");
    runBtn.className = "btn primary";
    runBtn.textContent = "Run";
    runBtn.addEventListener("click", () => {
        if (!validateAll()) return;
        callbacks.onRun(preview.textContent || cmdInput);
    });

    const insertBtn = document.createElement("button");
    insertBtn.className = "btn";
    insertBtn.textContent = "Insert into editor";
    insertBtn.addEventListener("click", () => {
        if (!validateAll()) return;
        callbacks.onInsert(preview.textContent || cmdInput);
    });

    actions.appendChild(runBtn);
    actions.appendChild(insertBtn);
    actions.appendChild(preview);
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
