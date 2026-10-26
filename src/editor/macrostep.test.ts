import { describe, expect, it } from "vitest";
import { stepIn } from "./macrostep";

describe("stepping into a macro form", () => {
  it("indents the expansion to the form's column and keeps every macro form findable", () => {
    const outer = { text: "(IF X\n    (INCF X)\n    (WHEN Y 1))", macros: [{ name: "INCF", start: 10 }, { name: "WHEN", start: 23 }] };
    const inner = { text: "(SETQ X\n (+ 1 X))", macros: [] };
    const r = stepIn(outer, 10, inner);
    expect(r.text).toBe("(IF X\n    (SETQ X\n     (+ 1 X))\n    (WHEN Y 1))");
    expect(r.macros.map((m) => r.text.slice(m.start, m.start + 5))).toEqual(["(WHEN"]);
  });

  it("places macro forms from the inner expansion on their indented lines", () => {
    const outer = { text: "(A\n  (M))", macros: [{ name: "M", start: 5 }] };
    const inner = { text: "(LET ()\n  (UNLESS Z))", macros: [{ name: "UNLESS", start: 10 }] };
    const r = stepIn(outer, 5, inner);
    expect(r.text.slice(r.macros[0].start)).toMatch(/^\(UNLESS Z\)/);
  });
});
