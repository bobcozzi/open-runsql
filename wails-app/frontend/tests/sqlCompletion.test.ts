import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { sql, SQLDialect, StandardSQL } from "@codemirror/lang-sql";
import { CompletionContext } from "@codemirror/autocomplete";
import { completionRequests, createSQLCompletionSource, type SQLCompletionItem } from "../src/sqlCompletion";

function context(marked: string, explicit = true): CompletionContext {
    const pos = marked.indexOf("|");
    const state = EditorState.create({
        doc: marked.replace("|", ""),
        extensions: [sql({ dialect: SQLDialect.define({ ...StandardSQL.spec, slashComments: true }) })],
    });
    return new CompletionContext(state, pos, explicit);
}
const plan = (text: string) => completionRequests(context(text), "MYLIB");

describe("SQL completion context", () => {
    it("looks up tables using the qualified schema and typed prefix", () => {
        expect(plan("SELECT * FROM qgpl.cu|").requests).toEqual([
            { kind: "tables", schema: "QGPL", object: "", prefix: "CU", qualify: undefined },
        ]);
    });
    it("supports default-schema table lookup", () => {
        expect(plan("SELECT * FROM CUS|").requests[0]).toMatchObject({ kind: "tables", schema: "MYLIB", prefix: "CUS" });
    });
    it("offers table functions after TABLE(schema.)", () => {
        expect(plan("SELECT * FROM TABLE(QSYS2.OBJ|)").requests[0]).toMatchObject({ kind: "tableFunctions", schema: "QSYS2", prefix: "OBJ" });
    });
    it("offers table-function output columns at SELECT * without running the function", () => {
        const request = plan("SELECT *| FROM TABLE(QSYS2.OBJECT_STATISTICS('QGPL','*FILE','QRPGLESRC')) AS O");
        expect(request.from).toBe(7);
        expect(request.requests).toEqual([{ kind: "routineColumns", schema: "QSYS2", object: "OBJECT_STATISTICS", prefix: "", qualify: undefined }]);
    });
    it("resolves table-function aliases and table aliases", () => {
        expect(plan("SELECT O.OBJ| FROM TABLE(QSYS2.OBJECT_STATISTICS('QGPL','*FILE')) AS O").requests[0])
            .toMatchObject({ kind: "routineColumns", schema: "QSYS2", object: "OBJECT_STATISTICS", prefix: "OBJ" });
        expect(plan("SELECT C.CUS| FROM QGPL.CUSTOMERS C").requests[0])
            .toMatchObject({ kind: "columns", schema: "QGPL", object: "CUSTOMERS", prefix: "CUS" });
    });
    it("qualifies column insertions when multiple sources are present", () => {
        expect(plan("SELECT | FROM QGPL.CUSTOMERS C JOIN DATA.ORDERS O ON C.ID = O.ID").requests)
            .toEqual([
                { kind: "columns", schema: "QGPL", object: "CUSTOMERS", prefix: "", qualify: "C" },
                { kind: "columns", schema: "DATA", object: "ORDERS", prefix: "", qualify: "O" },
            ]);
    });
    it("offers catalog parameters inside a qualified function call", () => {
        expect(plan("VALUES QSYS2.QCMDEXC(|)").requests[0])
            .toMatchObject({ kind: "parameters", schema: "QSYS2", object: "QCMDEXC", prefix: "" });
    });
    it("preserves delimited identifier case", () => {
        expect(plan('SELECT * FROM "My Schema"."Mi|').requests[0])
            .toMatchObject({ schema: "My Schema", prefix: "Mi" });
    });
    it.each(["CL: ADDLIBLE LIB(QG|PL)", "SELECT 'QSYS2.OB|J'", "SELECT 1 -- QSYS2.OB|J", "// QSYS2.OB|J", "SELECT /* QSYS2.OB|J */ 1"])
    ("suppresses SQL completion in CL, strings, and comments: %s", (text) => {
        expect(plan(text).suppressed).toBe(true);
    });
    it("does not mix objects from other statements or nested query scopes", () => {
        expect(plan("SELECT | FROM QGPL.CUSTOMERS; SELECT * FROM SECRET.T").requests).toHaveLength(1);
        expect(plan("SELECT | FROM (SELECT * FROM QGPL.CUSTOMERS) C").requests).toEqual([]);
    });
});

describe("live SQL completion", () => {
    it("caches requests and sends only identifiers, never the edited SQL", async () => {
        const lookup = vi.fn(async () => [{ name: "OBJECT_NAME", kind: "routineColumns", detail: "OUT VARCHAR" }]);
        const source = createSQLCompletionSource(() => ({ connectionId: "one", defaultSchema: "MYLIB" }), lookup);
        const input = context("SELECT *| FROM TABLE(QSYS2.OBJECT_STATISTICS('QGPL','*FILE')) O");
        const result = await source(input);
        await source(input);
        expect(lookup).toHaveBeenCalledExactlyOnceWith("one", "routineColumns", "QSYS2", "OBJECT_STATISTICS", "");
        expect(result?.from).toBe(7);
        expect(result?.options[0].apply).toBe("OBJECT_NAME");
    });
    it("quotes identifiers and offers named parameters with their types", async () => {
        const lookup = vi.fn(async () => [{ name: "Mixed Name", kind: "parameters", detail: "IN VARCHAR [SPEC]" }]);
        const source = createSQLCompletionSource(() => ({ connectionId: "one", defaultSchema: "MYLIB" }), lookup);
        expect((await source(context("VALUES QSYS2.FOO(|)")))?.options[0])
            .toMatchObject({ apply: '"Mixed Name" => ', detail: "IN VARCHAR [SPEC]" });
    });
    it("discards results after switching connections", async () => {
        let connectionId = "one";
        let resolve!: (rows: SQLCompletionItem[]) => void;
        const lookup = vi.fn(() => new Promise<SQLCompletionItem[]>((done) => { resolve = done; }));
        const source = createSQLCompletionSource(() => ({ connectionId, defaultSchema: "MYLIB" }), lookup);
        const pending = source(context("SELECT * FROM QGPL.C|"));
        connectionId = "two";
        resolve([{ name: "CUSTOMERS", kind: "tables", detail: "" }]);
        expect(await pending).toBeNull();
    });
    it("degrades to no live suggestions on metadata errors and retries later", async () => {
        const lookup = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue([{ name: "CUSTOMERS", kind: "tables", detail: "" }]);
        const source = createSQLCompletionSource(() => ({ connectionId: "one", defaultSchema: "MYLIB" }), lookup);
        expect(await source(context("SELECT * FROM QGPL.C|"))).toBeNull();
        expect((await source(context("SELECT * FROM QGPL.C|")))?.options[0].label).toBe("CUSTOMERS");
        expect(lookup).toHaveBeenCalledTimes(2);
    });
});