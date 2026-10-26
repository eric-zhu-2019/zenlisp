import { indentSelection, insertNewlineAndIndent } from "@codemirror/commands";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { type IndentSpecs, indentColumn, lispIndentation, reindentForm, reindentRange } from "./indent";

const stateOf = (doc: string, specs: IndentSpecs = {}, cursor = 0) =>
  EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: lispIndentation(() => specs) });

const reindent = (text: string, specs: IndentSpecs = {}) => {
  const state = stateOf(text, specs);
  return state.update(reindentRange(state, 0, text.length)).state.doc.toString();
};

const flatten = (text: string) => text.replace(/^[ \t]+/gm, "");

// Each expected shape was checked against Emacs 31 with slime-cl-indent's
// "basic" style.
const SHAPES: Record<string, string> = {
  "defun body and let bindings": `(defun foo (x y)
  (let ((a 1)
        (b 2))
    (+ a
       b)))`,
  "call arguments under the first argument": `(foo bar
     baz)`,
  "call with nothing after the head": `(foo
 bar)`,
  "flet local definitions": `(flet ((helper (x)
         (* x 2))
       (other ()
         nil))
  (helper 1))`,
  "destructuring-bind": `(destructuring-bind (a b)
    (list 1 2)
  (+ a b))`,
  "handler-case clauses": `(handler-case
    (risky)
  (error (e)
    (print e))
  (:no-error (v)
    v))`,
  cond: `(cond ((null x)
       nil)
      (t
       (car x)))`,
  case: `(case x
  (:a 1)
  ((:b :c)
   2)
  (otherwise 3))`,
  "loop subclauses": `(loop for x in list
      when (evenp x)
        collect x
      finally (return t))`,
  "lambda list keywords": `(defun f (a &optional b
              c
          &key d)
  a)`,
  "unknown def* defaults to defun": `(defthing foo (x)
  body)`,
  "unknown with-* gets a body": `(with-open-thing (s path)
  (read s))`,
  "keyword arguments align": `(make-instance 'point :x 1
                      :y 2)`,
  "backquote templates indent as code": `(defmacro m (x)
  \`(let ((y ,x))
     (list y
           ,@body)))`,
  "feature expressions line up": `(list 1 #+sbcl (sbcl-thing)
        #-sbcl (other-thing))`,
  "quoted lists are data": `(setq data '(a
             b))`,
  "package-qualified operators": `(cl:defun qualified ()
  body)`,
  defmethod: `(defmethod area ((s square))
  (* (side s)
     (side s)))`,
  "destructuring lambda list with defaults": `(defmacro with-thing ((var &key (size 10)
                             name)
                      &body body)
  \`(call ,var ,size ,name ,@body))`,
  "multiple-value-bind": `(multiple-value-bind (q r)
    (floor 7 2)
  (list q r))`,
  dolist: `(dolist (x items)
  (print x))`,
};

describe("reindentRange", () => {
  for (const [name, expected] of Object.entries(SHAPES)) {
    it(name, () => expect(reindent(flatten(expected))).toBe(expected));
  }

  it("leaves string contents and ;;; comments alone, and indents ;; comments as code", () => {
    const text = `(defun f ()
"First line
      second line keeps its spaces."
;; a comment
;;; a section comment
t)`;
    expect(reindent(text)).toBe(`(defun f ()
  "First line
      second line keeps its spaces."
  ;; a comment
;;; a section comment
  t)`);
  });

  it("lets a Swank spec override a built-in", () => {
    const text = "(if (test)\n(then)\n(else))";
    expect(reindent(text)).toBe("(if (test)\n    (then)\n    (else))");
    expect(reindent(text, { if: [4, 2, 2] })).toBe("(if (test)\n  (then)\n  (else))");
  });

  it("uses Swank specs for macros it does not know", () => {
    const text = "(my-macro (a b)\n(c)\n(d))";
    expect(reindent(text)).toBe("(my-macro (a b)\n          (c)\n          (d))");
    expect(reindent(text, { "my-macro": 1 })).toBe("(my-macro (a b)\n  (c)\n  (d))");
    expect(reindent(text, { "my-macro": [4, "&body"] })).toBe("(my-macro (a b)\n  (c)\n  (d))");
  });

  it("empties blank lines and tags the edit as indentation", () => {
    const state = stateOf("(progn\n   \n(a))");
    const tr = state.update(reindentRange(state, 0, state.doc.length));
    expect(tr.state.doc.toString()).toBe("(progn\n\n  (a))");
    expect(tr.isUserEvent("indent")).toBe(true);
  });

  it("only touches lines in the range", () => {
    const text = "(progn\n(a)\n(b))";
    const state = stateOf(text);
    const tr = state.update(reindentRange(state, text.indexOf("(a"), text.indexOf("(a")));
    expect(tr.state.doc.toString()).toBe("(progn\n  (a)\n(b))");
  });

  it("aligns with earlier lines as they stand", () => {
    const text = "(progn\n(a)\n(b))";
    const state = stateOf(text);
    const tr = state.update(reindentRange(state, text.indexOf("(b"), text.indexOf("(b")));
    expect(tr.state.doc.toString()).toBe(text);
  });
});

