import { describe, expect, it } from "vitest";
import { parseCmdXml } from "../src/clprompter/prompterModel";
import { populateFromCommandText, showPrompter } from "../src/clprompter/prompterView";

const XML = `<?xml version="1.0"?>
<QcdCLCmd><Cmd CmdName="DSPOBJD" Prompt="Display Object Description">
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
    <QUAL Type="NAME" Len="10" Prompt="Library" Dft="*LIBL"/>
  </Parm>
</Cmd></QcdCLCmd>`;

describe("round-trip populate", () => {
  it("DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(temp/qcustname)", () => {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const cmd = parseCmdXml(XML);
    showPrompter(pane, cmd, "DSPOBJD", { onRun: () => { }, onClose: () => { } },
      "DSPOBJD OBJ(qiws/qcustcdt) OBJTYPE(*FILE) OUTPUT(*OUTFILE) OUTFILE(temp/qcustname)");
    const val = (kwd: string) =>
      pane.querySelector<HTMLInputElement | HTMLSelectElement>(`.prompter-input[data-kwd="${kwd}"]`)?.value;
    expect(val("OBJ.0")).toBe("qcustcdt");   // QUAL part 0 = object
    expect(val("OBJ.1")).toBe("qiws");       // QUAL part 1 = library
    expect(val("OBJTYPE")).toBe("*FILE");    // select picked
    expect(val("OUTPUT")).toBe("*OUTFILE");
    expect(val("OUTFILE.0")).toBe("qcustname");
    expect(val("OUTFILE.1")).toBe("temp");
    // PmtCtl: OUTFILE parts visible because OUTPUT=*OUTFILE was populated
    // (QUAL-only parms render inline — no .prompter-group wrapper).
    const part = pane.querySelector<HTMLElement>('.prompter-field[data-parm-kwd="OUTFILE.0"]');
    expect(part?.hidden).toBe(false);
    // QUAL-only parms render without a fieldset/group box.
    expect(pane.querySelector('.prompter-group[data-parm-kwd="OUTFILE"]')).toBeNull();
    expect(pane.querySelector('.prompter-group[data-parm-kwd="OBJ"]')).toBeNull();
    pane.remove();
  });
});
