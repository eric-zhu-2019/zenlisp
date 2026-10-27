// Every key binding in ZenLisp. The editor keymap, the Vim mappings, the
// window shortcuts and the help screen are all built from this table.

import type { KeyBinding } from "@codemirror/view";
import { runPluginCommand, usePlugins } from "./plugins";
import type { EditorView } from "@codemirror/view";
import * as actions from "./actions";
import { inTauri } from "./backend";
import {
  compileFile,
  compileForm,
  describeSymbol,
  disassembleAtCursor,
  documentSymbol,
  activeEditor,
  evalForm,
  evalLastForm,
  findReferencesAtCursor,
  goToDefinition,
  inspectAtCursor,
  loadFile,
  macroexpand,
  profileAtCursor,
  toggleRepl,
  toggleTraceAtCursor,
  viewPath,
} from "./editor/commands";
import { showDocTip } from "./editor/hover";
import { isMarkdown } from "./ui/MarkdownPreview";
import { reindentForm } from "./editor/indent";
import { structuralCommands } from "./editor/structural";
import { useSettings } from "./settings";
import { activeDebugger, get, set } from "./store";
import { toggleBreakpoint } from "./editor/breakpoints";

export type Category = "Lisp" | "Navigation" | "Editing" | "Structure" | "Project" | "Window" | "REPL" | "Debugger" | "Tools" | "Plugins";

type Base = {
  id: string;
  label: string;
  category: Category;
  key?: string;
  vim?: string;
  /** An Emacs key sequence, written as Emacs documents it: "C-x C-e", "M-.", "C-c RET". */
  emacs?: string;
  note?: string;
  /** The editor built-in this window shortcut deliberately replaces. */
  overrides?: string;
};

export type Binding =
  | (Base & { scope: "editor"; run: (view: EditorView) => boolean })
  /** `when` false lets the key through to the editor, as the step keys do outside the stepper. */
  | (Base & { scope: "window"; run: () => void; when?: () => boolean })
  | (Base & { scope: "elsewhere" });

const save = (v: EditorView) => {
  const p = viewPath.get(v);
  if (p) actions.saveTab(p);
  return true;
};

const stepping = () => activeDebugger(get())?.stepping === true;

function testProject() {
  const system = get().tests?.system ?? get().systems[0]?.name;
  if (system) return actions.testSystem(system);
}

const toggleRight = (panel: "inspector" | "assistant" | "docs") => set({ right: get().right === panel ? null : panel });

