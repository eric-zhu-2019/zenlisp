// The REPL as one buffer, like SBCL's own: the transcript, then the prompt,
// then the input. Only the input is editable; the transcript can be read,
// searched, selected and copied like any text.

import { insertNewlineAndIndent } from "@codemirror/commands";
import { Annotation, EditorSelection, EditorState, type Extension, Facet, Prec, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { isComplete } from "../lisp/forms";
import type { TranscriptItem } from "../store";

/** Marks transactions that write the transcript, which the read-only guard lets through. */
export const transcriptWrite = Annotation.define<boolean>();

type Mark = { from: number; to: number; deco: Decoration };

type Layout = {
  /** Where the prompt starts: everything before it is transcript. */
  promptFrom: number;
  /** Where the user's input starts, just after the prompt. */
  inputStart: number;
  /** Past inputs, so Enter on one copies it down to the prompt. */
  inputs: { from: number; to: number }[];
  marks: DecorationSet;
};

type Append = { at: number; marks: Mark[]; inputs: { from: number; to: number }[] };

const appended = StateEffect.define<Append>();
const promptChanged = StateEffect.define<{ promptFrom: number; inputStart: number }>();
const cleared = StateEffect.define<{ inputStart: number }>();

export const layout = StateField.define<Layout>({
  create: (state) => ({ promptFrom: 0, inputStart: state.doc.length, inputs: [], marks: Decoration.none }),
  update(l, tr) {
    let next: Layout = tr.docChanged
      ? {
          promptFrom: tr.changes.mapPos(l.promptFrom, 1),
          // Typing at the boundary is input, so the boundary stays before it. With
          // no prompt, while Lisp reads, the boundary is the transcript's end too,
          // and transcript written there goes before it.
          inputStart: tr.changes.mapPos(l.inputStart, tr.annotation(transcriptWrite) && l.inputStart === l.promptFrom ? 1 : -1),
          inputs: l.inputs.flatMap((r) => {
            const from = tr.changes.mapPos(r.from, 1);
            const to = tr.changes.mapPos(r.to, -1);
            return to > from ? [{ from, to }] : [];
          }),
          marks: l.marks.map(tr.changes),
        }
      : l;
    for (const e of tr.effects) {
      if (e.is(appended)) {
        const b = new RangeSetBuilder<Decoration>();
        const all: Mark[] = [];
        next.marks.between(0, tr.state.doc.length, (from, to, deco) => void all.push({ from, to, deco }));
        all.push(...e.value.marks);
        all.sort((a, z) => a.from - z.from || a.deco.startSide - z.deco.startSide);
        for (const m of all) b.add(m.from, m.to, m.deco);
        next = { ...next, marks: b.finish(), inputs: [...next.inputs, ...e.value.inputs] };
      }
      // A prompt rewrite starts exactly at promptFrom, which mapping would push past it.
      if (e.is(promptChanged)) next = { ...next, promptFrom: e.value.promptFrom, inputStart: e.value.inputStart };
      if (e.is(cleared)) next = { promptFrom: 0, inputStart: e.value.inputStart, inputs: [], marks: Decoration.none };
    }
    return next;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (l) => l.marks),
    EditorView.decorations.compute([f], (state) => {
      const { promptFrom, inputStart } = state.field(f);
      return inputStart > promptFrom ? Decoration.set(mark("repl-prompt").range(promptFrom, inputStart)) : Decoration.none;
    }),
  ],
});

const mark = (cls: string, attributes?: Record<string, string>) => Decoration.mark({ class: cls, attributes });
const lineClass = (cls: string) => Decoration.line({ class: cls });

export function promptText(pkg: string) {
  return `${pkg === "COMMON-LISP-USER" ? "CL-USER" : pkg}> `;
}

