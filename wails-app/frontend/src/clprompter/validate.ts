// CL prompter validation engine — ported from cozzi-cl-prompter prompter.ts:
// Full, Rstd, Range (val + kwd-bounded), Rel/RelKwd, AlwVar/RtnVal, NAME-family,
// Expr bypass, SNGVAL exclusivity, Min-required, CL expression detection.

import { CL_VARIABLE_PATTERN, isValidNameValue } from "./promptHelpers";
import type { ParmDescriptor, RelConstraint } from "./prompterModel";

export interface FieldError {
    kwd: string;
    message: string;
}

/** CL expression detection (%, *CAT/*TCAT/*BCAT, comparison operators). */
export function isCLExpression(val: string): boolean {
    const upper = val.trim().toUpperCase();
    if (!upper) return false;
    if (upper.startsWith("(") && upper.endsWith(")")) return true;
    const namedOps = ["*CAT", "*TCAT", "*BCAT", "*AND", "*OR", "*NOT", "*EQ", "*NE", "*GT", "*GE", "*LT", "*LE", "*NG", "*NL"];
    if (namedOps.some((op) => upper.includes(op))) return true;
    return /%[A-Z][A-Z0-9]*\s*\(/i.test(upper);
}

function isVariable(val: string): boolean {
    return CL_VARIABLE_PATTERN.test(val.trim());
}

const NAME_TYPES = new Set(["NAME", "SNAME", "CNAME", "PNAME", "GENERIC"]);
const NUMERIC_TYPES = new Set(["DEC", "INT2", "INT4", "UINT2", "UINT4"]);

function compareRel(op: string, left: number | string, right: number | string): boolean {
    const ln = typeof left === "number" ? left : Number(left);
    const rn = typeof right === "number" ? right : Number(right);
    const numeric = Number.isFinite(ln) && Number.isFinite(rn) && left !== "" && right !== "";
    const cmp = numeric ? (ln < rn ? -1 : ln > rn ? 1 : 0) : String(left).localeCompare(String(right));
    switch (op.toUpperCase()) {
        case "EQ": return cmp === 0;
        case "NE": return cmp !== 0;
        case "GT": return cmp > 0;
        case "GE": return cmp >= 0;
        case "LT": return cmp < 0;
        case "LE": return cmp <= 0;
        case "NG": return cmp <= 0;
        case "NL": return cmp >= 0;
        default: return true;
    }
}

function checkRel(kwd: string, value: string, rel: RelConstraint, getValue: (k: string) => string): string | undefined {
    const other = rel.kwd != null ? getValue(rel.kwd) : rel.value;
    if (other === "") return undefined; // nothing to compare against yet
    if (!compareRel(rel.op, value, other)) {
        return `${kwd} must be ${rel.op} ${rel.kwd ? `${rel.kwd} (${other})` : other}`;
    }
    return undefined;
}

/**
 * Validate a single field value against its descriptor.
 * getValue resolves other keywords for RelKwd/range-kwd comparisons.
 */
export function validateField(
    parm: ParmDescriptor,
    rawValue: string,
    getValue: (kwd: string) => string = () => "",
): string | undefined {
    const value = rawValue.trim();
    const kwd = parm.kwd;

    // Required
    if (parm.min > 0 && !value) {
        return `${parm.prompt || kwd} is required.`;
    }
    if (!value) return undefined;

    // Expressions bypass static checks when Expr=YES
    if (parm.exprOk && isCLExpression(value)) return undefined;

    // Variables
    if (isVariable(value)) {
        if (!parm.alwVar) return `${kwd} does not allow a CL variable.`;
        return undefined; // variables skip value/length/range checks
    }
    if (parm.rtnVal) {
        return `${kwd} requires a CL variable (e.g. &RESULT).`;
    }

    // Length — Len bounds only plain literals. CL variables already returned
    // above; expressions/%BIFs and choice/single values are exempt regardless
    // of Len (e.g. CHGJOB LOG: Len=1 with *SECLVL; VAR(%SST(&OBJ 11 10)) in a
    // char(10) field). Quoted literals are measured without the quotes.
    const effLen = parm.len ?? 0;
    const literal = /^'.*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : value;
    const isChoiceValue = [...parm.choices.map((c) => c.value), ...parm.sngVals]
        .some((a) => a.toUpperCase() === value.toUpperCase());
    if (effLen > 0 && !isChoiceValue && !isCLExpression(value) && literal.length > effLen) {
        return `${kwd} is limited to ${effLen} characters.`;
    }
    if (parm.full && effLen > 0 && !isChoiceValue && !isCLExpression(value) && literal.length !== effLen) {
        return `${kwd} must be exactly ${effLen} characters (Full=YES).`;
    }

    // Numeric types — a listed special/choice value is valid even on a
    // numeric parm (RUNPTY *SAME MapTo=0: the host maps it; the display
    // value isn't digits).
    if (parm.type && NUMERIC_TYPES.has(parm.type.toUpperCase())) {
        if (!isChoiceValue && !/^[+-]?\d+(\.\d+)?$/.test(value)) {
            return `${kwd} must be numeric.`;
        }
    }

    // NAME-family — hybrid: a listed special/choice value is valid even when
    // it isn't a NAME (CURLIB Dft=*SAME case; extension createParmInput).
    if (parm.type && NAME_TYPES.has(parm.type.toUpperCase())) {
        if (!isChoiceValue && !isValidNameValue(value, effLen || undefined, parm.type)) {
            return `${kwd} is not a valid ${parm.type} name.`;
        }
    }

    // Rstd: value must be among choices or single values
    if (parm.rstd) {
        const allowed = [...parm.choices.map((c) => c.value), ...parm.sngVals];
        if (allowed.length > 0 && !allowed.some((a) => a.toUpperCase() === value.toUpperCase())) {
            return `${kwd} must be one of: ${allowed.join(", ")}`;
        }
    }

    // Range (literal bounds)
    const num = Number(value);
    if (parm.rangeMin != null && Number.isFinite(num) && num < parm.rangeMin) {
        return `${kwd} must be >= ${parm.rangeMin}.`;
    }
    if (parm.rangeMax != null && Number.isFinite(num) && num > parm.rangeMax) {
        return `${kwd} must be <= ${parm.rangeMax}.`;
    }

    // Range (keyword-bounded)
    if (parm.rangeMinKwd) {
        const lo = getValue(parm.rangeMinKwd);
        if (lo !== "" && Number.isFinite(num) && Number.isFinite(Number(lo)) && num < Number(lo)) {
            return `${kwd} must be >= ${parm.rangeMinKwd} (${lo}).`;
        }
    }
    if (parm.rangeMaxKwd) {
        const hi = getValue(parm.rangeMaxKwd);
        if (hi !== "" && Number.isFinite(num) && Number.isFinite(Number(hi)) && num > Number(hi)) {
            return `${kwd} must be <= ${parm.rangeMaxKwd} (${hi}).`;
        }
    }

    // Rel constraints
    for (const rel of parm.rel ?? []) {
        const err = checkRel(kwd, value, rel, getValue);
        if (err) return err;
    }

    return undefined;
}

/**
 * SNGVAL exclusivity: if a single value (e.g. *SAME) is entered alongside
 * other values in a multi-instance parm, that's an error.
 */
export function validateSngValExclusivity(parm: ParmDescriptor, values: string[]): string | undefined {
    if (!parm.sngVals.length || values.length <= 1) return undefined;
    const used = values.map((v) => v.trim()).filter(Boolean);
    const exclusive = used.find((v) => parm.sngVals.some((s) => s.toUpperCase() === v.toUpperCase()));
    if (exclusive && used.length > 1) {
        return `${parm.kwd}: ${exclusive} cannot be combined with other values.`;
    }
    return undefined;
}
