import { describe, expect, it } from "vitest";
import { arrowRecallDirection, InputHistory, InputHistoryStore } from "../src/inputHistory";

describe("InputHistory", () => {
    it("recalls newest-first, then walks older", () => {
        const h = new InputHistory();
        h.push("select * from qiws.qcustcdt");
        h.push("CL: DSPLIBL");
        h.push("select * from qsys2.sysschemas");
        expect(h.prev("")).toBe("select * from qsys2.sysschemas");
        expect(h.prev("")).toBe("CL: DSPLIBL");
        expect(h.prev("")).toBe("select * from qiws.qcustcdt");
        // Stays on the oldest entry when going further back.
        expect(h.prev("")).toBe("select * from qiws.qcustcdt");
    });

    it("next() walks newer and restores the stashed draft past the newest entry", () => {
        const h = new InputHistory();
        h.push("one");
        h.push("two");
        expect(h.prev("draft being typed")).toBe("two"); // stash happens on first prev
        expect(h.prev("")).toBe("one");
        expect(h.next()).toBe("two");
        expect(h.next()).toBe("draft being typed");      // past newest → stash back
        expect(h.browsing).toBe(false);
    });

    it("next() does nothing when not browsing", () => {
        const h = new InputHistory();
        h.push("one");
        expect(h.next()).toBeUndefined();
    });

    it("dedupes consecutive duplicates only", () => {
        const h = new InputHistory();
        h.push("a");
        h.push("a");
        h.push("b");
        h.push("a");
        expect(h.size).toBe(3);
        expect(h.prev("")).toBe("a");
        expect(h.prev("")).toBe("b");
        expect(h.prev("")).toBe("a");
    });

    it("ignores blank statements", () => {
        const h = new InputHistory();
        h.push("   ");
        h.push("");
        expect(h.hasHistory).toBe(false);
    });

    it("push() exits browsing mode; next prev() starts from the newest", () => {
        const h = new InputHistory();
        h.push("one");
        h.push("two");
        expect(h.prev("")).toBe("two");
        h.push("three");
        expect(h.browsing).toBe(false);
        expect(h.prev("")).toBe("three");
    });

    it("reset() drops the stash", () => {
        const h = new InputHistory();
        h.push("one");
        h.prev("my draft");
        h.reset();
        expect(h.next()).toBeUndefined();
        expect(h.prev("newer draft")).toBe("one");
        expect(h.next()).toBe("newer draft");
    });

    it("prev() on empty history returns undefined", () => {
        expect(new InputHistory().prev("x")).toBeUndefined();
    });
});

describe("InputHistoryStore (per-connection isolation)", () => {
    it("keeps separate histories per connectionId", () => {
        const store = new InputHistoryStore();
        store.for("conn-1").push("stmt from conn 1");
        store.for("conn-2").push("stmt from conn 2");
        expect(store.for("conn-1").prev("")).toBe("stmt from conn 1");
        expect(store.for("conn-2").prev("")).toBe("stmt from conn 2");
    });

    it("returns the same instance for the same connectionId", () => {
        const store = new InputHistoryStore();
        expect(store.for("conn-1")).toBe(store.for("conn-1"));
    });

    it("unknown connections start empty; null/undefined share one bucket", () => {
        const store = new InputHistoryStore();
        expect(store.for("conn-x").hasHistory).toBe(false);
        store.for(null).push("disconnected stmt");
        expect(store.for(undefined).prev("")).toBe("disconnected stmt");
    });
});

describe("arrowRecallDirection", () => {
    const text = "line one\nline two\nline three";

    it("ArrowUp recalls only on the first line", () => {
        expect(arrowRecallDirection("ArrowUp", text, 0, 0)).toBe("prev");
        expect(arrowRecallDirection("ArrowUp", text, 4, 4)).toBe("prev");
        // Caret on line two → normal caret movement.
        expect(arrowRecallDirection("ArrowUp", text, 12, 12)).toBeUndefined();
    });

    it("ArrowDown recalls only on the last line", () => {
        expect(arrowRecallDirection("ArrowDown", text, text.length, text.length)).toBe("next");
        expect(arrowRecallDirection("ArrowDown", text, 20, 20)).toBe("next");
        // Caret on line one → normal caret movement.
        expect(arrowRecallDirection("ArrowDown", text, 3, 3)).toBeUndefined();
    });

    it("single-line buffer: ArrowUp recalls, ArrowDown recalls", () => {
        expect(arrowRecallDirection("ArrowUp", "select 1", 2, 2)).toBe("prev");
        expect(arrowRecallDirection("ArrowDown", "select 1", 2, 2)).toBe("next");
    });

    it("never hijacks with an active selection", () => {
        expect(arrowRecallDirection("ArrowUp", text, 0, 5)).toBeUndefined();
        expect(arrowRecallDirection("ArrowDown", text, 10, text.length)).toBeUndefined();
    });

    it("ignores non-arrow keys", () => {
        expect(arrowRecallDirection("F9", text, 0, 0)).toBeUndefined();
    });
});
