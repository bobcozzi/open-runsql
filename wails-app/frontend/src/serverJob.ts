export function formatServerJob(value: string | null | undefined): string {
    if (!value) return "";
    const parts = value.split("/").map((part) => part.trim());
    return parts.length === 3 && parts.every(Boolean) ? parts.join("/") : "";
}