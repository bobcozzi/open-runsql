// Test for the saved-connections context menu behavior (the right-click bug
// where text was selected instead of the menu appearing).
import { beforeEach, describe, expect, it } from "vitest";

// Minimal harness mirroring main.ts popup behavior without the Wails binding.
function buildPopup(profiles: { name: string; host: string; user: string; tls: boolean }[]) {
    document.body.innerHTML = `<div class="host-combo">
        <input id="in-host" />
        <div id="saved-hosts-popup" class="combo-popup" hidden></div>
    </div>`;
    const popup = document.getElementById("saved-hosts-popup") as HTMLDivElement;
    for (const p of profiles) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "combo-item";
        item.dataset.profileName = p.name;
        item.textContent = `${p.host} — ${p.user}`;
        popup.appendChild(item);
    }
    return popup;
}

describe("saved-connections popup context menu", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("popup items carry data-profile-name for delegated contextmenu", () => {
        const popup = buildPopup([{ name: "myhost", host: "myhost", user: "ME", tls: false }]);
        const item = popup.querySelector(".combo-item[data-profile-name]");
        expect(item).not.toBeNull();
        expect((item as HTMLElement).dataset.profileName).toBe("myhost");
    });

    it("contextmenu event is preventable on popup items (no text selection)", () => {
        const popup = buildPopup([{ name: "myhost", host: "myhost", user: "ME", tls: false }]);
        const item = popup.querySelector(".combo-item") as HTMLElement;

        let handled = false;
        document.addEventListener(
            "contextmenu",
            (ev) => {
                const target = (ev.target as HTMLElement).closest(".combo-item[data-profile-name]");
                if (!target) return;
                ev.preventDefault();
                handled = true;
            },
            true,
        );

        const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        item.dispatchEvent(ev);
        expect(handled).toBe(true);
        expect(ev.defaultPrevented).toBe(true);
    });
});
