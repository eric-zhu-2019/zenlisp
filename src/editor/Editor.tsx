import { setDiagnostics } from "@codemirror/lint";
import { EditorSelection, EditorState, type StateEffect, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { useEffect, useRef } from "react";
import * as actions from "../actions";
import { useSettings } from "../settings";
import { liveDebugSpot, useStore } from "../store";
import { activeEditor, notesToDiagnostics, viewPath } from "./commands";
import { setBound, setBreakpoints } from "./breakpoints";
import { setDebugSpot } from "./debugSpot";
import { diffCompartment, editorExtensions, externalChange, fallbackStructure, structureCompartment, vimCompartment, watchVimMode, wrapCompartment } from "./setup";
import { setGitBase } from "./gitGutter";
import { unifiedMergeView } from "@codemirror/merge";
import { structureExtension } from "./structure";

/**
 * The change that turns `from` into `to`: the span between their common start
 * and end. Mirroring a file's edits from another pane this way keeps the
 * cursor and the undo history of the text around the edit.
 */
export function difference(from: string, to: string) {
  let start = 0;
  const max = Math.min(from.length, to.length);
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

/** Brings a state's text up to the store's, after the same file was edited in the other pane. */
function mirrored(st: EditorState, text: string) {
  if (st.doc.length === text.length && st.doc.toString() === text) return null;
  return { changes: difference(st.doc.toString(), text), annotations: [Transaction.addToHistory.of(false), externalChange.of(true)] };
}

export function Editor({ pane }: { pane: number }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const activeTab = useStore((s) => s.panes[pane]?.active ?? null);
  const focused = useStore((s) => s.focusedPane === pane);
  const tabs = useStore((s) => s.tabs);
  const notes = useStore((s) => (activeTab ? s.notes[activeTab] : undefined));
  const reveal = useStore((s) => s.reveal);
  const spot = useStore(liveDebugSpot);
  const bound = useStore((s) => (activeTab ? s.boundBreakpoints[activeTab] : undefined));
  const gitHead = useStore((s) => (activeTab ? s.gitHeads[activeTab] : undefined));
  const diffShown = useStore((s) => (activeTab ? s.diffOn.includes(activeTab) : false));
  const vimOn = useSettings((s) => s.vim);
  const wrapOn = useSettings((s) => s.wordWrap);
  const parinferOn = useSettings((s) => s.parinfer);

  const stateFor = (path: string) => {
    const existing = states.current.get(path);
    if (existing) return existing;
    const tab = useStore.getState().tabs.find((t) => t.path === path);
    const st = EditorState.create({
      doc: tab?.text ?? "",
      extensions: editorExtensions({
        vim: useSettings.getState().vim,
        structure: useSettings.getState().parinfer ? structureExtension() : fallbackStructure,
        onChange: (text) => {
          actions.updateTab(path, text);
          actions.checkSoon(path);
        },
        onBreakpoints: (list, toggled) => actions.breakpointsChanged(path, list, toggled),
        readOnly: actions.readOnlyFile(path),
        wrap: useSettings.getState().wordWrap,
      }),
    }).update({ effects: setBreakpoints.of(useStore.getState().breakpoints[path] ?? []) }).state;
    states.current.set(path, st);
    return st;
  };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current });
    view.current = v;
    if (useStore.getState().focusedPane === pane) activeEditor.view = v;
    // Clicking or typing in a pane focuses it, so commands act on its file.
    const focus = () => {
      activeEditor.view = v;
      actions.focusPane(pane);
    };
    v.contentDOM.addEventListener("focus", focus);
    return () => {
      v.contentDOM.removeEventListener("focus", focus);
      if (activeEditor.view === v) activeEditor.view = null;
      v.destroy();
    };
  }, [pane]);

  useEffect(() => {
    if (focused && view.current) activeEditor.view = view.current;
  }, [focused]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const prev = viewPath.get(v);
    if (prev) states.current.set(prev, v.state);
    if (!activeTab) {
      viewPath.delete(v);
      v.setState(EditorState.create({ doc: "" }));
      return;
    }
    viewPath.set(v, activeTab);
    let st = stateFor(activeTab);
    const text = useStore.getState().tabs.find((t) => t.path === activeTab)?.text;
    const sync = text === undefined ? null : mirrored(st, text);
    if (sync) st = st.update(sync).state;
    v.setState(st);
    actions.checkSoon(activeTab, 0);
    watchVimMode(v);
    if (useStore.getState().focusedPane === pane) v.focus();
  }, [activeTab]);

  const revisions = useRef(new Map<string, number>());

  useEffect(() => {
    const open = new Set(tabs.map((t) => t.path));
    for (const p of states.current.keys()) if (!open.has(p)) states.current.delete(p);
    for (const tab of tabs) {
      const seen = revisions.current.get(tab.path) ?? 0;
      revisions.current.set(tab.path, tab.revision);
      if (tab.revision <= seen) continue;
      // The file changed on disk and the buffer was clean, so take the disk text.
      const v = view.current;
      // Only the span that changed is replaced, so the cursor stays and one undo reverts it.
      const replace = (st: EditorState) => ({ changes: difference(st.doc.toString(), tab.text), annotations: externalChange.of(true) });
      if (v && viewPath.get(v) === tab.path) v.dispatch(replace(v.state));
      else {
        const st = states.current.get(tab.path);
        if (st) states.current.set(tab.path, st.update(replace(st)).state);
      }
    }
    // The other pane may show this file too and have just changed it.
    const v = view.current;
    const shownTab = v && tabs.find((t) => t.path === viewPath.get(v));
    const sync = shownTab && v && mirrored(v.state, shownTab.text);
    if (sync && v) v.dispatch(sync);
  }, [tabs]);

  const reconfigureAll = (effect: () => StateEffect<unknown>) => {
    for (const [p, st] of states.current) states.current.set(p, st.update({ effects: effect() }).state);
    view.current?.dispatch({ effects: effect() });
  };

  useEffect(() => {
    reconfigureAll(() => vimCompartment.reconfigure(vimOn ? vim({ status: false }) : []));
  }, [vimOn]);

  useEffect(() => {
    reconfigureAll(() => wrapCompartment.reconfigure(wrapOn ? EditorView.lineWrapping : []));
  }, [wrapOn]);

  useEffect(() => {
    reconfigureAll(() => structureCompartment.reconfigure(parinferOn ? structureExtension() : fallbackStructure));
  }, [parinferOn]);

  useEffect(() => {
    const v = view.current;
    if (!v || !activeTab) return;
    v.dispatch(setDiagnostics(v.state, notesToDiagnostics(notes ?? [], v.state.doc.toString())));
  }, [notes, activeTab]);

  useEffect(() => {
    const v = view.current;
    if (v && activeTab) v.dispatch({ effects: setBound.of(bound ?? []) });
  }, [bound, activeTab]);

  useEffect(() => {
    const v = view.current;
    if (v && activeTab && gitHead !== undefined) v.dispatch({ effects: setGitBase.of(gitHead) });
  }, [gitHead, activeTab]);

  useEffect(() => {
    const v = view.current;
    if (!v || !activeTab) return;
    const original = diffShown && gitHead != null ? gitHead : null;
    v.dispatch({
      effects: diffCompartment.reconfigure(
        original === null
          ? []
          : unifiedMergeView({
              original,
              gutter: false,
              syntaxHighlightDeletions: true,
              // Only reverting makes sense here; keeping a change is what saving does.
              mergeControls: (type, action) => {
                const b = document.createElement("button");
                if (type === "accept") {
                  b.hidden = true;
                  return b;
                }
                b.className = "cm-git-revert";
                b.textContent = "Revert";
                b.title = "Put back the committed lines";
                b.onmousedown = action;
                return b;
              },
            }),
      ),
    });
  }, [diffShown, gitHead, activeTab]);

  useEffect(() => {
    const v = view.current;
    if (!v || !activeTab) return;
    v.dispatch({ effects: setDebugSpot.of(spot?.path === activeTab ? spot.offset : null) });
  }, [spot, activeTab]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal || reveal.path !== activeTab || useStore.getState().focusedPane !== pane) return;
    const at = Math.min(reveal.offset, v.state.doc.length);
    v.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
    v.focus();
  }, [reveal, activeTab]);

  return <div className="editor-host" ref={host} />;
}
