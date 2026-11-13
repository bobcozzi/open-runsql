import { describe, expect, it } from "vitest";
import { formatServerJob } from "../src/serverJob";

describe("SQL server job formatting", () => {
    it("removes padding around the classic job components", () => {
        expect(formatServerJob(" 123456 / USER / QZDASOINIT  ")).toBe("123456/USER/QZDASOINIT");
    });

    it("hides missing and incomplete identifiers", () => {
        for (const value of [undefined, null, "", "  ", "123456/USER/ ", "123456/USER", "a/b/c/d"]) {
            expect(formatServerJob(value)).toBe("");
        }
    });
});