/** The text an item adds to the transcript, and how to style it. */
function render(item: TranscriptItem): { text: string; marks: (at: number) => Mark[]; input?: [number, number] } {
  switch (item.kind) {
    case "input": {
      // Input typed while Lisp was reading has no prompt, as in SBCL.
      const shown = item.package === "" ? "" : promptText(item.package);
      const text = `${shown}${item.text}\n`;
      return {
        text,
        marks: (at) => [{ from: at, to: at + shown.length, deco: mark("repl-prompt") }],
        input: [shown.length, shown.length + item.text.length],
      };
    }
    case "output":
      return { text: item.text, marks: (at) => (item.text ? [{ from: at, to: at + item.text.length, deco: mark("repl-output") }] : []) };
    case "result": {
      const body = item.text.replace(/\n$/, "");
      const deco =
        item.presentation === null
          ? mark("repl-result")
          : mark("presentation", { "data-presentation": String(item.presentation), title: "Click to use in the input, ⌘-click to inspect" });
      return { text: item.text, marks: (at) => (body ? [{ from: at, to: at + body.length, deco }] : []) };
    }
    case "condition": {
      const type = item.type.replace(/^\[|\]$/g, "").replace(/Condition of type /, "");
      const lines = [`; ${type} · debugger level ${item.level}`, ...item.condition.split("\n").map((l) => `;   ${l}`)];
      const text = `${lines.join("\n")}\n`;
      return {
        text,
        marks: (at) => {
          const out: Mark[] = [];
          let pos = at;
          for (const l of lines) {
            out.push({ from: pos, to: pos, deco: lineClass("repl-condition") });
            pos += l.length + 1;
          }
          return out;
        },
      };
    }
    case "notice":
      return { text: `; ${item.text}\n`, marks: (at) => [{ from: at, to: at + item.text.length + 2, deco: mark(`repl-notice ${item.tone}`) }] };
  }
}

/** Past this many characters the oldest transcript is dropped, keeping the latest `KEEP`. */
export const TRANSCRIPT_LIMIT = 4_000_000;
const KEEP = 2_000_000;

/**
 * Renders store transcript items into the buffer, appending only what is new.
 * Items carry increasing ids, so the last one rendered marks where to go on,
 * however long the transcript or however much the store has dropped from its start.
 */
export class TranscriptRenderer {
  /** The last item rendered, and how much of its text, since output items grow. */
  private last: { id: number; length: number } | null = null;
  /** A newline we added so the prompt starts its own line, as SBCL's fresh-line does. */
  private softBreak = false;
  /**
   * Whether new output scrolls into view. Only the user scrolling up stops it,
   * and reaching the bottom again restarts it: while the editor measures a large
   * insert, its own scroll adjustments can look like scrolling away.
   */
  private following = true;
  private watching: EditorView | null = null;

  constructor(private readonly limit = TRANSCRIPT_LIMIT) {}

  private follow(view: EditorView) {
    if (this.watching === view) return;
    this.watching = view;
    const d = view.scrollDOM;
    d.addEventListener("wheel", (e) => {
      if (e.deltaY < 0) this.following = false;
    });
    d.addEventListener("scroll", () => {
      if (d.scrollHeight - d.scrollTop - d.clientHeight < 60) this.following = true;
    });
  }

