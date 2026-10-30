import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { Diagnostic } from "@codemirror/lint";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import * as actions from "../actions";
import { autodocForm, enclosingLists, formAtOrBefore, isSymbolChar, listEnd, packageAt, symbolAt } from "../lisp/forms";
import { definitions, formBefore } from "../lisp/tree";
import { designatorToken } from "../lisp/designators";
import { localBinding } from "../lisp/scope";
import type { Fix } from "../protocol/Fix";
import type { Note } from "../protocol/Note";
import { appendTranscript, set, useStore } from "../store";
import { markTour } from "../tour";
import { showInline } from "./inline";
import { lispPackage, regionOf, toRegion } from "./region";

export const viewPath = new WeakMap<EditorView, string>();

export const activeEditor: { view: EditorView | null } = { view: null };

export function editorContext() {
  const v = activeEditor.view;
  const file = v ? viewPath.get(v) : undefined;
  if (!v || !file) return null;
  const form = currentForm(v);
  return { file, package: bufferPackage(v), form: form ? form.text.slice(0, 4000) : null };
}

export function insertAtCursor(text: string) {
  const v = activeEditor.view;
  if (!v || !viewPath.get(v)) return false;
  const pos = v.state.selection.main.head;
  const line = v.state.doc.lineAt(pos);
  const insert = line.text.trim() ? `\n${text}\n` : `${text}\n`;
  const at = line.text.trim() ? line.to : pos;
  v.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
  v.focus();
  return true;
}

export function bufferPackage(view: EditorView, pos = view.state.selection.main.head) {
  return statePackage(view.state, view.state.doc.toString(), pos);
}

function statePackage(state: EditorState, text: string, pos: number) {
  return packageAt(text, pos) ?? state.facet(lispPackage)?.(state) ?? "COMMON-LISP-USER";
}

/** The Lisp region's text and the cursor in it, or null when the cursor is outside it. */
function lispText(state: EditorState, pos: number) {
  const r = regionOf(state);
  const at = toRegion(r, pos);
  return at === null ? null : { text: r.text.toString(), pos: at };
}

function currentForm(view: EditorView) {
  const text = view.state.doc.toString();
  const sel = view.state.selection.main;
  if (!sel.empty) return { from: sel.from, to: sel.to, text: text.slice(sel.from, sel.to) };
  const r = formAtOrBefore(text, sel.head);
  return r ? { ...r, text: text.slice(r.from, r.to) } : null;
}

const firstLine = (s: string, max = 400) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const COALTON_BLOCK = /^\(\s*(coalton:)?coalton-toplevel[\s)]/i;

/** Definitions compile from the buffer, as SLIME's C-c C-c does, so go-to-definition still finds them. */
export function evalForm(view: EditorView): boolean {
  const form = currentForm(view);
  if (!form) return false;
  const def = view.state.selection.main.empty ? definitions(form.text)[0] : undefined;
  if (def && def.offset === 0) return compileDefinition(view, form, def.name);
  // A Coalton block defines what it holds, and compiling reports its type errors as notes.
  if (view.state.selection.main.empty && COALTON_BLOCK.test(form.text)) return compileDefinition(view, form, "coalton-toplevel");
  return evaluate(view, form);
}

/** Evaluates the expression just before the cursor, as Emacs's C-x C-e does. */
export function evalLastForm(view: EditorView): boolean {
  const text = view.state.doc.toString();
  // Vim's block cursor covers a character, so the point Emacs means is just after it.
  const vim = getCM(view)?.state.vim as { insertMode?: boolean } | undefined;
  const head = view.state.selection.main.head;
  const node = formBefore(text, vim && !vim.insertMode ? Math.min(head + 1, text.length) : head);
  if (!node) return false;
  return evaluate(view, { from: node.from, to: node.to, text: text.slice(node.from, node.to) });
}

export function loadFile(view: EditorView): boolean {
  const path = viewPath.get(view);
  if (!path) return false;
  actions.saveTab(path).then(() => actions.lisp({ op: "loadFile", path }));
  return true;
}

/**
 * Shows the REPL and puts the cursor at the end of its input, scrolled to the
 * prompt. A REPL hidden behind another panel tab renders on the next frames.
 */
