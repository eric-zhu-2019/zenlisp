import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { briefMessage, notesToDiagnostics, noteSymbol } from "./commands";

const note = (message: string, offset: number) => ({ message, severity: "warning", location: { file: null, buffer: null, offset, snippet: null }, fixes: [] });

describe("compiler notes in the editor", () => {
  it("reads the symbol a message is about", () => {
    expect(noteSymbol("undefined variable: COMMON-LISP-USER::MISSING-ARG")).toBe("missing-arg");
    expect(noteSymbol("The variable X is defined but never used.")).toBe("x");
    expect(noteSymbol("undefined function: APP::HELPER")).toBe("helper");
    expect(noteSymbol("Lisp error during constant folding")).toBeNull();
  });

  it("underlines that symbol inside the form SBCL pointed at", () => {
    const text = "(defun f (s) (concatenate 'string s missing-arg))";
    const at = text.indexOf("(concatenate");
    const [d] = notesToDiagnostics([note("undefined variable: CL-USER::MISSING-ARG", at)], text);
    expect(text.slice(d.from, d.to)).toBe("missing-arg");
  });

  it("keeps the whole form when the symbol is not in it", () => {
    const text = "(defun f () (g 1))";
    const at = text.indexOf("(g 1)");
    const [d] = notesToDiagnostics([note("The function G is called with one argument, but wants exactly two.", at)], text);
    expect(text.slice(d.from, d.to)).toBe("g");
    const [e] = notesToDiagnostics([note("undefined variable: ZZ", at)], text);
    expect(text.slice(e.from, e.to)).toBe("(g 1)");
  });

  it("shows a Coalton message without the source the underline already marks", () => {
    const malformed = [
      "error: Malformed type alias definition",
      "  --> /Users/me/app/src/main.ct:9:2",
      "   |",
      " 9 |    (declare greet (String -> String))",
      "   |    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ unexpected trailing form",
    ].join("\n");
    const [d] = notesToDiagnostics([note(malformed, 0)], "(declare greet (String -> String))");
    expect(d.message).toBe("Malformed type alias definition\nunexpected trailing form");
    const ambiguous = 'error: Ambiguous predicate\n  --> main.ct:3:5\n   |\n 3 |      (+ x "s")))\n   |       ^ Ambiguous predicate Num String\n   = help: add a type\n';
    expect(briefMessage(ambiguous)).toBe("Ambiguous predicate Num String\n= help: add a type");
    const sbcl = "The function G is called with one argument, but wants exactly two.";
    expect(briefMessage(sbcl)).toBe(sbcl);
  });

  it("offers the edits Coalton suggests, and makes one only where its text still is", () => {
    const text = "(coalton-toplevel (define (f1 x) 1))";
    const fix = { label: "prefix the variable with '_' to declare it unused", offset: text.indexOf("x)"), old: "x", text: "_x" };
    const [d] = notesToDiagnostics([{ ...note("warn: Unused variable", 0), fixes: [fix] }], text);
    expect(d.actions!.map((a) => a.name)).toEqual(["Prefix the variable with '_' to declare it unused", "Copy", "Ask AI to fix"]);
    const view = (doc: string) => {
      const v = { state: EditorState.create({ doc }), dispatch: (spec: object) => (v.state = v.state.update(spec).state) };
      return v as unknown as EditorView;
    };
    const fresh = view(text);
    d.actions![0].apply(fresh, d.from, d.to);
    expect(fresh.state.doc.toString()).toBe("(coalton-toplevel (define (f1 _x) 1))");
    // Typing before the form moves the diagnostic with it, and the fix follows.
    const moved = view(`\n\n${text}`);
    d.actions![0].apply(moved, d.from + 2, d.to + 2);
    expect(moved.state.doc.toString()).toBe("\n\n(coalton-toplevel (define (f1 _x) 1))");
    const changed = view("(coalton-toplevel (define (f1 y) 1))");
    d.actions![0].apply(changed, d.from, d.to);
    expect(changed.state.doc.toString()).toBe("(coalton-toplevel (define (f1 y) 1))");
  });
});
