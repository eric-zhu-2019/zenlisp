import { readFileSync } from "node:fs";
import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CodeMirrorV, InputStateInterface, MotionArgs, vimState } from "@replit/codemirror-vim";
import { beforeAll, describe, expect, it } from "vitest";
import { lisp } from "./lisp";
import { initParinferSync, parinfer } from "./parinfer";
import {
  backwardForm,
  barfBackward,
  barfForward,
  downList,
  expandSelection,
  formObject,
  formObjectMotion,
  forwardForm,
  joinLists,
  keyLabel,
  killForm,
  listInsertPoint,
  raise,
  shrinkSelection,
  slurpBackward,
  slurpForward,
  splice,
  splitList,
  structuralCommands,
  handleOptionKey,
  structuralKeymap,
  transpose,
  upList,
  type FormObject,
  type StructuralCommand,
} from "./structural";

/** "|" marks the cursor; "<sel>" and "</sel>" mark a selection. */
function load(fixture: string, extensions: Extension[] = []): EditorState {
  const sel = fixture.indexOf("<sel>");
  if (sel >= 0) {
    const doc = fixture.replace("<sel>", "").replace("</sel>", "");
    const end = fixture.indexOf("</sel>") - "<sel>".length;
    return EditorState.create({ doc, selection: EditorSelection.single(sel, end), extensions: [lisp(), ...extensions] });
  }
  const at = fixture.indexOf("|");
  return EditorState.create({
    doc: fixture.replace("|", ""),
    selection: EditorSelection.cursor(at),
    extensions: [lisp(), ...extensions],
  });
}

function show(state: EditorState): string {
  const { from, to } = state.selection.main;
  const doc = state.doc.toString();
  if (from === to) return doc.slice(0, from) + "|" + doc.slice(from);
  return doc.slice(0, from) + "<sel>" + doc.slice(from, to) + "</sel>" + doc.slice(to);
}

function apply(command: StructuralCommand, state: EditorState): EditorState | null {
  const spec = command(state);
  return spec ? state.update(spec).state : null;
}

const run = (command: StructuralCommand, fixture: string) => {
  const next = apply(command, load(fixture));
  return next ? show(next) : null;
};

type Case = [input: string, expected: string | null];