export function showRepl(): boolean {
  set({ bottom: "repl" });
  const focus = (tries: number) => {
    const dom = document.querySelector("[data-testid=repl-input] .cm-editor");
    const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
    if (!view) return void (tries > 0 && requestAnimationFrame(() => focus(tries - 1)));
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length }, effects: EditorView.scrollIntoView(view.state.doc.length, { y: "end" }) });
  };
  focus(20);
  return true;
}

/** Goes to the REPL, or from the REPL back to the editor last used, as SLIME's C-c C-z does. */
export function toggleRepl(): boolean {
  const inRepl = document.activeElement instanceof Element && document.activeElement.closest(".repl");
  if (inRepl && activeEditor.view) {
    activeEditor.view.focus();
    return true;
  }
  return showRepl();
}

function evaluate(view: EditorView, form: { from: number; to: number; text: string }): boolean {
  markTour("eval");
  const at = { from: form.from, to: form.to };
  view.dispatch({ effects: showInline.of({ ...at, kind: "pending", text: "evaluating" }) });
  actions
    .lisp({ op: "eval", form: form.text, package: bufferPackage(view, form.from) })
    .then((r) => {
      if (r.kind !== "evaluated") return;
      if (r.output) appendTranscript({ kind: "output", text: r.output });
      view.dispatch({ effects: showInline.of({ ...at, kind: "result", text: firstLine(r.value.replace(/\n/g, " ")) }) });
    })
    .catch((e) => view.dispatch({ effects: showInline.of({ ...at, kind: "error", text: String(e.message ?? e) }) }));
  return true;
}

function compileDefinition(view: EditorView, form: { from: number; to: number; text: string }, name: string): boolean {
  markTour("eval");
  const path = viewPath.get(view);
  const at = { from: form.from, to: form.to };
  view.dispatch({ effects: showInline.of({ ...at, kind: "pending", text: "compiling" }) });
  actions
    .lisp({ op: "compileForm", form: form.text, package: bufferPackage(view, form.from), buffer: path ?? "scratch", file: path ?? null, offset: form.from })
    .then((r) => {
      if (r.kind !== "compiled") return;
      if (path) set((s) => ({ notes: { ...s.notes, [path]: [...(s.notes[path] ?? []).filter((n) => !inRange(n, form)), ...r.notes] } }));
      const failed = !r.success || r.notes.some((n) => n.severity === "error" || n.severity === "read-error");
      const label = name.toUpperCase();
      const text = failed ? "compile failed" : r.notes.length ? `${label} (${r.notes.length} note${r.notes.length > 1 ? "s" : ""})` : label;
      view.dispatch({ effects: showInline.of({ ...at, kind: failed ? "error" : "result", text }) });
    })
    .catch((e) => view.dispatch({ effects: showInline.of({ ...at, kind: "error", text: String(e.message ?? e) }) }));
  return true;
}

export function compileForm(view: EditorView): boolean {
  const form = currentForm(view);
  const path = viewPath.get(view);
  if (!form || !path) return false;
  actions
    .lisp({
      op: "compileForm",
      form: form.text,
      package: bufferPackage(view, form.from),
      buffer: path,
      file: path,
      offset: form.from,
    })
    .then((r) => {
      if (r.kind !== "compiled") return;
      set((s) => ({ notes: { ...s.notes, [path]: [...(s.notes[path] ?? []).filter((n) => !inRange(n, form)), ...r.notes] } }));
      const at = { from: form.from, to: form.to };
      const msg = r.notes.length ? `compiled with ${r.notes.length} note${r.notes.length > 1 ? "s" : ""}` : "compiled";
      view.dispatch({ effects: showInline.of({ ...at, kind: r.notes.length ? "error" : "result", text: msg }) });
    });
  return true;
}

function inRange(n: Note, r: { from: number; to: number }) {
  const o = n.location?.offset;
  return o != null && o >= r.from && o <= r.to;
}

export function compileFile(view: EditorView): boolean {
  const path = viewPath.get(view);
  if (!path) return false;
  actions.compileFile(path);
  return true;
}

export function macroexpand(view: EditorView, all = false): boolean {
  if (!all) return macrostep(view);
  const text = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const start = enclosingLists(text, head + 1).pop();
  const end = start === undefined ? undefined : listEnd(text, start);
  if (start === undefined || end === undefined) return false;
  actions.lisp({ op: "macroexpand", form: text.slice(start, end), package: bufferPackage(view), all }).then((r) => {
    if (r.kind === "text") view.dispatch({ effects: showInline.of({ from: start, to: end, kind: "expansion", text: r.text }) });
  });
  return true;
}

