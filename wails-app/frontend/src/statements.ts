// SQL/CL statement splitting for multi-statement execution.
// Splits on top-level semicolons, respecting quotes and -- / // / /* */ comments.
// Comments are recognized for splitting AND stripped from the emitted text, so
// neither the log nor the host payload includes them ("//" is not valid in
// Db2/CL at all). Source offsets in the spans are unaffected.
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
    // Comment ranges within the current statement, stripped from text.
    let strip: Array<readonly [number, number]> = [];
    let lineCommentStart = -1;
    let blockCommentStart = -1;

    const push = (end: number) => {
        const slice = source.slice(stmtStart, end);
        let text: string;
        if (strip.length === 0) {
            text = slice.trim();
        } else {
            let out = "";
            let cursor = stmtStart;
            for (const [cs, ce] of strip) {
                out += source.slice(cursor, Math.min(cs, end));
                cursor = Math.min(ce, end);
            }
            out += source.slice(cursor, end);
            text = out.trim();
        }
        if (text) {
            // adjust start to first non-ws char, then past any leading
            // comment lines/blocks so the caret lands on the first CODE token
            // (caret-follow during Run All/From would otherwise stop on a
            // leading "--" line).
            let start = stmtStart + (slice.length - slice.trimStart().length);
            for (;;) {
                while (start < end && /\s/.test(source[start])) start += 1;
                const two = source.slice(start, start + 2);
                if (two === "--" || two === "//") {
                    const nl = source.indexOf("\n", start);
                    if (nl < 0 || nl >= end) { start = end; break; }
                    start = nl + 1;
                    continue;
                }
                if (two === "/*") {
                    const close = source.indexOf("*/", start + 2);
                    if (close < 0 || close + 2 >= end) { start = end; break; }
                    start = close + 2;
                    continue;
                }
                break;
            }
            spans.push({ text, start, end });
        }
        strip = [];
    };

    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];

        if (inLineComment) {
            if (ch === "\n" || ch === "\r") {
                strip.push([lineCommentStart, i]);
                lineCommentStart = -1;
                inLineComment = false;
            }
            continue;
        }
        if (inBlockComment) {
            if (ch === "*" && next === "/") {
                strip.push([blockCommentStart, i + 2]);
                blockCommentStart = -1;
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
            lineCommentStart = i;
            i += 1;
            continue;
        }
        if (ch === "/" && next === "/") {
            inLineComment = true;
            lineCommentStart = i;
            i += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            inBlockComment = true;
            blockCommentStart = i;
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
    if (lineCommentStart >= 0) strip.push([lineCommentStart, source.length]);
    if (blockCommentStart >= 0) strip.push([blockCommentStart, source.length]); // unterminated /* */ — drop to end
    push(source.length);
    return spans;
}

/** Statement whose span contains the caret/selection position. `end` is the
 *  offset OF the terminating ';' (or end-of-text). Rules (ACS Run Selected
 *  parity):
 *   - caret within the statement text or exactly ON its ';' -> that statement.
 *   - caret AFTER the ';' (whitespace/comment gap before the next statement)
 *     -> the FOLLOWING statement (look forward, not back).
 *   - caret in the gap before the first statement -> first statement.
 *   - caret past the last statement with only whitespace to end-of-text ->
 *     the trailing statement (nothing follows to move forward to). */
export function statementAt(source: string, pos: number): StatementSpan | undefined {
    const spans = splitStatements(source);
    for (const s of spans) {
        if (pos < s.start) return s; // gap before this statement -> forward
        if (pos <= s.end) return s;  // on the text or its terminating ';'
    }
    // Whitespace fallback: caret past the last statement's end with nothing but
    // whitespace until end of text -> that trailing statement.
    if (source.slice(pos).trim() === "" && spans.length > 0) {
        const last = spans[spans.length - 1];
        if (pos > last.end) return last;
    }
    return undefined;
}

/** Statements from the caret/selection position to the end. */
export function statementsFrom(source: string, pos: number): StatementSpan[] {
    const spans = splitStatements(source);
    const at = statementAt(source, pos);
    if (!at) return [];
    // statementAt re-splits internally, so match by offset (not identity).
    const idx = spans.findIndex((s) => s.start === at.start && s.end === at.end);
    return idx >= 0 ? spans.slice(idx) : [];
}

/** True when a statement span is a bare STOP (STOP or STOP;, only thing on the
 * line) — ACS RUNSQL parity: Run All / Run from Selected end at STOP. Works on
 * a splitStatements span (whose text excludes the trailing ';') or raw text. */
export function isStopStatement(text: string): boolean {
    return /^stop\s*;?$/i.test(text.trim());
}
