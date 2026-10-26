import { describe, expect, it } from "vitest";
import { notesToDiagnostics, noteSymbol } from "./commands";

const note = (message: string, offset: number) => ({ message, severity: "warning", location: { file: null, buffer: null, offset, snippet: null } });

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
});
