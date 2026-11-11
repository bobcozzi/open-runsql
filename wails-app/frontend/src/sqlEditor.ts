import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, placeholder, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { sql, SQLDialect, StandardSQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { editorHighlightRanges } from "./editorHighlight";

const marks = {
    comment: Decoration.mark({ class: "editor-highlight-comment" }),
    stop: Decoration.mark({ class: "editor-highlight-stop" }),
    "cl-command": Decoration.mark({ class: "editor-highlight-cl-command" }),
    "cl-keyword": Decoration.mark({ class: "editor-highlight-cl-keyword" }),
    "cl-value": Decoration.mark({ class: "editor-highlight-cl-value" }),
};

const sqlHighlightStyle = HighlightStyle.define([
    { tag: tags.keyword, class: "sql-token-keyword" },
    { tag: tags.string, class: "sql-token-string" },
    { tag: [tags.number, tags.bool, tags.null], class: "sql-token-literal" },
    { tag: tags.typeName, class: "sql-token-type" },
    { tag: tags.operator, class: "sql-token-operator" },
]);

function highlights(state: EditorState): DecorationSet {
    return Decoration.set(editorHighlightRanges(state.doc.toString()).map((range) => marks[range.kind].range(range.start, range.end)));
}

const highlightField = StateField.define<DecorationSet>({
    create: highlights,
    update: (value, transaction) => transaction.docChanged ? highlights(transaction.state) : value,
    provide: (field) => EditorView.decorations.from(field),
});

const runningStatementEffect = StateEffect.define<{ start: number; end: number } | null>();
const runningStatementMark = Decoration.mark({ class: "editor-running-statement" });
const runningStatementField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
        if (transaction.docChanged) value = Decoration.none;
        for (const effect of transaction.effects) {
            if (effect.is(runningStatementEffect)) {
                const range = effect.value;
                value = range && range.end > range.start
                    ? Decoration.set([runningStatementMark.range(range.start, range.end)])
                    : Decoration.none;
            }
        }
        return value;
    },
    provide: (field) => EditorView.decorations.from(field),
});

export class SqlEditor {
    readonly view: EditorView;
    private programmatic = false;
    private readonly syntaxHighlight = new Compartment();

    constructor(parent: HTMLElement, highlightSql = true) {
        const dialect = SQLDialect.define({ ...StandardSQL.spec, slashComments: true });
        this.view = new EditorView({
            parent,
            extensions: [
                sql({ dialect }), this.syntaxHighlight.of(highlightSql ? syntaxHighlighting(sqlHighlightStyle) : []), highlightField, runningStatementField, EditorView.lineWrapping,
                history(), keymap.of([...historyKeymap, ...standardKeymap]),
                placeholder("SELECT * FROM QSYS2.SYSTEM_STATUS_INFO\nCL: DSPLIBL OUTPUT(*PRINT)"),
                EditorView.contentAttributes.of({ "aria-label": "SQL/CL script", spellcheck: "false" }),
                EditorView.domEventHandlers({ keydown: (event) => event.defaultPrevented }),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged && !this.programmatic) this.view.contentDOM.dispatchEvent(new Event("input", { bubbles: true }));
                }),
            ],
        });
        this.view.contentDOM.addEventListener("keydown", (event: KeyboardEvent) => {
            if ((event.key !== "Home" && event.key !== "End") || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
            const selection = this.view.state.selection.main;
            const line = this.view.state.doc.lineAt(selection.head);
            const target = event.key === "Home" ? line.from : line.to;
            event.preventDefault();
            this.view.dispatch({
                selection: { anchor: event.shiftKey ? selection.anchor : target, head: target },
                effects: EditorView.scrollIntoView(target),
            });
        }, true);
    }

    get value(): string { return this.view.state.doc.toString(); }
    set value(value: string) {
        this.programmatic = true;
        try { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } }); }
        finally { this.programmatic = false; }
    }
    get selectionStart(): number { return this.view.state.selection.main.from; }
    set selectionStart(value: number) { this.setSelectionRange(value, Math.max(value, this.selectionEnd)); }
    get selectionEnd(): number { return this.view.state.selection.main.to; }
    set selectionEnd(value: number) { this.setSelectionRange(Math.min(value, this.selectionStart), value); }
    get selectionDirection(): string { return this.view.state.selection.main.anchor > this.view.state.selection.main.head ? "backward" : "forward"; }
    setSelectionRange(start: number, end: number): void { this.view.dispatch({ selection: { anchor: start, head: end } }); }
    focus(): void { this.view.focus(); }
    setSqlHighlighting(enabled: boolean): void {
        this.view.dispatch({ effects: this.syntaxHighlight.reconfigure(enabled ? syntaxHighlighting(sqlHighlightStyle) : []) });
    }
    scrollToOffset(offset: number): void { this.view.dispatch({ effects: EditorView.scrollIntoView(offset, { y: "nearest" }) }); }
    highlightRunningStatement(start: number, end: number): void {
        const length = this.view.state.doc.length;
        if (start < 0 || end > length || end <= start) return;
        this.view.dispatch({ effects: [runningStatementEffect.of({ start, end }), EditorView.scrollIntoView(start, { y: "nearest" })] });
    }
    clearRunningStatement(): void { this.view.dispatch({ effects: runningStatementEffect.of(null) }); }
    addEventListener<K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void): void {
        this.view.contentDOM.addEventListener(type, listener as EventListener, type === "keydown");
    }
}