/**
 * Expands the innermost macro form around the cursor one step, as an
 * expansion whose own macro forms can be stepped into in place.
 */
export function macrostep(view: EditorView): boolean {
  const text = view.state.doc.toString();
  const pkg = bufferPackage(view);
  const starts = enclosingLists(text, view.state.selection.main.head + 1).reverse();
  if (!starts.length) return false;
  const expand = async (form: string) => {
    const r = await actions.lisp({ op: "macrostep", form, package: pkg }).catch((e) => ({ kind: "text" as const, text: String(e.message ?? e) }));
    return r.kind === "expansion" ? { text: r.text, macros: r.macros } : r.kind === "text" ? r.text : "No expansion";
  };
  (async () => {
    let reason = "Not inside a macro form";
    for (const start of starts.slice(0, 8)) {
      const end = listEnd(text, start);
      if (end === undefined) continue;
      const r = await expand(text.slice(start, end));
      if (typeof r !== "string") {
        view.dispatch({ effects: showInline.of({ from: start, to: end, kind: "macrostep", text: r.text, macros: r.macros, expand }) });
        return;
      }
      if (!r.startsWith("Not a macro")) reason = r;
    }
    const at = starts[0];
    view.dispatch({ effects: showInline.of({ from: at, to: listEnd(text, at) ?? at, kind: "error", text: reason }) });
  })();
  return true;
}

export function disassembleAtCursor(view: EditorView): boolean {
  const sym = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
  if (!sym) return false;
  actions
    .lisp({ op: "disassemble", name: sym.name, package: bufferPackage(view) })
    .then((r) => r.kind === "text" && view.dispatch({ effects: showInline.of({ from: sym.from, to: sym.to, kind: "code", text: r.text.trimEnd() }) }))
    .catch((e) => view.dispatch({ effects: showInline.of({ from: sym.from, to: sym.to, kind: "error", text: String(e.message ?? e) }) }));
  return true;
}

export function toggleTraceAtCursor(view: EditorView): boolean {
  const sym = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
  if (!sym) return false;
  actions
    .toggleTrace(sym.name, bufferPackage(view))
    .then((text) => view.dispatch({ effects: showInline.of({ from: sym.from, to: view.state.doc.lineAt(sym.to).to, kind: "result", text }) }))
    .catch((e) => view.dispatch({ effects: showInline.of({ from: sym.from, to: sym.to, kind: "error", text: String(e.message ?? e) }) }));
  return true;
}

/** Runs the top-level form at the cursor, or the selection, under the profiler. */
export function profileAtCursor(view: EditorView): boolean {
  const form = currentForm(view);
  if (!form) return false;
  void actions.profileForm(form.text, bufferPackage(view, form.from));
  return true;
}

export function describeSymbol(view: EditorView): boolean {
  const sym = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
  if (!sym) return false;
  actions.lisp({ op: "describe", symbol: sym.name, package: bufferPackage(view) }).then((r) => {
    if (r.kind === "text") view.dispatch({ effects: showInline.of({ from: sym.from, to: sym.to, kind: "doc", text: r.text }) });
  });
  return true;
}

/** Opens the documentation panel on the symbol at the cursor, with its HyperSpec page. */
export function documentSymbol(view: EditorView): boolean {
  const sym = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
  if (!sym) return false;
  actions.showDocs(sym.name, bufferPackage(view));
  return true;
}

export function goToDefinition(view: EditorView): boolean {
  const sym = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
  if (!sym) return false;
  const path = viewPath.get(view);
  const text = view.state.doc.toString();
  // A local variable or function first, as Vim's gd goes to the local declaration.
  const local = localBinding(text, view.state.selection.main.head);
  if (path && local !== null && local !== sym.from) {
    void actions.navigate(path, local);
    return true;
  }
  actions.findDefinition(sym.name, bufferPackage(view), path ? { path, text } : undefined).then((found) => {
    if (!found) view.dispatch({ effects: showInline.of({ from: sym.from, to: sym.to, kind: "error", text: `no definition of ${sym.name} found` }) });
  });
  return true;
}

export function findReferencesAtCursor(view: EditorView): boolean {
  const sym = symbolAt(view.state.doc.toString(), view.state.selection.main.head);
  if (!sym) return false;
  actions.findReferences(sym.name, bufferPackage(view));
  return true;
}

