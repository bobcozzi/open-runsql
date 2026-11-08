// CL prompter model: parses QCDRCMDD CMDD0200 XML into renderable parameter
// descriptors and serializes form values back to a CL command string.
// Browser-native DOMParser; no VS Code dependencies.
//
// Ported attribute/validation surface from cozzi-cl-prompter prompter.ts:
// SpcVal/SngVal/Values (with _RANGE_/_REL_/_DEPREL_ pseudo-value filtering),
// Range/Rel/RelKwd/Full/Rstd/DspInput/Case/AlwVar/RtnVal/Expr/InlPmtLen,
// QUAL reverse-order part mapping, nested ELEM, Min/Max.

import { extractParmMetas } from "./parseCL";
import { isContainerType } from "./promptHelpers";
import type { ParmMeta } from "./types";

export interface ParmChoice {
    value: string;
    text?: string;
}

export interface RelConstraint {
    op: "EQ" | "NE" | "GT" | "GE" | "LT" | "LE" | "NG" | "NL";
    /** literal value, or @KWD to compare against another parm */
    value: string;
    kwd?: string;
}

export interface ParmDescriptor {
    kwd: string;
    prompt: string;
    type?: string;
    len?: number;
    /** Display width (InlPmtLen) when smaller than storage Len. */
    inlPmtLen?: number;
    dft?: string;
    min: number;          // 1 = required
    max: number;
    posNbr?: number;
    /** Rstd=YES: value must come from choices/single values. */
    rstd: boolean;
    choices: ParmChoice[]; // SpcVal/Values displayable entries (pseudo-values stripped)
    /** SngVal: mutually exclusive single values. */
    sngVals: string[];
    full: boolean;        // Full=YES: exact length required
    alwVar: boolean;      // AlwVar=NO: reject &VARIABLE
    rtnVal: boolean;      // RtnVal=YES: require &VARIABLE
    exprOk: boolean;      // Expr=YES: expression values bypass static checks
    caseMixed: boolean;   // Case=MIXED: don't uppercase
    dspInput: boolean;    // DspInput=NO: password-style masking
    rangeMin?: number;
    rangeMax?: number;
    rangeMinKwd?: string;
    rangeMaxKwd?: string;
    rel?: RelConstraint[];
    isQual: boolean;
    isElem: boolean;
    children: ParmDescriptor[]; // QUAL parts / ELEM rows (recursive)
}

export interface DepParmEntry {
    kwd: string;
    rel: string;      // EQ, NE, GT, LT, GE, LE, NL, NG, SPCFD
    cmpVal?: string;  // literal internal value to compare against
    cmpKwd?: string;  // keyword of another parameter to compare against
}

export interface DepConstraint {
    ctlKwdRel: string;  // ALWAYS, EQ, NE, SPCFD
    ctlKwd?: string;    // controlling keyword (absent when ALWAYS)
    cmpVal?: string;    // internal value to compare ctlKwd against
    nbrTrueRel: string; // GT, GE, EQ, LE, LT, NE, ALL
    nbrTrue: number;    // threshold count
    msgId: string;      // e.g. "CPD2830"
    depParms: DepParmEntry[];
}

export interface PmtCtlCond {
    rel: string;     // EQ, NE, GT, LT, GE, LE, NL, NG, SPCFD, UNSPCFD
    cmpVal?: string; // absent for SPCFD/UNSPCFD
}

export interface PmtCtlGroup {
    ctlKwd: string;
    nbrTrueRel: string; // EQ, NE, GT, LT, GE, LE, NL, NG, ALL
    nbrTrue: number;
    lglRel?: string;    // AND | OR (relation to previous group)
    conds: PmtCtlCond[];
}

/** Parm visibility: PMTCTL groups; PMTRQS = show only when user supplied a value. */
export interface PmtCtlEntry {
    kind: "PMTCTL" | "PMTRQS";
    groups: PmtCtlGroup[];
}

export interface CmdDescriptor {
    name: string;
    library?: string;
    prompt: string;
    maxPos: number;
    parms: ParmDescriptor[];
    deps: DepConstraint[];
    /** kwd → visibility rule, for parms carrying a PmtCtl attribute. */
    pmtCtl: Map<string, PmtCtlEntry>;
}

function childElements(el: Element, name: string): Element[] {
    const out: Element[] = [];
    for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 1 && (n as Element).tagName.toUpperCase() === name.toUpperCase()) {
            out.push(n as Element);
        }
    }
    return out;
}

function attr(el: Element, name: string): string | undefined {
    const v = el.getAttribute(name);
    return v == null || v === "" ? undefined : v;
}

