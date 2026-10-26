import { describe, expect, it } from "vitest";
import { bodyEnd, bodyStart, breakpointForm, definitionOf, enclosingList, formAt, forms, headName, parse, parseRange, pathAt, type Node } from "./tree";

const show = (text: string, nodes: Node[]): string[] => nodes.map((n) => text.slice(n.from, n.to));

describe("formBefore", () => {
  it("picks the expression before point, as C-x C-e does", async () => {
    const { formBefore } = await import("./tree");
    const t = "(defun f () (list (+ 1 2) 'x))";
    const at = (marker: string, offset = marker.length) => {
      const n = formBefore(t, t.indexOf(marker) + offset);
      return n ? t.slice(n.from, n.to) : null;
    };
    expect(at("(+ 1 2)")).toBe("(+ 1 2)");
    expect(at("'x")).toBe("'x");
    expect(at("(+ 1 2)", 3)).toBe("+");
    expect(at("(+ 1 2)", 4)).toBe("1");
    expect(formBefore(t, t.length)).toMatchObject({ from: 0, to: t.length });
    expect(formBefore("  (a)", 1)).toBeNull();
  });
});

describe("parse", () => {
  it("reads nested lists, atoms, strings and comments with exact ranges", () => {
    const t = `(defun f (x) ; note\n  "doc (with parens)"\n  (+ x 1))`;
    const [top] = parse(t);
    expect(top.kind).toBe("list");
    expect(t.slice(top.from, top.to)).toBe(t);
    expect(show(t, top.children)).toEqual(["defun", "f", "(x)", "; note", '"doc (with parens)"', "(+ x 1)"]);
    expect(show(t, forms(top.children))).toHaveLength(5);
  });

  it("attaches reader prefixes to the form they precede", () => {
    const t = "'(a) `(b ,c ,@d) #'car #+sbcl (e) #-(or ccl ecl) f";
    expect(show(t, parse(t))).toEqual(["'(a)", "`(b ,c ,@d)", "#'car", "#+sbcl (e)", "#-(or ccl ecl) f"]);
    const [, quasi] = parse(t);
    expect(show(t, quasi.children)).toEqual(["b", ",c", ",@d"]);
  });

  it("does not open lists on character literals or inside |symbols|", () => {
    const t = "(list #\\( #\\Space |a (b| c)";
    const [top] = parse(t);
    expect(top.closed).toBe(true);
    expect(show(t, top.children)).toEqual(["list", "#\\(", "#\\Space", "|a (b|", "c"]);
  });

  it("honours backslash escapes inside |symbols|", () => {
    const t = "(a :|>\\|| b)";
    expect(show(t, parse(t)[0].children)).toEqual(["a", ":|>\\||", "b"]);
  });

  it("keeps vectors and nested block comments", () => {
    const t = "#(1 2) #| a #| b |# c |# x";
    expect(show(t, parse(t))).toEqual(["#(1 2)", "#| a #| b |# c |#", "x"]);
  });

  it("marks unclosed lists instead of guessing", () => {
    const t = "(defun f (x";
    const [top] = parse(t);
    expect(top.closed).toBe(false);
    expect(top.to).toBe(t.length);
    expect(top.children[2].closed).toBe(false);
  });
});

describe("parseRange", () => {
  it("parses part of a text with ranges in the whole text", () => {
    const t = "(a #+(or sbcl\n      ccl) b)";
    const from = t.indexOf("(or");
    const [feature] = parseRange(t, from, t.indexOf(" b)"));
    expect(show(t, [feature])).toEqual(["(or sbcl\n      ccl)"]);
    expect(show(t, feature.children)).toEqual(["or", "sbcl", "ccl"]);
  });
});

describe("positions", () => {
  const t = "(a (b c) d)";
  const nodes = parse(t);

  it("finds the innermost enclosing list", () => {
    expect(show(t, [enclosingList(nodes, t.indexOf("c"))!])).toEqual(["(b c)"]);
    expect(show(t, [enclosingList(nodes, t.indexOf("d"))!])).toEqual([t]);
    expect(enclosingList(nodes, 0)).toBeNull();
    expect(enclosingList(nodes, t.length)).toBeNull();
  });

  it("finds the form the cursor touches", () => {
    expect(show(t, [formAt(nodes, t.indexOf("(b"))!])).toEqual(["(b c)"]);
    expect(show(t, [formAt(nodes, t.indexOf(") d"))!])).toEqual(["c"]);
    expect(pathAt(nodes, t.indexOf("b")).map((n) => n.kind)).toEqual(["list", "list", "atom"]);
  });

  it("names a list's head", () => {
    expect(headName(t, nodes[0])).toBe("a");
  });

  it("finds a list's body inside its delimiters", () => {
    const v = "'#(1 2) (a";
    const [vector, open] = parse(v);
    expect(v.slice(bodyStart(v, vector), bodyEnd(vector))).toBe("1 2");
    expect(v.slice(bodyStart(v, open), bodyEnd(open))).toBe("a");
  });
});

describe("definitions", () => {
  it("lists top-level definitions with their names", async () => {
    const { definitions } = await import("./tree");
    const t = "(in-package :x)\n(defun f (a) a)\n(defstruct (point (:conc-name p-)) x y)\n(define-condition oops (error) ())\n#+sbcl (defvar *v* 1)";
    expect(definitions(t).map((d) => `${d.kind} ${d.name}`)).toEqual(["defun f", "defstruct point", "define-condition oops", "defvar *v*"]);
  });
});

describe("breakpointForm", () => {
  const text = '(defun main ()\n  (let ((a (greet "x")))\n    (write-line a)))\n';
  const line = (n: number) => {
    const lines = text.split("\n");
    const from = lines.slice(0, n - 1).join("\n").length + (n > 1 ? 1 : 0);
    return [from, from + lines[n - 1].length] as const;
  };
  const picked = (n: number) => {
    const r = breakpointForm(text, ...line(n));
    return r && text.slice(r.from, r.to);
  };

  it("takes the first call starting on the line", () => {
    expect(picked(2)).toBe('(let ((a (greet "x")))\n    (write-line a))');
    expect(picked(3)).toBe("(write-line a)");
  });

  it("never takes a top-level form or a list that is not a call", () => {
    expect(picked(1)).toBeNull();
  });
});

describe("finding a definition in unloaded source", () => {
  it("matches the symbol's name in any case and package", () => {
    const text = '(in-package #:app)\n\n(defun greet (name) name)\n(defmacro with-x (&body b) b)\n(defun (setf thing) (v) v)\n';
    expect(definitionOf(text, "greet")).toBe(text.indexOf("(defun greet"));
    expect(definitionOf(text, "APP::GREET")).toBe(text.indexOf("(defun greet"));
    expect(definitionOf(text, "with-x")).toBe(text.indexOf("(defmacro"));
    expect(definitionOf(text, "missing")).toBeNull();
  });
});