export function inspectAtCursor(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const text = view.state.doc.toString();
  const form = sel.empty ? symbolAt(text, sel.head)?.name : text.slice(sel.from, sel.to);
  if (!form) return false;
  actions.inspectForm(form, bufferPackage(view));
  return true;
}

/** Swank fuzzy-completion flags: b f g c t m s p. */
function completionType(flags: string): string {
  if (flags[5] === "m") return "keyword";
  if (flags[6] === "s") return "keyword";
  if (flags[2] === "g" || flags[1] === "f") return "function";
  if (flags[3] === "c" || flags[4] === "t") return "class";
  if (flags[7] === "p") return "namespace";
  if (flags[0] === "b") return "variable";
  return "text";
}

/**
 * Package or system names for a name being typed where one belongs: packages
 * Lisp has, the project's systems and dependencies, and systems the catalogs
 * list, so a dependency completes before it is loaded.
 */
async function designatorCompletions(kind: "package" | "system", prefix: string, from: number): Promise<CompletionResult> {
  const s = useStore.getState();
  const names = new Map<string, string>();
  const add = (name: string, detail: string) => {
    const n = name.toLowerCase();
    if (!names.has(n)) names.set(n, detail);
  };
  if (kind === "package") for (const p of s.packages) add(p, "package");
  for (const sys of s.systems) add(sys.name, "project");
  for (const d of s.deps) add(d.name, d.source === "missing" ? "dependency" : `${d.source} dependency`);
  if (prefix.length >= 2) {
    const r = await actions.lisp({ op: "findSystems", query: prefix }).catch(() => null);
    if (r?.kind === "systems") for (const sys of r.items) add(sys.name, sys.source === "quicklisp" ? "Quicklisp system" : "system");
  }
  const options: Completion[] = [...names].map(([label, detail]) => ({ label, detail, type: kind === "package" ? "namespace" : "class" }));
  return { from, options, validFor: /^[\w.+/-]*$/ };
}

export async function lispCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
  const lisp = lispText(ctx.state, ctx.pos);
  if (!lisp) return null;
  const { text, pos } = lisp;
  const token = designatorToken(text, pos);
  if (token && (token.prefix.length >= 1 || ctx.explicit)) {
    const r = await actions.lisp({ op: "designatorAt", text: token.form }).catch(() => null);
    if (ctx.aborted) return null;
    const kind = r?.kind === "text" ? r.text : null;
    if (kind === "package" || kind === "system") {
      const result = await designatorCompletions(kind, token.prefix, ctx.pos - (pos - token.from));
      return ctx.aborted ? null : result;
    }
  }
  let from = pos;
  while (from > 0 && isSymbolChar(text[from - 1])) from--;
  const prefix = text.slice(from, pos).replace(/^#'/, "");
  if (prefix.length < 2 && !ctx.explicit) return null;
  if (/^[0-9]/.test(prefix)) return null;
  const pkg = statePackage(ctx.state, text, pos);
  const r = await actions.lisp({ op: "complete", prefix, package: pkg }).catch(() => null);
  if (ctx.aborted || !r || r.kind !== "completions") return null;
  const options: Completion[] = r.items.map((c, i) => ({
    label: c.label,
    type: completionType(c.flags),
    boost: -i,
  }));
  return { from: ctx.pos - prefix.length, options, filter: false };
}

let hintTimer: ReturnType<typeof setTimeout> | undefined;
let hintSeq = 0;

export function updateArglist(view: EditorView) {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(async () => {
    const lisp = lispText(view.state, view.state.selection.main.head);
    if (!lisp) return;
    const form = autodocForm(lisp.text, lisp.pos);
    const seq = ++hintSeq;
    if (!form) return;
    const r = await actions.lisp({ op: "autodoc", form, package: statePackage(view.state, lisp.text, lisp.pos) }).catch(() => null);
    if (seq !== hintSeq || !r) return;
    if (r.kind === "arglist" && r.text && !r.text.startsWith("Arglist Error")) set({ hint: { text: r.text, active: r.active } });
  }, 180);
}

/** Compiler notes point at a form's start; underline that whole form or symbol. */
/** The symbol a compiler message is about, such as X in "undefined variable: PKG::X". */
export function noteSymbol(message: string): string | null {
  const m =
    /undefined (?:variable|function|type): (\S+)/i.exec(message) ??
    /The (?:variable|function) (\S+) /.exec(message) ??
    /unknown type specifier: (\S+)/i.exec(message);
  return m ? m[1].replace(/^.*?::?(?=[^:])/, "").replace(/[.,]$/, "").toLowerCase() : null;
}

