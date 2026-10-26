// Change markers against the file's last commit: a bar beside added and
// changed lines, and a notch where lines were deleted.

import { Chunk } from "@codemirror/merge";
import { RangeSet, StateEffect, StateField, Text, type EditorState } from "@codemirror/state";
import { type EditorView, gutter, GutterMarker } from "@codemirror/view";

export type LineChange = "added" | "changed" | "deleted";

class ChangeMarker extends GutterMarker {
  constructor(readonly change: LineChange) {
    super();
  }
  eq(o: ChangeMarker) {
    return o.change === this.change;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git cm-git-${this.change}`;
    el.title = this.change === "added" ? "Added since the last commit" : this.change === "changed" ? "Changed since the last commit" : "Lines deleted here";
    return el;
  }
}

const markers = { added: new ChangeMarker("added"), changed: new ChangeMarker("changed"), deleted: new ChangeMarker("deleted") };

/** The file's text at HEAD; null for a file git does not track. */
export const setGitBase = StateEffect.define<string | null>();

type GitState = { base: Text | null; chunks: readonly Chunk[] };

export const gitState = StateField.define<GitState>({
  create: () => ({ base: null, chunks: [] }),
  update(value, tr) {
    let { base, chunks } = value;
    for (const e of tr.effects) {
      if (e.is(setGitBase)) {
        base = e.value === null ? null : Text.of(e.value.split("\n"));
        chunks = base ? Chunk.build(base, tr.state.doc) : [];
      }
    }
    if (tr.docChanged && base && chunks === value.chunks) chunks = Chunk.updateB(chunks, base, tr.state.doc, tr.changes);
    return base === value.base && chunks === value.chunks ? value : { base, chunks };
  },
});

/** Each changed line's kind, by line number, for the gutter and for tests. */
export function lineChanges(state: EditorState): Map<number, LineChange> {
  const out = new Map<number, LineChange>();
  const { chunks } = state.field(gitState);
  const doc = state.doc;
  for (const c of chunks) {
    if (c.fromB === c.toB) {
      // Nothing left in this file where lines were removed: mark the line after the gap.
      out.set(doc.lineAt(Math.min(c.fromB, doc.length)).number, "deleted");
      continue;
    }
    // Chunks cover whole lines, so mark only the lines the changes inside them touch.
    // Text only inserted makes added lines; anything removed makes changed ones.
    for (const ch of c.changes) {
      const kind: LineChange = ch.fromA === ch.toA ? "added" : "changed";
      let from = c.fromB + ch.fromB;
      let to = c.fromB + ch.toB;
      if (kind === "added") {
        // A new line inserted after an existing one starts with that line's newline.
        if (doc.sliceString(from, from + 1) === "\n") from++;
        if (to > from && doc.sliceString(to - 1, to) === "\n") to--;
      }
      if (to < from) continue;
      const first = doc.lineAt(Math.min(from, doc.length)).number;
      const last = doc.lineAt(Math.min(Math.max(from, to), doc.length)).number;
      for (let n = first; n <= last; n++) {
        const line = doc.line(n);
        // Text inserted into a line that was there before changes it; a line made wholly of inserted text is new.
        const whole = kind === "added" && from <= line.from && to >= line.to;
        out.set(n, out.get(n) === "changed" || !whole ? "changed" : "added");
      }
    }
  }
  return out;
}

/** The gutter; clicking a marker calls `onClick`, which shows the changes. */
export const gitGutter = (onClick: (view: EditorView) => void) => [
  gitState,
  gutter({
    class: "cm-git-gutter",
    domEventHandlers: {
      mousedown: (view, line) => {
        if (!lineChanges(view.state).has(view.state.doc.lineAt(line.from).number)) return false;
        onClick(view);
        return true;
      },
    },
    markers: (view) => {
      const changes = lineChanges(view.state);
      const ranges = [...changes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, kind]) => markers[kind].range(view.state.doc.line(n).from));
      return RangeSet.of(ranges);
    },
  }),
];
