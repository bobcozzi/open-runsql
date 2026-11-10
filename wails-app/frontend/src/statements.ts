// SQL/CL statement splitting for multi-statement execution.
// Splits on top-level semicolons, respecting quotes and -- / block comments.
// Ported from cozzi-cl-prompter sqlSyntaxChecker.ts scanning rules.

export interface StatementSpan {
    text: string;
    start: number; // offset in source
    end: number;
}

export function splitStatements(source: string): StatementSpan[] {
    const spans: StatementSpan[] = [];
    let inSingle = false;
    let inDouble = false;
    let inLineComment = false;
    let inBlockComment = false;
    let stmtStart = 0;

    const push = (end: number) => {
        const text = source.slice(stmtStart, end).trim();
        if (text) {
            // adjust start to first non-ws char
            const lead = source.slice(stmtStart, end).length - source.slice(stmtStart, end).trimStart().length;
            spans.push({ text, start: stmtStart + lead, end });
        }
    };

    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];

        if (inLineComment) {
            if (ch === "\n" || ch === "\r") inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (inSingle) {
            if (ch === "'" && next === "'") {
                i += 1;
                continue;
            }
            if (ch === "'") inSingle = false;
            continue;
        }
        if (inDouble) {
            if (ch === '"' && next === '"') {
                i += 1;
                continue;
            }
            if (ch === '"') inDouble = false;
            continue;
        }
        if (ch === "-" && next === "-") {
            inLineComment = true;
            i += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            i += 1;
            continue;
        }
        if (ch === "'") {
            inSingle = true;
            continue;
        }
        if (ch === '"') {
            inDouble = true;
            continue;
        }
        if (ch === ";") {
            push(i);
            stmtStart = i + 1;
        }
    }
    push(source.length);
    return spans;
}

/** Statement whose span contains the caret/selection position. A caret in
 *  whitespace immediately after a statement's end (e.g. Enter pressed after
 *  the last line, caret at start of the new row) still counts as "on" that
 *  statement — matching ACS Run Selected, which looks backward for a
 *  semicolon or start-of-text, then forward. Only applies when no LATER
 *  statement exists: on a blank line between two statements the caret belongs
 *  to neither (the statement at/after the caret wins instead). */
export function statementAt(source: string, pos: number): StatementSpan | undefined {
    const spans = splitStatements(source);
    // end is exclusive-ish: the char AT end is the delimiter/whitespace.
    const direct = spans.find((s) => pos >= s.start && pos < s.end)
        // caret exactly at the very end of the last statement still counts
        ?? spans.find((s, i) => i === spans.length - 1 && pos === s.end && s.end === source.trimEnd().length);
    if (direct) return direct;
    // Whitespace fallback: caret on empty space right after a statement with
    // nothing but whitespace until end of text -> that trailing statement.
    if (source.slice(pos).trim() === "" && spans.length > 0) {
        const last = spans[spans.length - 1];
        if (pos >= last.end) return last;
    }
    return undefined;
}

/** Statements from the caret/selection position to the end. */
export function statementsFrom(source: string, pos: number): StatementSpan[] {
    const spans = splitStatements(source);
    const idx = spans.findIndex((s) => pos >= s.start && pos < s.end);
    if (idx < 0) return [];
    return spans.slice(idx);
}

/** True when a statement span is a bare STOP (STOP or STOP;, only thing on the
 * line) — ACS RUNSQL parity: Run All / Run from Selected end at STOP. Works on
 * a splitStatements span (whose text excludes the trailing ';') or raw text. */
export function isStopStatement(text: string): boolean {
    return /^stop\s*;?$/i.test(text.trim());
}
