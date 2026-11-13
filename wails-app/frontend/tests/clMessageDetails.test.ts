import { describe, expect, it } from "vitest";
import { addCLMessageDetails } from "../src/clMessageDetails";

describe("enhanced CL message details", () => {
    it("uses native disclosure, safely preserves text, and survives HTML restoration", () => {
        const item = document.createElement("li");
        item.textContent = "CPC0001: Done";
        addCLMessageDetails(item, { fromProgram: "<img src=x onerror=alert(1)>", sentTimestamp: "2026-11-13 12:34:56.123456", toProcedure: "TARGET" });
        const details = item.querySelector<HTMLDetailsElement>("details")!;
        expect(details.querySelector("summary")?.textContent).toBe("CPC0001: Done");
        expect(details.querySelector("img")).toBeNull();
        expect(details.textContent).toContain("<img src=x onerror=alert(1)>");
        details.open = true;
        const restored = document.createElement("ul");
        restored.innerHTML = item.outerHTML;
        expect(restored.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
        expect(restored.querySelector("summary")).not.toBeNull();
        expect(restored.querySelector("img")).toBeNull();
    });

    it("does not add disclosure to standard messages or blank fields", () => {
        const item = document.createElement("li");
        item.textContent = "Standard message";
        addCLMessageDetails(item, { text: "Standard message", fromProgram: " " });
        expect(item.querySelector("details")).toBeNull();
        expect(item.textContent).toBe("Standard message");
    });

    it("keeps help inside a closed disclosure even without sender details", () => {
        const item = document.createElement("li");
        item.textContent = "CPF2889 10 *INFO - Member added";
        addCLMessageDetails(item, { secondLevelText: "Cause\nRecovery" });
        const details = item.querySelector<HTMLDetailsElement>("details")!;
        expect(details.open).toBe(false);
        expect(details.querySelector("summary")?.textContent).toBe("CPF2889 10 *INFO - Member added");
        expect(details.querySelector(".msg-second-level")?.textContent).toBe("Cause\nRecovery");
        expect(item.querySelector(":scope > .msg-second-level")).toBeNull();
    });
});