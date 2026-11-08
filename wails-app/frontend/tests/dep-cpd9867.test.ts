import { describe, expect, it } from "vitest";
import { evaluateDepConstraint, type DepEvalContext } from "../src/clprompter/prompterView";

// Real DSPOBJD block: CtlKwdRel="NE" CtlKwd="OUTMBR" CmpVal="*FIRST"
// NbrTrueRel="EQ" NbrTrue="0" → DepParm OUTFILE EQ X'40' must be FALSE (0 met).
const dep = {
    ctlKwdRel: "NE", ctlKwd: "OUTMBR", cmpVal: "*FIRST",
    nbrTrueRel: "EQ", nbrTrue: 0, msgId: "CPD9867",
    depParms: [{ kwd: "OUTFILE", rel: "EQ", cmpVal: "X'40'" }],
};

// Mirrors showPrompter.getValue: container parms proxy to their first child.
const mk = (outmbr0: string, outfile0: string): DepEvalContext => {
    const form = document.createElement("div");
    form.innerHTML =
        `<input class="prompter-input" data-kwd="OUTMBR.0" value="${outmbr0}">` +
        `<input class="prompter-input" data-kwd="OUTMBR.1" value="*REPLACE">` +
        `<input class="prompter-input" data-kwd="OUTFILE.0" value="${outfile0}">`;
    const getValue = (kwd: string): string => {
        const node = form.querySelector<HTMLInputElement>(`.prompter-input[data-kwd="${kwd}"]`)
            ?? form.querySelector<HTMLInputElement>(`.prompter-input[data-kwd="${kwd}.0"]`);
        return node?.value?.trim() ?? "";
    };
    return { form, getValue, dftLookup: () => undefined };
};

describe("DSPOBJD CPD9867 (container control parm)", () => {
    it("OUTMBR at default *FIRST → gate inert, no error", () => {
        expect(evaluateDepConstraint(dep, mk("*FIRST", ""))).toBeNull();
    });
    it("OUTMBR changed + OUTFILE blank → error", () => {
        expect(evaluateDepConstraint(dep, mk("MYMBR", ""))).toMatch(/CPD9867/);
    });
    it("OUTMBR changed + OUTFILE filled → passes", () => {
        expect(evaluateDepConstraint(dep, mk("MYMBR", "MYFILE"))).toBeNull();
    });
});