function yesAttr(el: Element, name: string): boolean {
    const v = (attr(el, name) ?? "").toUpperCase();
    return v === "YES" || v === "1" || v === "TRUE";
}

function noAttr(el: Element, name: string): boolean {
    const v = (attr(el, name) ?? "").toUpperCase();
    return v === "NO" || v === "0" || v === "FALSE";
}

function intAttr(el: Element, name: string, dft: number): number {
    const v = attr(el, name);
    if (v == null) return dft;
    const n = Number(v);
    return Number.isFinite(n) ? n : dft;
}

function numAttr(el: Element, name: string): number | undefined {
    const v = attr(el, name);
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

/** Pseudo-values the host embeds in choice lists: not displayable choices. */
const PSEUDO_VALUE_PREFIXES = ["_RANGE_", "_REL_", "_RELKWD_", "_DEPREL_", "_RANGEMINKWD_", "_RANGEMAXKWD_"];
export function isPseudoValue(v: string): boolean {
    const up = v.toUpperCase();
    return PSEUDO_VALUE_PREFIXES.some((p) => up.startsWith(p));
}

/** SpcVal + Values>Value, displayable entries only, plus SngVal separately.
    IBM XML wraps values: <SpcVal><Value Val="..." ValTxt="..."/></SpcVal>. */
function extractChoices(parmEl: Element): { choices: ParmChoice[]; sngVals: string[] } {
    const choices: ParmChoice[] = [];
    const sngVals: string[] = [];
    const choiceFrom = (v: Element): ParmChoice | undefined => {
        const val = attr(v, "Val");
        if (val == null || isPseudoValue(val)) return undefined;
        return { value: val, text: attr(v, "ValTxt") ?? attr(v, "Prompt") };
    };
    const addChoice = (v: Element) => {
        const c = choiceFrom(v);
        if (c) choices.push(c);
    };
    const addSng = (v: Element) => {
        const c = choiceFrom(v);
        if (c) sngVals.push(c.value);
    };
    for (const spc of childElements(parmEl, "SpcVal")) {
        const kids = childElements(spc, "Value");
        if (kids.length) kids.forEach(addChoice);
        else addChoice(spc); // flat form: <SpcVal Val="..."/>
    }
    for (const sng of childElements(parmEl, "SngVal")) {
        const kids = childElements(sng, "Value");
        if (kids.length) kids.forEach(addSng);
        else addSng(sng);
    }
    for (const values of childElements(parmEl, "Values")) {
        for (const v of childElements(values, "Value")) addChoice(v);
    }
    return { choices, sngVals };
}

function extractRelConstraints(el: Element): RelConstraint[] | undefined {
    const out: RelConstraint[] = [];
    const rel = attr(el, "Rel");
    const relVal = attr(el, "RelVal");
    const relKwd = attr(el, "RelKwd");
    if (rel && relVal != null) {
        out.push({ op: rel.toUpperCase() as RelConstraint["op"], value: relVal });
    }
    if (rel && relKwd != null) {
        out.push({ op: rel.toUpperCase() as RelConstraint["op"], value: "", kwd: relKwd });
    }
    return out.length ? out : undefined;
}

function describeElement(el: Element, meta?: { Prompt?: string; Type?: string }, parent?: { choices: ParmChoice[]; sngVals: string[] }): ParmDescriptor {
    const own = extractChoices(el);
    // Choice metadata on a container parent applies to single-field children
    // (e.g. CHGJOB LOG: ELEM Len=1 children inherit the parent's SpcVal list).
    const choices = own.choices.length ? own.choices : (parent?.choices ?? []);
    const sngVals = own.sngVals.length ? own.sngVals : (parent?.sngVals ?? []);
    const type = attr(el, "Type") ?? meta?.Type;
    const isContainer = type != null && isContainerType(type);
    return {
        kwd: "",
        prompt: attr(el, "Prompt") ?? meta?.Prompt ?? "",
        type,
        len: intAttr(el, "Len", 0) || undefined,
        inlPmtLen: intAttr(el, "InlPmtLen", 0) || undefined,
        dft: attr(el, "Dft"),
        min: intAttr(el, "Min", 0),
        max: intAttr(el, "Max", 1),
        rstd: yesAttr(el, "Rstd"),
        choices,
        sngVals,
        full: yesAttr(el, "Full"),
        alwVar: !noAttr(el, "AlwVar"),
        rtnVal: yesAttr(el, "RtnVal"),
        exprOk: yesAttr(el, "Expr"),
        caseMixed: (attr(el, "Case") ?? "").toUpperCase() === "MIXED",
        dspInput: !noAttr(el, "DspInput"),
        rangeMin: numAttr(el, "RangeMinVal"),
        rangeMax: numAttr(el, "RangeMaxVal"),
        rangeMinKwd: attr(el, "RangeMinKwd"),
        rangeMaxKwd: attr(el, "RangeMaxKwd"),
        rel: extractRelConstraints(el),
        isQual: type === "QUAL",
        isElem: type === "ELEM",
        children: isContainer ? describeContainerChildren(el) : [],
    };
}

function describeContainerChildren(parmEl: Element): ParmDescriptor[] {
    const out: ParmDescriptor[] = [];
    const parentPrompt = attr(parmEl, "Prompt") ?? "";
    const parentChoices = extractChoices(parmEl);
    const parentDft = attr(parmEl, "Dft");
    // QUAL parts render in XML document order (object name, then library);
    // the reversal happens only when assembling the output string.
    const qualEls = childElements(parmEl, "QUAL");
    for (let i = 0; i < qualEls.length; i++) {
        const d = describeElement(qualEls[i], undefined, parentChoices);
        d.kwd = `${i}`; // part index in document order
        if (i === 0) {
            // First part inherits the parent's Dft when it's one of the
            // parent's SngVals (JOB(*) style: whole value is a special value).
            if (!d.dft && parentDft && parentChoices.sngVals.some((s) => s.toUpperCase() === parentDft.toUpperCase())) {
                d.dft = parentDft;
            }
            if (!d.prompt) d.prompt = parentPrompt;
        }
        out.push(d);
    }
    for (const e of childElements(parmEl, "ELEM")) {
        const d = describeElement(e, undefined, parentChoices);
        d.kwd = "";
        out.push(d);
    }
    return out;
}

// Display rules ported from prompter.ts / promptHelpers.ts:
// skip Constant parms, NULL-type parms, and internal constant ELEM shells.
function isDisplayableParm(el: Element, meta: ParmMeta): boolean {
    const type = (attr(el, "Type") ?? meta.Type ?? "").toUpperCase();
    if (type === "NULL") return false;
    if (attr(el, "Constant") != null) return false;
    if (isContainerType(type) && type === "ELEM") {
        const hasPosNbr = attr(el, "PosNbr") != null;
        const hasPrompt = (attr(el, "Prompt") ?? "").trim().length > 0;
        if (!hasPosNbr && !hasPrompt) {
            const elems = childElements(el, "ELEM");
            if (elems.length > 0 && elems.every((e) => {
                if (attr(e, "Constant") == null) return false;
                if (childElements(e, "ELEM").length > 0 || childElements(e, "QUAL").length > 0) return false;
                if ((attr(e, "Prompt") ?? "").trim().length > 0) return false;
                if (attr(e, "DspInput") != null || attr(e, "Choice") != null) return false;
                return true;
            })) {
                return false;
            }
        }
    }
    return true;
}

export function parseCmdXml(xml: string): CmdDescriptor {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const cmdEls = doc.getElementsByTagName("Cmd");
    if (!cmdEls.length) throw new Error("No Cmd element in command XML");
    const cmdEl = cmdEls[0];

    const parmEls = new Map<string, Element>();
    for (const p of Array.from(doc.getElementsByTagName("Parm"))) {
        const kwd = p.getAttribute("Kwd") ?? "";
        if (kwd) parmEls.set(kwd.toUpperCase(), p);
    }

    const deps: DepConstraint[] = [];
    for (const dep of Array.from(cmdEl.getElementsByTagName("Dep"))) {
        const depParms: DepParmEntry[] = [];
        for (const dp of Array.from(dep.getElementsByTagName("DepParm"))) {
            const kwd = attr(dp, "Kwd");
            const rel = attr(dp, "Rel");
            if (!kwd || !rel) continue;
            const entry: DepParmEntry = { kwd, rel: rel.toUpperCase() };
            const cv = attr(dp, "CmpVal");
            if (cv !== undefined) entry.cmpVal = cv;
            const ck = attr(dp, "CmpKwd");
            if (ck) entry.cmpKwd = ck;
            depParms.push(entry);
        }
        if (depParms.length > 0) {
            deps.push({
                ctlKwdRel: (attr(dep, "CtlKwdRel") ?? "ALWAYS").toUpperCase(),
                ctlKwd: attr(dep, "CtlKwd"),
                cmpVal: attr(dep, "CmpVal"),
                nbrTrueRel: (attr(dep, "NbrTrueRel") ?? "GT").toUpperCase(),
                nbrTrue: intAttr(dep, "NbrTrue", 0),
                msgId: attr(dep, "MsgID") ?? "",
                depParms,
            });
        }
    }
    // PmtCtl visibility: keyed by the CONTROLLED parm's Kwd. PMTCTL groups
    // evaluate against the controlling parm's value; PMTRQS parms show only
    // when the user has supplied a value.
    const pmtCtl = new Map<string, PmtCtlEntry>();
    for (const p of Array.from(doc.getElementsByTagName("Parm"))) {
        const attrVal = p.getAttribute("PmtCtl");
        if (attrVal !== "PMTCTL" && attrVal !== "PMTRQS") continue;
        const kwd = p.getAttribute("Kwd");
        if (!kwd) continue;
        if (attrVal === "PMTRQS") {
            pmtCtl.set(kwd, { kind: "PMTRQS", groups: [] });
            continue;
        }
        const groups: PmtCtlGroup[] = [];
        for (const el of Array.from(p.getElementsByTagName("PmtCtl"))) {
            const ctlKwd = el.getAttribute("CtlKwd");
            if (!ctlKwd) continue;
            const conds: PmtCtlCond[] = [];
            for (const cond of Array.from(el.getElementsByTagName("PmtCtlCond"))) {
                const rel = cond.getAttribute("Rel");
                const cmpVal = cond.getAttribute("CmpVal");
                if (rel !== null && (cmpVal !== null || rel === "SPCFD" || rel === "UNSPCFD")) {
                    conds.push(cmpVal !== null ? { rel: rel.toUpperCase(), cmpVal } : { rel: rel.toUpperCase() });
                }
            }
            groups.push({
                ctlKwd,
                nbrTrueRel: (el.getAttribute("NbrTrueRel") ?? "EQ").toUpperCase(),
                nbrTrue: Number.parseInt(el.getAttribute("NbrTrue") ?? "1", 10) || 1,
                lglRel: el.getAttribute("LglRel") ?? undefined,
                conds,
            });
        }
        if (groups.length > 0) pmtCtl.set(kwd, { kind: "PMTCTL", groups });
    }

    const metas = extractParmMetas(xml);
    // Display order follows PosNbr (positional parms first, unnumbered parms
    // last in document order) — same as the extension's loadForm sort.
    const posOf = (meta: ParmMeta): number => {
        const el = parmEls.get(meta.Kwd.toUpperCase());
        const raw = el?.getAttribute("PosNbr");
        const n = raw != null ? Number(raw) : Number.NaN;
        return Number.isFinite(n) && n > 0 ? n : 9999;
    };
    const ordered = metas
        .map((m, i) => ({ m, i, pos: posOf(m) }))
        .sort((a, b) => a.pos - b.pos || a.i - b.i);
    const parms: ParmDescriptor[] = [];
    for (const { m: meta } of ordered) {
        const el = parmEls.get(meta.Kwd.toUpperCase());
        if (el && !isDisplayableParm(el, meta)) continue;
        const d = el ? describeElement(el, undefined) : ({} as ParmDescriptor);
        d.kwd = meta.Kwd;
        if (!d.prompt) d.prompt = meta.Quals?.[0]?.Prompt ?? meta.Elems?.[0]?.Prompt ?? meta.Kwd;
        if (!d.type) d.type = meta.Type;
        d.min = el ? intAttr(el, "Min", 0) : 0;
        d.max = meta.Max ?? (el ? intAttr(el, "Max", 1) : 1);
        d.posNbr = el ? intAttr(el, "PosNbr", 0) || undefined : meta.PosNbr;
        if (el && d.children.length === 0 && (meta.Quals?.length || meta.Elems?.length)) {
            d.children = describeContainerChildren(el);
        }
        parms.push(d);
    }

    return {
        name: attr(cmdEl, "CmdName") ?? "",
        library: attr(cmdEl, "CmdLib"),
        prompt: attr(cmdEl, "Prompt") ?? "",
        maxPos: intAttr(cmdEl, "MaxPos", 0),
        parms,
        deps,
        pmtCtl,
    };
}

// --- Command string assembly ---

function quoteCL(v: string): string {
    if (/^'.*'$/.test(v)) return v;
    if (/\s|[(),]/.test(v)) return `'${v.replace(/'/g, "''")}'`;
    return v;
}

export function buildCommandString(cmdName: string, values: Map<string, string>): string {
    const parts: string[] = [cmdName];
    for (const [kwd, raw] of values) {
        const value = raw.trim();
        if (!value) continue;
        if (kwd.includes(".")) continue; // containers assembled by caller
        parts.push(`${kwd}(${quoteCL(value)})`);
    }
    return parts.join(" ");
}
