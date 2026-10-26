import { describe, expect, it } from "vitest";
import { trimDoc } from "./hover";

describe("trimDoc", () => {
  it("drops Swank's header and keeps the documentation", () => {
    const raw = "Documentation for the symbol MAPCAR:\n\nFunction:\n Arglist: (FUNCTION LIST &REST MORE-LISTS)\n\n Apply FUNCTION to successive tuples.";
    expect(trimDoc(raw)).toBe("Function:\n Arglist: (FUNCTION LIST &REST MORE-LISTS)\n\n Apply FUNCTION to successive tuples.");
  });

  it("shows nothing for unknown or undocumented symbols", () => {
    expect(trimDoc("No such symbol, FOO.")).toBeNull();
    expect(trimDoc("Documentation for the symbol X:\n\n")).toBeNull();
  });

  it("shortens long documentation", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(trimDoc(long)!.split("\n")).toHaveLength(19);
  });
});
