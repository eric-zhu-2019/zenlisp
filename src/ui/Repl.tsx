import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useMemo, useRef, useState } from "react";
import * as actions from "../actions";
import { lispCompletions, updateArglist } from "../editor/commands";
import { lispIndentation } from "../editor/indent";
import { lisp } from "../editor/lisp";
import { lispPackage, lispRegionStart } from "../editor/region";
import { structureExtension } from "../editor/structure";
import { optionKeys, structuralKeymap } from "../editor/structural";
import { type State, type TranscriptItem, set, useStore } from "../store";
import { Icon } from "./Icon";
import { layout, promptText, replBuffer, runInput, searchHistory, setInput, TranscriptRenderer } from "./replBuffer";

const HISTORY = "zenlisp.replHistory";

/** Inputs run in any REPL, oldest first, shared by every REPL and kept across launches. */
const past: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY) ?? "[]");
  } catch {
    return [];
  }
})();

function remember(code: string) {
  if (past[past.length - 1] !== code) past.push(code);
  try {
    localStorage.setItem(HISTORY, JSON.stringify(past.slice(-500)));
  } catch {
    // History is a convenience.
  }
}

/** Where a REPL buffer's transcript comes from and where its input goes. */
type Source = {
  key: string;
  read: (s: State) => { transcript: TranscriptItem[]; package: string; reading: boolean };
  submit: (code: string, shown: string) => void;
  inspect: (presentation: number) => void;
};

const mainSource: Source = {
  key: "main",
  read: (s) => ({ transcript: s.transcript, package: s.package, reading: s.inputRequest !== null }),
  submit: (code, shown) => {
    if (useStore.getState().inputRequest) return void actions.answerInput(code);
    remember(shown);
    void actions.replEval(code, shown);
  },
  inspect: (id) => actions.inspectPresentation(id),
};

function extraSource(replId: number): Source {
  const repl = (s: State) => s.repls.find((r) => r.id === replId);
  return {
    key: `repl-${replId}`,
    read: (s) => {
      const r = repl(s);
      return { transcript: r?.transcript ?? [], package: r?.package ?? "COMMON-LISP-USER", reading: r?.reading ?? false };
    },
    submit: (code, shown) => {
      if (!repl(useStore.getState())?.reading) remember(shown);
      actions.replSend(replId, code, shown);
    },
    inspect: () => {},
  };
}

/** Input typed but not yet run, per REPL, kept while its buffer is hidden. */
const drafts = new Map<string, string>();

/** The buffer on show, for history search to fill. */
const shown: { view: EditorView | null } = { view: null };

function ReplBuffer({ source, onSearch }: { source: Source; onSearch: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  useEffect(() => {
    if (!host.current) return;
    let cursor = past.length;
    let pending = "";
    const now = () => source.read(useStore.getState());

    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: promptText(now().package),
        extensions: [
          replBuffer({
            reading: () => now().reading,
            submit: (code, text) => {
              cursor = past.length + 1;
              pending = "";
              source.submit(code, text);
            },
            history: (dir, current) => {
              if (cursor > past.length) cursor = past.length;
              if (cursor === past.length) pending = current;
              const next = Math.max(0, Math.min(past.length, cursor + dir));
              if (next === cursor) return null;
              cursor = next;
              return cursor === past.length ? pending : past[cursor];
            },
            inspect: (id) => source.inspect(id),
          }),
          // While Lisp reads raw text there is no Lisp region for parinfer to correct.
          lispRegionStart.of((s) => (now().reading ? s.doc.length : s.field(layout).inputStart)),
          lispPackage.of(() => now().package),
          history(),
          lisp(),
          lispIndentation(() => useStore.getState().indentSpecs),
          EditorView.lineWrapping,
          bracketMatching(),
          structureExtension(),
          Prec.highest(keymap.of(structuralKeymap)),
          optionKeys,
          autocompletion({ override: [lispCompletions], activateOnTypingDelay: 120 }),
          Prec.high(
            keymap.of([
              { key: "Ctrl-c", run: () => (actions.interrupt(), true) },
              { key: "Ctrl-r", run: () => (searchRef.current(), true) },
              { key: "Mod-k", run: () => (clearTranscript(source), true) },
            ]),
          ),
          keymap.of([...completionKeymap, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) updateArglist(u.view);
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "var(--editor-font-size)", lineHeight: "1.5" },
          }),
        ],
      }),
    });

    const renderer = new TranscriptRenderer();
    const sync = () => {
      const s = now();
      renderer.setPrompt(view, s.package, s.reading);
      renderer.sync(view, s.transcript, s.package);
    };
    sync();
    const draft = drafts.get(source.key);
    if (draft) {
      const { inputStart } = view.state.field(layout);
      view.dispatch({ changes: { from: inputStart, to: view.state.doc.length, insert: draft } });
    }
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    let before = now();
    const unsubscribe = useStore.subscribe(() => {
      const s = now();
      if (s.transcript !== before.transcript || s.package !== before.package || s.reading !== before.reading) sync();
      if (s.reading && !before.reading) {
        view.focus();
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      }
      before = s;
    });
    shown.view = view;
    (window as unknown as { zenRepl?: EditorView }).zenRepl = view;

    return () => {
      drafts.set(source.key, view.state.doc.sliceString(view.state.field(layout).inputStart));
      unsubscribe();
      if (shown.view === view) shown.view = null;
      view.destroy();
    };
  }, [source]);

  return <div className="repl-buffer" ref={host} data-testid="repl-input" />;
}