  sync(view: EditorView, items: TranscriptItem[], pkg: string) {
    if (items.length === 0) return this.last ? this.clear(view, pkg) : undefined;
    let text = "";
    const marks: Mark[] = [];
    const inputs: { from: number; to: number }[] = [];
    const l = view.state.field(layout);
    let from = 0;
    if (this.last) {
      const lastId = this.last.id;
      let i = items.length - 1;
      while (i >= 0 && items[i].id > lastId) i--;
      from = i >= 0 && items[i].id === lastId ? i : i + 1;
    }
    // More output for the line the soft break ended goes before that break.
    const continuing = this.softBreak && this.continuesOutput(items[from]);
    const at = continuing ? l.promptFrom - 1 : l.promptFrom;
    let lastChar = view.state.doc.sliceString(Math.max(0, at - 1), at);

    const add = (piece: { text: string; marks: (at: number) => Mark[]; input?: [number, number] }, freshLine: boolean) => {
      if (freshLine && lastChar && lastChar !== "\n") {
        text += "\n";
        lastChar = "\n";
      }
      const start = at + text.length;
      marks.push(...piece.marks(start));
      if (piece.input) inputs.push({ from: start + piece.input[0], to: start + piece.input[1] });
      text += piece.text;
      if (piece.text) lastChar = piece.text[piece.text.length - 1];
    };

    for (const item of items.slice(from)) {
      const done = this.last;
      if (done && done.id === item.id) {
        const grown = "text" in item ? item.text.length - done.length : 0;
        if (grown > 0 && (item.kind === "output" || item.kind === "result")) {
          add(render({ ...item, text: item.text.slice(done.length) } as TranscriptItem), false);
          done.length = item.text.length;
        }
        continue;
      }
      add(render(item), item.kind !== "output");
      this.last = { id: item.id, length: "text" in item ? item.text.length : 0 };
    }
    if (!text) return;
    // The prompt always starts its own line. A newline we add for that is soft:
    // output that later continues the line replaces it (see `continuing`).
    const endsLine = text.endsWith("\n");
    if (!endsLine) text += "\n";
    this.softBreak = !endsLine;
    this.follow(view);
    const stick = this.following;
    view.dispatch({
      changes: { from: at, to: continuing ? l.promptFrom : at, insert: text },
      effects: [appended.of({ at, marks, inputs }), ...(stick ? [EditorView.scrollIntoView(at + text.length + 1, { y: "end" })] : [])],
      annotations: [transcriptWrite.of(true)],
    });
    if (view.state.field(layout).promptFrom > this.limit) this.trim(view);
  }

  /** Drops the oldest transcript, whole lines of it, keeping the latest part. */
  private trim(view: EditorView) {
    const { promptFrom } = view.state.field(layout);
    const keep = Math.min(KEEP, Math.floor(this.limit / 2));
    const cut = view.state.doc.lineAt(promptFrom - keep).from;
    if (cut <= 0) return;
    const notice = "; Earlier output was dropped to keep the REPL fast.\n";
    view.dispatch({
      changes: { from: 0, to: cut, insert: notice },
      effects: appended.of({ at: 0, marks: [{ from: 0, to: notice.length - 1, deco: mark("repl-notice info") }], inputs: [] }),
      annotations: [transcriptWrite.of(true)],
    });
  }

  private continuesOutput(item: TranscriptItem | undefined): boolean {
    const last = this.last;
    if (!last || !item || item.id !== last.id) return false;
    return (item.kind === "output" || item.kind === "result") && item.text.length > last.length;
  }

  private clear(view: EditorView, pkg: string) {
    const l = view.state.field(layout);
    const prompt = promptText(pkg);
    view.dispatch({
      changes: { from: 0, to: l.inputStart, insert: prompt },
      effects: cleared.of({ inputStart: prompt.length }),
      annotations: [transcriptWrite.of(true)],
    });
    this.last = null;
    this.softBreak = false;
  }

  /** While Lisp reads from standard input there is no prompt, as in SBCL. */
  setPrompt(view: EditorView, pkg: string, reading = false) {
    const l = view.state.field(layout);
    const prompt = reading ? "" : promptText(pkg);
    if (view.state.doc.sliceString(l.promptFrom, l.inputStart) === prompt) return;
    view.dispatch({
      changes: { from: l.promptFrom, to: l.inputStart, insert: prompt },
      effects: promptChanged.of({ promptFrom: l.promptFrom, inputStart: l.promptFrom + prompt.length }),
      annotations: [transcriptWrite.of(true)],
    });
  }
}

/**
 * Keeps the transcript read-only. Typing while the cursor sits in the
 * transcript goes to the end of the input instead of being lost.
 */
