// *AFPDS spooled files: routed to the host GIF page-transform image viewer.
import { describe, expect, it } from "vitest";
import { isAfpdsFile } from "../src/spool";
import type { SpooledFileInfo } from "../src/types";

const BASE: SpooledFileInfo = {
    name: "AFPOUT", number: "1", jobName: "JOB1", jobUser: "COZZI", jobNumber: "123456",
    userData: "", outqName: "QPRINT", outqLib: "QGPL", createDate: "2026-11-09",
    createTime: "09:00:00", pages: 2, size: 4096, status: "RDY", holdStatus: "NO",
    deviceType: "*AFPDS",
};

describe("isAfpdsFile", () => {
    it("is true for *AFPDS regardless of case/whitespace", () => {
        expect(isAfpdsFile(BASE)).toBe(true);
        expect(isAfpdsFile({ ...BASE, deviceType: " *afpds " })).toBe(true);
    });

    it("is false for SCS, USERASCII, blank and unknown types", () => {
        expect(isAfpdsFile({ ...BASE, deviceType: "*SCS" })).toBe(false);
        expect(isAfpdsFile({ ...BASE, deviceType: "*USERASCII" })).toBe(false);
        expect(isAfpdsFile({ ...BASE, deviceType: "" })).toBe(false);
        expect(isAfpdsFile({ ...BASE, deviceType: undefined })).toBe(false);
    });
});
