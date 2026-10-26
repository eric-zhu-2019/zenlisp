// The form a stopped debugger is at, marked in its source while that debugger lasts.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { listEnd, symbolAt } from "../lisp/forms";

export const setDebugSpot = StateEffect.define<number | null>();

const line = Decoration.line({ class: "cm-debug-line" });
const form = Decoration.mark({ class: "cm-debug-form" });

export const debugSpot = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setDebugSpot)) continue;
      if (e.value === null) return Decoration.none;
      const text = tr.state.doc.toString();
      const from = Math.min(e.value, text.length);
      const to = text[from] === "(" ? (listEnd(text, from) ?? from + 1) : (symbolAt(text, from)?.to ?? from);
      marks = Decoration.set([line.range(tr.state.doc.lineAt(from).from), ...(to > from ? [form.range(from, to)] : [])], true);
    }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});
