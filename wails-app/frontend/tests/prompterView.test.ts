// Tests for the CL prompter view (prompterView.ts): defaults-as-values,
// buildCommand default skipping, PmtCtl SPCFD default semantics, ELEM form
// defaults, and Val→MapTo internal resolution (valToMapToMap).
import { describe, expect, it } from "vitest";
import { parseCmdXml, type CmdDescriptor } from "../src/clprompter/prompterModel";
import { validateField } from "../src/clprompter/validate";
import {
  buildCommand, evaluateDepConstraint, resolveValToInternal, showPrompter,
  type DepEvalContext,
} from "../src/clprompter/prompterView";

type AnyField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function render(xml: string, cmdInput: string): { host: HTMLElement; cmd: CmdDescriptor; built: () => string } {
  const cmd = parseCmdXml(xml);
  const host = document.createElement("div");
  showPrompter(host, cmd, cmdInput, { onRun: () => { /* not under test */ }, onClose: () => { /* not under test */ } });
  return { host, cmd, built: () => buildCommand(cmdInput, host, cmd) };
}

function field(host: HTMLElement, kwd: string): AnyField {
  const el = host.querySelector<AnyField>(`.prompter-input[data-kwd="${kwd}"]`);
  if (!el) throw new Error(`no prompter input for ${kwd}`);
  return el;
}

describe("defaults are real values", () => {
  const REQUIRED_DFT_XML = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="CHGLIBL" Prompt="Change library list">
      <Parm Kwd="CURLIB" Type="NAME" Len="10" Min="1" Max="1" Dft="*SAME" Prompt="Current library">
        <SpcVal Val="*SAME"/><SpcVal Val="*CRTDFT"/>
      </Parm>
    </Cmd></QcdCLCmd>`;

  it("(a) Min=1 parm with Dft prefills the value and validates clean untouched", () => {
    const { host, cmd } = render(REQUIRED_DFT_XML, "CHGLIBL");
    const f = field(host, "CURLIB");
    expect(f.value).toBe("*SAME");
    expect((f as HTMLInputElement).placeholder).toBe("");
    const parm = cmd.parms.find((p) => p.kwd === "CURLIB")!;
    expect(validateField(parm, f.value)).toBeUndefined();
  });

  it("(b) buildCommand omits KWD at its default and emits it once changed", () => {
    const { host, built } = render(REQUIRED_DFT_XML, "CHGLIBL");
    expect(built()).toBe("CHGLIBL");
    const f = field(host, "CURLIB");
    f.value = "*CRTDFT";
    expect(built()).toBe("CHGLIBL CURLIB(*CRTDFT)");
  });

  it("restricted select preselects the option matching Dft", () => {
    const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="C" Prompt="c">
          <Parm Kwd="MODE" Type="CHAR" Len="7" Rstd="YES" Dft="*NO" Prompt="Mode">
            <SpcVal Val="*YES"/><SpcVal Val="*NO"/>
          </Parm>
        </Cmd></QcdCLCmd>`;
    const { host, built } = render(xml, "C");
    const sel = field(host, "MODE") as HTMLSelectElement;
    expect(sel.tagName).toBe("SELECT");
    expect(sel.value).toBe("*NO");
    // Default preselected → not emitted.
    expect(built()).toBe("C");
    sel.value = "*YES";
    expect(built()).toBe("C MODE(*YES)");
  });

  it("no Dft: restricted select keeps a leading blank option with no value", () => {
    const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="C" Prompt="c">
          <Parm Kwd="MODE" Type="CHAR" Len="7" Rstd="YES" Prompt="Mode">
            <SpcVal Val="*YES"/><SpcVal Val="*NO"/>
          </Parm>
        </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "C");
    const sel = field(host, "MODE") as HTMLSelectElement;
    expect(sel.value).toBe("");
    expect(sel.options[0].value).toBe("");
    expect(sel.options[0].textContent).toBe("");
  });
});

