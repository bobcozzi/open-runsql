import { describe, expect, it } from "vitest";
import { parseCmdXml } from "../src/clprompter/prompterModel";
import { populateFromCommandText, showPrompter } from "../src/clprompter/prompterView";
import { positionalBindingOrder, rewritePositionalParms, type PositionalParm } from "../src/clprompter/positional";

// DSPOBJD-style command: OBJ/OBJTYPE positional (PosNbr 1,2), MaxPos=2 caps the
// leading positionals. OUTFILE's library QUAL is restricted with a QTEMP choice
// so it renders as a <select> and recalls with canonical casing.
const XML = `<?xml version="1.0"?>
<QcdCLCmd><Cmd CmdName="DSPOBJD" Prompt="Display Object Description" MaxPos="2">
  <Parm Kwd="OBJ" Type="QUAL" Min="1" PosNbr="1" Prompt="Object">
    <QUAL Type="GENERIC" Len="10" Min="1" Prompt="Name"/>
    <QUAL Type="NAME" Len="10" Prompt="Library" Dft="*LIBL"/>
  </Parm>
  <Parm Kwd="OBJTYPE" Type="CHAR" Len="7" Rstd="YES" Min="1" Max="93" PosNbr="2" Prompt="Object type">
    <SngVal><Value Val="*ALL"/></SngVal>
    <SpcVal><Value Val="*FILE"/></SpcVal><SpcVal><Value Val="*PGM"/></SpcVal>
  </Parm>
  <Parm Kwd="OUTPUT" Type="CHAR" Len="1" Rstd="YES" Dft="*" PosNbr="5" Prompt="Output">
    <SpcVal><Value Val="*"/></SpcVal><SpcVal><Value Val="*PRINT"/></SpcVal><SpcVal><Value Val="*OUTFILE"/></SpcVal>
  </Parm>
  <Parm Kwd="OUTFILE" Type="QUAL" Min="0" PosNbr="6" Prompt="File to receive output" PmtCtl="PMTCTL">
    <PmtCtl CtlKwd="OUTPUT" NbrTrueRel="EQ" NbrTrue="1"><PmtCtlCond Rel="EQ" CmpVal="*OUTFILE"/></PmtCtl>
    <QUAL Type="NAME" Len="10" Min="1" Prompt="File"/>
    <QUAL Type="NAME" Len="10" Prompt="Library" Dft="*LIBL" Rstd="YES">
      <SpcVal><Value Val="*LIBL"/></SpcVal><SpcVal><Value Val="*CURLIB"/></SpcVal><SpcVal><Value Val="QTEMP"/></SpcVal>
    </QUAL>
  </Parm>
</Cmd></QcdCLCmd>`;

// PositionalParm view of the same command (kwd/posNbr/xmlOrder).
const PARMS: PositionalParm[] = [
    { kwd: "OBJ", posNbr: 1, type: "QUAL", xmlOrder: 0 },
    { kwd: "OBJTYPE", posNbr: 2, type: "CHAR", xmlOrder: 1 },
    { kwd: "OUTPUT", posNbr: 5, type: "CHAR", xmlOrder: 2 },
    { kwd: "OUTFILE", posNbr: 6, type: "QUAL", xmlOrder: 3 },
];

describe("positionalBindingOrder", () => {
    it("binds by XML arrival order, not PosNbr (DCL STG case)", () => {
        // STG has PosNbr=3 for display but arrives last in the command source;
        // LEN/VALUE (PosNbr 4/5) precede it for positional binding.
        const dcl: PositionalParm[] = [
            { kwd: "VAR", posNbr: 1, xmlOrder: 0 },
            { kwd: "TYPE", posNbr: 2, xmlOrder: 1 },
            { kwd: "STG", posNbr: 3, xmlOrder: 4 },
            { kwd: "LEN", posNbr: 4, xmlOrder: 2 },
            { kwd: "VALUE", posNbr: 5, xmlOrder: 3 },
        ];
        expect(positionalBindingOrder(dcl)).toEqual(["VAR", "TYPE", "LEN", "VALUE", "STG"]);
    });

    it("skips parms without PosNbr", () => {
        const parms: PositionalParm[] = [
            { kwd: "HIDDEN", xmlOrder: 0 },
            { kwd: "OBJ", posNbr: 1, xmlOrder: 1 },
        ];
        expect(positionalBindingOrder(parms)).toEqual(["OBJ"]);
    });
});

