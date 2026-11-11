import type { SettingDef } from "./settings";

const colors = {
    editorClCommandColor: { storage: "ibmi-runsql-cl-command-color", variable: "--editor-cl-command-color", light: "#075428", dark: "#59ae71" },
    editorClKeywordColor: { storage: "ibmi-runsql-cl-keyword-color", variable: "--editor-cl-keyword-color", light: "#1753ad", dark: "#8ab4f8" },
    editorClValueColor: { storage: "ibmi-runsql-cl-value-color", variable: "--editor-cl-value-color", light: "#198047", dark: "#a5e3b2" },
} as const;

export function clColorSettings(): SettingDef[] {
    return Object.entries(colors).map(([key, color]) => ({
        key,
        type: "color",
        get: () => localStorage.getItem(color.storage) || (document.documentElement.dataset.theme === "dark" ? color.dark : color.light),
        withValue: (settings) => settings,
        persist: async (value) => { localStorage.setItem(color.storage, value); },
    }));
}

export function applyClColorSetting(key: string, value: string): void {
    const color = colors[key as keyof typeof colors];
    if (color) document.documentElement.style.setProperty(color.variable, value);
}

export function restoreClColors(): void {
    for (const [key, color] of Object.entries(colors)) {
        const value = localStorage.getItem(color.storage);
        if (value) applyClColorSetting(key, value);
    }
}