const readOnlyTranscript = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(transcriptWrite)) return tr;
  const { inputStart } = tr.startState.field(layout);
  let outside = false;
  let typed = "";
  const kept: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA >= inputStart) return void kept.push({ from: fromA, to: toA, insert: inserted.toString() });
    outside = true;
    typed += inserted.toString();
    // A deletion reaching into the input, such as select-all then delete, removes only the input part.
    if (toA > inputStart && !inserted.length) kept.push({ from: inputStart, to: toA, insert: "" });
  });
  if (!outside) return tr;
  if (kept.length) return { changes: kept, userEvent: "delete", scrollIntoView: true };
  if (!typed || !(tr.isUserEvent("input.type") || tr.isUserEvent("input.paste"))) return [];
  const end = tr.startState.doc.length;
  return { changes: { from: end, insert: typed }, selection: { anchor: end + typed.length }, userEvent: "input.type", scrollIntoView: true };
});

/**
 * Earlier results placed in the input. Each shows as its printed text and is
 * sent as a reference to the object itself, as SLIME's presentations are.
 */
const addRef = StateEffect.define<{ from: number; to: number; id: number }>();

const refs = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    // An edit inside a reference breaks it, so it goes back to being text.
    if (tr.docChanged)
      next = next.update({
        filter: (from, to) => {
          let touched = false;
          tr.changes.iterChangedRanges((_a, _b, fromB, toB) => {
            if (fromB < to && toB > from) touched = true;
          });
          return !touched;
        },
      });
    for (const e of tr.effects)
      if (e.is(addRef))
        next = next.update({
          add: [Decoration.mark({ class: "repl-ref", ref: e.value.id, attributes: { title: "An earlier result, sent as that object" } }).range(e.value.from, e.value.to)],
        });
    return next;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
});

/** The input as Lisp should read it: each reference becomes a lookup of its object. */
export function inputCode(state: EditorState) {
  const { inputStart } = state.field(layout);
  let code = state.doc.sliceString(inputStart);
  const found: { from: number; to: number; id: number }[] = [];
  state.field(refs).between(inputStart, state.doc.length, (from, to, deco) => void found.push({ from, to, id: deco.spec.ref }));
  for (const r of found.reverse()) {
    code = `${code.slice(0, r.from - inputStart)}#.(swank:lookup-presented-object-or-lose ${r.id})${code.slice(r.to - inputStart)}`;
  }
  return code;
}

