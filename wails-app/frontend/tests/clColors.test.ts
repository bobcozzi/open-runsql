import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClColorSetting, clColorSettings, restoreClColors } from "../src/clColors";
import { createSettingsPane } from "../src/settings";

afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
});

describe("CL editor colors", () => {
    it("shows and applies the three CL swatches in Editor Options", async () => {
        document.documentElement.dataset.theme = "light";
        const pane = createSettingsPane({
            load: async () => ({}), save: async () => {}, onChanged: applyClColorSetting,
        }, [{ key: "editorOptions", type: "group", controls: clColorSettings() }]);
        document.body.append(pane.root);
        await vi.waitFor(() => expect(pane.root.querySelectorAll('input[type="color"]')).toHaveLength(3));
        expect([...pane.root.querySelectorAll(".settings-group-label")].map((label) => label.textContent))
            .toEqual(["CL Cmd Name", "CL Parm Name", "CL Parm Value"]);
        const fields = [...pane.root.querySelectorAll<HTMLInputElement>('input[type="color"]')];
        expect(fields.map((field) => field.value)).toEqual(["#075428", "#1753ad", "#198047"]);
        fields[1].value = "#123456";
        fields[1].dispatchEvent(new Event("change", { bubbles: true }));
        await vi.waitFor(() => expect(document.documentElement.style.getPropertyValue("--editor-cl-keyword-color")).toBe("#123456"));
        expect(localStorage.getItem("ibmi-runsql-cl-keyword-color")).toBe("#123456");
        pane.root.remove();
    });
    it("provides distinct theme-appropriate defaults", () => {
        const settings = clColorSettings();
        document.documentElement.dataset.theme = "light";
        expect(settings.map((setting) => setting.get?.({}))).toEqual(["#075428", "#1753ad", "#198047"]);
        document.documentElement.dataset.theme = "dark";
        expect(settings.map((setting) => setting.get?.({}))).toEqual(["#59ae71", "#8ab4f8", "#a5e3b2"]);
    });

    it("persists, applies, and restores independent color choices", async () => {
        const settings = clColorSettings();
        const values = ["#112233", "#445566", "#778899"];
        for (const [index, setting] of settings.entries()) {
            await setting.persist?.(values[index]);
            applyClColorSetting(setting.key, values[index]);
        }
        const variables = ["--editor-cl-command-color", "--editor-cl-keyword-color", "--editor-cl-value-color"];
        expect(variables.map((variable) => document.documentElement.style.getPropertyValue(variable))).toEqual(values);
        document.documentElement.removeAttribute("style");
        restoreClColors();
        expect(variables.map((variable) => document.documentElement.style.getPropertyValue(variable))).toEqual(values);
        expect(settings.map((setting) => setting.get?.({}))).toEqual(values);
    });
});