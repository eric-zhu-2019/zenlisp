import { describe, expect, it } from "vitest";
import { designatorToken } from "./designators";

/** The token being typed at the `|` in `src`. */
function at(src: string) {
  const pos = src.indexOf("|");
  return designatorToken(src.replace("|", ""), pos);
}

describe("a name that could be a package or a system", () => {
  it("starts after its marker or quote, and carries its top-level form up to the cursor", () => {
    expect(at("(in-package :my-|")).toEqual({ from: 13, prefix: "my-", form: "(in-package :my-" });
    expect(at('(in-package "MY-|")')).toMatchObject({ from: 13, prefix: "my-" });
    expect(at("(:use #:alexan|")).toMatchObject({ from: 8, prefix: "alexan" });
  });

  it("is not a plain symbol", () => {
    expect(at("(mapc|")).toBeNull();
  });
});
