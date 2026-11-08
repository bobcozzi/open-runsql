import { describe, expect, it } from "vitest";
import { parseCmdXml } from "../src/clprompter/prompterModel";
import { showPrompter } from "../src/clprompter/prompterView";

const XML = `<?xml version="1.0"?>
<QcdCLCmd><Cmd CmdName="DSPOBJD" Prompt="Display Object Description">
  <Parm Kwd="OBJ" Type="QUAL" Min="1" PosNbr="1" Prompt="Object">
    <QUAL Type="GENERIC" Len="10" Min="1" Prompt="Name"/>
    <QUAL Type="NAME" Len="10" Prompt="Library" Dft="*LIBL"/>
  </Parm>
  <Parm Kwd="DETAIL" Type="CHAR" Len="1" Rstd="YES" Dft="*BASIC" PosNbr="3" Prompt="Detail">
    <SpcVal><Value Val="*BASIC"/></SpcVal><SpcVal><Value Val="*FULL"/></SpcVal>
  </Parm>
</Cmd></QcdCLCmd>`;

describe("Enter writes command back", () => {
    it("typed value + defaults → command string on Enter", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        let got = "";
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "DSPOBJD", {
            onRun: (t) => { got = t; },
            onClose: () => {},
        });
        // type into OBJ.0
        const obj0 = pane.querySelector<HTMLInputElement>('.prompter-input[data-kwd="OBJ.0"]')!;
        obj0.value = "QCUSTCDT";
        obj0.dispatchEvent(new Event("input", { bubbles: true }));
        const btn = [...pane.querySelectorAll<HTMLButtonElement>(".prompter-actions button")]
            .find((b) => b.textContent === "Enter")!;
        btn.click();
        expect(got).toContain("DSPOBJD");
        expect(got).toContain("OBJ(");
        expect(got).not.toContain("DETAIL"); // default not emitted
        pane.remove();
    });
    it("untouched required field blocks Enter with error banner", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        let got = "";
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "DSPOBJD", { onRun: (t) => { got = t; }, onClose: () => {} });
        const btn = [...pane.querySelectorAll<HTMLButtonElement>(".prompter-actions button")]
            .find((b) => b.textContent === "Enter")!;
        btn.click();
        expect(got).toBe(""); // blocked: OBJ.0 required and empty
        pane.remove();
    });
});
