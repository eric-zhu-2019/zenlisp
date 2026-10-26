import { readFileSync } from "node:fs";
import { history, undo, undoDepth } from "@codemirror/commands";
import { EditorSelection, EditorState, TransactionSpec } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import {
  initParinferSync,
  parinfer,
  parinferStatus,
  ParinferOptions,
  setParinferEnabled,
  setParinferMode,
  toggleParinfer,
} from "./parinfer";

beforeAll(() => {
  initParinferSync({ module: readFileSync(new URL("./parinfer/pkg/parinfer_wasm_bg.wasm", import.meta.url)) });
});

function editor(fixture: string, opts?: ParinferOptions): EditorState {
  const cursor = fixture.indexOf("^");
  return EditorState.create({
    doc: fixture.replace("^", ""),
    selection: { anchor: Math.max(cursor, 0) },
    extensions: [history(), parinfer(opts)],
  });
}

function show(state: EditorState): string {
  const head = state.selection.main.head;
  return state.sliceDoc(0, head) + "^" + state.sliceDoc(head);
}

function type(state: EditorState, text: string): EditorState {
  for (const ch of text) state = state.update(state.replaceSelection(ch), { userEvent: "input.type" }).state;
  return state;
}

function apply(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update(spec).state;
}

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state;
  command({ state, dispatch: (tr) => (next = tr.state) });
  return next;
}

describe("parinfer smart mode", () => {
  it("closes parens while typing a form", () => {
    expect(show(type(editor("^"), "(defun f (x"))).toBe("(defun f (x^))");
  });

  it("pulls the closer down to a line indented into the form", () => {
    const state = apply(editor("(foo)\n^bar"), { changes: { from: 6, insert: "  " }, userEvent: "input.indent" });
    expect(state.doc.toString()).toBe("(foo\n  bar)");
  });

  it("drops the trailing closer of a deleted opener", () => {
    const state = apply(editor("(foo (^bar baz))"), {
      changes: { from: 5, to: 6 },
      selection: { anchor: 5 },
      userEvent: "delete.backward",
    });
    expect(show(state)).toBe("(foo ^bar baz)");
  });

  it("keeps a pasted multi-line form intact", () => {
    const state = editor("(progn\n  ^)");
    const pasted = apply(state, {
      ...state.replaceSelection("(when x\n    (print x))"),
      userEvent: "input.paste",
    });
    expect(pasted.doc.toString()).toBe("(progn\n  (when x\n    (print x)))");
  });

  it("fixes up a vim line delete", () => {
    const state = apply(editor("^(defun f ()\n  (g))\n(h)"), {
      changes: { from: 0, to: 12 },
      userEvent: "input.type.compose",
    });
    expect(state.doc.toString()).toBe("  (g)\n(h)");
  });

  it("undoes the edit and its correction in one step", () => {
    const start = editor("(a)\n^");
    const typed = type(start, "(");
    expect(typed.doc.toString()).toBe("(a)\n()");
    expect(undoDepth(typed)).toBe(1);
    expect(show(run(typed, undo))).toBe("(a)\n^");
  });

  it("leaves programmatic and remote edits alone", () => {
    const state = apply(editor("^"), { changes: { from: 0, insert: "(foo (bar" } });
    expect(state.doc.toString()).toBe("(foo (bar");
    const replaced = apply(state, { changes: { from: 0, to: state.doc.length, insert: "))" } });
    expect(replaced.doc.toString()).toBe("))");
  });

  it("treats #\\( as a character, not an opener", () => {
    expect(show(type(editor("^"), "(list #\\( x"))).toBe("(list #\\( x^)");
    expect(show(type(editor("^"), '(list #\\| #\\" #\\; x'))).toBe('(list #\\| #\\" #\\; x^)');
  });

  it("ignores parens inside |symbols| and #| block comments |#", () => {
    expect(show(type(editor("^"), "(list |a(b| x"))).toBe("(list |a(b| x^)");
    expect(show(type(editor("#| (( |#\n^"), "(f"))).toBe("#| (( |#\n(f^)");
  });

  it("reports an unclosed quote without touching the text", () => {
    const state = type(editor("(foo ^)"), '"');
    expect(show(state)).toBe('(foo "^)');
    expect(state.field(parinferStatus).error).toMatchObject({ name: "unclosed-quote", pos: 5 });
    expect(type(state, '"').field(parinferStatus).error).toBeNull();
  });

  it("measures columns in display width on lines with wide characters", () => {
    expect(show(type(editor('"漢字" ^'), "(a"))).toBe('"漢字" (a^)');
  });
});

describe("parinfer controls", () => {
  it("exposes the configured mode", () => {
    const state = editor("^", { mode: "indent" });
    expect(state.field(parinferStatus)).toEqual({ enabled: true, mode: "indent", error: null });
    expect(apply(state, { effects: setParinferMode.of("paren") }).field(parinferStatus).mode).toBe("paren");
  });

  it("does nothing while disabled", () => {
    const off = apply(editor("^"), { effects: setParinferEnabled.of(false) });
    expect(show(type(off, "(a"))).toBe("(a^");
    expect(show(type(run(off, toggleParinfer), "(a"))).toBe("(a^)");
  });

  it("paren mode reindents instead of moving parens", () => {
    const state = apply(editor("(foo\n^bar)", { mode: "paren" }), {
      changes: { from: 5, insert: "x" },
      selection: EditorSelection.cursor(6),
      userEvent: "input.type",
    });
    expect(state.doc.toString()).toBe("(foo\n xbar)");
  });
});
