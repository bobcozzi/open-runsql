export function createToolbarStatus(element: HTMLElement, currentConnection: () => string | null, events: Document = document) {
    let owner: string | null = null;
    const clear = () => { element.textContent = ""; owner = null; };
    for (const type of ["pointerdown", "click", "keydown", "input", "change", "wheel", "touchstart", "contextmenu"]) {
        events.addEventListener(type, clear, { capture: true, passive: true });
    }
    events.defaultView?.addEventListener("blur", clear);
    return {
        clear,
        sync(): void {
            if (owner !== null && owner !== currentConnection()) clear();
        },
        show(message: string, connectionId: string): void {
            if (connectionId && currentConnection() === connectionId) {
                owner = connectionId;
                element.textContent = message;
            }
        },
    };
}