import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, closeHoverTooltips, hoverTooltip, showTooltip, type Tooltip } from "@codemirror/view";
import * as actions from "../actions";
import { isSymbolChar, packageAt, symbolAt } from "../lisp/forms";
import { formAt, parse } from "../lisp/tree";

const cache = new Map<string, string | null>();

/** Docs go stale when code changes, so evaluation and compilation clear them. */
export function forgetDocs() {
  cache.clear();
}

/** Swank's text minus its "Documentation for the symbol X:" header. */
export function trimDoc(raw: string, maxLines = 18): string | null {
  const text = raw.replace(/^Documentation for the symbol [^\n]*\n+/, "").trim();
  if (!text || /^(No such symbol|Not documented)/i.test(text)) return null;
  const lines = text.split("\n");
  return lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n…` : text;
}

async function describe(symbol: string, pkg: string): Promise<string | null> {
  const key = `${pkg}::${symbol}`;
  if (cache.has(key)) return cache.get(key)!;
  const r = await actions.lisp({ op: "describe", symbol, package: pkg }).catch(() => null);
  let doc = r?.kind === "text" ? trimDoc(r.text) : null;
  if (!doc && r?.kind === "text" && !/^No such symbol/.test(r.text)) {
    // Undocumented, but an argument list still helps.
    const a = await actions.lisp({ op: "autodoc", form: [symbol, "", { cursor: true }], package: pkg }).catch(() => null);
    if (a?.kind === "arglist" && a.text.startsWith("(")) doc = a.text;
  }
  cache.set(key, doc);
  return doc;
}

export const lispHover = hoverTooltip(
  async (view, pos): Promise<Tooltip | null> => {
    // K's box already shows a doc.
    if (view.state.field(docTip, false)) return null;
    const text = view.state.doc.toString();
    if (!isSymbolChar(text[pos] ?? "") && !isSymbolChar(text[pos - 1] ?? "")) return null;
    const node = formAt(parse(text), pos);
    if (node && node.kind !== "atom") return null;
    const sym = symbolAt(text, pos);
    if (!sym || sym.name.startsWith(":") || /^[-+]?\d/.test(sym.name)) return null;
    const doc = await describe(sym.name, packageAt(text, pos) ?? "COMMON-LISP-USER");
    if (!doc) return null;
    return {
      pos: sym.from,
      end: sym.to,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-lisp-doc";
        dom.textContent = doc;
        return { dom };
      },
    };
  },
  { hoverTime: 450 },
);

type DocTip = { from: number; to: number; text: string };

const setDocTip = StateEffect.define<DocTip | null>();

/** The doc K shows at the symbol under the cursor, until the cursor moves or the text changes. */
const docTip = StateField.define<DocTip | null>({
  create: () => null,
  update(tip, tr) {
    for (const e of tr.effects) if (e.is(setDocTip)) return e.value;
    return tr.docChanged || tr.selection ? null : tip;
  },
  provide: (f) =>
    showTooltip.compute([f], (state): Tooltip | null => {
      const tip = state.field(f);
      if (!tip) return null;
      return {
        pos: tip.from,
        end: tip.to,
        above: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "cm-lisp-doc cm-doc-tip";
          dom.textContent = tip.text;
          return { dom };
        },
      };
    }),
});

export const docTips = [
  docTip,
  EditorView.domEventHandlers({
    keydown(e, view) {
      if (e.key !== "Escape" || !view.state.field(docTip)) return false;
      view.dispatch({ effects: setDocTip.of(null) });
      return true;
    },
  }),
];

/** Shows the symbol's doc, or its argument list, in a box at the symbol: Vim's K, as a popup. */
export function showDocTip(view: EditorView): boolean {
  const text = view.state.doc.toString();
  const pos = view.state.selection.main.head;
  const sym = symbolAt(text, pos) ?? symbolAt(text, pos + 1);
  if (!sym) return false;
  void describe(sym.name, packageAt(text, pos) ?? "COMMON-LISP-USER").then((doc) =>
    view.dispatch({
      effects: [setDocTip.of({ from: sym.from, to: sym.to, text: doc ?? `No documentation for ${sym.name}` }), closeHoverTooltips],
    }),
  );
  return true;
}
