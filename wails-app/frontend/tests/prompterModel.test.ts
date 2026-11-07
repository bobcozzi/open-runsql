// Tests for the CL prompter model: CMDD0200 XML -> ParmDescriptor filtering.
import { describe, expect, it } from "vitest";
import { parseCmdXml } from "../src/clprompter/prompterModel";

const CHGLIBL_XML = `<?xml version="1.0"?>
<QcdCLCmd>
  <Cmd CmdName="CHGLIBL" CmdLib="QSYS" Prompt="Change library list" MaxPos="0">
    <Parm Kwd="LIBL" Type="ELEM" Min="0" Max="250" Prompt="Libraries" PosNbr="1">
      <Elem Type="NAME" Len="10" Prompt="Library" />
    </Parm>
    <Parm Kwd="INV" Type="CHAR" Len="10" Constant="*INL" />
    <Parm Kwd="CURLIB" Type="NAME" Len="10" Min="0" Max="1" Dft="*SAME" Prompt="Current library">
      <SpcVal Val="*SAME" ValTxt="Same" />
      <SpcVal Val="*CRTDFT" ValTxt="Create default" />
    </Parm>
  </Cmd>
</QcdCLCmd>`;

describe("parseCmdXml", () => {
    it("parses command identity", () => {
        const cmd = parseCmdXml(CHGLIBL_XML);
        expect(cmd.name).toBe("CHGLIBL");
        expect(cmd.library).toBe("QSYS");
    });

    it("filters out Constant parms (the phantom INV bug)", () => {
        const cmd = parseCmdXml(CHGLIBL_XML);
        expect(cmd.parms.map((p) => p.kwd)).not.toContain("INV");
        expect(cmd.parms.map((p) => p.kwd)).toEqual(["LIBL", "CURLIB"]);
    });

    it("detects container parms and children", () => {
        const cmd = parseCmdXml(CHGLIBL_XML);
        const libl = cmd.parms.find((p) => p.kwd === "LIBL");
        expect(libl?.isElem).toBe(true);
        expect(libl?.max).toBe(250);
        expect(libl?.children.length).toBe(1);
        expect(libl?.children[0].type).toBe("NAME");
    });

    it("extracts SpcVal choices", () => {
        const cmd = parseCmdXml(CHGLIBL_XML);
        const curlib = cmd.parms.find((p) => p.kwd === "CURLIB");
        expect(curlib?.choices.map((c) => c.value)).toEqual(["*SAME", "*CRTDFT"]);
        expect(curlib?.dft).toBe("*SAME");
    });
});
