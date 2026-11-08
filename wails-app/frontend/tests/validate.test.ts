// Tests for the CL prompter validation engine (validate.ts).
import { describe, expect, it } from "vitest";
import { isCLExpression, validateField, validateSngValExclusivity } from "../src/clprompter/validate";
import { isPseudoValue, parseCmdXml, type ParmDescriptor } from "../src/clprompter/prompterModel";
import {
    compareDepValues, evaluateDepConstraint, isParmSpecified, isParmVisible,
    nbrTruePasses, resolveHexLiteral, type DepEvalContext,
} from "../src/clprompter/prompterView";

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
    it("variables are permitted with Expr=NO (AlwVar governs, not Expr)", () => {
        // Default parm() has exprOk: false — variables must still pass every
        // check family: length, NAME, Rstd, range.
        expect(validateField(parm({ len: 2, exprOk: false }), "&LONGVARIABLENAME")).toBeUndefined();
        expect(validateField(parm({ type: "NAME", exprOk: false }), "&OBJ")).toBeUndefined();
        expect(validateField(parm({ rstd: true, choices: [{ value: "*A" }], exprOk: false }), "&X")).toBeUndefined();
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

    it("QUAL parts render in XML document order (object, then library)", () => {
        const cmd = parseCmdXml(XML);
        const outq = cmd.parms.find((p) => p.kwd === "OUTQ");
        expect(outq?.children.length).toBe(2);
        expect(outq?.children[0].prompt).toBe("Library");
        expect(outq?.children[1].prompt).toBe("Queue");
    });

    it("parms sort by PosNbr; unnumbered parms keep document order after", () => {
        const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="ORD" Prompt="Order">
          <Parm Kwd="KWDONLY" Type="CHAR" Len="5"/>
          <Parm Kwd="SECOND" Type="CHAR" Len="5" PosNbr="20"/>
          <Parm Kwd="FIRST" Type="CHAR" Len="5" PosNbr="10"/>
          <Parm Kwd="ALSONOPOS" Type="CHAR" Len="5"/>
        </Cmd></QcdCLCmd>`;
        const cmd = parseCmdXml(xml);
        expect(cmd.parms.map((p) => p.kwd)).toEqual(["FIRST", "SECOND", "KWDONLY", "ALSONOPOS"]);
    });

    it("first QUAL part inherits parent Dft when it is a parent SngVal (JOB(*) case)", () => {
        const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="JOBPARM" Prompt="Job">
          <Parm Kwd="JOB" Type="QUAL" Dft="*" Prompt="Job name">
            <SngVal Val="*"/>
            <QUAL Type="NAME" Len="10" Prompt="Name" />
            <QUAL Type="NAME" Len="10" Prompt="User" />
          </Parm>
        </Cmd></QcdCLCmd>`;
        const cmd = parseCmdXml(xml);
        const job = cmd.parms.find((p) => p.kwd === "JOB");
        expect(job?.children[0].dft).toBe("*");
        expect(job?.children[1].dft).toBeUndefined();
    });
});

