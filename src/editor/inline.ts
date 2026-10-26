import { Prec, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import type { MacroSpot } from "../protocol/MacroSpot";
import { type Expand, macrostepView } from "./macrostep";

export type InlineKind = "result" | "error" | "expansion" | "doc" | "pending" | "code" | "macrostep";

export type Inline = {
  from: number;
  to: number;
  kind: InlineKind;
  text: string;
  /** For "macrostep": the expansion's macro forms, and how to expand one. */
  macros?: MacroSpot[];
  expand?: Expand;
};

export const showInline = StateEffect.define<Inline>();
export const clearInline = StateEffect.define<null>();

class InlineWidget extends WidgetType {
  constructor(
    readonly kind: InlineKind,
    readonly text: string,
    readonly item: Inline,
  ) {
    super();
  }
  eq(o: InlineWidget) {
    return o.kind === this.kind && o.text === this.text;
  }
  /** The macro stepper handles its own clicks. */
  ignoreEvent() {
    return this.kind === "macrostep";
  }
  toDOM() {
    if (this.kind === "macrostep" && this.item.expand) {
      return macrostepView({ text: this.text, macros: this.item.macros ?? [] }, this.item.expand);
    }
    const el = document.createElement("div");
    el.className = `cm-inline cm-inline-${this.kind}`;
    if (this.kind === "result" || this.kind === "pending") {
      const arrow = document.createElement("span");
      arrow.className = "cm-inline-arrow";
      arrow.textContent = this.kind === "pending" ? "… " : "⇒ ";
      el.append(arrow, this.text);
    } else {
      el.textContent = this.text;
    }
    return el;
  }
}

type Field = { items: Inline[]; decorations: DecorationSet };

function decorate(state: EditorState, items: Inline[]): DecorationSet {
  return Decoration.set(
    items.map((i) => {
      const block = i.kind === "expansion" || i.kind === "doc" || i.kind === "code" || i.kind === "macrostep";
      const at = block ? state.doc.lineAt(i.to).to : i.to;
      return Decoration.widget({ widget: new InlineWidget(i.kind, i.text, i), side: 1, block }).range(at);
    }),
    true,
  );
}

const inlineField = StateField.define<Field>({
  create: () => ({ items: [], decorations: Decoration.none }),
  update(field, tr) {
    let items = field.items;
    if (tr.docChanged) {
      items = items.filter((i) => {
        let touched = false;
        tr.changes.iterChangedRanges((from, to) => {
          if (from <= i.to && to >= i.from) touched = true;
        });
        return !touched;
      });
      items = items.map((i) => ({ ...i, from: tr.changes.mapPos(i.from), to: tr.changes.mapPos(i.to) }));
    }
    for (const e of tr.effects) {
      if (e.is(clearInline)) items = [];
      if (e.is(showInline)) items = [...items.filter((i) => i.from !== e.value.from), e.value];
    }
    if (items === field.items) return field;
    return { items, decorations: decorate(tr.state, items) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

export function inlineResults() {
  return [
    inlineField,
    // Escape also leaves Vim insert mode, so clear and let it through.
    Prec.highest(
      keymap.of([
        {
          key: "Escape",
          run: (view) => {
            if (view.state.field(inlineField).items.length > 0) view.dispatch({ effects: clearInline.of(null) });
            return false;
          },
        },
      ]),
    ),
  ];
}
