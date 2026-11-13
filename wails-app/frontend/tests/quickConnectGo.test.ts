import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL as NodeURL } from "node:url";

const app = vi.hoisted(() => ({
    GetAppSettings: vi.fn(async () => ({})),
    ListConnectionProfiles: vi.fn(async () => [{ name: "Test", host: "host", user: "user" }]),
    GetProfilePassword: vi.fn(async () => ""),
    ListDetached: vi.fn(async () => []),
    Version: vi.fn(async () => "test"),
}));

vi.mock("../src/types", () => ({ App: () => app }));
vi.mock("@wailsio/runtime", () => ({ Events: { On: vi.fn() } }));

describe("quick connect GO", () => {
    it("stays visible while disabled, and enables only for a selected profile", async () => {
        document.documentElement.innerHTML = readFileSync(fileURLToPath(new NodeURL("../index.html", import.meta.url)), "utf8")
            .replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>[\s\S]*$/i, "");
        Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn() }) });
        Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
        Range.prototype.getBoundingClientRect = () => new DOMRect();
        await import("../src/main");
        const go = document.querySelector<HTMLButtonElement>("#btn-go")!;
        expect(go.hidden).toBe(false);
        expect(go.disabled).toBe(true);
        await vi.waitFor(() => expect(app.ListConnectionProfiles).toHaveBeenCalled());
        document.querySelector<HTMLButtonElement>("#btn-saved-hosts")!.click();
        await vi.waitFor(() => expect(document.querySelector('[data-profile-name="Test"]')).toBeTruthy());
        document.querySelector<HTMLButtonElement>('[data-profile-name="Test"]')!.click();
        await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>("#in-host")!.value).toBe("host"));
        expect(go.hidden).toBe(false);
        expect(go.disabled).toBe(false);
        document.querySelector<HTMLInputElement>("#in-host")!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(go.hidden).toBe(false);
        expect(go.disabled).toBe(true);
    });
});