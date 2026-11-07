// Tests for the saved-connections dropdown ordering: Word-font-dropdown style
// sections (recently used on top, separator, remainder) above 5 profiles, and a
// stable list at 5 or fewer.
import { describe, expect, it } from "vitest";

interface TestProfile {
    name: string;
    pinnedAt?: number;
}

const RECENT_SECTION_SIZE = 5;

// Mirrors toggleSavedHosts() in main.ts: returns the item/element sequence.
function popupSequence(profiles: TestProfile[]): { kind: string; name?: string }[] {
    const out: { kind: string; name?: string }[] = [];
    if (profiles.length === 0) {
        return [{ kind: "empty" }];
    }
    const pinnedCount = profiles.filter((p) => (p.pinnedAt ?? 0) > 0).length;
    const recentCount = profiles.length > RECENT_SECTION_SIZE
        ? Math.max(pinnedCount, RECENT_SECTION_SIZE)
        : profiles.length;
    profiles.forEach((p, i) => {
        if (i === recentCount) out.push({ kind: "separator" });
        out.push({ kind: "item", name: p.name });
    });
    return out;
}

describe("saved-connections dropdown sections", () => {
    it("5 or fewer profiles: flat list, no separator", () => {
        const seq = popupSequence([{ name: "a" }, { name: "b" }, { name: "c" }]);
        expect(seq).toEqual([
            { kind: "item", name: "a" },
            { kind: "item", name: "b" },
            { kind: "item", name: "c" },
        ]);
        expect(seq.some((s) => s.kind === "separator")).toBe(false);
    });

    it("more than 5 profiles: 5 recent items, separator, then the rest", () => {
        const seq = popupSequence([
            { name: "r1" }, { name: "r2" }, { name: "r3" }, { name: "r4" }, { name: "r5" },
            { name: "x1" }, { name: "x2" },
        ]);
        expect(seq.map((s) => s.kind)).toEqual([
            "item", "item", "item", "item", "item", "separator", "item", "item",
        ]);
        expect(seq[5].kind).toBe("separator");
        expect(seq[6]).toEqual({ kind: "item", name: "x1" });
    });

    it("pinned entries count toward the recent section when many are pinned", () => {
        const seq = popupSequence([
            { name: "p1", pinnedAt: 1 }, { name: "p2", pinnedAt: 2 }, { name: "p3", pinnedAt: 3 },
            { name: "p4", pinnedAt: 4 }, { name: "p5", pinnedAt: 5 }, { name: "p6", pinnedAt: 6 },
            { name: "rest" },
        ]);
        // 6 pinned > 5: separator goes after all pinned, "rest" below it.
        expect(seq[6].kind).toBe("separator");
        expect(seq[7]).toEqual({ kind: "item", name: "rest" });
    });

    it("empty list shows the empty placeholder", () => {
        expect(popupSequence([])).toEqual([{ kind: "empty" }]);
    });
});