export const bindings: Binding[] = [
  { id: "eval", label: "Evaluate the top-level form at the cursor", category: "Lisp", key: "Mod-Enter", vim: ",e", emacs: "C-M-x", scope: "editor", run: evalForm },
  { id: "eval-last", label: "Evaluate the form before the cursor", category: "Lisp", emacs: "C-x C-e", scope: "editor", run: evalLastForm },
  { id: "compile-form", label: "Compile the form, with compiler notes", category: "Lisp", key: "Mod-Shift-Enter", vim: ",c", emacs: "C-c C-c", scope: "editor", run: compileForm },
  { id: "compile-file", label: "Compile and load the file", category: "Lisp", key: "Mod-b", vim: ",l", emacs: "C-c C-k", scope: "editor", run: compileFile, note: "or :make" },
  { id: "load-file", label: "Load the file without compiling", category: "Lisp", emacs: "C-c C-l", scope: "editor", run: loadFile },
  { id: "macroexpand", label: "Expand the macro a step", category: "Lisp", key: "Mod-Shift-m", vim: ",m", emacs: "C-c RET", note: "then click macros inside to expand them in place", scope: "editor", run: (v) => macroexpand(v) },
  { id: "macroexpand-all", label: "Macroexpand fully", category: "Lisp", key: "Mod-Alt-m", vim: ",M", emacs: "C-c M-m", scope: "editor", run: (v) => macroexpand(v, true) },
  { id: "doc-tip", label: "Show the symbol's documentation in a popup", category: "Lisp", vim: "K", note: "Escape closes it", scope: "editor", run: (v) => showDocTip(v) },
  { id: "describe", label: "Describe the symbol in full", category: "Lisp", key: "Mod-d", emacs: "C-c C-d d", scope: "editor", run: describeSymbol },
  { id: "docs", label: "Show the symbol's documentation and HyperSpec page", category: "Lisp", key: "Mod-Shift-d", vim: ",h", emacs: "C-c C-d h", scope: "editor", run: documentSymbol },
  { id: "inspect", label: "Inspect the symbol or selection", category: "Lisp", key: "Mod-i", vim: ",i", emacs: "C-c I", scope: "editor", run: inspectAtCursor },
  { id: "interrupt", label: "Interrupt the evaluation", category: "Lisp", emacs: "C-c C-b", scope: "window", run: () => void actions.interrupt() },
  { id: "definition", label: "Go to definition", category: "Navigation", key: "F12", vim: "gd", emacs: "M-.", scope: "editor", run: goToDefinition },
  { id: "references", label: "Find references", category: "Navigation", key: "Shift-F12", vim: "gr", emacs: "C-c C-w c", scope: "editor", run: findReferencesAtCursor },
  { id: "back", label: "Go back", category: "Navigation", key: "Ctrl-o", emacs: "M-,", overrides: "splitLine", note: "also in Vim", scope: "window", run: () => void actions.goBack() },
  { id: "forward", label: "Go forward", category: "Navigation", key: "Ctrl-Shift-o", note: "also in Vim", scope: "window", run: () => void actions.goForward() },
  { id: "files", label: "Go to file", category: "Navigation", key: "Mod-p", scope: "window", run: () => get().status.project && set({ palette: "files" }) },
  { id: "symbols", label: "Go to definition in file", category: "Navigation", key: "Mod-Shift-o", scope: "window", run: () => get().activeTab && set({ palette: "symbols" }) },
  { id: "search", label: "Search in project", category: "Navigation", key: "Mod-Shift-f", scope: "window", run: () => get().status.project && set({ sidebar: "search" }) },
  { id: "reindent", label: "Reindent the top-level form", category: "Editing", key: "Mod-Alt-l", note: "Vim: =aF, or == for a line", scope: "editor", run: (v) => reindentForm(v) },
  { id: "save", label: "Save", category: "Editing", key: "Mod-s", vim: ":w", scope: "editor", run: save },
  { id: "split", label: "Split the editor, or go to the other pane", category: "Window", key: "Mod-\\", scope: "window", run: () => actions.splitEditor() },
  { id: "pane-1", label: "Go to the left pane", category: "Window", key: "Mod-1", scope: "window", run: () => actions.focusPane(0) },
  { id: "pane-2", label: "Go to the right pane", category: "Window", key: "Mod-2", scope: "window", run: () => actions.focusPane(1) },
  { id: "close-tab", label: "Close the file", category: "Editing", key: "Mod-w", scope: "window", run: () => get().activeTab && actions.requestCloseTab(get().activeTab!) },
  { id: "settings", label: "Settings", category: "Window", key: "Mod-,", scope: "window", run: () => set({ palette: null, settingsOpen: true }) },
  { id: "palette", label: "Command palette", category: "Window", key: "Mod-Shift-p", scope: "window", run: () => set({ palette: "commands" }) },
  { id: "help", label: "Keyboard shortcuts", category: "Window", key: "Mod-Shift-/", scope: "window", run: () => set({ palette: null, help: true }) },
  { id: "comment", label: "Comment or uncomment the line", category: "Editing", key: "Mod-/", scope: "elsewhere", note: "CodeMirror built-in" },
  // In the app these keys belong to the File menu, which takes them before the page sees them.
  { id: "open", label: "Open a project", category: "Project", key: "Mod-o", note: "or File ▸ Open Project…", scope: "window", when: () => !inTauri, run: () => actions.requestOpenProject() },
  { id: "new", label: "New project", category: "Project", key: "Mod-Shift-n", note: "or File ▸ New Project…", scope: "window", when: () => !inTauri, run: () => set({ newProject: true }) },
  { id: "repl", label: "Switch to the REPL, or back to the editor", category: "Window", key: "Mod-j", emacs: "C-c C-z", scope: "window", run: () => void toggleRepl() },
  { id: "assistant", label: "Toggle the assistant", category: "Window", key: "Mod-l", scope: "window", run: () => toggleRight("assistant") },
  { id: "inspector", label: "Toggle the inspector", category: "Window", key: "Mod-Alt-i", scope: "window", run: () => toggleRight("inspector") },
  { id: "docs-panel", label: "Toggle the documentation panel", category: "Window", scope: "window", run: () => toggleRight("docs") },
  { id: "md-preview", label: "Show a Markdown file rendered, or as text", category: "Window", key: "Mod-Shift-v", scope: "window", when: () => isMarkdown(get().activeTab), run: () => actions.togglePreview(get().activeTab!) },
  { id: "wrap", label: "Wrap long lines, or stop wrapping them", category: "Window", key: "Alt-z", scope: "window", run: () => useSettings.setState((s) => ({ wordWrap: !s.wordWrap })) },
  { id: "bigger", label: "Increase the font size", category: "Window", key: "Mod-=", scope: "window", run: () => useSettings.setState((s) => ({ fontSize: s.fontSize + 1 })) },
  { id: "smaller", label: "Decrease the font size", category: "Window", key: "Mod--", scope: "window", run: () => useSettings.setState((s) => ({ fontSize: Math.max(9, s.fontSize - 1) })) },
  { id: "repl-send", label: "Run the input, with the cursor at its end", category: "REPL", key: "Enter", note: "elsewhere it opens an indented line", scope: "elsewhere" },
  { id: "repl-run", label: "Run the input from anywhere in it", category: "REPL", key: "Mod-Enter", scope: "elsewhere" },
  { id: "repl-newline", label: "Open an indented line", category: "REPL", key: "Shift-Enter", scope: "elsewhere" },
  { id: "repl-history", label: "Recall earlier input", category: "REPL", key: "ArrowUp", scope: "elsewhere", note: "and ↓" },
  { id: "repl-interrupt", label: "Interrupt the evaluation", category: "REPL", key: "Ctrl-c", scope: "elsewhere" },
  { id: "repl-clear", label: "Clear the REPL", category: "REPL", key: "Mod-k", note: "or ⌃L", scope: "elsewhere" },
  { id: "repl-search", label: "Search earlier input", category: "REPL", key: "Ctrl-r", note: "⌃R again for older matches", scope: "elsewhere" },
  { id: "repl-use-result", label: "Use a result in the input", category: "REPL", note: "click it; ⌘-click inspects it", scope: "elsewhere" },
  { id: "breakpoint", label: "Toggle a breakpoint on the line", category: "Debugger", key: "Mod-F8", vim: ",b", note: "or click the gutter", scope: "editor", run: (v) => toggleBreakpoint(v) },
  { id: "step-into", label: "Step into the next form", category: "Debugger", key: "F7", note: "s in the debugger, as in SLIME", scope: "window", when: stepping, run: () => actions.stepActive("into") },
  { id: "step-over", label: "Step over the next form", category: "Debugger", key: "F8", note: "x in the debugger; otherwise F8 goes to the next problem", overrides: "nextDiagnostic", scope: "window", when: stepping, run: () => actions.stepActive("over") },
  { id: "step-out", label: "Step out of the function", category: "Debugger", key: "Shift-F8", note: "o in the debugger", scope: "window", when: stepping, run: () => actions.stepActive("out") },
  { id: "step-continue", label: "Stop stepping and run on", category: "Debugger", key: "F9", note: "c in the debugger", scope: "window", when: stepping, run: () => actions.stepActive("continue") },
  { id: "test", label: "Run the project's tests", category: "Tools", key: "Mod-u", note: "the last system tested, or the first", overrides: "undoSelection", scope: "window", run: () => void testProject() },
  { id: "diff", label: "Show the file's changes since the last commit", category: "Tools", vim: ",g", note: "or click a change marker in the gutter", scope: "editor", run: (v) => {
    const path = viewPath.get(v);
    if (path) actions.toggleDiff(path);
    return !!path;
  } },
  { id: "trace", label: "Trace the function, or stop tracing it", category: "Tools", key: "Mod-Alt-t", vim: ",t", emacs: "C-c M-t", note: "calls show in the Trace panel", scope: "editor", run: toggleTraceAtCursor },
  { id: "profile", label: "Profile the form", category: "Tools", key: "Mod-Alt-p", vim: ",p", note: "the selection, or the top-level form", scope: "editor", run: profileAtCursor },
  { id: "profile-all", label: "Start or stop profiling every thread", category: "Tools", scope: "window", run: () => void (get().profiling === "all" ? actions.stopProfiling() : actions.startProfiling()) },
  { id: "disassemble", label: "Disassemble the function", category: "Tools", vim: ",d", emacs: "C-c M-d", note: "⌥⌘D is the system's Dock shortcut", scope: "editor", run: disassembleAtCursor },
  { id: "restart", label: "Invoke a restart by number", category: "Debugger", key: "0-9", scope: "elsewhere" },
  { id: "abort", label: "Abort to top level", category: "Debugger", key: "q", scope: "elsewhere" },
];

const GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Cmd: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Ctrl: "⌃",
  Enter: "↩",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backspace: "⌫",
  Escape: "⎋",
};

/** Splits "Mod-Shift--" into ["Mod", "Shift", "-"]. */
function keyParts(key: string): string[] {
  const parts = key.split("-");
  if (key.endsWith("--")) return [...parts.slice(0, -2), "-"];
  return parts;
}

/** "Mod-Shift-p" as macOS shows it: ⇧⌘P. */
export function displayKey(key: string): string {
  const parts = keyParts(key);
  const last = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  const order = ["Ctrl", "Alt", "Shift", "Mod", "Cmd"];
  const shown = order.filter((m) => mods.includes(m)).map((m) => GLYPHS[m]);
  return shown.join("") + (GLYPHS[last] ?? (last.length === 1 ? last.toUpperCase() : last));
}

const CODES: Record<string, string> = { "-": "Minus", "=": "Equal", "/": "Slash" };

/** Whether a window keydown is `key`, compared by physical key for punctuation so ⇧ does not change it. */
export function matches(e: KeyboardEvent, key: string): boolean {
  const parts = keyParts(key);
  const last = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  if (e.metaKey !== mods.has("Mod") || e.ctrlKey !== mods.has("Ctrl") || e.altKey !== mods.has("Alt") || e.shiftKey !== mods.has("Shift")) {
    return false;
  }
  if (CODES[last]) return e.code === CODES[last];
  // ⌥ makes macOS type a composed character, such as Ω for ⌥Z, so letters with it match by key.
  if (mods.has("Alt") && /^[a-z]$/i.test(last)) return e.code === `Key${last.toUpperCase()}`;
  return e.key.toLowerCase() === last.toLowerCase();
}

