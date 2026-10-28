import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { commonLisp } from "@codemirror/legacy-modes/mode/commonlisp";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/** Coalton's operators the Common Lisp mode does not already color, as heads of forms. */
const COALTON_FORMS = /^(coalton-toplevel|coalton|declare|match|fn|lisp|rec|for\*?|break|continue|return|derive|repr|monomorphize|specialize|inline|noinline|handle|protect|resumable|resume-to)$/;

export const lispMode: typeof commonLisp = {
  ...commonLisp,
  token(stream, state) {
    const afterOpen = (state as { lastType: string | null }).lastType === "open";
    const style = commonLisp.token(stream, state);
    return style === "variableName" && afterOpen && COALTON_FORMS.test(stream.current()) ? "keyword" : style;
  },
};

export const lispLanguage = StreamLanguage.define(lispMode);

const highlight = HighlightStyle.define([
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.string, color: "var(--syn-string)" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: t.atom, color: "var(--syn-keyword-arg)" },
  { tag: [t.keyword, t.definitionKeyword], color: "var(--syn-special)", fontWeight: "600" },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: "var(--syn-def)" },
  { tag: t.variableName, color: "var(--syn-symbol)" },
  { tag: t.meta, color: "var(--syn-meta)" },
  { tag: t.bracket, color: "var(--syn-paren)" },
]);

const DEPTHS = 6;
const parenMarks = Array.from({ length: DEPTHS }, (_, i) => Decoration.mark({ class: `cm-paren-${i}` }));

function rainbow(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc.toString();
  const { from: vFrom, to: vTo } = view.viewport;
  let depth = 0;
  let inString = false;
  let inComment = false;
  let inBlock = 0;
  for (let i = 0; i < Math.min(doc.length, vTo); i++) {
    const ch = doc[i];
    if (inComment) {
      if (ch === "\n") inComment = false;
      continue;
    }
    if (inBlock) {
      if (ch === "|" && doc[i + 1] === "#") (inBlock--, i++);
      continue;
    }
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === "\\" || (ch === "#" && doc[i + 1] === "\\")) {
      i += ch === "#" ? 2 : 1;
      continue;
    }
    if (ch === "#" && doc[i + 1] === "|") (inBlock = 1, i++);
    else if (ch === ";") inComment = true;
    else if (ch === '"') inString = true;
    else if (ch === "(" || ch === ")") {
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (i >= vFrom) b.add(i, i + 1, parenMarks[depth % DEPTHS]);
      if (ch === "(") depth++;
    }
  }
  return b.finish();
}

const rainbowParens = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = rainbow(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = rainbow(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export function lisp(): Extension {
  return [lispLanguage, syntaxHighlighting(highlight), rainbowParens];
}
