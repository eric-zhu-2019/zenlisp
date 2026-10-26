import { readFileSync } from "node:fs";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import { lispIndentation } from "./indent";
import { initParinferSync, parinfer } from "./parinfer";
import { lispRegionStart } from "./region";

beforeAll(() => {
  initParinferSync({ module: readFileSync(new URL("./parinfer/pkg/parinfer_wasm_bg.wasm", import.meta.url)) });
});

const PROMPT = "CL-USER> ";
const transcript = `${PROMPT}(print "x"\n; (unclosed output from the image\n"x"\n`;

function repl(input = "") {
  return EditorState.create({
    doc: transcript + PROMPT + input,
    selection: { anchor: (transcript + PROMPT + input).length },
    extensions: [
      parinfer(),
      lispIndentation(() => ({})),
      lispRegionStart.of((s) => s.doc.toString().lastIndexOf(PROMPT) + PROMPT.length),
    ],
  });
}

function type(state: EditorState, text: string) {
  for (const ch of text) {
    const at = state.selection.main.head;
    state = state.update({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 }, userEvent: "input.type" }).state;
  }
  return state;
}

const input = (s: EditorState) => s.doc.toString().slice(s.doc.toString().lastIndexOf(PROMPT) + PROMPT.length);

describe("a Lisp region after a REPL prompt", () => {
  it("lets parinfer balance the input and leaves the transcript alone", () => {
    const s = type(repl(), "(defun f (x)");
    expect(input(s)).toBe("(defun f (x))");
    expect(s.doc.toString().startsWith(transcript)).toBe(true);
  });

  it("indents new lines by the columns the user sees after the prompt", () => {
    let s = type(repl(), "(defun f (x)");
    insertNewlineAndIndent({ state: s, dispatch: (tr) => (s = tr.state) });
    s = type(s, "(* 2 x");
    expect(input(s)).toBe(`(defun f (x)\n${" ".repeat(PROMPT.length + 2)}(* 2 x))`);
  });
});