export function editorKeymap(): KeyBinding[] {
  return bindings.flatMap((b) => (b.scope === "editor" && b.key ? [{ key: b.key, run: b.run }] : []));
}

/**
 * Window shortcuts, listened for in the capture phase so they act once, before
 * the editor or Vim see the key. Editor bindings are left to CodeMirror.
 */
export function handleWindowKey(e: KeyboardEvent) {
  for (const b of bindings) {
    if (b.scope === "window" && b.key && matches(e, b.key) && (b.when?.() ?? true)) {
      e.preventDefault();
      e.stopPropagation();
      b.run();
      return;
    }
  }
  for (const c of usePlugins.getState().manifest?.commands ?? []) {
    if (c.key && matches(e, c.key)) {
      e.preventDefault();
      e.stopPropagation();
      void runPluginCommand(c.id);
      return;
    }
  }
}

const EMACS_NAMED: Record<string, string> = { RET: "Enter", TAB: "Tab", SPC: " ", ESC: "Escape", DEL: "Backspace" };
const EMACS_CODES: Record<string, string> = { ".": "Period", ",": "Comma", "/": "Slash", ";": "Semicolon", "-": "Minus", "=": "Equal" };

/**
 * Whether a keydown is one Emacs key such as "C-x", "C-M-x", "M-." or "I".
 * Letters and punctuation are read by physical key, because ⌥ makes macOS
 * type a composed character such as ≥ instead of the letter.
 */
