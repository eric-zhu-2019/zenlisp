import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { wrapSelection } from "./structure";

const apply = (doc: string, from: number, to: number, ch: string) => {
  const state = EditorState.create({ doc, selection: EditorSelection.single(from, to) });
  const spec = wrapSelection(state, ch);
  return spec ? state.update(spec).state : null;
};

describe("wrapSelection", () => {
  it("surrounds the selection and keeps it selected", () => {
    const s = apply("(foo bar baz)", 5, 8, "(")!;
    expect(s.doc.toString()).toBe("(foo (bar) baz)");
    expect(s.sliceDoc(s.selection.main.from, s.selection.main.to)).toBe("bar");
  });

  it("wraps strings and vertical-bar symbols", () => {
    expect(apply("hello", 0, 5, '"')!.doc.toString()).toBe('"hello"');
    expect(apply("a b", 0, 3, "|")!.doc.toString()).toBe("|a b|");
  });

  it("leaves plain typing to the editor", () => {
    expect(apply("abc", 1, 1, "(")).toBeNull();
    expect(apply("abc", 0, 3, "x")).toBeNull();
  });
});