const cases: Record<string, [StructuralCommand, Case[]]> = {
  slurpForward: [
    slurpForward,
    [
      ["(a b|) c", "(a b| c)"],
      ["(a (b|) c) d", "(a (b| c)) d"],
      ["(a|) 'b", "(a| 'b)"],
      ["(a|) #'f", "(a| #'f)"],
      ["(a|) `(b ,c)", "(a| `(b ,c))"],
      ["(a|) ; note\nb", "(a| ; note\n b)"],
      ["(when t|)\n(print x)", "(when t|\n  (print x))"],
      ['(when t|)\n"a\n  b"', '(when t|\n  "a\n  b")'],
      ["(when t|)\n#| a\n  b |#\nc", "(when t|\n  #| a\n  b |#\n  c)"],
      ["a| (b)", null],
      ["(a|)", null],
      ["(a| b", null],
      ["(a|) (b", null],
    ],
  ],
  slurpBackward: [
    slurpBackward,
    [
      ["a (b| c)", "(a b| c)"],
      ["x '(b|)", "'(x b|)"],
      ["(f) #(1| 2)", "#((f) 1| 2)"],
      ["(|b)", null],
      ["a| b", null],
    ],
  ],
  barfForward: [
    barfForward,
    [
      ["(a b c|)", "(a b) c|"],
      ["(a| b ; note\n c)", "(a| b) ; note\nc"],
      ["(|a)", "(|) a"],
      ["(a '(b c|))", "(a '(b) c|)"],
      ["(|)", null],
      ["a|", null],
    ],
  ],
  barfBackward: [
    barfBackward,
    [
      ["(a| b c)", "a| (b c)"],
      ["'(a| b)", "a| '(b)"],
      ["(a|)", "a (|)"],
      ["(a |b c)", "a (|b c)"],
      ["(|)", null],
      ["(a| b", null],
    ],
  ],
  raise: [
    raise,
    [
      ["(a (b| c) d)", "(a b| d)"],
      ["(foo (bar |x))", "(foo |x)"],
      ["(list '(a |b))", "(list '|b)"],
      ["(f (g |'x))", "(f |'x)"],
      ["(f (g |#'h))", "(f |#'h)"],
      ["(when t\n  (let ()\n    |(print x)))", "(when t\n  |(print x))"],
      ["(a\n (b\n   |(c\n     d)))", "(a\n |(c\n  d))"],
      ["|a", null],
      ["(a (|b", null],
    ],
  ],
  splice: [
    splice,
    [
      ["(a (b| c) d)", "(a b| c d)"],
      ["(a '(b| c))", "(a b| c)"],
      ["(a #(1| 2))", "(a 1| 2)"],
      ["(when t\n  (progn|\n    (a)\n    (b)))", "(when t\n  progn|\n  (a)\n  (b))"],
      ['(when t\n  (progn| "a\nb"\n    c))', '(when t\n  progn| "a\nb"\n  c)'],
      ["a|", null],
      ["(a| b", null],
    ],
  ],
  killForm: [
    killForm,
    [
      ["(a |b c)", "(a |c)"],
      ["(a b|)", "(a|)"],
      ["(a 'b| c)", "(a |c)"],
      ["(a #'f| c)", "(a |c)"],
      ["(when t\n  |b\n  c)", "(when t|\n  c)"],
      ["(a ; note\n  |b)", "(a ; note\n|)"],
      ["(a |; note\n b)", "(a |; note\n)"],
      ["(a b |; note\n c)", "(a b |; note\n)"],
      ["(|b)", "(|)"],
      ["(a)\n\n|(b)\n\n(c)", "(a)|\n\n(c)"],
      ["(a |b", "(a|"],
      ["(a) |", null],
      ["|", null],
    ],
  ],
  transpose: [
    transpose,
    [
      ["(a |b c)", "(b a| c)"],
      ["(a b|)", "(b a|)"],
      ["('a |#'f)", "(#'f 'a|)"],
      ["(fo|o bar)", "(bar foo|)"],
      ["(a ; c\n |b)", "(b ; c\n a|)"],
      ["(|a)", null],
    ],
  ],
  splitList: [
    splitList,
    [
      ["(a b| c)", "(a b)| (c)"],
      ["#(1| 2)", "#(1)| #(2)"],
      ["'(a| b)", "'(a)| (b)"],
      ["(a\n |b)", "(a)|\n(b)"],
      ["(a|b c)", null],
      ["a| b", null],
      ["(a ;x|\n b)", null],
    ],
  ],
  joinLists: [
    joinLists,
    [
      ["(a b)| (c)", "(a b| c)"],
      ["(a)|(b)", "(a| b)"],
      ["(a) |'(b)", "(a |b)"],
      ["(a) |b", null],
      ["(a|) (b)", null],
    ],
  ],
  forwardForm: [
    forwardForm,
    [
      ["(|a b)", "(a| b)"],
      ["(a b|)", "(a b)|"],
      ["|'(a) b", "'(a)| b"],
      ["(a |; c\n b)", "(a ; c\n b|)"],
      ["a|", null],
    ],
  ],
  backwardForm: [
    backwardForm,
    [
      ["(a b|)", "(a |b)"],
      ["(|a)", "|(a)"],
      ["x '(a) |", "x |'(a) "],
      ["|a", null],
    ],
  ],
  upList: [
    upList,
    [
      ["(a (b |c))", "(a |(b c))"],
      ["'(a |b)", "|'(a b)"],
      ["|a", null],
    ],
  ],
  downList: [
    downList,
    [
      ["|a (b c)", "a (|b c)"],
      ["|'(b)", "'(|b)"],
      ["|#(1)", "#(|1)"],
      ["(a|)", null],
    ],
  ],
};

describe.each(Object.entries(cases))("%s", (_name, [command, table]) => {
  it.each(table)("%j becomes %j", (input, expected) => {
    expect(run(command, input)).toBe(expected);
  });
});