export function emacsKeyMatches(e: KeyboardEvent, token: string): boolean {
  let rest = token;
  const want = { ctrl: false, alt: false };
  for (;;) {
    if (rest.startsWith("C-") && rest.length > 2) (want.ctrl = true), (rest = rest.slice(2));
    else if (rest.startsWith("M-") && rest.length > 2) (want.alt = true), (rest = rest.slice(2));
    else break;
  }
  if (e.ctrlKey !== want.ctrl || e.altKey !== want.alt || e.metaKey) return false;
  if (EMACS_NAMED[rest]) return e.key === EMACS_NAMED[rest] && !e.shiftKey;
  if (EMACS_CODES[rest]) return e.code === EMACS_CODES[rest] && !e.shiftKey;
  if (/^[a-zA-Z]$/.test(rest)) {
    const shifted = rest !== rest.toLowerCase();
    return e.code === `Key${rest.toUpperCase()}` && e.shiftKey === shifted;
  }
  return e.key === rest;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** A keydown in Emacs notation, for messages such as "C-x C-q is undefined". */
function emacsName(e: KeyboardEvent): string {
  const base = /^Key[A-Z]$/.test(e.code) ? e.code[3][e.shiftKey ? "toUpperCase" : "toLowerCase"]() : e.key;
  const named = Object.entries(EMACS_NAMED).find(([, k]) => k === base)?.[0] ?? base;
  return `${e.ctrlKey ? "C-" : ""}${e.altKey ? "M-" : ""}${named}`;
}

export type ChordStep =
  | { kind: "pass" }
  | { kind: "pending"; prefix: string }
  | { kind: "run"; binding: Binding }
  | { kind: "undefined"; sequence: string }
  | { kind: "cancel" };

/** Follows Emacs key sequences one keydown at a time, as Emacs's prefix keys do. */
export class EmacsChords {
  private typed: string[] = [];

  constructor(private readonly table: () => Binding[] = () => bindings) {}

  feed(e: KeyboardEvent): ChordStep {
    if (MODIFIER_KEYS.has(e.key)) return this.typed.length ? { kind: "pending", prefix: this.typed.join(" ") } : { kind: "pass" };
    if (this.typed.length && (emacsKeyMatches(e, "C-g") || e.key === "Escape")) {
      this.typed = [];
      return { kind: "cancel" };
    }
    const depth = this.typed.length;
    const candidates = this.table().filter((b) => {
      const seq = b.emacs?.split(" ");
      return seq && seq.length > depth && seq.slice(0, depth).join(" ") === this.typed.join(" ") && emacsKeyMatches(e, seq[depth]);
    });
    if (candidates.length === 0) {
      if (!depth) return { kind: "pass" };
      const sequence = [...this.typed, emacsName(e)].join(" ");
      this.typed = [];
      return { kind: "undefined", sequence };
    }
    const token = candidates[0].emacs!.split(" ")[depth];
    const complete = candidates.find((b) => b.emacs!.split(" ").length === depth + 1);
    if (complete) {
      this.typed = [];
      return { kind: "run", binding: complete };
    }
    this.typed.push(token);
    return { kind: "pending", prefix: this.typed.join(" ") };
  }
}

/** Plugin commands with keys, as bindings: the Emacs chords follow them and help lists them. */
export function pluginBindings(commands = usePlugins.getState().manifest?.commands ?? []): Binding[] {
  return commands
    .filter((c) => c.key || c.emacs)
    .map((c) => ({
      id: `plugin:${c.id}`,
      label: c.title,
      category: "Plugins",
      key: c.key ?? undefined,
      emacs: c.emacs ?? undefined,
      note: `from ${c.plugin}`,
      scope: "window",
      run: () => void runPluginCommand(c.id),
    }));
}

/** Emacs key sequences in the main editor, caught before CodeMirror and Vim. */
export function emacsKeyHandler() {
  const chords = new EmacsChords(() => [...bindings, ...pluginBindings()]);
  return (e: KeyboardEvent) => {
    if (!useSettings.getState().emacs) return;
    const view = activeEditor.view;
    if (!view || !(e.target instanceof Node) || !view.dom.contains(e.target)) return;
    const step = chords.feed(e);
    if (step.kind === "pass") return;
    e.preventDefault();
    e.stopPropagation();
    if (step.kind === "pending") set({ chord: `${step.prefix}-` });
    else if (step.kind === "cancel") set({ chord: null });
    else if (step.kind === "undefined") {
      set({ chord: `${step.sequence} is undefined` });
      setTimeout(() => get().chord?.endsWith("undefined") && set({ chord: null }), 1500);
    } else {
      set({ chord: null });
      const b = step.binding;
      if (b.scope === "editor") b.run(view);
      else if (b.scope === "window") b.run();
    }
  };
}

type VimApi = {
  defineAction(name: string, fn: (cm: { cm6: EditorView }) => void): void;
  mapCommand(keys: string, type: string, name: string, args: object, extra: object): void;
  unmap(lhs: string, ctx?: string): boolean | undefined;
};

export function mapVimBindings(Vim: VimApi) {
  // , is our leader, as in Slimv. Vim's own , (repeat f/t backwards) would
  // match first and hide every ,e-style binding.
  if (bindings.some((b) => b.vim?.startsWith(","))) Vim.unmap(",");
  for (const b of bindings) {
    if (!b.vim || b.vim.startsWith(":") || b.scope === "elsewhere") continue;
    const name = `zl-${b.id}`;
    const run = b.run;
    if (b.scope === "editor") Vim.defineAction(name, (cm) => void (run as (v: EditorView) => boolean)(cm.cm6));
    else Vim.defineAction(name, () => (run as () => void)());
    Vim.mapCommand(b.vim, "action", name, {}, { context: "normal" });
  }
}

// Structural editing keeps its own table, which builds its keymap and Vim
// motions; the registry lists it so help shows one complete picture.
bindings.push(
  ...structuralCommands.map(
    (c): Binding => ({
      id: `structure-${c.name}`,
      label: c.name,
      category: "Structure",
      key: c.keys[0],
      vim: c.vim.join(" "),
      note: c.keys.length > 1 ? `or ${c.keys.slice(1).map(displayKey).join(", ")}` : undefined,
      scope: "elsewhere",
    }),
  ),
);
