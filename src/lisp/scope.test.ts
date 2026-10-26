import { describe, expect, it } from "vitest";
import { localBinding } from "./scope";

/** The binding found for the symbol at the `|` in `src`, shown as the text from there. */
function bindingOf(src: string) {
  const pos = src.indexOf("|");
  const text = src.replace("|", "");
  const at = localBinding(text, pos);
  return at === null ? null : text.slice(at, at + 12);
}

describe("local bindings for gd", () => {
  it("finds a function's parameters", () => {
    expect(bindingOf("(defun f (alpha &optional (beta 2) &key gamma) (list alpha beta |gamma))")).toBe("gamma) (list");
    expect(bindingOf("(defun f (alpha) (+ |alpha 1))")).toBe("alpha) (+ al");
  });

  it("finds LET and LET* variables, the innermost first", () => {
    expect(bindingOf("(let ((x 1)) (let ((x 2)) (print |x)))")).toBe("x 2)) (print");
    expect(bindingOf("(let* ((a 1) (b a)) (+ a |b))")).toBe("b a)) (+ a b");
  });

  it("finds FLET and LABELS functions, and the parameters of the one the cursor is in", () => {
    expect(bindingOf("(labels ((walk (node) (walk |node))) (walk 1))")).toBe("node) (walk ");
    expect(bindingOf("(flet ((twice (n) (* 2 n))) (|twice 4))")).toBe("twice (n) (*");
  });

  it("finds DOLIST, DESTRUCTURING-BIND, LOOP and method parameters", () => {
    expect(bindingOf("(dolist (item items) (print |item))")).toBe("item items) ");
    expect(bindingOf("(destructuring-bind (a (b c)) x (list a b |c))")).toBe("c)) x (list ");
    expect(bindingOf("(loop for (k v) in pairs collect |v)")).toBe("v) in pairs ");
    expect(bindingOf("(defmethod area ((s square) unit) (* (side |s) unit))")).toBe("s square) un");
  });

  it("finds nothing for a free symbol, a keyword or a global function", () => {
    expect(bindingOf("(defun f (x) (+ x |y))")).toBeNull();
    expect(bindingOf("(defun f (x) (list |:x x))")).toBeNull();
    expect(bindingOf("(defun f (x) (|print x))")).toBeNull();
  });
});
