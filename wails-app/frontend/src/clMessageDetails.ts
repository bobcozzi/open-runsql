import type { CLMessage } from "./types";

export function addCLMessageDetails(item: HTMLElement, message: Partial<CLMessage>): void {
    const fields: Array<[string, string | undefined]> = [
        ["Sent by", message.sentByUser], ["Sent at", message.sentTimestamp],
        ["From program", message.fromProgram], ["From module", message.fromModule],
        ["From procedure", message.fromProcedure], ["From statement", message.fromStatement],
        ["To program", message.toProgram], ["To module", message.toModule],
        ["To procedure", message.toProcedure], ["To statement", message.toStatement],
    ];
    const present = fields.filter(([, value]) => value?.trim());
    if (!present.length && !message.secondLevelText?.trim()) return;
    const details = document.createElement("details");
    details.className = "msg-details";
    const summary = document.createElement("summary");
    while (item.firstChild) summary.appendChild(item.firstChild);
    details.appendChild(summary);
    if (message.secondLevelText?.trim()) {
        const help = document.createElement("div");
        help.className = "msg-second-level";
        help.textContent = message.secondLevelText;
        details.appendChild(help);
    }
    if (present.length) {
        const list = document.createElement("dl");
        for (const [label, value] of present) {
            const term = document.createElement("dt");
            term.textContent = label;
            const description = document.createElement("dd");
            description.textContent = value ?? "";
            list.append(term, description);
        }
        details.appendChild(list);
    }
    item.appendChild(details);
}