/** Where `symbol` occurs as a whole symbol in text[from, to), first. */
function symbolIn(text: string, from: number, to: number, symbol: string): { from: number; to: number } | null {
  const lower = text.slice(from, to).toLowerCase();
  for (let i = lower.indexOf(symbol); i >= 0; i = lower.indexOf(symbol, i + 1)) {
    const start = from + i;
    const end = start + symbol.length;
    // A package prefix belongs to the symbol, so pkg::x still counts as x.
    if (!isSymbolChar(text[end] ?? " ") && (start === 0 || !isSymbolChar(text[start - 1]) || text[start - 1] === ":")) return { from: start, to: end };
  }
  return null;
}

const projectRelative = (path: string) => {
  const root = useStore.getState().status.project?.root;
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
};

/** Hands a compiler note to the assistant, with where it is, to explain and fix. */
function askToFix(view: EditorView, from: number, n: Note) {
  const path = viewPath.get(view);
  if (!path) return;
  const line = view.state.doc.lineAt(from);
  const doc = view.state.doc.toString();
  const r = formAtOrBefore(doc, from);
  const form = r ? doc.slice(r.from, r.to) : null;
  const text = [
    `SBCL reports this ${n.severity.replace("-", " ")} in ${projectRelative(path)} at line ${line.number}:`,
    "",
    n.message,
    "",
    "Find the cause, say it in a sentence or two, and fix it in the file.",
  ].join("\n");
  return actions.askToFix(path, text, { file: path, package: bufferPackage(view, from), form: form ? form.slice(0, 4000) : null });
}

/**
 * A Coalton message without its copy of the source, which the underline already
 * shows: the headline, what the carets say, and any help. Other messages stay whole.
 */
export function briefMessage(message: string): string {
  const lines = message.split("\n");
  if (!lines.some((l) => /^\s*--> /.test(l))) return message;
  let headline = lines[0].replace(/^(error|warning): /, "");
  const rest: string[] = [];
  for (const line of lines.slice(1)) {
    const label = /^\s*\|[\s|/\\_]*[\^\-~]+\s+(\S.*)$/.exec(line)?.[1];
    if (label) {
      if (label.startsWith(headline)) headline = label;
      else rest.push(label);
    } else if (!/^\s*(-->|\d*\s*\|)/.test(line) && line.trim()) rest.push(line.trim());
  }
  return [headline, ...rest].join("\n");
}

/** Makes the edit a compiler suggested, when the text it would replace is still at `at`. */
function applyFix(view: EditorView, at: number, fix: Fix) {
  if (view.state.sliceDoc(at, at + fix.old.length) !== fix.old) return void actions.flash("The code changed since this was checked", "error");
  view.dispatch({ changes: { from: at, to: at + fix.old.length, insert: fix.text }, userEvent: "input" });
}

export function notesToDiagnostics(notes: Note[], text: string): Diagnostic[] {
  return notes
    .filter((n) => n.location?.offset != null)
    .map((n) => {
      const at = Math.min(Math.max(0, n.location!.offset!), text.length);
      const end = text[at] === "(" ? (listEnd(text, at) ?? at + 1) : (symbolAt(text, at)?.to ?? at);
      // SBCL places a note at the form it was compiling; the symbol it names is more exact.
      const symbol = noteSymbol(n.message);
      const exact = symbol ? symbolIn(text, at, end, symbol) : null;
      const from = exact?.from ?? at;
      const to = exact?.to ?? end;
      return {
        from,
        to,
        // An undefined function is only a style warning to SBCL, and the commonest typo.
        severity: n.severity === "error" || n.severity === "read-error" ? "error" : n.severity === "warning" || n.severity === "style-warning" ? "warning" : "info",
        message: briefMessage(n.message),
        source: "SBCL",
        actions: [
          ...n.fixes.map((f) => ({ name: f.label[0].toUpperCase() + f.label.slice(1), apply: (view: EditorView, at: number) => applyFix(view, at + f.offset - from, f) })),
          { name: "Copy", apply: () => void navigator.clipboard.writeText(n.message) },
          { name: "Ask AI to fix", apply: (view, from) => void askToFix(view, from, n) },
        ],
      } satisfies Diagnostic;
    });
}