describe("Dep/PmtCtl engine", () => {
    const mkCtx = (values: Record<string, string>, dfts: Record<string, string> = {}): DepEvalContext => {
        const form = document.createElement("div");
        for (const [k, v] of Object.entries(values)) {
            const input = document.createElement("input");
            input.className = "prompter-input";
            input.dataset.kwd = k;
            input.value = v;
            form.appendChild(input);
        }
        return {
            form,
            getValue: (k) => values[k] ?? "",
            dftLookup: (k) => dfts[k],
        };
    };

    it("resolveHexLiteral: X'40' and X'4040' are blank", () => {
        expect(resolveHexLiteral("X'40'")).toBe(" ");
        expect(resolveHexLiteral("X'4040'")).toBe(" ");
        expect(resolveHexLiteral("ABC")).toBe("ABC");
    });

    it("compareDepValues: numeric and case-insensitive string", () => {
        expect(compareDepValues("5", "GT", "3")).toBe(true);
        expect(compareDepValues("*SAME", "EQ", "*same")).toBe(true);
        expect(compareDepValues("B", "LT", "A")).toBe(false);
    });

    it("nbrTruePasses: ALL / GT / EQ / NE", () => {
        expect(nbrTruePasses("ALL", 0, 2, 2)).toBe(true);
        expect(nbrTruePasses("ALL", 0, 1, 2)).toBe(false);
        expect(nbrTruePasses("GT", 0, 1, 3)).toBe(true);
        expect(nbrTruePasses("EQ", 2, 2, 3)).toBe(true);
        expect(nbrTruePasses("NE", 1, 1, 3)).toBe(false);
    });

    it("parseCmdXml: Dep with DepParm CmpVal/CmpKwd", () => {
        const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="X">
          <Parm Kwd="A" Type="CHAR" Len="5"/>
          <Parm Kwd="B" Type="CHAR" Len="5"/>
          <Dep CtlKwdRel="ALWAYS" NbrTrueRel="GT" NbrTrue="0" MsgID="CPD0001">
            <DepParm Kwd="A" Rel="EQ" CmpVal="X'40'"/>
            <DepParm Kwd="B" Rel="EQ" CmpKwd="A"/>
          </Dep>
        </Cmd></QcdCLCmd>`;
        const cmd = parseCmdXml(xml);
        expect(cmd.deps.length).toBe(1);
        expect(cmd.deps[0].ctlKwdRel).toBe("ALWAYS");
        expect(cmd.deps[0].depParms).toEqual([
            { kwd: "A", rel: "EQ", cmpVal: "X'40'" },
            { kwd: "B", rel: "EQ", cmpKwd: "A" },
        ]);
    });

    it("evaluateDepConstraint: ALWAYS GT 0 fires when nothing specified", () => {
        const dep = {
            ctlKwdRel: "ALWAYS", nbrTrueRel: "GT", nbrTrue: 0, msgId: "CPD2830",
            depParms: [{ kwd: "A", rel: "SPCFD" }, { kwd: "B", rel: "SPCFD" }],
        };
        const err = evaluateDepConstraint(dep, mkCtx({}));
        expect(err).toMatch(/CPD2830/);
        expect(evaluateDepConstraint(dep, mkCtx({ A: "x" }))).toBeNull();
    });

    it("evaluateDepConstraint: CtlKwdRel=SPCFD gates the constraint", () => {
        const dep = {
            ctlKwdRel: "SPCFD", ctlKwd: "MODE", nbrTrueRel: "ALL", nbrTrue: 0, msgId: "",
            depParms: [{ kwd: "A", rel: "EQ", cmpVal: "Y" }],
        };
        // MODE not specified → constraint inert even though A != Y
        expect(evaluateDepConstraint(dep, mkCtx({ A: "N" }))).toBeNull();
        // MODE specified → constraint active and violated
        expect(evaluateDepConstraint(dep, mkCtx({ MODE: "1", A: "N" }))).toMatch(/not satisfied/);
        expect(evaluateDepConstraint(dep, mkCtx({ MODE: "1", A: "Y" }))).toBeNull();
    });

    it("isParmSpecified: value equal to default does not count", () => {
        const form = document.createElement("div");
        form.innerHTML = `<input class="prompter-input" data-kwd="P1" value="*SAME">`;
        expect(isParmSpecified(form, "P1", () => "*SAME")).toBe(false);
        expect(isParmSpecified(form, "P1", () => "*OTHER")).toBe(true);
    });

    it("parseCmdXml: PmtCtl PMTCTL groups and PMTRQS", () => {
        const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="X">
          <Parm Kwd="MODE" Type="CHAR" Len="1"/>
          <Parm Kwd="OPT" Type="CHAR" Len="5" PmtCtl="PMTCTL">
            <PmtCtl CtlKwd="MODE" NbrTrueRel="EQ" NbrTrue="1">
              <PmtCtlCond Rel="EQ" CmpVal="A"/>
            </PmtCtl>
          </Parm>
          <Parm Kwd="HIDDEN" Type="CHAR" Len="5" PmtCtl="PMTRQS"/>
        </Cmd></QcdCLCmd>`;
        const cmd = parseCmdXml(xml);
        const opt = cmd.pmtCtl.get("OPT");
        expect(opt?.kind).toBe("PMTCTL");
        expect(opt?.groups[0].conds).toEqual([{ rel: "EQ", cmpVal: "A" }]);
        expect(cmd.pmtCtl.get("HIDDEN")?.kind).toBe("PMTRQS");
        expect(cmd.pmtCtl.get("HIDDEN")?.groups).toEqual([]);

        // Visibility: OPT shows only when MODE = A; HIDDEN shows only when specified.
        expect(isParmVisible(opt, "OPT", mkCtx({ MODE: "A" }))).toBe(true);
        expect(isParmVisible(opt, "OPT", mkCtx({ MODE: "B" }))).toBe(false);
        expect(isParmVisible(cmd.pmtCtl.get("HIDDEN"), "HIDDEN", mkCtx({}))).toBe(false);
    });
});

describe("numeric parm special values (RUNPTY case)", () => {
    it("INT2 with *SAME choice validates", () => {
        const p = parm({ type: "INT2", len: 0, dft: "*SAME", rangeMin: 1, rangeMax: 99,
            choices: [{ value: "*SAME" }] });
        expect(validateField(p, "*SAME")).toBeUndefined();
        expect(validateField(p, "50")).toBeUndefined();
        expect(validateField(p, "abc")).toMatch(/numeric/);
        expect(validateField(p, "0")).toMatch(/>= 1/);
    });
});