describe("every edit", () => {
  const edits: [StructuralCommand, string][] = [
    [slurpForward, "(when t|)\n(print x)"],
    [barfForward, "(when t\n  (a)\n  |(b))"],
    [raise, "(when t\n  (let ()\n    |(print x)))"],
    [splice, "(when t\n  (progn|\n    (a)\n    (b)))"],
    [splitList, "(a\n |b)"],
  ];

  it.each(edits)("is one undo step tagged structure (%#)", (command, fixture) => {
    const state = load(fixture, [history()]);
    const tr = state.update(command(state)!);
    expect(tr.isUserEvent("structure")).toBe(true);
    let undone = tr.state;
    undo({ state: undone, dispatch: (t) => (undone = t.state) });
    expect(undone.doc.toString()).toBe(state.doc.toString());
  });

  describe("under parinfer", () => {
    beforeAll(() => {
      initParinferSync({ module: readFileSync(new URL("./parinfer/pkg/parinfer_wasm_bg.wasm", import.meta.url)) });
    });

    it.each(edits)("keeps its structure through the next keystroke (%#)", (command, fixture) => {
      const state = load(fixture, [parinfer()]);
      const edited = state.update(command(state)!).state;
      const end = edited.doc.length;
      const typed = edited.update({ changes: { from: end, insert: "\nx" }, userEvent: "input.type" }).state;
      expect(typed.doc.toString()).toBe(edited.doc.toString() + "\nx");
    });
  });
});

describe("expand and shrink selection", () => {
  it("climbs form, list, then outward, and shrinks back down the same steps", () => {
    let state = load("(a (b|c) d)");
    const steps: string[] = [];
    for (;;) {
      const next = apply(expandSelection, state);
      if (!next) break;
      state = next;
      steps.push(show(state));
    }
    expect(steps).toEqual(["(a (<sel>bc</sel>) d)", "(a <sel>(bc)</sel> d)", "<sel>(a (bc) d)</sel>"]);
    const back: string[] = [];
    for (;;) {
      const next = apply(shrinkSelection, state);
      if (!next) break;
      state = next;
      back.push(show(state));
    }
    expect(back).toEqual(["(a <sel>(bc)</sel> d)", "(a (<sel>bc</sel>) d)", "(a (b|c) d)"]);
  });

  it("selects reader prefixes with their form and the whole list from whitespace", () => {
    expect(run(expandSelection, "(f '(a|))")).toBe("(f '(<sel>a</sel>))");
    expect(run(expandSelection, "(f '(<sel>a</sel>))")).toBe("(f <sel>'(a)</sel>)");
    expect(run(expandSelection, "(a | b)")).toBe("<sel>(a  b)</sel>");
  });

  it("does not shrink once the selection has moved or the text changed", () => {
    const expanded = apply(expandSelection, load("(a b|c)"))!;
    expect(apply(shrinkSelection, expanded.update({ selection: EditorSelection.cursor(1) }).state)).toBeNull();
    expect(apply(shrinkSelection, expanded.update({ changes: { from: 0, insert: " " } }).state)).toBeNull();
    expect(apply(shrinkSelection, load("(a b|c)"))).toBeNull();
  });
});

describe("listInsertPoint", () => {
  it("is just inside the enclosing list's delimiters", () => {
    const state = load("(a |b c)");
    expect(listInsertPoint(state, "start")).toBe(1);
    expect(listInsertPoint(state, "end")).toBe(6);
    expect(listInsertPoint(load("|a"), "start")).toBeNull();
  });
});

const A_FORM = { inner: false, topLevel: false };
const INNER_FORM = { inner: true, topLevel: false };
const A_TOP = { inner: false, topLevel: true };
const INNER_TOP = { inner: true, topLevel: true };

