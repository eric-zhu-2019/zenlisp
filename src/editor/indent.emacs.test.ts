// Differential check against Emacs itself: strip the indentation of real
// Lisp files, indent them line by line with Emacs + slime-cl-indent ("basic"
// style, what Tab does), and compare with reindentRange.
//
//   INDENT_ORACLE=1 npx vitest run src/editor/indent.emacs.test.ts
//
// Needs `emacs` on PATH and SLIME under ~/.quicklisp (or SLIME_DIR). Files
// come from the quicklisp software directory (or INDENT_ORACLE_FILES, one path
// per line). Lines starting with a single ; are skipped: Emacs moves those to
// comment-column.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lispIndentation, reindentRange } from "./indent";

const ELISP = `
(add-to-list 'load-path (getenv "SLIME_DIR"))
(add-to-list 'load-path (concat (getenv "SLIME_DIR") "/contrib"))
(require 'slime-cl-indent)
(dolist (pair (seq-partition command-line-args-left 2))
  (with-temp-buffer
    (insert-file-contents (car pair))
    (lisp-mode)
    (setq indent-tabs-mode nil)
    (set (make-local-variable 'lisp-indent-function) 'common-lisp-indent-function)
    (common-lisp-set-style "basic")
    (goto-char (point-min))
    (while (not (eobp))
      (unless (looking-at "^$") (ignore-errors (lisp-indent-line)))
      (forward-line 1))
    (write-region nil nil (cadr pair))))
(setq command-line-args-left nil)
`;

const software = join(homedir(), ".quicklisp/dists/quicklisp/software");

function lispFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) lispFiles(path, out);
    else if (name.endsWith(".lisp") && st.size > 2000 && st.size < 80000) out.push(path);
  }
  return out;
}

describe.skipIf(!process.env.INDENT_ORACLE)("against Emacs", () => {
  it("indents real Lisp files the way Emacs and SLIME do", () => {
    const slime = process.env.SLIME_DIR ?? join(software, readdirSync(software).filter((d) => d.startsWith("slime-v")).sort().pop()!);
    const files = process.env.INDENT_ORACLE_FILES
      ? readFileSync(process.env.INDENT_ORACLE_FILES, "utf8").trim().split("\n")
      : lispFiles(software).filter((_, i) => i % 3 === 0).slice(0, 500);
    const dir = mkdtempSync(join(tmpdir(), "indent-oracle-"));
    writeFileSync(join(dir, "indent.el"), ELISP);
    const inputs = files.map((f, i) => {
      const text = readFileSync(f, "utf8").replace(/\r/g, "").replace(/\t/g, " ").replace(/^ +/gm, "");
      writeFileSync(join(dir, `${i}.lisp`), text);
      return text;
    });
    const args = files.flatMap((_, i) => [join(dir, `${i}.lisp`), join(dir, `${i}.out`)]);
    execFileSync("emacs", ["-Q", "--batch", "-l", join(dir, "indent.el"), ...args], {
      env: { ...process.env, SLIME_DIR: slime },
      stdio: "ignore",
    });

    let lines = 0;
    const diffs: string[] = [];
    inputs.forEach((input, i) => {
      const want = readFileSync(join(dir, `${i}.out`), "utf8").split("\n");
      const state = EditorState.create({ doc: input, extensions: lispIndentation(() => ({})) });
      const got = state.update(reindentRange(state, 0, input.length)).state.doc.toString().split("\n");
      want.forEach((line, l) => {
        if (/^\s*;(?!;)/.test(line)) return;
        lines++;
        const w = line.trimEnd();
        const g = (got[l] ?? "").trimEnd();
        if (w !== g) diffs.push(`${files[i]}:${l + 1}\n  emacs: ${w}\n  ours:  ${g}`);
      });
    });
    console.log(`${diffs.length} of ${lines} lines in ${files.length} files differ from Emacs\n${diffs.join("\n")}`);
    expect(diffs.length / lines).toBeLessThan(0.0005);
  }, 600_000);
});
