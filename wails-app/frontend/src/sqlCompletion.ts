import { type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { StandardSQL } from "@codemirror/lang-sql";

export type MetadataKind = "tables" | "columns" | "routines" | "tableFunctions" | "parameters" | "routineColumns";
export interface SQLCompletionItem {
    name: string;
    kind: string;
    detail: string;
    specificName?: string;
}
export interface CompletionSession { connectionId: string; defaultSchema: string }
export type MetadataLookup = (connectionId: string, kind: MetadataKind, schema: string, object: string, prefix: string) => Promise<SQLCompletionItem[]>;
interface Token { text: string; type: string; from: number; to: number }
interface Reference { schema: string; name: string; alias: string; routine: boolean }
interface Request { kind: MetadataKind; schema: string; object: string; prefix: string; qualify?: string }
const reserved = new Set((StandardSQL.spec.keywords || "").toUpperCase().split(/\s+/));

function identifier(token?: Token): boolean {
    return !!token && /^(Identifier|QuotedIdentifier)$/.test(token.type);
}
function catalogName(text: string): string {
    return text.startsWith('"') ? text.slice(1, text.endsWith('"') ? -1 : undefined).replace(/""/g, '"') : text.toUpperCase();
}
function sqlName(name: string): string {
    return /^[A-Z_#$@][A-Z0-9_#$@]*$/.test(name) && !reserved.has(name)
        ? name : '"' + name.replace(/"/g, '""') + '"';
}
function referenceAt(tokens: Token[], start: number, defaultSchema: string): { reference: Reference; next: number } | null {
    if (!identifier(tokens[start])) return null;
    const first = catalogName(tokens[start].text);
    if (tokens[start + 1]?.text === "." && identifier(tokens[start + 2])) {
        return { reference: { schema: first, name: catalogName(tokens[start + 2].text), alias: "", routine: false }, next: start + 3 };
    }
    return { reference: { schema: defaultSchema, name: first, alias: "", routine: false }, next: start + 1 };
}
function skipParens(tokens: Token[], start: number): number {
    let depth = 0;
    for (let index = start; index < tokens.length; index++) {
        if (tokens[index].text === "(") depth++;
        if (tokens[index].text === ")" && --depth === 0) return index + 1;
    }
    return tokens.length;
}
function sourceReferences(tokens: Token[], defaultSchema: string): Reference[] {
    if (tokens.filter((token) => token.text.toUpperCase() === "SELECT").length > 1 || tokens[0]?.text.toUpperCase() === "WITH") return [];
    const references: Reference[] = [];
    let depth = 0;
    let inFrom = false;
    for (let index = 0; index < tokens.length; index++) {
        const word = tokens[index].text.toUpperCase();
        if (word === "(") { depth++; continue; }
        if (word === ")") { depth--; continue; }
        if (depth !== 0) continue;
        if (["WHERE", "GROUP", "ORDER", "HAVING", "UNION", "EXCEPT", "INTERSECT"].includes(word)) inFrom = false;
        if (!["FROM", "JOIN", "UPDATE", "INTO"].includes(word) && !(word === "," && inFrom)) continue;
        inFrom = true;
        let start = index + 1;
        const routine = tokens[start]?.text.toUpperCase() === "TABLE" && tokens[start + 1]?.text === "(";
        if (routine) start += 2;
        const parsed = referenceAt(tokens, start, defaultSchema);
        if (!parsed) continue;
        parsed.reference.routine = routine;
        let next = parsed.next;
        if (routine) next = skipParens(tokens, index + 2);
        if (tokens[next]?.text.toUpperCase() === "AS") next++;
        if (identifier(tokens[next])) parsed.reference.alias = catalogName(tokens[next++].text);
        references.push(parsed.reference);
        index = Math.max(index, next - 1);
    }
    return references;
}

export function completionRequests(context: CompletionContext, defaultSchema: string): { from: number; requests: Request[]; suppressed: boolean } {
    const empty = { from: context.pos, requests: [] as Request[], suppressed: false };
    const tree = ensureSyntaxTree(context.state, context.state.doc.length, 50);
    if (!tree) return empty;
    let node = tree.resolveInner(context.pos, -1);
    if (/Comment|String/.test(node.name) && context.pos > node.from && (context.pos < node.to || /Comment/.test(node.name))) {
        return { ...empty, suppressed: true };
    }
    while (node.parent && node.name !== "Statement") node = node.parent;
    if (node.name !== "Statement") return empty;
    const tokens: Token[] = [];
    node.toTree().iterate({ enter(current) {
        if (!current.node.firstChild && !/Comment/.test(current.name)) {
            tokens.push({ type: current.name, text: context.state.sliceDoc(node.from + current.from, node.from + current.to), from: node.from + current.from, to: node.from + current.to });
        }
    } });
    const first = tokens[0]?.text.toUpperCase() || "";
    const startsSQL = ["SELECT", "VALUES", "WITH", "CALL", "INSERT", "UPDATE", "DELETE", "MERGE", "SQL", "CREATE", "ALTER", "DROP", "SET", "COMMIT", "ROLLBACK"];
    if (!startsSQL.includes(first) && !(tokens.length === 1 && startsSQL.some((word) => word.startsWith(first)))) return { ...empty, suppressed: true };
    const match = context.matchBefore(/(?:"(?:[^"]|"")*"?|[\w#$@]+|\*)$/);
    const from = match?.from ?? context.pos;
    const raw = match?.text ?? "";
    if (raw === "*" && !context.explicit) return empty;
    const prefix = raw === "*" ? "" : catalogName(raw);
    const before = tokens.filter((token) => token.to <= from);
    const last = before[before.length - 1]?.text.toUpperCase();
    const refs = sourceReferences(tokens, defaultSchema);
    const qualified = last === "." && identifier(before[before.length - 2]);
    const qualifier = qualified ? catalogName(before[before.length - 2].text) : "";
    const preceding = qualified ? before[before.length - 3]?.text.toUpperCase() : last;
    const requests: Request[] = [];
    const push = (kind: MetadataKind, schema: string, object = "", qualify?: string) => {
        if (schema) requests.push({ kind, schema, object, prefix, qualify });
    };
    if (["FROM", "JOIN", "UPDATE", "INTO"].includes(preceding || "")) {
        push("tables", qualifier || defaultSchema);
    } else if (preceding === "(" && before[before.length - (qualified ? 4 : 2)]?.text.toUpperCase() === "TABLE") {
        push("tableFunctions", qualifier || defaultSchema);
    } else if (preceding === "CALL") {
        push("routines", qualifier || defaultSchema);
    } else if (qualified) {
        const source = refs.find((ref) => (ref.alias || ref.name) === qualifier);
        if (source) push(source.routine ? "routineColumns" : "columns", source.schema, source.name);
        else push("routines", qualifier);
    } else {
        const stack: number[] = [];
        before.forEach((token, index) => {
            if (token.text === "(") stack.push(index);
            else if (token.text === ")") stack.pop();
        });
        const open = stack[stack.length - 1];
        if (open !== undefined && identifier(before[open - 1])) {
            const name = catalogName(before[open - 1].text);
            const schema = before[open - 2]?.text === "." && identifier(before[open - 3]) ? catalogName(before[open - 3].text) : defaultSchema;
            push("parameters", schema, name);
        } else if (raw || context.explicit) {
            for (const ref of refs.slice(0, 8)) {
                push(ref.routine ? "routineColumns" : "columns", ref.schema, ref.name, refs.length > 1 ? sqlName(ref.alias || ref.name) : undefined);
            }
        }
    }
    return { from, requests, suppressed: false };
}

export function createSQLCompletionSource(session: () => CompletionSession | null, lookup: MetadataLookup) {
    const cache = new Map<string, { expires: number; value: Promise<SQLCompletionItem[]> }>();
    let activeConnection = "";
    return async (context: CompletionContext): Promise<CompletionResult | null> => {
        const current = session();
        const plan = completionRequests(context, current?.defaultSchema || "");
        if (!current || plan.suppressed || !plan.requests.length) return null;
        if (activeConnection !== current.connectionId) { cache.clear(); activeConnection = current.connectionId; }
        const options: Completion[] = [];
        await Promise.all(plan.requests.map(async (request) => {
            const key = JSON.stringify([current.connectionId, request.kind, request.schema, request.object, request.prefix]);
            let entry = cache.get(key);
            if (!entry || entry.expires < Date.now()) {
                const value = lookup(current.connectionId, request.kind, request.schema, request.object, request.prefix);
                entry = { expires: Date.now() + 120_000, value };
                cache.set(key, entry);
                if (cache.size > 128) cache.delete(cache.keys().next().value!);
                void value.catch(() => { cache.delete(key); });
            }
            const items = await entry.value.catch(() => []);
            for (const item of items) {
                const name = sqlName(item.name);
                options.push({
                    label: item.name,
                    displayLabel: item.name,
                    detail: item.detail,
                    info: [request.schema, request.object, item.specificName].filter(Boolean).join(" / "),
                    type: request.kind === "parameters" ? "variable" : request.kind === "columns" || request.kind === "routineColumns" ? "property"
                        : request.kind === "tables" ? "class" : "function",
                    apply: request.kind === "parameters" ? `${name} => ` : request.qualify ? `${request.qualify}.${name}` : name,
                });
            }
        }));
        if (context.aborted || session()?.connectionId !== current.connectionId) return null;
        const distinct = options.filter((option, index) => options.findIndex((other) => other.label === option.label && other.apply === option.apply && other.detail === option.detail) === index);
        return distinct.length ? { from: plan.from, options: distinct, validFor: /^[\w#$@]*$/ } : null;
    };
}