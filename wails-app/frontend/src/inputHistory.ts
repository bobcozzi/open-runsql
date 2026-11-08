// Per-connection input history for the SQL/CL editor textarea.
// Model only — DOM wiring lives in main.ts. Recall semantics mirror the
// cozzi-cl-prompter Command Entry: newest-first history, F9/ArrowUp = previous
// (older), F8/ArrowDown = next (newer), and cycling past the newest entry
// restores the buffer the user was typing when they started browsing.

export class InputHistory {
    /** Executed statement texts, newest first. */
    private entries: string[] = [];
    /** -1 = not browsing; 0..n-1 = entries[index] currently recalled. */
    private index = -1;
    /** Buffer stashed when browsing started; restored when cycling past newest. */
    private draft = "";

    get hasHistory(): boolean {
        return this.entries.length > 0;
    }

    get browsing(): boolean {
        return this.index >= 0;
    }

    get size(): number {
        return this.entries.length;
    }

    /** Record an executed statement. Blank text is ignored; consecutive duplicates collapse. */
    push(text: string): void {
        const trimmed = text.trim();
        this.reset();
        if (!trimmed) return;
        if (this.entries[0] === trimmed) return;
        this.entries.unshift(trimmed);
    }

    /**
     * Recall the previous (older) entry. `current` is stashed on the first
     * recall of a browsing session and restored by next() past the newest entry.
     * At the oldest entry, stays on it.
     */
    prev(current: string): string | undefined {
        if (!this.entries.length) return undefined;
        if (this.index === -1) this.draft = current;
        if (this.index < this.entries.length - 1) this.index += 1;
        return this.entries[this.index];
    }

    /** Recall the next (newer) entry; past the newest, restores the stashed draft. */
    next(): string | undefined {
        if (this.index === -1) return undefined;
        this.index -= 1;
        return this.index < 0 ? this.draft : this.entries[this.index];
    }

    /** Exit browsing mode and drop the stash (user typed, or ran a statement). */
    reset(): void {
        this.index = -1;
        this.draft = "";
    }
}

/** Histories keyed by connectionId ("" is the not-connected bucket). */
export class InputHistoryStore {
    private byConnection = new Map<string, InputHistory>();

    for(connectionId: string | null | undefined): InputHistory {
        const key = connectionId ?? "";
        let history = this.byConnection.get(key);
        if (!history) {
            history = new InputHistory();
            this.byConnection.set(key, history);
        }
        return history;
    }
}

/**
 * Decide whether an ArrowUp/ArrowDown keydown on a textarea should trigger
 * history recall instead of caret movement: ArrowUp only with the caret on the
 * first line, ArrowDown only on the last line, and never with an active
 * selection. Returns the recall direction or undefined (behave normally).
 */
export function arrowRecallDirection(
    key: string,
    value: string,
    selectionStart: number,
    selectionEnd: number,
): "prev" | "next" | undefined {
    if (selectionStart !== selectionEnd) return undefined;
    const caretLine = value.slice(0, selectionStart).split("\n").length - 1;
    const lastLine = value.split("\n").length - 1;
    if (key === "ArrowUp" && caretLine === 0) return "prev";
    if (key === "ArrowDown" && caretLine === lastLine) return "next";
    return undefined;
}
