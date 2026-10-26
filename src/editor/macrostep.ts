// Macro stepping, as SLIME's macrostep: an expansion whose own macro forms
// can each be expanded in place, one step at a time, and stepped back.

import type { MacroSpot } from "../protocol/MacroSpot";
import { listEnd } from "../lisp/forms";

export type Expansion = { text: string; macros: MacroSpot[] };

/** Expands one Lisp form a step, or returns why it can't. */
export type Expand = (form: string) => Promise<Expansion | string>;

/**
 * Puts `inner`, the expansion of the form at `start`, in place of that form.
 * The expansion is printed from column 0, so its later lines take the form's
 * column; the macro forms inside the replaced form go and the expansion's come in.
 */
export function stepIn(outer: Expansion, start: number, inner: Expansion): Expansion {
  const end = listEnd(outer.text, start) ?? start;
  const column = start - (outer.text.lastIndexOf("\n", start - 1) + 1);
  const pad = " ".repeat(column);
  const text = inner.text.replace(/\n/g, `\n${pad}`);
  const shift = text.length - (end - start);
  const linesBefore = (p: number) => inner.text.slice(0, p).split("\n").length - 1;
  const macros = [
    ...outer.macros.filter((m) => m.start < start),
    ...inner.macros.map((m) => ({ ...m, start: start + m.start + column * linesBefore(m.start) })),
    ...outer.macros.filter((m) => m.start >= end).map((m) => ({ ...m, start: m.start + shift })),
  ];
  return { text: outer.text.slice(0, start) + text + outer.text.slice(end), macros };
}

const SYMBOL_END = /[\s()'"`,]/;

/** The expansion's DOM, with each macro form's operator clickable. */
export function macrostepView(first: Expansion, expand: Expand): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-inline cm-inline-expansion cm-macrostep";
  let current = first;
  const past: Expansion[] = [];
  let message = "";

  const render = () => {
    root.replaceChildren();
    const head = document.createElement("div");
    head.className = "cm-macrostep-head";
    const hint = document.createElement("span");
    hint.textContent = message || (current.macros.length ? "Click a highlighted macro to expand it in place." : "No macros left to expand.");
    if (message) hint.className = "cm-macrostep-error";
    const back = document.createElement("button");
    back.textContent = "Step back";
    back.disabled = past.length === 0;
    back.onclick = () => {
      current = past.pop() ?? current;
      message = "";
      render();
    };
    head.append(hint, back);

    const body = document.createElement("div");
    body.className = "cm-macrostep-body";
    let at = 0;
    for (const m of [...current.macros].sort((a, b) => a.start - b.start)) {
      const from = m.start + 1;
      let to = from;
      while (to < current.text.length && !SYMBOL_END.test(current.text[to])) to++;
      if (from < at || to === from) continue;
      body.append(current.text.slice(at, from));
      const op = document.createElement("span");
      op.className = "cm-macro";
      op.title = `Expand ${m.name}`;
      op.textContent = current.text.slice(from, to);
      op.onclick = async () => {
        const end = listEnd(current.text, m.start);
        if (end === undefined) return;
        const r = await expand(current.text.slice(m.start, end));
        if (typeof r === "string") {
          message = r;
        } else {
          past.push(current);
          current = stepIn(current, m.start, r);
          message = "";
        }
        render();
      };
      body.append(op);
      at = to;
    }
    body.append(current.text.slice(at));
    root.append(head, body);
  };
  render();
  return root;
}