describe("indentColumn", () => {
  it("indents a line inside an unfinished form", () => {
    const text = "(defun foo (x)\n  (let ((y x))\n";
    expect(indentColumn(text, text.indexOf("  (let"), {})).toBe(2);
    expect(indentColumn(text, text.length, {})).toBe(4);
  });

  it("keeps the current indentation inside a string", () => {
    const text = '(f "a\n     b")';
    expect(indentColumn(text, text.indexOf("     b"), {})).toBe(5);
  });

  it("puts top-level lines at column 0", () => {
    expect(indentColumn("  (foo)", 0, {})).toBe(0);
  });
});

describe("CodeMirror integration", () => {
  const run = (state: EditorState, command: (t: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean) => {
    let out = state;
    command({ state, dispatch: (tr) => (out = tr.state) });
    return out;
  };

  it("indents a new line on Enter", () => {
    const doc = "(defun foo (x)\n  (let ((y x))";
    const s = run(stateOf(doc, {}, doc.length), insertNewlineAndIndent);
    expect(s.doc.toString()).toBe(doc + "\n    ");
  });

  it("indents on Enter in the middle of a line", () => {
    const doc = "(when (ready) (go))";
    const s = run(stateOf(doc, {}, doc.indexOf("(go")), insertNewlineAndIndent);
    expect(s.doc.line(2).text).toBe("  (go))");
  });

  it("reindents a selection the way Vim's = does, using lines already fixed", () => {
    const doc = "(let ((a 1)\n(b 2))\n(+ a\nb))";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: lispIndentation(() => ({})),
    });
    expect(run(state, indentSelection).doc.toString()).toBe("(let ((a 1)\n      (b 2))\n  (+ a\n     b))");
  });

  it("reindents the top-level form at the cursor", () => {
    const doc = "(progn\n(a))\n\n(progn\n(b))";
    const s = run(stateOf(doc, {}, doc.indexOf("(b")), reindentForm);
    expect(s.doc.toString()).toBe("(progn\n(a))\n\n(progn\n  (b))");
  });
});

describe("performance", () => {
  const chunk = flatten(Object.values(SHAPES).join("\n\n")) + "\n\n";
  let text = "";
  while (text.split("\n").length < 2000) text += chunk;
  text = text.split("\n").slice(0, 2000).join("\n");

  // Median of five runs on fresh states, so each run parses the text again.
  const median = (label: string, run: (state: EditorState) => void) => {
    run(stateOf(text));
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const state = EditorState.create({
        doc: text,
        selection: EditorSelection.single(0, text.length),
        extensions: lispIndentation(() => ({})),
      });
      const t0 = performance.now();
      run(state);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    console.log(`${label}, 2000 lines (${text.length} chars): median ${times[2].toFixed(1)} ms, max ${times[4].toFixed(1)} ms`);
    return times[2];
  };

  it("reindents a 2000-line file in under 100 ms", () => {
    expect(median("reindentRange", (s) => reindentRange(s, 0, text.length))).toBeLessThan(100);
  });

  it("reindents a 2000-line selection line by line, as Vim's = does, in under 100 ms", () => {
    expect(median("indentSelection", (s) => indentSelection({ state: s, dispatch: () => {} }))).toBeLessThan(100);
  });
});