function clearTranscript(source: Source) {
  if (source.key === "main") set({ transcript: [] });
  else set((s) => ({ repls: s.repls.map((r) => (`repl-${r.id}` === source.key ? { ...r, transcript: [] } : r)) }));
}

/** ⌃R: finds an earlier input as the shell's reverse search does, and puts it in the input. */
function HistorySearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = useMemo(() => searchHistory(past, query), [query]);
  const pick = (run: boolean) => {
    const code = matches[index];
    const view = shown.view;
    onClose();
    if (code === undefined || !view) return;
    setInput(view, code);
    view.focus();
    if (run) runInput(view);
  };
  const move = (by: number) => setIndex((i) => Math.max(0, Math.min(matches.length - 1, i + by)));

  return (
    <div className="history-search" data-testid="history-search">
      <div className="history-input">
        <span className="dim">Search history</span>
        <input
          autoFocus
          value={query}
          placeholder="Type part of an earlier input"
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onBlur={onClose}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              shown.view?.focus();
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(e.metaKey);
            } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "r")) {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "s")) {
              e.preventDefault();
              move(-1);
            }
          }}
        />
        <span className="dim hint">↩ use · ⌘↩ run · ⌃R older</span>
      </div>
      {matches.length === 0 ? (
        <div className="history-empty dim">{past.length ? "No earlier input matches." : "Nothing run yet."}</div>
      ) : (
        <ul>
          {matches.map((m, i) => (
            <li
              key={m}
              className={i === index ? "selected" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                setIndex(i);
                pick(false);
              }}
            >
              <Highlighted text={m.split("\n")[0]} query={query} />
              {m.includes("\n") && <span className="dim"> …</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <code>{text}</code>;
  return (
    <code>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </code>
  );
}

export function Repl() {
  const repls = useStore((s) => s.repls);
  const active = useStore((s) => s.activeRepl);
  const [searching, setSearching] = useState(false);
  const extra = repls.find((r) => r.id === active);
  const source = useMemo(() => (extra ? extraSource(extra.id) : mainSource), [extra?.id]);

  return (
    <div className="repl">
      {repls.length > 0 && (
        <div className="repl-tabs" role="tablist">
          <button role="tab" className={`repl-tab ${extra ? "" : "active"}`} onClick={() => set({ activeRepl: null })}>
            Main
          </button>
          {repls.map((r) => (
            <span key={r.id} role="tab" className={`repl-tab ${r.id === active ? "active" : ""}`} onClick={() => set({ activeRepl: r.id })}>
              {r.name}
              {r.busy && <span className="dot starting" />}
              <button
                title={`Close ${r.name} and end its thread`}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.closeRepl(r.id);
                }}
              >
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
        </div>
      )}
      <ReplBuffer key={source.key} source={source} onSearch={() => setSearching(true)} />
      {searching && <HistorySearch onClose={() => setSearching(false)} />}
    </div>
  );
}
