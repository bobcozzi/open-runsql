import { isStopStatement, splitStatements } from "./statements";

export interface HighlightRange {
    start: number;
    end: number;
    kind: "comment" | "stop" | "cl-command" | "cl-keyword" | "cl-value";
}

const sqlStart = /^(?:select|values|with|set|call|insert|update|delete|merge|create|drop|alter|declare|truncate|comment|grant|revoke|rename|label)\b/i;

function clHighlightRanges(source: string, start: number, end: number, comments: HighlightRange[]): HighlightRange[] {
    const masked = source.slice(start, end).split("");
    for (const comment of comments) {
        const from = Math.max(comment.start, start);
        const to = Math.min(comment.end, end);
        for (let index = from; index < to; index += 1) masked[index - start] = " ";
    }
    const text = masked.join("");
    let offset = 0;
    const ranges: HighlightRange[] = [];
    const prefix = text.match(/^CL(?:\s*:\s*|\s+)(?=\S)/i);
    if (prefix) {
        const prefixEnd = prefix[0].trimEnd().length;
        ranges.push({ start, end: start + prefixEnd, kind: "cl-command" });
        offset = prefix[0].length;
    }
    const command = text.slice(offset).match(/^[A-Z_#$@][A-Z0-9_#$@]*(?:\/[A-Z_#$@][A-Z0-9_#$@]*)?/i);
    if (!command) return [];
    ranges.push({ start: start + offset, end: start + offset + command[0].length, kind: "cl-command" });
    offset += command[0].length;
    let depth = 0;
    while (offset < text.length) {
        const char = text[offset];
        if (char === "(") { depth += 1; offset += 1; continue; }
        if (char === ")") { depth = Math.max(0, depth - 1); offset += 1; continue; }
        if (/\s/.test(char)) { offset += 1; continue; }
        if (char === "'") {
            const begin = offset++;
            while (offset < text.length) {
                if (text[offset++] === "'") {
                    if (text[offset] === "'") offset += 1;
                    else break;
                }
            }
            if (depth > 0) ranges.push({ start: start + begin, end: start + offset, kind: "cl-value" });
            continue;
        }
        const token = text.slice(offset).match(/^[A-Z0-9_#$@*%&./+-]+/i);
        if (!token) { offset += 1; continue; }
        const begin = offset;
        offset += token[0].length;
        const rest = text.slice(offset);
        if (depth === 0 && /^[A-Z_#$@][A-Z0-9_#$@]*$/i.test(token[0]) && /^\s*\(/.test(rest)) {
            ranges.push({ start: start + begin, end: start + offset, kind: "cl-keyword" });
        } else if (depth > 0) {
            ranges.push({ start: start + begin, end: start + offset, kind: "cl-value" });
        }
    }
    return ranges;
}

export function editorHighlightRanges(source: string): HighlightRange[] {
    const ranges: HighlightRange[] = [];
    let quote = "";
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const next = source[index + 1];
        if (quote) {
            if (char === quote && next === quote) index += 1;
            else if (char === quote) quote = "";
        } else if (char === "'" || char === '"') {
            quote = char;
        } else if ((char === "-" && next === "-") || (char === "/" && next === "/")) {
            const start = index;
            while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
            ranges.push({ start, end: index, kind: "comment" });
            index -= 1;
        } else if (char === "/" && next === "*") {
            const start = index;
            const close = source.indexOf("*/", index + 2);
            const end = close < 0 ? source.length : close + 2;
            ranges.push({ start, end, kind: "comment" });
            index = end - 1;
        }
    }
    const comments = [...ranges];
    for (const statement of splitStatements(source)) {
        if (isStopStatement(statement.text)) {
            const word = source.slice(statement.start, statement.end).match(/^stop\b/i);
            if (word) ranges.push({ start: statement.start, end: statement.start + word[0].length, kind: "stop" });
        } else if (!/^sql\s*:/i.test(statement.text) && !sqlStart.test(statement.text)) {
            ranges.push(...clHighlightRanges(source, statement.start, statement.end, comments));
        }
    }
    return ranges.sort((first, second) => first.start - second.start);
}