describe("ELEM form defaults (getElemFormDefault)", () => {
  it("restricted ELEM child with no Dft prefills the first allowed value", () => {
    const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="Z" Prompt="z">
          <Parm Kwd="LVL" Type="ELEM" Prompt="Levels">
            <Elem Type="CHAR" Len="5" Rstd="YES" Prompt="Level">
              <SpcVal Val="*ONE"/><SpcVal Val="*TWO"/>
            </Elem>
            <Elem Type="CHAR" Len="5" Prompt="Free"/>
          </Parm>
        </Cmd></QcdCLCmd>`;
    const { host, built } = render(xml, "Z");
    const first = field(host, "LVL.0");
    expect(first.value).toBe("*ONE");
    expect(first.dataset.default).toBe("*ONE");
    expect(field(host, "LVL.1").value).toBe("");
    // Prefilled first-allowed value is a form default → not emitted.
    expect(built()).toBe("Z");
    first.value = "*TWO";
    expect(built()).toBe("Z LVL(*TWO)");
  });

  it("ELEM children inherit the parent composite Dft per part", () => {
    const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="Z" Prompt="z">
          <Parm Kwd="SRC" Type="ELEM" Dft="SRC(1.00 2.00)" Prompt="s">
            <Elem Type="CHAR" Len="6" Prompt="A"/>
            <Elem Type="CHAR" Len="6" Prompt="B"/>
          </Parm>
        </Cmd></QcdCLCmd>`;
    const { host, built } = render(xml, "Z");
    expect(field(host, "SRC.0").value).toBe("1.00");
    expect(field(host, "SRC.1").value).toBe("2.00");
    expect(built()).toBe("Z");
  });
});

describe("PmtCtl SPCFD with defaults", () => {
  const PMTCTL_SPCFD_XML = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="X" Prompt="x">
      <Parm Kwd="MODE" Type="CHAR" Len="10" Dft="*DFT" Prompt="Mode"/>
      <Parm Kwd="OPT" Type="CHAR" Len="5" Prompt="Opt" PmtCtl="PMTCTL">
        <PmtCtl CtlKwd="MODE"><PmtCtlCond Rel="SPCFD"/></PmtCtl>
      </Parm>
    </Cmd></QcdCLCmd>`;

  it("(c) default-filled control counts as not-specified (hidden stays hidden)", () => {
    const { host } = render(PMTCTL_SPCFD_XML, "X");
    const optWrap = host.querySelector<HTMLElement>('.prompter-field[data-parm-kwd="OPT"]')!;
    expect(optWrap.hidden).toBe(true);
    const mode = field(host, "MODE");
    expect(mode.value).toBe("*DFT");
    mode.value = "OTHER";
    mode.dispatchEvent(new Event("input", { bubbles: true }));
    expect(optWrap.hidden).toBe(false);
  });
});

describe("valToMapToMap", () => {
  const MAPTO_XML = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="Y" Prompt="y">
      <Parm Kwd="TYPE" Type="CHAR" Len="5" Rstd="YES" Dft="*NO" Prompt="Type">
        <SpcVal><Value Val="*YES" MapTo="Y"/><Value Val="*NO" MapTo="N"/></SpcVal>
      </Parm>
      <Parm Kwd="OPT" Type="CHAR" Len="5" Prompt="Opt" PmtCtl="PMTCTL">
        <PmtCtl CtlKwd="TYPE"><PmtCtlCond Rel="EQ" CmpVal="Y"/></PmtCtl>
      </Parm>
      <Dep CtlKwdRel="ALWAYS" NbrTrueRel="GT" NbrTrue="0" MsgID="CPD0001">
        <DepParm Kwd="TYPE" Rel="NE" CmpVal="Y"/>
      </Dep>
    </Cmd></QcdCLCmd>`;

  it("parseCmdXml extracts Val→MapTo per keyword", () => {
    const cmd = parseCmdXml(MAPTO_XML);
    expect(cmd.valToInternal["TYPE"]).toEqual({ "*YES": "Y", "*NO": "N" });
  });

  it("resolveValToInternal: direct, case-insensitive, passthrough", () => {
    const map = { TYPE: { "*YES": "Y", "*NO": "N" } };
    expect(resolveValToInternal(map, "TYPE", "*YES")).toBe("Y");
    expect(resolveValToInternal(map, "type", "*yes")).toBe("Y");
    expect(resolveValToInternal(map, "TYPE", "OTHER")).toBe("OTHER");
    expect(resolveValToInternal(map, "NOPE", "*YES")).toBe("*YES");
  });

  it("(d) Dep CmpVal in internal form matches when user picks the display form", () => {
    const cmd = parseCmdXml(MAPTO_XML);
    const mkCtx = (typeVal: string): DepEvalContext => {
      const form = document.createElement("div");
      form.innerHTML = `<input class="prompter-input" data-kwd="TYPE" value="${typeVal}">`;
      return {
        form,
        getValue: (k) => (k === "TYPE" ? typeVal : ""),
        dftLookup: () => undefined,
        resolveToInternal: (k, v) => resolveValToInternal(cmd.valToInternal, k, v),
      };
    };
    // TYPE=*YES → internal "Y" → NE "Y" false → 0 of 1 conditions → violated.
    expect(evaluateDepConstraint(cmd.deps[0], mkCtx("*YES"))).toMatch(/CPD0001/);
    // TYPE=*NO → internal "N" → NE "Y" true → satisfied.
    expect(evaluateDepConstraint(cmd.deps[0], mkCtx("*NO"))).toBeNull();
  });

  it("(d) PmtCtl CmpVal in internal form shows the parm for the display form", () => {
    const { host } = render(MAPTO_XML, "Y");
    const optWrap = host.querySelector<HTMLElement>('.prompter-field[data-parm-kwd="OPT"]')!;
    const type = field(host, "TYPE") as HTMLSelectElement;
    // Default *NO → internal N ≠ Y → hidden.
    expect(type.value).toBe("*NO");
    expect(optWrap.hidden).toBe(true);
    // User picks display form *YES → internal Y = Y → shown.
    type.value = "*YES";
    type.dispatchEvent(new Event("change", { bubbles: true }));
    expect(optWrap.hidden).toBe(false);
  });
});