/** Puts a transcript result in the input at the cursor, or at its end. */
function insertResult(view: EditorView, id: number) {
  let range: { from: number; to: number } | null = null;
  view.state.field(layout).marks.between(0, view.state.field(layout).promptFrom, (from, to, deco) => {
    if (deco.spec.attributes?.["data-presentation"] === String(id)) range = { from, to };
  });
  if (!range) return;
  const { from, to } = range as { from: number; to: number };
  const text = view.state.doc.sliceString(from, to);
  const { inputStart } = view.state.field(layout);
  const head = view.state.selection.main.head;
  const at = head >= inputStart ? head : view.state.doc.length;
  const before = view.state.doc.sliceString(at - 1, at);
  const pad = at > inputStart && before && !/[\s(]/.test(before) ? " " : "";
  view.dispatch({
    changes: { from: at, insert: pad + text },
    effects: addRef.of({ from: at + pad.length, to: at + pad.length + text.length, id }),
    selection: { anchor: at + pad.length + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

export type ReplHandlers = {
  /** `code` is what Lisp reads; `shown` is the input as the user sees it. */
  submit: (code: string, shown: string) => void;
  /** Lisp is reading a line from standard input, so Enter sends raw text. */
  reading: () => boolean;
  history: (dir: -1 | 1, current: string) => string | null;
  inspect: (presentation: number) => void;
};

function inputText(state: EditorState) {
  return state.doc.sliceString(state.field(layout).inputStart);
}

export function setInput(view: EditorView, code: string) {
  const { inputStart } = view.state.field(layout);
  view.dispatch({
    changes: { from: inputStart, to: view.state.doc.length, insert: code },
    selection: { anchor: inputStart + code.length },
    scrollIntoView: true,
  });
}

const handlersFacet = Facet.define<ReplHandlers, ReplHandlers | null>({ combine: (v) => v[0] ?? null });

/** Runs the input, if it is a complete form, or sends it as a line while Lisp reads. */
export function runInput(v: EditorView): boolean {
  const handlers = v.state.facet(handlersFacet);
  if (!handlers) return false;
  const shown = inputText(v.state);
  const code = handlers.reading() ? shown : inputCode(v.state);
  if (!handlers.reading() && !isComplete(code)) return true;
  setInput(v, "");
  handlers.submit(code, shown);
  return true;
}

export function replBuffer(handlers: ReplHandlers): Extension {
  const atEnd = (s: EditorState) => {
    const sel = s.selection.main;
    return sel.empty && s.doc.sliceString(sel.head).trim() === "";
  };
  const inInput = (s: EditorState) => s.selection.main.head >= s.field(layout).inputStart;
  const toEnd = (v: EditorView) => (v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true }), true);
  const submit = runInput;

  const enter = (v: EditorView) => {
    if (!inInput(v.state)) {
      // Enter on an earlier input copies it down to the prompt, as in SLIME.
      const head = v.state.selection.main.head;
      const old = v.state.field(layout).inputs.find((r) => r.from <= head && head <= r.to);
      if (old) setInput(v, v.state.doc.sliceString(old.from, old.to));
      else toEnd(v);
      return true;
    }
    // Parinfer keeps the input balanced, so "complete" alone would run it on every
    // Enter. Run only from the end; elsewhere Enter opens an indented line.
    return atEnd(v.state) || handlers.reading() ? submit(v) : insertNewlineAndIndent(v);
  };

  const newline = (v: EditorView) => (inInput(v.state) ? insertNewlineAndIndent(v) : toEnd(v));

  const recall = (dir: -1 | 1) => (v: EditorView) => {
    const s = v.state;
    if (!inInput(s)) return false;
    const line = s.doc.lineAt(s.selection.main.head).number;
    const edge = dir < 0 ? s.doc.lineAt(s.field(layout).inputStart).number : s.doc.lines;
    if (line !== edge) return false;
    const code = handlers.history(dir, inputText(s));
    if (code === null) return true;
    setInput(v, code);
    return true;
  };

  const home = (v: EditorView) => {
    const s = v.state;
    const { inputStart } = s.field(layout);
    const head = s.selection.main.head;
    if (head < inputStart || s.doc.lineAt(head).number !== s.doc.lineAt(inputStart).number) return false;
    v.dispatch({ selection: EditorSelection.cursor(inputStart) });
    return true;
  };

  return [
    handlersFacet.of(handlers),
    layout,
    refs,
    readOnlyTranscript,
    Prec.high(
      keymap.of([
        { key: "Enter", run: enter },
        { key: "Mod-Enter", run: (v) => (inInput(v.state) ? submit(v) : toEnd(v)) },
        { key: "Shift-Enter", run: newline },
        { key: "Alt-Enter", run: newline },
        { key: "ArrowUp", run: recall(-1) },
        { key: "ArrowDown", run: recall(1) },
        { key: "Home", run: home },
        { key: "Ctrl-a", run: home },
      ]),
    ),
    EditorView.domEventHandlers({
      // A click on a result puts it in the input; ⌘-click inspects it.
      mousedown(event, view) {
        const target = (event.target as HTMLElement).closest("[data-presentation]");
        if (!target) return false;
        event.preventDefault();
        const id = Number(target.getAttribute("data-presentation"));
        if (event.metaKey) handlers.inspect(id);
        else insertResult(view, id);
        return true;
      },
    }),
  ];
}

/** Matches for `query` among past inputs, newest first, each once. */
export function searchHistory(items: string[], query: string, limit = 12): string[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const item = items[i];
    if (seen.has(item) || !item.toLowerCase().includes(q)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
