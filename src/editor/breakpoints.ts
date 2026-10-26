// Breakpoints on forms, toggled from the gutter. Each covers a whole form, so
// it follows edits; Lisp reports which ones bound to compiled code.

import { RangeSet, RangeValue, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { type EditorView, GutterMarker, gutter } from "@codemirror/view";
import { breakpointForm } from "../lisp/tree";

export type Breakpoint = { from: number; to: number };

class Form extends RangeValue {}
const form = new Form();

/** Replaces the file's breakpoints, as when its editor state is created. */
export const setBreakpoints = StateEffect.define<Breakpoint[]>();
/** The breakpoint starts Lisp bound to code. The others show as unbound. */
export const setBound = StateEffect.define<number[]>();
const toggle = StateEffect.define<number>();

/** Whether a transaction is the user toggling a breakpoint, which Lisp must hear about now. */
export const isToggle = (tr: { effects: readonly StateEffect<unknown>[] }) => tr.effects.some((e) => e.is(toggle));

export const breakpoints = StateField.define<RangeSet<Form>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setBreakpoints)) set = RangeSet.of(e.value.map((b) => form.range(b.from, b.to)), true);
      if (e.is(toggle)) {
        const line = tr.state.doc.lineAt(e.value);
        let removed = false;
        set = set.update({
          filter: (from) => {
            const on = from >= line.from && from <= line.to;
            removed ||= on;
            return !on;
          },
        });
        const target = removed ? null : breakpointForm(tr.state.doc.toString(), line.from, line.to);
        if (target) set = set.update({ add: [form.range(target.from, target.to)] });
      }
    }
    return set;
  },
});

const bound = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBound)) value = new Set(e.value);
    // An edit leaves the compiled code behind, so nothing counts as bound until the next sync.
    return tr.docChanged && value.size ? new Set() : value;
  },
});

export function breakpointList(state: EditorState): Breakpoint[] {
  const out: Breakpoint[] = [];
  for (let c = state.field(breakpoints).iter(); c.value; c.next()) out.push({ from: c.from, to: c.to });
  return out;
}

class Dot extends GutterMarker {
  constructor(readonly bound: boolean) {
    super();
  }
  eq(o: Dot) {
    return o.bound === this.bound;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-breakpoint ${this.bound ? "bound" : "unbound"}`;
    el.title = this.bound ? "Breakpoint" : "Breakpoint, not bound to compiled code: compile the file or form";
    return el;
  }
}

export function toggleBreakpoint(view: EditorView, pos = view.state.selection.main.head) {
  view.dispatch({ effects: toggle.of(pos) });
  return true;
}

export const breakpointGutter = [
  breakpoints,
  bound,
  gutter({
    class: "cm-breakpoint-gutter",
    renderEmptyElements: true,
    markers: (view) => {
      const on = view.state.field(bound);
      const dots: { from: number; marker: Dot }[] = [];
      for (let c = view.state.field(breakpoints).iter(); c.value; c.next()) {
        dots.push({ from: view.state.doc.lineAt(c.from).from, marker: new Dot(on.has(c.from)) });
      }
      return RangeSet.of(dots.map((d) => d.marker.range(d.from)), true);
    },
    domEventHandlers: {
      mousedown: (view, line) => toggleBreakpoint(view, line.from),
    },
  }),
];