describe("inline ChoicePgmValues (Choice=__PGM)", () => {
  const CHOICEPGM_XML = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="CHGUSRPRF" Prompt="Change user profile">
      <Parm Kwd="LANGID" Type="CHAR" Len="3" Min="0" Max="1" Rstd="NO" Dft="*SAME"
            Choice="__PGM" ChoicePgm="QLGPMCHC" ChoiceLib="QSYS" Prompt="Language ID">
        <SpcVal><Value Val="*SAME" MapTo="S  "/><Value Val="*SYSVAL" MapTo="X'404040'"/></SpcVal>
        <ChoicePgmText Text="*SAME, *SYSVAL..."></ChoicePgmText>
        <ChoicePgmValues>
          <Value Val="*SAME"/>
          <Value Val="*SYSVAL"/>
          <Value Val="AFR Afrikaans"/>
          <Value Val="ENU US English"/>
        </ChoicePgmValues>
      </Parm>
    </Cmd></QcdCLCmd>`;

  it("parses ChoicePgmValues into value/text pairs", () => {
    const cmd = parseCmdXml(CHOICEPGM_XML);
    const p = cmd.parms.find((x) => x.kwd === "LANGID")!;
    expect(p.choicePgmValues).toEqual([
      { value: "*SAME", text: undefined },
      { value: "*SYSVAL", text: undefined },
      { value: "AFR", text: "Afrikaans" },
      { value: "ENU", text: "US English" },
    ]);
  });

  it("renders choice-program values in the datalist, deduped against SpcVal", () => {
    const { host } = render(CHOICEPGM_XML, "CHGUSRPRF");
    const input = field(host, "LANGID") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT"); // Rstd=NO → text input, not select
    const listId = input.getAttribute("list")!;
    const dl = host.querySelector<HTMLDataListElement>(`datalist#${listId}`)!;
    const values = Array.from(dl.options).map((o) => o.value);
    // *SAME/*SYSVAL appear once (from SpcVal), then AFR/ENU appended.
    expect(values).toEqual(["*SAME", "*SYSVAL", "AFR", "ENU"]);
    const afr = Array.from(dl.options).find((o) => o.value === "AFR")!;
    expect(afr.label).toBe("Afrikaans");
  });

  it("container children inherit the parent's ChoicePgmValues", () => {
    const xml = `<?xml version="1.0"?>
        <QcdCLCmd><Cmd CmdName="Z" Prompt="z">
          <Parm Kwd="P" Type="ELEM" Prompt="p" Choice="__PGM">
            <ChoicePgmValues><Value Val="*ONE One"/><Value Val="*TWO Two"/></ChoicePgmValues>
            <Elem Type="CHAR" Len="5" Prompt="A"/>
          </Parm>
        </Cmd></QcdCLCmd>`;
    const cmd = parseCmdXml(xml);
    const child = cmd.parms[0].children[0];
    expect(child.choicePgmValues.map((c) => c.value)).toEqual(["*ONE", "*TWO"]);
  });
});

