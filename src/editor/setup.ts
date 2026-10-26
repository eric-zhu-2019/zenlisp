import { autocompletion, closeBrackets, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { cursorDiagnostic } from "./cursorDiagnostic";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { getCM, Vim, vim } from "@replit/codemirror-vim";
import * as actions from "../actions";
import { editorKeymap, mapVimBindings } from "../keys";
import { set, useStore } from "../store";
import { symbolAt } from "../lisp/forms";
import { bufferPackage, compileFile, lispCompletions, updateArglist, viewPath } from "./commands";
import { lispHover } from "./hover";
import { lispIndentation } from "./indent";
import { inlineResults } from "./inline";
import { configureStructuralVim, optionKeys, structuralKeymap } from "./structural";
import { lisp } from "./lisp";
import { debugSpot } from "./debugSpot";
import { type Breakpoint, breakpointGutter, breakpointList, breakpoints, isToggle } from "./breakpoints";
import { gitGutter } from "./gitGutter";

export const vimCompartment = new Compartment();
export const structureCompartment = new Compartment();

const lispKeymap = keymap.of(editorKeymap());

let vimConfigured = false;

function configureVim() {
  if (vimConfigured) return;
  vimConfigured = true;
  // Search with Vim's own regex syntax (\v, \<, \(, \|), not JavaScript's.
  Vim.setOption("pcre", false);
  mapVimBindings(Vim);
  configureStructuralVim(Vim as never);
  Vim.defineEx("write", "w", (cm: { cm6: EditorView }) => {
    const p = viewPath.get(cm.cm6);
    if (p) actions.saveTab(p);
  });
  Vim.defineEx("make", "make", (cm: { cm6: EditorView }) => compileFile(cm.cm6));
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)" },
});

/** The inline diff against the last commit, on for files the user asked to see it for. */
export const diffCompartment = new Compartment();

export function editorExtensions(opts: {
  vim: boolean;
  structure: Extension;
  onChange: (text: string) => void;
  onBreakpoints: (list: Breakpoint[], toggled: boolean) => void;
}): Extension[] {
  configureVim();
  return [
    // Vim must come first: any keymap ahead of it breaks Escape in insert mode.
    vimCompartment.of(opts.vim ? vim({ status: false }) : []),
    Prec.highest(keymap.of(structuralKeymap)),
    optionKeys,
    breakpointGutter,
    EditorView.updateListener.of((u) => {
      if (u.startState.field(breakpoints) !== u.state.field(breakpoints)) {
        opts.onBreakpoints(breakpointList(u.state), u.transactions.some(isToggle));
      }
    }),
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    lintGutter(),
    cursorDiagnostic,
    lisp(),
    lispIndentation(() => useStore.getState().indentSpecs),
    structureCompartment.of(opts.structure),
    inlineResults(),
    debugSpot,
    lispHover,
    followDocs,
    gitGutter((view) => {
      const path = viewPath.get(view);
      if (path) actions.toggleDiff(path);
    }),
    diffCompartment.of([]),
    autocompletion({ override: [lispCompletions], activateOnTypingDelay: 120, icons: true }),
    Prec.high(lispKeymap),
    keymap.of([...completionKeymap, ...searchKeymap, ...historyKeymap, ...lintKeymap, ...defaultKeymap, indentWithTab]),
    theme,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) updateArglist(u.view);
    }),
  ];
}

export const fallbackStructure: Extension = closeBrackets();

export function watchVimMode(view: EditorView) {
  const cm = getCM(view);
  cm?.on("vim-mode-change", (e: { mode: string; subMode?: string }) =>
    set({ vimMode: e.subMode ? `${e.mode} ${e.subMode}` : e.mode }),
  );
}

let followTimer: ReturnType<typeof setTimeout> | undefined;

/** While the documentation panel follows the cursor, a symbol the cursor rests on is shown there. */
export const followDocs = EditorView.updateListener.of((u) => {
  if (!u.selectionSet) return;
  const s = useStore.getState();
  if (s.right !== "docs" || !s.docs.follow) return;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    const text = u.view.state.doc.toString();
    const sym = symbolAt(text, u.view.state.selection.main.head);
    if (sym && !sym.name.startsWith(":") && !/^[-+]?\d/.test(sym.name)) actions.showDocs(sym.name, bufferPackage(u.view), { open: false });
  }, 350);
});
