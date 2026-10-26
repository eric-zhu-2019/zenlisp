// Plugins: Lisp code from ZenLisp's plugins folder (resources/lisp/plugins.lisp).
// The manifest says what they add; commands and editor hooks answer with
// effects, edits and messages that this module applies.

import type { EditorView } from "@codemirror/view";
import { create } from "zustand";
import * as actions from "./actions";
import { activeEditor, bufferPackage } from "./editor/commands";
import { appendTranscript, get, set } from "./store";

export type PluginInfo = { name: string; path: string; error: string | null };
export type PluginCommand = { id: string; title: string; key: string | null; emacs: string | null; plugin: string };
export type PluginSetting = {
  id: string;
  plugin: string;
  title: string;
  type: "boolean" | "string" | "number" | "choice";
  value: boolean | number | string | null;
  choices: string[];
  doc: string | null;
};
export type Manifest = { directory: string | null; plugins: PluginInfo[]; commands: PluginCommand[]; settings: PluginSetting[]; hooks: string[] };

export type Effect =
  | { type: "replace"; from: number; to: number; text: string }
  | { type: "insert"; text: string }
  | { type: "open"; path: string; line: number | null }
  | { type: "message"; text: string }
  | { type: "print"; text: string };

type Answer = { effects: Effect[]; errors: string[] };

export const usePlugins = create<{ manifest: Manifest | null }>(() => ({ manifest: null }));

/** A plugin op's JSON answer, or null when Lisp is not there to answer. */
async function call<T>(op: Parameters<typeof actions.lisp>[0]): Promise<T | null> {
  const r = await actions.lisp(op).catch(() => null);
  return r?.kind === "text" ? (JSON.parse(r.text) as T) : null;
}

/** Load errors already shown, so each shows once in the REPL. */
const reported = new Set<string>();

function take(manifest: Manifest | null) {
  usePlugins.setState({ manifest });
  for (const p of manifest?.plugins ?? []) {
    const text = `Plugin ${p.name} did not load: ${p.error}`;
    if (p.error && !reported.has(text)) {
      reported.add(text);
      appendTranscript({ kind: "notice", tone: "error", text });
    }
  }
}

export async function fetchManifest() {
  take(await call<Manifest>({ op: "pluginManifest" }));
}

export async function reloadPlugins() {
  reported.clear();
  take(await call<Manifest>({ op: "reloadPlugins" }));
}

export async function setPluginSetting(id: string, value: boolean | number | string) {
  take(await call<Manifest>({ op: "setPluginSetting", id, value }));
}

export const hasHook = (event: string) => !!usePlugins.getState().manifest?.hooks.includes(event);

function report(errors: string[]) {
  for (const e of errors) appendTranscript({ kind: "notice", tone: "error", text: e });
  if (errors.length) actions.flash(errors[0], "error");
}

/** Applies effects to `view`, the editor they were asked of, if any. */
function apply(effects: Effect[], view: EditorView | null) {
  for (const e of effects) {
    if (e.type === "replace" && view) view.dispatch({ changes: { from: e.from, to: e.to, insert: e.text } });
    else if (e.type === "insert" && view) view.dispatch(view.state.replaceSelection(e.text));
    else if (e.type === "open") void (e.line ? actions.navigateToLine(e.path, e.line) : actions.navigate(e.path));
    else if (e.type === "message") actions.flash(e.text);
    else if (e.type === "print") appendTranscript({ kind: "output", text: e.text.endsWith("\n") ? e.text : `${e.text}\n` });
  }
}

export async function runPluginCommand(id: string) {
  const view = activeEditor.view;
  const sel = view?.state.selection.main;
  const answer = await call<Answer>({
    op: "runPluginCommand",
    id,
    file: get().activeTab,
    text: view?.state.doc.toString() ?? "",
    cursor: sel?.head ?? 0,
    selectionFrom: sel?.from ?? 0,
    selectionTo: sel?.to ?? 0,
    package: view ? bufferPackage(view) : "COMMON-LISP-USER",
  });
  if (!answer) return actions.flash("Plugins run in Lisp, which is not ready", "error");
  report(answer.errors);
  apply(answer.effects, view);
}

/** Edits as one string's change, for a file that is not on screen. */
function applyToText(text: string, effects: Effect[]) {
  let out = text;
  for (const e of effects) if (e.type === "replace") out = out.slice(0, e.from) + e.text + out.slice(e.to);
  return out;
}

/**
 * Runs the :before-save hooks on a file's text, applying their edits to its
 * editor, and returns the text to write.
 */
export async function beforeSave(path: string, text: string): Promise<string> {
  if (!hasHook("before-save")) return text;
  const answer = await call<Answer>({ op: "runPluginHook", event: "before-save", args: [path, text] });
  if (!answer) return text;
  report(answer.errors);
  const view = activeEditor.view && get().activeTab === path && activeEditor.view.state.doc.toString() === text ? activeEditor.view : null;
  if (view) {
    apply(answer.effects, view);
    return view.state.doc.toString();
  }
  apply(answer.effects.filter((e) => e.type !== "replace" && e.type !== "insert"), null);
  const changed = applyToText(text, answer.effects);
  if (changed !== text) set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, text: changed } : t)) }));
  return changed;
}

export async function afterSave(path: string) {
  if (!hasHook("after-save")) return;
  const answer = await call<Answer>({ op: "runPluginHook", event: "after-save", args: [path] });
  if (answer) {
    report(answer.errors);
    apply(answer.effects.filter((e) => e.type !== "replace" && e.type !== "insert"), null);
  }
}
