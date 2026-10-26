import { EditorSelection, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { set } from "../store";
import { parinfer, parinferStatus } from "./parinfer";

const PAIRS: Record<string, string> = { "(": ")", "[": "]", '"': '"', "|": "|" };

/** Typing an opener over a selection surrounds it instead of replacing it. */
export function wrapSelection(state: EditorState, open: string): TransactionSpec | null {
  const close = PAIRS[open];
  if (!close || state.selection.ranges.every((r) => r.empty)) return null;
  return state.changeByRange((r) =>
    r.empty
      ? { changes: { from: r.from, insert: open }, range: EditorSelection.cursor(r.from + 1) }
      : {
          changes: [
            { from: r.from, insert: open },
            { from: r.to, insert: close },
          ],
          range: EditorSelection.range(r.from + 1, r.to + 1),
        },
  );
}

export function structureExtension(): Extension {
  return [
    parinfer(),
    EditorView.inputHandler.of((view, _from, _to, text) => {
      const spec = wrapSelection(view.state, text);
      if (!spec) return false;
      view.dispatch(view.state.update(spec, { userEvent: "input" }));
      return true;
    }),
    EditorView.updateListener.of((u) => {
      const before = u.startState.field(parinferStatus, false);
      const after = u.state.field(parinferStatus, false);
      if (after && (before !== after || u.focusChanged)) set({ parinfer: { mode: after.mode, error: after.error?.message ?? null } });
    }),
  ];
}
