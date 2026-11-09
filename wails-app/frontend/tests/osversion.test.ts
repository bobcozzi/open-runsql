import { describe, expect, it } from "vitest";
import { formatOsVersion } from "../src/scsRender";

describe("formatOsVersion", () => {
    it("normalizes V7R3m0 to V7R3M0", () => {
        expect(formatOsVersion("V7R3m0")).toBe("V7R3M0");
    });
    it("collapses '07.03.0000 V7R3m0' to V7R3M0", () => {
        expect(formatOsVersion("07.03.0000 V7R3m0")).toBe("V7R3M0");
    });
    it("formats 07.03.000 as V7R3M0", () => {
        expect(formatOsVersion("07.03.000")).toBe("V7R3M0");
    });
    it("formats 07.05.000 as V7R5M0", () => {
        expect(formatOsVersion("07.05.000")).toBe("V7R5M0");
    });
    it("passes through unrecognized formats", () => {
        expect(formatOsVersion("something-else")).toBe("something-else");
    });
});
