import { describe, expect, it } from "vitest";
import { parseCmdXml } from "../src/clprompter/prompterModel";
import { buildCommand, showPrompter } from "../src/clprompter/prompterView";

// CHGJOB LOG: ELEM x3 — part0 *SAME/*MSG/*SECLVL (Len=1 style), all Dft=*SAME.
const XML = `<?xml version="1.0"?>
<QcdCLCmd><Cmd CmdName="CHGJOB" Prompt="Change job">
  <Parm Kwd="LOG" Type="ELEM" PosNbr="10" Prompt="Log">
    <ELEM Type="CHAR" Len="1" Dft="*SAME" Rstd="YES" Prompt="Job log">
      <SpcVal><Value Val="*SAME"/></SpcVal><SpcVal><Value Val="*MSG"/></SpcVal><SpcVal><Value Val="*SECLVL"/></SpcVal><SpcVal><Value Val="*NOLIST"/></SpcVal>
    </ELEM>
    <ELEM Type="CHAR" Len="1" Dft="*SAME" Rstd="YES" Prompt="Level">
      <SpcVal><Value Val="*SAME"/></SpcVal><SpcVal><Value Val="0"/></SpcVal><SpcVal><Value Val="4"/></SpcVal>
    </ELEM>
    <ELEM Type="CHAR" Len="10" Dft="*SAME" Rstd="YES" Prompt="Text">
      <SpcVal><Value Val="*SAME"/></SpcVal><SpcVal><Value Val="*NOLIST"/></SpcVal><SpcVal><Value Val="*SECLVL"/></SpcVal><SpcVal><Value Val="*MSG"/></SpcVal>
    </ELEM>
  </Parm>
</Cmd></QcdCLCmd>`;

function mkForm() {
    const pane = document.createElement("div");
    document.body.appendChild(pane);
    const cmd = parseCmdXml(XML);
    showPrompter(pane, cmd, "CHGJOB", { onRun: () => {}, onClose: () => {} });
    const form = pane.querySelector<HTMLElement>(".prompter-form")!;
    return { pane, cmd, form };
}
const setVal = (form: HTMLElement, kwd: string, v: string) => {
    const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`.prompter-input[data-kwd="${kwd}"]`)!;
    el.value = v;
};

describe("ELEM positional fill", () => {
    it("last part set → earlier parts emit current (default) values", () => {
        const { pane, cmd, form } = mkForm();
        setVal(form, "LOG.2", "*SECLVL");
        const out = buildCommand("CHGJOB", form, cmd);
        expect(out).toBe("CHGJOB LOG(*SAME *SAME *SECLVL)");
        pane.remove();
    });
    it("nothing touched → no LOG emitted", () => {
        const { pane, cmd, form } = mkForm();
        expect(buildCommand("CHGJOB", form, cmd)).toBe("CHGJOB");
        pane.remove();
    });
    it("first part only → LOG(*MSG) not padded", () => {
        const { pane, cmd, form } = mkForm();
        setVal(form, "LOG.0", "*MSG");
        expect(buildCommand("CHGJOB", form, cmd)).toBe("CHGJOB LOG(*MSG)");
        pane.remove();
    });
});

describe("ELEM positional fill with populated (touched) containers", () => {
    it("CHGJOB LOG(4 0 *SECLVL) prompted, part2→*MSG → LOG(*MSG 4 *MSG)", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "CHGJOB", { onRun: () => {}, onClose: () => {} },
            "CHGJOB LOG(*MSG 4 *SECLVL)");
        const form = pane.querySelector<HTMLElement>(".prompter-form")!;
        const el2 = form.querySelector<HTMLSelectElement>('.prompter-input[data-kwd="LOG.2"]')!;
        el2.value = "*MSG";
        el2.dispatchEvent(new Event("input", { bubbles: true }));
        // buildCommand needs the touched set — grab via a fresh showPrompter-less call:
        // touched lives in FieldCtx; simulate by passing the parent kwd as touched.
        const out = buildCommand("CHGJOB", form, cmd, new Set(["LOG"]));
        expect(out).toBe("CHGJOB LOG(*MSG 4 *MSG)");
        pane.remove();
    });
    it("populated *SAME defaults emit when container touched (LOG(*SAME *SAME *NOLIST))", () => {
        const pane = document.createElement("div");
        document.body.appendChild(pane);
        const cmd = parseCmdXml(XML);
        showPrompter(pane, cmd, "CHGJOB", { onRun: () => {}, onClose: () => {} },
            "CHGJOB LOG(*SAME *SAME *SECLVL)");
        const form = pane.querySelector<HTMLElement>(".prompter-form")!;
        const el2 = form.querySelector<HTMLSelectElement>('.prompter-input[data-kwd="LOG.2"]')!;
        el2.value = "*NOLIST";
        el2.dispatchEvent(new Event("input", { bubbles: true }));
        const out = buildCommand("CHGJOB", form, cmd, new Set(["LOG"]));
        expect(out).toBe("CHGJOB LOG(*SAME *SAME *NOLIST)");
        pane.remove();
    });
});
