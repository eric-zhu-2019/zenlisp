// Where a document's live Lisp starts. In the REPL that is the input after the
// last prompt; everything before it is transcript, which may hold any text and
// must not be parsed, reindented or corrected. Editors without the facet treat
// the whole document as Lisp.

import { type EditorState, Facet, Text } from "@codemirror/state";

export const lispRegionStart = Facet.define<(state: EditorState) => number, ((state: EditorState) => number) | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * The Lisp region as its own text. The first line is padded with spaces up to
 * the column where the region starts, so columns, and with them indentation,
 * match what the user sees after the prompt.
 */
export type Region = { from: number; pad: number; text: Text };

export function regionOf(state: EditorState, doc: Text = state.doc): Region {
  const start = state.facet(lispRegionStart);
  if (!start) return { from: 0, pad: 0, text: doc };
  const from = Math.min(start(state), doc.length);
  const pad = from - doc.lineAt(from).from;
  const text = Text.of((" ".repeat(pad) + doc.sliceString(from)).split("\n"));
  return { from, pad, text };
}

/** A document position as a region position, or null when it lies before the region. */
export function toRegion(r: Region, pos: number): number | null {
  return pos < r.from ? null : pos - r.from + r.pad;
}

export function fromRegion(r: Region, pos: number): number {
  return Math.max(r.from, pos - r.pad + r.from);
}

/** The package the Lisp region is read in, when it is not given by an in-package form. */
export const lispPackage = Facet.define<(state: EditorState) => string, ((state: EditorState) => string) | null>({
  combine: (values) => values[0] ?? null,
});
