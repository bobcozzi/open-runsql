// Byte-level SCS page-stream renderer. The bridge sends the raw page stream
// (no CCSID decode) so Presentation Position column bytes keep their exact
// values; we decode EBCDIC text bytes ourselves.

// EBCDIC Cp037 -> char for the invariant + common range. Falls back to space
// for bytes without a mapping we care about (control codes are handled, not
// decoded).
const CP037: Record<number, string> = (() => {
    const m: Record<number, string> = {};
    const digits = "0123456789";
    for (let i = 0; i < 10; i++) m[0xF0 + i] = digits[i];
    const up = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const upStart = [0xC1, 0xD1, 0xE2]; // A-I, J-R, S-Z
    let idx = 0;
    for (const base of upStart) {
        for (let i = 0; i < 9 && idx < 26; i++, idx++) m[base + i] = up[idx];
    }
    const lo = "abcdefghijklmnopqrstuvwxyz";
    const loStart = [0x81, 0x91, 0xA2]; // a-i, j-r, s-z
    idx = 0;
    for (const base of loStart) {
        for (let i = 0; i < 9 && idx < 26; i++, idx++) m[base + i] = lo[idx];
    }
    m[0x40] = " ";
    m[0x4B] = "."; m[0x4C] = "<"; m[0x4D] = "("; m[0x4E] = "+"; m[0x4F] = "|";
    m[0x50] = "&"; m[0x5A] = "!"; m[0x5B] = "$"; m[0x5C] = "*"; m[0x5D] = ")";
    m[0x5E] = ";"; m[0x60] = "-"; m[0x61] = "/"; m[0x6B] = ","; m[0x6C] = "%";
    m[0x6D] = "_"; m[0x6E] = ">"; m[0x6F] = "?"; m[0x7A] = ":"; m[0x7B] = "#";
    m[0x7C] = "@"; m[0x7D] = "'"; m[0x7E] = "="; m[0x7F] = '"';
    return m;
})();

function dec(b: number): string {
    return CP037[b] ?? " ";
}

/** Render raw SCS page-stream bytes to display text. Records are framed by
 * Presentation Position "\x34 <cmd> <parm>" (0xC0/0xC1 = absolute column
 * parm, 1-based) and end on "\x15"/"\x25"/"\x06" (line feed) or "\x0C"
 * (page eject). Plain line-data (no 0x34) passes through with EBCDIC decode.
 * Returns { lines, pageCount }. */
export function renderScsBytes(bytes: Uint8Array): { lines: string[]; pageCount: number } {
    const lines: string[] = [];
    let pageCount = 1;
    let cur = "";
    let i = 0;
    const n = bytes.length;
    const flush = (advance: boolean) => {
        const s = cur.replace(/\s+$/, "");
        if (advance || s) lines.push(s);
        cur = "";
    };
    while (i < n) {
        const b = bytes[i];
        if (b === 0x00) { i++; continue; }
        if (b === 0x0C || b === 0x3A) {            // form feed / required FF
            flush(false);
            lines.push("\f");
            pageCount++;
            i++;
            continue;
        }
        if (b === 0x25 || b === 0x15 || b === 0x06) { flush(true); i++; continue; } // LF/NL/RNL
        if (b === 0x2B && i + 1 < n) {              // SHF/SVF/SLD/SPD setup
            const sub = bytes[i + 1];
            if (sub === 0xC1 || sub === 0xC2 || sub === 0xC6 || sub === 0xD4) {
                const len = bytes[i + 2];           // length byte after code
                i += 3 + (len > 0 ? len - 1 : 0);
                continue;
            }
            i += 2;
            continue;
        }
        if (b === 0x34 && i + 2 < n) {              // Presentation Position
            const cmd = bytes[i + 1];
            const parm = bytes[i + 2];
            if (cmd === 0xC0 || cmd === 0xC1) {     // AHPP: absolute column
                const col = parm - 1;
                if (col > cur.length) cur += " ".repeat(col - cur.length);
                else if (cur && !cur.endsWith(" ")) cur += " ";
            } else if (cmd === 0xC8 || cmd === 0xC9) { // RHPP: move right nn
                cur += " ".repeat(parm);
            } else if (cmd === 0xC4) {              // AVPP: absolute line
                // Set line = parm: pad with blank lines to reach it.
                while (lines.length < parm - 1) lines.push("");
                flush(false);
            } else if (cmd === 0x4C) {              // RVPP: move down nn lines
                flush(true);
                for (let k = 1; k < parm; k++) lines.push("");
            }
            i += 3;
            continue;
        }
        if (b === 0x35 && i + 1 < n) {              // transparent mode
            i += 2 + bytes[i + 1];
            continue;
        }
        if (b < 0x40 && b !== 0x05) { i++; continue; } // other SCS control
        cur += dec(b);
        i++;
    }
    flush(false);
    return { lines, pageCount };
}

/** Decode base64 to bytes and render. Entry point for the spool paths. */
export function renderSpoolBase64(b64: string): { lines: string[]; pageCount: number } {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return renderScsBytes(bin);
}
