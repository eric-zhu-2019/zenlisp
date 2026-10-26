// The warning or error under the cursor, shown as hovering it would show it.
// It appears when the cursor moves onto a mark, not while typing, since the
// check that marks code runs as typing pauses and a box would chase the cursor.

import { type Diagnostic, forEachDiagnostic } from "@codemirror/lint";
import { type EditorState, StateField } from "@codemirror/state";
import { showTooltip, type Tooltip } from "@codemirror/view";

type Shown = { armed: boolean; tooltip: Tooltip | null; key: string };

/** The diagnostics covering `pos`, most severe first. */
export function diagnosticsAt(state: EditorState, pos: number): Diagnostic[] {
  const found: Diagnostic[] = [];
  forEachDiagnostic(state, (d, from, to) => {
    if (from <= pos && (pos < to || (from === to && pos === from))) found.push({ ...d, from, to });
  });
  const rank = { error: 0, warning: 1, info: 2, hint: 3 };
  return found.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function tooltipAt(state: EditorState): { tooltip: Tooltip | null; key: string } {
  const sel = state.selection.main;
  const found = sel.empty ? diagnosticsAt(state, sel.head) : [];
  if (!found.length) return { tooltip: null, key: "" };
  const key = `${found[0].from}:${found.map((d) => d.message).join("\n")}`;
  const tooltip: Tooltip = {
    pos: found[0].from,
    above: true,
    create: (view) => {
      const dom = document.createElement("ul");
      dom.className = "cm-tooltip-lint cm-cursor-diagnostic";
      for (const d of found) {
        const li = document.createElement("li");
        li.className = `cm-diagnostic cm-diagnostic-${d.severity}`;
        li.textContent = d.message;
        if (d.source) {
          const source = document.createElement("div");
          source.className = "cm-diagnosticSource";
          source.textContent = d.source;
          li.appendChild(source);
        }
        for (const action of d.actions ?? []) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "cm-diagnosticAction";
          button.textContent = action.name;
          button.onmousedown = (e) => e.preventDefault();
          button.onclick = () => action.apply(view, d.from, d.to);
          li.appendChild(button);
        }
        dom.appendChild(li);
      }
      return { dom };
    },
  };
  return { tooltip, key };
}

export const cursorDiagnostic = StateField.define<Shown>({
  create: () => ({ armed: false, tooltip: null, key: "" }),
  update(shown, tr) {
    // Typing disarms it until the cursor next moves. A click leaves it to the
    // mouse hover, which shows the same box where the pointer already is.
    const armed = tr.docChanged || tr.isUserEvent("select.pointer") ? false : tr.selection ? true : shown.armed;
    const next = armed ? tooltipAt(tr.state) : { tooltip: null, key: "" };
    // The same messages at the same place keep their box, so moving within a mark does not redraw it.
    if (armed === shown.armed && next.key === shown.key) return shown;
    return { armed, ...next };
  },
  provide: (f) => [showTooltip.compute([f], (state) => state.field(f).tooltip)],
});
