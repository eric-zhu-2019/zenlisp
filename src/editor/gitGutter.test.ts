import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { gitState, lineChanges, setGitBase } from "./gitGutter";

const at = (base: string, doc: string) =>
  lineChanges(EditorState.create({ doc, extensions: [gitState] }).update({ effects: setGitBase.of(base) }).state);

describe("change markers against the last commit", () => {
  it("marks added, changed and deleted lines", () => {
    const base = "(a)\n(b)\n(c)\n(d)\n";
    expect([...at(base, "(a)\n(new)\n(b)\n(c)\n(d)\n")]).toEqual([[2, "added"]]);
    expect([...at(base, "(a)\n(B)\n(c)\n(d)\n")]).toEqual([[2, "changed"]]);
    expect([...at(base, "(a)\n(c)\n(d)\n")]).toEqual([[2, "deleted"]]);
  });

  it("marks only the new line when one is added after the last", () => {
    expect([...at("(a)\n(b)\n", "(a)\n(b)\n\n(c)")]).toEqual([[4, "added"]]);
  });

  it("follows edits made after the base was set", () => {
    const st = EditorState.create({ doc: "(a)\n(b)\n", extensions: [gitState] }).update({ effects: setGitBase.of("(a)\n(b)\n") }).state;
    expect(lineChanges(st).size).toBe(0);
    const edited = st.update({ changes: { from: 4, insert: "(x)\n" } }).state;
    expect([...lineChanges(edited)]).toEqual([[2, "added"]]);
  });

  it("shows nothing for a file git does not track", () => {
    expect(at(null as unknown as string, "(a)\n").size).toBe(0);
  });
});

describe("text added inside a line", () => {
  it("changes that line rather than adding one", () => {
    expect([...at("(f x)\n", '(f x "y")\n')]).toEqual([[1, "changed"]]);
  });
});
