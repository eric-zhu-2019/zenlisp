import { describe, expect, it } from "vitest";
import { autodocForm, formAtOrBefore, isComplete, packageAt, symbolAt, topLevelForms } from "./forms";

const src = `(in-package :my-app)

;; a (comment) with parens
(defun greet (name)
  "Say \\"hi\\" (loudly)"
  (format nil "Hello, ~a" name))

#+sbcl (defvar *x* #\\()
'(a b)
`;

describe("topLevelForms", () => {
  it("skips parens in strings, comments and character literals", () => {
    const forms = topLevelForms(src).map((r) => src.slice(r.from, r.to));
    expect(forms).toEqual([
      "(in-package :my-app)",
      `(defun greet (name)\n  "Say \\"hi\\" (loudly)"\n  (format nil "Hello, ~a" name))`,
      "(defvar *x* #\\()",
      "'(a b)",
    ]);
  });

  it("finds the form under or before the cursor", () => {
    const inside = src.indexOf("format");
    expect(src.slice(formAtOrBefore(src, inside)!.from, formAtOrBefore(src, inside)!.to)).toMatch(/^\(defun greet/);
    const after = src.indexOf("name))") + 6;
    expect(src.slice(formAtOrBefore(src, after)!.from, after)).toMatch(/^\(defun greet/);
  });
});

describe("packageAt", () => {
  it("uses the last in-package before the cursor", () => {
    expect(packageAt(src, src.length)).toBe("MY-APP");
    expect(packageAt("(in-package #:foo) (in-package \"BAR\")", 40)).toBe("BAR");
    expect(packageAt("(defun f ())", 5)).toBeNull();
  });

  it("reads the package form a Coalton .coal file starts with", () => {
    const coal = ";; Shapes.\n(package zen-shapes\n  (import coalton-prelude))\n\n(define (area r) (* r r))\n";
    expect(packageAt(coal, coal.length)).toBe("ZEN-SHAPES");
    expect(packageAt("(defun f () (package x))", 20), "only as the first form").toBeNull();
  });
});

describe("symbolAt", () => {
  it("reads symbols including package prefixes and #'", () => {
    const t = "(mapcar #'alexandria:flatten xs)";
    expect(symbolAt(t, t.indexOf("flatten"))?.name).toBe("alexandria:flatten");
    expect(symbolAt(t, 3)?.name).toBe("mapcar");
    expect(symbolAt("(+ 1 22)", 6)).toBeNull();
  });
});

describe("autodocForm", () => {
  it("marks the cursor in the innermost call", () => {
    const t = "(defun f () (with-open-file (s ";
    expect(autodocForm(t, t.length)).toEqual(["with-open-file", ["s", "", { cursor: true }]]);
  });

  it("marks the argument being typed", () => {
    const t = "(mapcar #'car li";
    expect(autodocForm(t, t.length)).toEqual(["mapcar", "#'car", "li", { cursor: true }]);
  });

  it("returns null outside any call", () => {
    expect(autodocForm("(a b) ", 6)).toBeNull();
  });
});

describe("isComplete", () => {
  it("knows when REPL input is ready to send", () => {
    expect(isComplete("(+ 1 2)")).toBe(true);
    expect(isComplete("(+ 1")).toBe(false);
    expect(isComplete('"abc')).toBe(false);
    expect(isComplete("*package*")).toBe(true);
    expect(isComplete("   ")).toBe(false);
    expect(isComplete("(list #\\()")).toBe(true);
  });
});

describe("listEnd", () => {
  it("finds the matching close paren", async () => {
    const { listEnd } = await import("./forms");
    const t = '(a (b ")") #\\) c) d';
    expect(t.slice(0, listEnd(t, 0))).toBe('(a (b ")") #\\) c)');
    expect(listEnd("(a (b", 0)).toBeUndefined();
  });
});
