// Tests for the CL prompter validation engine (validate.ts).
import { describe, expect, it } from "vitest";
import { isCLExpression, validateField, validateSngValExclusivity } from "../src/clprompter/validate";
import { isPseudoValue, parseCmdXml, type ParmDescriptor } from "../src/clprompter/prompterModel";

function parm(partial: Partial<ParmDescriptor>): ParmDescriptor {
    return {
        kwd: "P1", prompt: "P1", min: 0, max: 1, rstd: false,
        choices: [], sngVals: [], full: false, alwVar: true, rtnVal: false,
        exprOk: false, caseMixed: false, dspInput: true,
        isQual: false, isElem: false, children: [], ...partial,
    };
}

describe("isPseudoValue", () => {
    it("filters host pseudo-values", () => {
        expect(isPseudoValue("_RANGE_1_100")).toBe(true);
        expect(isPseudoValue("_REL_GT_50")).toBe(true);
        expect(isPseudoValue("_DEPREL_EQ_OTHER")).toBe(true);
        expect(isPseudoValue("_RANGEMINKWD_LO")).toBe(true);
        expect(isPseudoValue("*SECLVL")).toBe(false);
        expect(isPseudoValue("*SAME")).toBe(false);
    });
});

describe("validateField", () => {
    it("required", () => {
        expect(validateField(parm({ min: 1 }), "")).toMatch(/required/);
        expect(validateField(parm({ min: 1 }), "X")).toBeUndefined();
    });
    it("length and Full", () => {
        expect(validateField(parm({ len: 5 }), "TOOLONG")).toMatch(/limited to 5/);
        expect(validateField(parm({ len: 5, full: true }), "ABC")).toMatch(/exactly 5/);
        expect(validateField(parm({ len: 5, full: true }), "ABCDE")).toBeUndefined();
    });
    it("choice-bearing parms skip storage-length clamp (CHGJOB LOG case)", () => {
        const p = parm({ len: 1, choices: [{ value: "*MSG" }, { value: "*SECLVL" }, { value: "*SAME" }] });
        expect(validateField(p, "*SECLVL")).toBeUndefined();
    });
    it("Rstd restricts to choices/sngvals", () => {
        const p = parm({ rstd: true, choices: [{ value: "*MSG" }], sngVals: ["*SAME"] });
        expect(validateField(p, "*NOPE")).toMatch(/must be one of/);
        expect(validateField(p, "*MSG")).toBeUndefined();
        expect(validateField(p, "*SAME")).toBeUndefined();
    });
    it("numeric types and ranges", () => {
        const p = parm({ type: "DEC", rangeMin: 1, rangeMax: 100 });
        expect(validateField(p, "abc")).toMatch(/numeric/);
        expect(validateField(p, "0")).toMatch(/>= 1/);
        expect(validateField(p, "101")).toMatch(/<= 100/);
        expect(validateField(p, "50")).toBeUndefined();
    });
    it("Rel literal and RelKwd", () => {
        const p = parm({ rel: [{ op: "GE", value: "10" }] });
        expect(validateField(p, "5")).toMatch(/GE 10/);
        expect(validateField(p, "10")).toBeUndefined();

        const pk = parm({ rel: [{ op: "LE", value: "", kwd: "END" }] });
        const gv = (k: string) => (k === "END" ? "99" : "");
        expect(validateField(pk, "100", gv)).toMatch(/LE END/);
        expect(validateField(pk, "99", gv)).toBeUndefined();
    });
    it("variables: AlwVar=NO rejects, RtnVal=YES requires", () => {
        expect(validateField(parm({ alwVar: false }), "&VAR")).toMatch(/does not allow/);
        expect(validateField(parm({ rtnVal: true }), "LITERAL")).toMatch(/requires a CL variable/);
        expect(validateField(parm({ rtnVal: true }), "&RESULT")).toBeUndefined();
    });
    it("variables skip range/length checks", () => {
        expect(validateField(parm({ len: 2, rangeMin: 5 }), "&V")).toBeUndefined();
    });
    it("Expr=YES bypasses static checks for expressions", () => {
        const p = parm({ len: 3, exprOk: true });
        expect(validateField(p, "%SST(&A 1 2)")).toBeUndefined();
        expect(validateField(p, "'A' *CAT 'B'")).toBeUndefined();
    });
    it("NAME-family validation", () => {
        const p = parm({ type: "NAME" });
        expect(validateField(p, "VALID_NAME")).toBeUndefined();
        expect(validateField(p, "1BAD")).toMatch(/not a valid/);
    });
});

describe("validateSngValExclusivity", () => {
    it("exclusive value cannot mix with others", () => {
        const p = parm({ max: 5, sngVals: ["*ALL"] });
        expect(validateSngValExclusivity(p, ["*ALL"])).toBeUndefined();
        expect(validateSngValExclusivity(p, ["A", "B"])).toBeUndefined();
        expect(validateSngValExclusivity(p, ["*ALL", "A"])).toMatch(/cannot be combined/);
    });
});

describe("parseCmdXml choice smarts", () => {
    const XML = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="CHGJOB" Prompt="Change job">
      <Parm Kwd="LOG" Type="CHAR" Len="1" Min="0" Max="4" Prompt="Log">
        <SpcVal Val="*MSG"/><SpcVal Val="*SECLVL"/><SpcVal Val="*SAME"/>
      </Parm>
      <Parm Kwd="OUTQ" Type="QUAL" Prompt="Output queue">
        <QUAL Type="NAME" Len="10" Prompt="Library" />
        <QUAL Type="NAME" Len="10" Prompt="Queue" />
      </Parm>
    </Cmd></QcdCLCmd>`;

    it("parses SpcVal as choices; SngVal as exclusive single values", () => {
        const cmd = parseCmdXml(XML);
        const log = cmd.parms.find((p) => p.kwd === "LOG");
        expect(log?.choices.map((c) => c.value)).toEqual(["*MSG", "*SECLVL", "*SAME"]);
        expect(log?.sngVals).toEqual([]);

        const withSng = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="X">
          <Parm Kwd="MODE" Type="CHAR" Len="10">
            <SpcVal Val="*STD"/><SngVal Val="*ALL"/>
          </Parm>
        </Cmd></QcdCLCmd>`;
        const c2 = parseCmdXml(withSng);
        const mode = c2.parms.find((p) => p.kwd === "MODE");
        expect(mode?.choices.map((c) => c.value)).toEqual(["*STD"]);
        expect(mode?.sngVals).toEqual(["*ALL"]);
    });

    it("QUAL parts map right-to-left (QUAL0 is last)", () => {
        const cmd = parseCmdXml(XML);
        const outq = cmd.parms.find((p) => p.kwd === "OUTQ");
        expect(outq?.children.length).toBe(2);
        // leftmost rendered part is the library (last QUAL in XML order reversed)
        expect(outq?.children[0].prompt).toBe("Queue");
        expect(outq?.children[1].prompt).toBe("Library");
    });
});