describe("Vim form text objects", () => {
  // "|" marks the character under Vim's block cursor.
  const objects: [string, FormObject, string | null][] = [
    ["(a (b |c) d)", A_FORM, "(b c)"],
    ["(a (b |c) d)", INNER_FORM, "b c"],
    ["(a (b |c) d)", A_TOP, "(a (b c) d)"],
    ["(a (b |c) d)", INNER_TOP, "a (b c) d"],
    ["(a |(b c) d)", A_FORM, "(b c)"],
    ["(a (b c|) d)", A_FORM, "(b c)"],
    ["(f '(|a))", A_FORM, "'(a)"],
    ["(f |'(a))", A_FORM, "'(a)"],
    ["(a ; note\n |b)", INNER_FORM, "a ; note\n b"],
    ["(|)", INNER_FORM, ""],
    ["|abc", A_FORM, null],
    ["|abc", A_TOP, "abc"],
    ["(a)\n|\n(b)", A_TOP, null],
  ];

  it.each(objects)("%j with %j selects %j", (fixture, kind, expected) => {
    const state = load(fixture);
    const at = state.selection.main.head;
    const r = formObject(state, { from: at, to: at + 1 }, kind);
    expect(r && state.sliceDoc(r.from, r.to)).toBe(expected);
  });

  it("grows a selection that already covers the object to the next list out", () => {
    const state = load("(a (b c) d)");
    const r = formObject(state, { from: 3, to: 8 }, A_FORM);
    expect(r).toEqual({ from: 0, to: 11 });
    expect(formObject(state, { from: 0, to: 11 }, A_FORM)).toBeNull();
  });

  const motion = (fixture: string, kind: FormObject, visual: vimState["sel"] | null) => {
    const state = load(fixture);
    const head = state.doc.lineAt(state.selection.main.head);
    const cm = { cm6: { state } } as unknown as CodeMirrorV;
    const vim = { visualMode: !!visual, sel: visual } as unknown as vimState;
    const pos = { line: head.number - 1, ch: state.selection.main.head - head.from };
    return formObjectMotion(kind)(cm, pos, { repeat: 1 } as MotionArgs, vim, {} as InputStateInterface);
  };

  it("hands Vim an exclusive range for operators and an inclusive one in Visual mode", () => {
    expect(motion("(x\n (b |c))", A_FORM, null)).toEqual([
      { line: 1, ch: 1 },
      { line: 1, ch: 6 },
    ]);
    const sel = { anchor: { line: 1, ch: 5 }, head: { line: 1, ch: 5 } };
    expect(motion("(x\n (b |c))", A_FORM, sel)).toEqual([
      { line: 1, ch: 1 },
      { line: 1, ch: 5 },
    ]);
    expect(motion("|abc", A_FORM, null)).toBeNull();
  });
});

describe("bindings", () => {
  it("binds every command's keys once, with no key bound twice", () => {
    const keys = structuralKeymap.flatMap((b) => (b.key ? [b.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
    const declared = structuralCommands.filter((c) => c.run).flatMap((c) => c.keys);
    expect(keys).toEqual(declared);
  });

  // What WebKit on macOS reports for Option-letter: the typed character, not the letter.
  const press = (fixture: string, key: string, keyCode: number, shiftKey = false) => {
    let state = load(fixture);
    const view = { get state() { return state; }, dispatch: (spec: TransactionSpec) => (state = state.update(spec).state) };
    const event = { type: "keydown", key, keyCode, altKey: true, shiftKey, ctrlKey: false, metaKey: false };
    const handled = handleOptionKey(view as unknown as EditorView, event as KeyboardEvent);
    return { handled, text: show(state) };
  };

  it("runs Option-letter commands from the key code, as macOS types a character instead", () => {
    expect(press("(a (b| c) d)", "®", 82)).toEqual({ handled: true, text: "(a b| d)" });
    expect(press("(a b| c)", "Í", 83, true)).toEqual({ handled: true, text: "(a b)| (c)" });
    expect(press("(a (b| c) d)", "ø", 79)).toEqual({ handled: false, text: "(a (b| c) d)" });
  });

  it("claims a bound Option-letter even when its command does not apply, so no character is typed", () => {
    expect(press("|a", "®", 82)).toEqual({ handled: true, text: "|a" });
  });

  it("labels keys with macOS symbols", () => {
    expect(keyLabel("Ctrl-Shift-Cmd-ArrowRight")).toBe("⌃⇧⌘→");
    expect(keyLabel("Alt-Shift-s")).toBe("⌥⇧S");
    expect(keyLabel("Ctrl-)")).toBe("⌃)");
  });
});
