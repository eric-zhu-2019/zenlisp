import { describe, expect, it } from "vitest";
import { searchHistory } from "./replBuffer";

describe("REPL history search", () => {
  it("lists matching inputs newest first, each once, ignoring case", () => {
    const past = ["(defun f ())", "(F 1)", "(list 1)", "(f 1)", "(F 1)"];
    expect(searchHistory(past, "f ")).toEqual(["(F 1)", "(f 1)", "(defun f ())"]);
    expect(searchHistory(past, "")).toEqual(["(F 1)", "(f 1)", "(list 1)", "(defun f ())"]);
    expect(searchHistory(past, "zzz")).toEqual([]);
  });
});
