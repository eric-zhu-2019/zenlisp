// Runs SLIME's own indentation corpus (contrib/test/slime-cl-indent-test.txt
// from slime-v2.30, vendored under fixtures/) the way SLIME's ERT runner does:
// strip each form's indentation, reindent it, expect the original back.

import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { forms, parse } from "../lisp/tree";
import { lispIndentation, reindentRange } from "./indent";

// SLIME's defaults ("basic-common" style). A case that sets any of these to
// something else tests an option ZParen does not have.
const DEFAULTS: Record<string, string> = {
  "lisp-lambda-list-keyword-parameter-alignment": "nil",
  "lisp-lambda-list-keyword-alignment": "nil",
  "lisp-loop-indent-subclauses": "t",
  "lisp-loop-indent-forms-like-keywords": "nil",
  "lisp-align-keywords-in-calls": "t",
  "lisp-lambda-list-indentation": "t",
  "lisp-loop-indent-body-forms-relative-to-loop-start": "nil",
  "lisp-loop-clauses-indentation": "2",
  "lisp-loop-body-forms-indentation": "3",
};

// Emacs comment-command settings that only keep Emacs 25 from moving ;; comments.
const EMACS_ONLY = new Set(["comment-indent-function", "comment-column"]);

// The specs SLIME's test style adds, as Swank would send them.
const SPECS = {
  "complex-indent.1": [["&whole", 4, ["&whole", 1, 1, 1, 1, ["&whole", 1, 1], "&rest", 1], "&body"], "&body"],
  "complex-indent.2": [4, ["&whole", 4, "&rest", 1], "&body"],
  "complex-indent.3": [4, "&body"],
};

type Case = { name: string; expected: string; skip: string | null };

function corpus(): Case[] {
  const text = readFileSync(new URL("./fixtures/slime-cl-indent-test.txt", import.meta.url), "utf8");
  const cases: Case[] = [];
  let current: { name: string; settings: [string, string][] } | null = null;
  for (const node of parse(text)) {
    const src = text.slice(node.from, node.to);
    if (node.kind === "comment") {
      const header = /^;;; Test: (\S+)/.exec(src);
      const setting = /^;;\s*([\w*-]+):\s*(.*?)\s*$/.exec(src);
      if (header) current = { name: header[1], settings: [] };
      else if (setting && current) current.settings.push([setting[1], setting[2]]);
      continue;
    }
    if (!current || !forms([node]).length) continue;
    const unsupported = current.settings.filter(([k, v]) => !EMACS_ONLY.has(k) && DEFAULTS[k] !== v);
    const skip = unsupported.length
      ? unsupported.map(([k, v]) => (k in DEFAULTS ? `${k} ${v} (default ${DEFAULTS[k]})` : `unknown setting ${k}`)).join(", ")
      : null;
    cases.push({ name: current.name, expected: src, skip });
    current = null;
  }
  return cases;
}

function reindent(text: string): string {
  const state = EditorState.create({ doc: text, extensions: lispIndentation(() => SPECS) });
  return state.update(reindentRange(state, 0, text.length)).state.doc.toString();
}

describe("SLIME indentation corpus", () => {
  const cases = corpus();

  it("reads every case in the file", () => {
    expect(cases.map((c) => c.name)).toEqual(Array.from({ length: 95 }, (_, i) => `indent-${i + 1}`));
  });

  for (const c of cases) {
    const stripped = c.expected.replace(/^[ \t]+/gm, "");
    if (c.skip) it.skip(`${c.name}: needs ${c.skip}`, () => {});
    else it(c.name, () => expect(reindent(stripped)).toBe(c.expected));
  }
});
