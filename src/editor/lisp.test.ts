import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { lispMode } from "./lisp";

function styles(line: string): Record<string, string | null> {
  const state = lispMode.startState!(2);
  const stream = new StringStream(line, 2, 2);
  const out: Record<string, string | null> = {};
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = lispMode.token(stream, state);
    if (stream.current().trim()) out[stream.current()] = style;
  }
  return out;
}

describe("Lisp highlighting", () => {
  it("colors Coalton operators that head a form, as it does Lisp's", () => {
    const s = styles("(coalton-toplevel (declare f (Integer -> Integer)) (define (f x) (match x (_ (fn (y) y)))))");
    expect(s["coalton-toplevel"]).toBe("keyword");
    expect(s["declare"]).toBe("keyword");
    expect(s["define"]).toBe("keyword");
    expect(s["match"]).toBe("keyword");
    expect(s["fn"]).toBe("keyword");
    expect(s["Integer"]).toBe("variableName");
  });

  it("colors a .coal file's package form and its clauses", () => {
    const s = styles("(package zen-coal (import coalton-prelude) (export double))");
    expect(s).toMatchObject({ package: "keyword", import: "keyword", export: "keyword", "zen-coal": "variableName" });
  });

  it("leaves Lisp's import and export alone outside a package form", () => {
    expect(styles("(export '(double))")).toMatchObject({ export: "variableName" });
    expect(styles("(progn (package x) (export y))")).toMatchObject({ package: "variableName", export: "variableName" });
  });

  it("leaves the same names alone where they are not a form's head", () => {
    expect(styles("(list match fn)")).toMatchObject({ list: "variableName", match: "variableName", fn: "variableName" });
  });
});