describe("rewritePositionalParms", () => {
    it("rewrites leading positionals as KWD(value), stopping at the first named parm", () => {
        expect(rewritePositionalParms("DSPOBJD qiws/qcustcdt *file output(*outfile)", PARMS, 2))
            .toBe("DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*file) output(*outfile)");
    });

    it("leaves keyword-only commands untouched", () => {
        const cmd = "DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*file)";
        expect(rewritePositionalParms(cmd, PARMS, 2)).toBe(cmd);
    });

    it("rewrites past a label prefix", () => {
        expect(rewritePositionalParms("MYLBL: DSPOBJD qiws/qcustcdt *file", PARMS, 2))
            .toBe("MYLBL: DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*file)");
    });

    it("rewrites past a CL: statement prefix", () => {
        expect(rewritePositionalParms("CL: DSPOBJD qiws/qcustcdt *file", PARMS, 2))
            .toBe("CL: DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*file)");
    });

    it("stops rewriting after maxPos positionals", () => {
        expect(rewritePositionalParms("DSPOBJD qiws/qcustcdt *file extra output(*outfile)", PARMS, 2))
            .toBe("DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*file) extra output(*outfile)");
    });

    it("keeps a quoted string with spaces and its /qualifier in one positional", () => {
        expect(rewritePositionalParms("DSPOBJD 'my lib'/qcustcdt *file", PARMS, 2))
            .toBe("DSPOBJD OBJ('my lib'/qcustcdt) OBJTYPE(*file)");
    });

    it("gobbles *special/object qualifiers split by the tokenizer", () => {
        expect(rewritePositionalParms("DSPOBJD *libl/qcustcdt", PARMS, 2))
            .toBe("DSPOBJD OBJ(*libl/qcustcdt)");
    });

    it("no MaxPos means no positional rewriting", () => {
        const cmd = "DSPOBJD qiws/qcustcdt";
        expect(rewritePositionalParms(cmd, PARMS, 0)).toBe(cmd);
    });

    it("no positional parms means no rewriting", () => {
        const cmd = "DSPOBJD qiws/qcustcdt";
        expect(rewritePositionalParms(cmd, [{ kwd: "OUTPUT", xmlOrder: 0 }], 9)).toBe(cmd);
    });
});

describe("populateFromCommandText with positionals", () => {
    const val = (pane: HTMLElement, kwd: string) =>
        pane.querySelector<HTMLInputElement | HTMLSelectElement>(`.prompter-input[data-kwd="${kwd}"]`)?.value;

    it("DSPOBJD qiws/qcustcdt *file output(*outfile) outfile(qtemp/custmast)", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "DSPOBJD", { onRun: () => { }, onClose: () => { } },
            "DSPOBJD qiws/qcustcdt *file output(*outfile) outfile(qtemp/custmast)");
        expect(val(pane, "OBJ.0")).toBe("qcustcdt");   // positional QUAL part 0 = object
        expect(val(pane, "OBJ.1")).toBe("qiws");       // positional QUAL part 1 = library
        expect(val(pane, "OBJTYPE")).toBe("*FILE");    // positional select, canonical case
        expect(val(pane, "OUTPUT")).toBe("*OUTFILE");  // lowercase keyword still binds
        expect(val(pane, "OUTFILE.0")).toBe("custmast");
        expect(val(pane, "OUTFILE.1")).toBe("QTEMP");  // restricted select, canonical case
        const part = pane.querySelector<HTMLElement>('.prompter-field[data-parm-kwd="OUTFILE.0"]');
        expect(part?.hidden).toBe(false);
        pane.remove();
    });

    it("keyword-only commands still populate (direct populateFromCommandText)", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "DSPOBJD", { onRun: () => { }, onClose: () => { } });
        const form = pane.querySelector<HTMLElement>(".prompter-form")!;
        populateFromCommandText(form, cmd, "DSPOBJD OBJ(QIWS/QCUSTCDT) OBJTYPE(*PGM)");
        expect(val(pane, "OBJ.0")).toBe("QCUSTCDT");
        expect(val(pane, "OBJ.1")).toBe("QIWS");
        expect(val(pane, "OBJTYPE")).toBe("*PGM");
        pane.remove();
    });

    it("label-prefixed commands populate positionals", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "DSPOBJD", { onRun: () => { }, onClose: () => { } });
        const form = pane.querySelector<HTMLElement>(".prompter-form")!;
        populateFromCommandText(form, cmd, "MYLBL: DSPOBJD qiws/qcustcdt *file");
        expect(val(pane, "OBJ.0")).toBe("qcustcdt");
        expect(val(pane, "OBJ.1")).toBe("qiws");
        expect(val(pane, "OBJTYPE")).toBe("*FILE");
        pane.remove();
    });
});