describe("Choice attribute hint text", () => {
  const hintFor = (host: HTMLElement, kwd: string): string =>
    host.querySelector<HTMLElement>(`.prompter-field[data-parm-kwd="${kwd}"] .prompter-hint`)?.textContent ?? "";

  it("Choice attr text is parsed; __PGM resolves to ChoicePgmText@Text", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="PLAIN" Type="NAME" Len="10" Min="0" Max="1" Choice="Name" Prompt="Plain"/>
      <Parm Kwd="PGM" Type="CHAR" Len="3" Min="0" Max="1" Rstd="NO" Dft="*SAME"
            Choice="__PGM" ChoicePgm="QLGPMCHC" Prompt="Lang">
        <SpcVal><Value Val="*SAME"/><Value Val="*SYSVAL"/></SpcVal>
        <ChoicePgmText Text="*SAME, *SYSVAL..."></ChoicePgmText>
        <ChoicePgmValues><Value Val="*SAME"/><Value Val="AFR Afrikaans"/></ChoicePgmValues>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const cmd = parseCmdXml(xml);
    expect(cmd.parms.find((p) => p.kwd === "PLAIN")!.choice).toBe("Name");
    expect(cmd.parms.find((p) => p.kwd === "PGM")!.choice).toBe("*SAME, *SYSVAL...");
  });

  it("Choice text claims the hint slot over the length hint", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="LANGID" Type="CHAR" Len="3" Min="0" Max="1" Rstd="NO" Dft="*SAME"
            Choice="__PGM" ChoicePgm="QLGPMCHC" Prompt="Language ID">
        <SpcVal><Value Val="*SAME"/><Value Val="*SYSVAL"/></SpcVal>
        <ChoicePgmText Text="*SAME, *SYSVAL..."></ChoicePgmText>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "C");
    expect(hintFor(host, "LANGID")).toBe("*SAME, *SYSVAL...");
    // Default still prefilled as a real value.
    expect(field(host, "LANGID").value).toBe("*SAME");
  });

  it("host Choice text wins over the derived range hint", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="ITV" Type="INT2" Min="0" Max="1" Rstd="NO" Dft="*SAME"
            RangeMinVal="1" RangeMaxVal="366" Choice="1-366" Prompt="Interval">
        <SpcVal><Value Val="*SAME"/></SpcVal>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "C");
    // "1-366" type word + the *SAME special value appended.
    expect(hintFor(host, "ITV")).toBe("1-366, *SAME");
  });

  it("lone GE 0 baseline constraint is suppressed so Choice text shows (CCSID)", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="CCSID" Type="INT4" Min="0" Max="1" Rstd="NO" Dft="*SAME"
            Rel="GE" RelVal="0" Choice="__PGM" ChoicePgm="QTBCCLST" Prompt="Coded character set ID">
        <SpcVal><Value Val="*SAME"/><Value Val="*SYSVAL"/><Value Val="*HEX"/></SpcVal>
        <ChoicePgmText Text="*SAME, *SYSVAL, *HEX..."></ChoicePgmText>
        <ChoicePgmValues><Value Val="*SAME"/><Value Val="37"/></ChoicePgmValues>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "C");
    expect(hintFor(host, "CCSID")).toBe("*SAME, *SYSVAL, *HEX...");
  });

  it("range/rel hint shows in ACS operator form only when no Choice text", () => {
    const withChoice = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="MAXSTG" Type="INT4" Min="0" Max="1" Rstd="NO" Dft="*SAME"
            Rel="GE" RelVal="0" RangeMinVal="5" Choice="Kilobytes" Prompt="Storage">
        <SpcVal><Value Val="*SAME"/></SpcVal>
      </Parm>
    </Cmd></QcdCLCmd>`;
    expect(hintFor(render(withChoice, "C").host, "MAXSTG")).toBe("Kilobytes, *SAME");
    const noChoice = withChoice.replace(' Choice="Kilobytes"', "");
    // Range present → GE 0 not suppressed → "5 to, >= 0".
    expect(hintFor(render(noChoice, "C").host, "MAXSTG")).toBe("5 to, >= 0");
  });

  it("QUAL parts show only their own Choice text (no parent inheritance)", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="PGM" Type="QUAL" Min="0" Max="1" Choice="*SAME, *NONE" Prompt="Program">
        <Qual Type="NAME" Len="10" Min="1" Max="1" Prompt="Program" Choice="Name"/>
        <Qual Type="NAME" Len="10" Min="0" Max="1" Prompt="Library"/>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const cmd = parseCmdXml(xml);
    const pgm = cmd.parms.find((p) => p.kwd === "PGM")!;
    expect(pgm.children[0].choice).toBe("Name");      // own
    expect(pgm.children[1].choice).toBeUndefined();   // no parent bleed
  });

  it("QUAL datalist: parent SngVal scopes to part 0, not the Library part", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="CHGUSRPRF" Prompt="c">
      <Parm Kwd="INLPGM" Type="QUAL" Min="0" Max="1" Prompt="Initial program" Rstd="NO" Dft="*SAME" Choice="*SAME, *NONE">
        <SngVal><Value Val="*SAME"/><Value Val="*NONE"/></SngVal>
        <Qual Type="NAME" Min="1" Max="1" Len="10" Rstd="NO" Choice="Name" Prompt="Program"></Qual>
        <Qual Type="NAME" Min="0" Max="1" Prompt="Library" Len="10" Rstd="NO" Dft="*LIBL" Choice="Name">
          <SpcVal><Value Val="*LIBL"/><Value Val="*CURLIB"/></SpcVal>
        </Qual>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "CHGUSRPRF");
    const opts = (kwd: string) => {
      const input = field(host, kwd) as HTMLInputElement;
      const dl = host.querySelector<HTMLDataListElement>(`datalist[id="${input.getAttribute("list")}"]`)!;
      return Array.from(dl.options).map((o) => o.value);
    };
    // Part 0 (whole-value slot): parent *SAME/*NONE.
    expect(opts("INLPGM.0")).toEqual(["*SAME", "*NONE"]);
    // Part 1 (Library): only its own *LIBL/*CURLIB — no parent *SAME/*NONE.
    expect(opts("INLPGM.1")).toEqual(["*LIBL", "*CURLIB"]);
    // Part 0 merges its type word with the parent's whole-value specials.
    expect(hintFor(host, "INLPGM.0")).toBe("Name, *SAME, *NONE");
    // Part 1 (Library): its type word + its own *LIBL/*CURLIB.
    expect(hintFor(host, "INLPGM.1")).toBe("Name, *LIBL, *CURLIB");
    // Parts render inside the shaded band (no fieldset box).
    const band = host.querySelector(".prompter-qual-band[data-parm-kwd=\"INLPGM\"]")!;
    expect(band).not.toBeNull();
    expect(band.querySelectorAll(".prompter-field").length).toBe(2);
    expect(host.querySelector(".prompter-group[data-parm-kwd=\"INLPGM\"]")).toBeNull();
  });

  it("QUAL Number part: host Choice text wins over derived range (leading zeros kept)", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="CHGJOB" Prompt="c">
      <Parm Kwd="JOB" Type="QUAL" Min="0" Max="1" Prompt="Job name" Rstd="NO" Dft="*" Choice="*">
        <SngVal><Value Val="*"/></SngVal>
        <Qual Type="NAME" Len="10" Min="1" Max="1" Choice="Name"/>
        <Qual Type="CHAR" Len="6" Min="0" Max="1" Prompt="Number" RangeMinVal="000000" RangeMaxVal="999999" Full="YES" Choice="000000-999999"/>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "CHGJOB");
    expect(hintFor(host, "JOB.0")).toBe("Name, *");         // type word + parent's whole-value
    expect(hintFor(host, "JOB.1")).toBe("000000-999999");  // host text, not "0 to 999999"
  });

  it("QUAL band: all part hints render and parts 1+ indent under part 0", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="CHGJOB" Prompt="Change Job">
      <Parm Kwd="JOB" Type="QUAL" Min="0" Max="1" Prompt="Job name" Rstd="NO" Dft="*" Choice="*">
        <SngVal><Value Val="*"/></SngVal>
        <Qual Type="NAME" Min="1" Max="1" Len="10" Rstd="NO" Choice="Name"/>
        <Qual Type="NAME" Min="0" Max="1" Prompt="User" Len="10" Rstd="NO" Choice="Name"/>
        <Qual Type="CHAR" Min="0" Max="1" Prompt="Number" Len="6" Rstd="NO" Full="YES" Choice="000000-999999"/>
      </Parm>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "CHGJOB");
    // Every part's hint renders (none missing).
    expect(hintFor(host, "JOB.0")).toBe("Name, *");        // type word + parent whole-value
    expect(hintFor(host, "JOB.1")).toBe("Name");
    expect(hintFor(host, "JOB.2")).toBe("000000-999999");
    // Band groups the parts; part 0 flush, parts 1+ indent (CSS sibling rule).
    const band = host.querySelector('.prompter-qual-band[data-parm-kwd="JOB"]')!;
    const fields = band.querySelectorAll(":scope > .prompter-field");
    expect(fields.length).toBe(3);
    expect(fields[0].previousElementSibling).toBeNull();            // part 0 first
    expect(fields[1].previousElementSibling).toBe(fields[0]);       // + selector applies
    expect(fields[2].previousElementSibling).toBe(fields[1]);
  });

  it("no Choice and no constraints falls back to the length hint", () => {
    const xml = `<?xml version="1.0"?>
    <QcdCLCmd><Cmd CmdName="C" Prompt="c">
      <Parm Kwd="TXT" Type="CHAR" Len="50" Min="0" Max="1" Prompt="Text"/>
    </Cmd></QcdCLCmd>`;
    const { host } = render(xml, "C");
    expect(hintFor(host, "TXT")).toBe("max 50 chars");
  });
});
