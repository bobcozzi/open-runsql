// Positional (unqualified) CL parameter support for the prompter round-trip.
//
// IBM i binds unnamed (positional) parameter values by the order the PARM
// statements appear in the command source — XML arrival order — NOT by PosNbr,
// which only controls prompt display order. (DCL is the classic case: STG was
// added to the source after LEN/VALUE but given PosNbr=3 for display; a bare
// 3rd positional value still binds to LEN.) Ported from cozzi-cl-prompter's
// getPositionalKwdsFromXMLByArrival + rewriteLeadingPositionalsByList flow.

import { rewriteLeadingPositionalsByList } from "./tokenizeCL";

/** Structural minimum needed for positional binding (ParmDescriptor satisfies it). */
export interface PositionalParm {
    kwd: string;
    /** PosNbr from the XML; parms without it are not positional-eligible. */
    posNbr?: number;
    /** Parm Type (CMD/CMDSTR positionals gobble the rest of the statement). */
    type?: string;
    /** Document (XML arrival) order index; lower = earlier in the command source. */
    xmlOrder?: number;
}

/** Positional-eligible keywords in XML arrival order (the IBM i binding order). */
export function positionalBindingOrder(parms: PositionalParm[]): string[] {
    return parms
        .map((p, idx) => ({ p, idx }))
        .filter((x) => (x.p.posNbr ?? 0) > 0)
        .sort((a, b) => (a.p.xmlOrder ?? a.idx) - (b.p.xmlOrder ?? b.idx))
        .map((x) => x.p.kwd.toUpperCase());
}

/**
 * Rewrite leading positional tokens in commandText to KWD(value) form so
 * parseCLParms can bind them. Stops at the first KWD( token or after maxPos
 * positionals. A leading "CL:"/"SQL:" statement prefix (app editor syntax, not
 * a CL label) and user labels ("MYLBL:") are preserved.
 */
export function rewritePositionalParms(commandText: string, parms: PositionalParm[], maxPos: number): string {
    if (!commandText || maxPos <= 0 || parms.length === 0) return commandText;
    const kwds = positionalBindingOrder(parms);
    if (kwds.length === 0) return commandText;
    const parmTypeMap: Record<string, string> = {};
    for (const p of parms) parmTypeMap[p.kwd.toUpperCase()] = p.type ?? "";
    // "CL:"/"SQL:" is an app statement prefix, not a CL label — detach it so
    // the tokenizer sees the command token, then re-attach.
    const prefixMatch = commandText.match(/^(\s*(?:CL|SQL)\s*:\s*)([\s\S]*)$/i);
    const prefix = prefixMatch?.[1] ?? "";
    const body = prefixMatch ? prefixMatch[2] : commandText;
    if (!body.trim()) return commandText;
    return prefix + rewriteLeadingPositionalsByList(body, kwds, maxPos, parmTypeMap);
}
