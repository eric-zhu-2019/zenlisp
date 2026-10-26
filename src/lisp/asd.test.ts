import { describe, expect, it } from "vitest";
import { addDependency, dependencies, removeDependency } from "./asd";

const ASD = `(defsystem "app"
  :version "0.1.0"
  :depends-on ("alexandria") ; utilities
  :components ((:file "main")))

(defsystem "app/tests"
  :depends-on ("app")
  :components ((:file "tests")))
`;

describe("editing an .asd file's dependencies", () => {
  it("adds to the right system's list, keeping comments and layout", () => {
    const out = addDependency(ASD, "app", "cl-ppcre")!;
    expect(out).toContain(':depends-on ("alexandria" "cl-ppcre") ; utilities');
    expect(dependencies(out, "app/tests")).toEqual(['"app"']);
  });

  it("adds a :depends-on where a system has none, indented like its other arguments", () => {
    const out = addDependency('(defsystem #:tiny\n  :components ((:file "a")))', "tiny", "str")!;
    expect(out).toBe('(defsystem #:tiny\n  :depends-on ("str")\n  :components ((:file "a")))');
  });

  it("leaves a dependency that is already there, however it is written", () => {
    const text = "(asdf:defsystem :x :depends-on (#:Alexandria))";
    expect(addDependency(text, "x", "alexandria")).toBe(text);
  });

  it("removes one dependency and its space", () => {
    const two = addDependency(ASD, "app", "cl-ppcre")!;
    expect(removeDependency(two, "app", "alexandria")).toContain(':depends-on ("cl-ppcre") ; utilities');
    expect(removeDependency(two, "app", "cl-ppcre")).toBe(ASD);
  });

  it("says when the file does not define the system", () => {
    expect(addDependency(ASD, "other", "x")).toBeNull();
  });
});
