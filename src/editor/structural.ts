import { indentRange } from "@codemirror/language";
import {
  ChangeSet,
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSpec,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import { type EditorView, type KeyBinding, ViewPlugin } from "@codemirror/view";
import type { CodeMirrorV, InputStateInterface, MotionArgs, Pos, Vim, vimState } from "@replit/codemirror-vim";
import { bodyEnd, bodyStart, formAt, forms, parse, pathAt, type Node } from "../lisp/tree";

/** A paredit command: the edit to make at the main cursor, or null when it does not apply. */
export type StructuralCommand = (state: EditorState) => TransactionSpec | null;

type Range = { from: number; to: number };

/** The list around a position (null at top level), its children, and the nodes beside it. */
type Level = { list: Node | null; children: Node[]; siblings: Node[] };

function levelAt(nodes: Node[], pos: number): Level {
  const lists = pathAt(nodes, pos).filter((n) => n.kind === "list");
  const list = lists[lists.length - 1] ?? null;
  const outer = lists[lists.length - 2];
  return { list, children: list ? list.children : nodes, siblings: outer ? outer.children : list ? nodes : [] };
}

function read(state: EditorState) {
  const text = state.doc.toString();
  const nodes = parse(text);
  const pos = state.selection.main.head;
  return { text, nodes, pos, ...levelAt(nodes, pos) };
}

function last<T>(items: T[], test: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return items[i];
  return undefined;
}

/** The form at the cursor, or else the next one in the same list. */
function targetForm(nodes: Node[], children: Node[], pos: number): Node | null {
  return formAt(nodes, pos) ?? forms(children).find((n) => n.from >= pos) ?? null;
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * One undoable "structure" transaction. Moving parens changes which list a line belongs to,
 * so the lines after the first edit are reindented through the end of the top-level form:
 * parinfer reads structure from indentation and would otherwise undo the edit on the next
 * keystroke. `cursor` is a position in the edited document before reindenting; without it the
 * selection follows the text, staying before text inserted at it unless `assoc` is 1.
 */
function edit(state: EditorState, changes: ChangeSpec, cursor?: number, assoc: -1 | 1 = -1): TransactionSpec {
  const first = state.update({ changes });
  const reindent = reindentAfter(first.state, first.changes);
  const all = first.changes.compose(reindent);
  const selection =
    cursor === undefined ? state.selection.map(all, assoc) : EditorSelection.single(reindent.mapPos(cursor));
  return { changes: all, selection, userEvent: "structure", scrollIntoView: true };
}

function reindentAfter(state: EditorState, changes: ChangeSet): ChangeSet {
  let lo = Infinity;
  let hi = -1;
  changes.iterChangedRanges((_fa, _ta, from, to) => {
    lo = Math.min(lo, from);
    hi = Math.max(hi, to);
  });
  const length = state.doc.length;
  if (hi < 0) return ChangeSet.empty(length);
  const nodes = parse(state.doc.toString());
  const top = nodes.find((n) => n.from <= hi && hi <= n.to);
  const end = Math.max(hi, top ? top.to : hi);
  const firstLine = state.doc.lineAt(lo).number + 1;
  if (firstLine > state.doc.lineAt(end).number) return ChangeSet.empty(length);
  // Leading whitespace inside a string or block comment is content, not indentation.
  const literals = literalsIn(nodes);
  const kept: ChangeSpec[] = [];
  indentRange(state, state.doc.line(firstLine).from, end).iterChanges((from, to, _fb, _tb, insert) => {
    if (!literals.some((n) => n.start < from && from < n.to)) kept.push({ from, to, insert });
  });
  return ChangeSet.of(kept, length);
}

function literalsIn(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (n.kind === "list" ? literalsIn(n.children) : n.kind === "string" || n.kind === "blockComment" ? [n] : []));
}

function moveTo(pos: number): TransactionSpec {
  return { selection: EditorSelection.cursor(pos), userEvent: "structure", scrollIntoView: true };
}

export const slurpForward: StructuralCommand = (state) => {
  const { list, siblings } = read(state);
  if (!list?.closed) return null;
  const next = forms(siblings).find((n) => n.from >= list.to);
  if (!next || (next.kind === "list" && !next.closed)) return null;
  return edit(state, [
    { from: list.to - 1, to: list.to },
    { from: next.to, insert: ")" },
  ]);
};

export const slurpBackward: StructuralCommand = (state) => {
  const { text, list, siblings } = read(state);
  if (!list?.closed) return null;
  const prev = last(forms(siblings), (n) => n.to <= list.from);
  if (!prev) return null;
  const open = bodyStart(text, list);
  return edit(state, [
    { from: prev.from, insert: text.slice(list.from, open) },
    { from: list.from, to: open },
  ]);
};

export const barfForward: StructuralCommand = (state) => {
  const { text, list } = read(state);
  if (!list?.closed) return null;
  const code = forms(list.children);
  if (!code.length) return null;
  const keep = code[code.length - 2];
  const at = keep ? keep.to : bodyStart(text, list);
  return edit(state, [
    { from: at, insert: isSpace(text[at]) ? ")" : ") " },
    { from: list.to - 1, to: list.to },
  ]);
};

export const barfBackward: StructuralCommand = (state) => {
  const { text, list } = read(state);
  if (!list?.closed) return null;
  const code = forms(list.children);
  if (!code.length) return null;
  const open = bodyStart(text, list);
  const at = code[1] ? code[1].from : bodyEnd(list);
  const opener = text.slice(list.from, open);
  // A cursor on the new first form stays inside the list, after the moved "(".
  return edit(
    state,
    [
      { from: list.from, to: open },
      { from: at, insert: isSpace(text[at - 1]) ? opener : " " + opener },
    ],
    undefined,
    1,
  );
};

/** Replace the enclosing list with the form at the cursor, keeping the list's reader prefix. */
export const raise: StructuralCommand = (state) => {
  const { text, nodes, pos, list, children } = read(state);
  const form = targetForm(nodes, children, pos);
  if (!list?.closed || !form) return null;
  const offset = Math.min(Math.max(pos - form.from, 0), form.to - form.from);
  return edit(state, { from: list.start, to: list.to, insert: text.slice(form.from, form.to) }, list.start + offset);
};

/** Remove the enclosing list's delimiters and its reader prefix, which no longer has a form to apply to. */
export const splice: StructuralCommand = (state) => {
  const { text, list } = read(state);
  if (!list?.closed) return null;
  return edit(state, [
    { from: list.from, to: bodyStart(text, list) },
    { from: list.to - 1, to: list.to },
  ]);
};

export const killForm: StructuralCommand = (state) => {
  const { text, nodes, pos, list, children } = read(state);
  const form = targetForm(nodes, children, pos);
  if (!form) return null;
  const i = children.indexOf(form);
  const prev = children[i - 1];
  const next = children[i + 1];
  const sameLine = (a: number, b: number) => !text.slice(a, b).includes("\n");
  let range: Range;
  if (next && sameLine(form.to, next.from)) range = { from: form.from, to: next.from };
  else if (prev && prev.kind !== "comment") range = { from: prev.to, to: form.to };
  else if (next) range = { from: form.from, to: next.from };
  else if (list && !prev) range = { from: bodyStart(text, list), to: bodyEnd(list) };
  else range = { from: form.from, to: form.to };
  // A form right after a line comment starts its own line, so take its indentation too.
  if (prev?.kind === "comment" && !next) {
    while (range.from > 0 && (text[range.from - 1] === " " || text[range.from - 1] === "\t")) range.from--;
  }
  return edit(state, range);
};

/** Swap the forms on either side of the cursor (or the nearest two), leaving the cursor after both. */
export const transpose: StructuralCommand = (state) => {
  const { text, pos, children } = read(state);
  const code = forms(children);
  const inside = code.findIndex((n) => n.from < pos && pos < n.to);
  let b = inside >= 0 ? inside + 1 : code.findIndex((n) => n.from >= pos);
  if (b < 0 || b >= code.length) b = code.length - 1;
  if (b < 1) b = 1;
  const first = code[b - 1];
  const second = code[b];
  if (!first || !second) return null;
  return edit(
    state,
    [
      { from: first.from, to: first.to, insert: text.slice(second.from, second.to) },
      { from: second.from, to: second.to, insert: text.slice(first.from, first.to) },
    ],
    second.to,
  );
};

export const splitList: StructuralCommand = (state) => {
  const { text, pos, list, children } = read(state);
  if (!list?.closed || children.some((n) => n.from < pos && pos < n.to)) return null;
  const start = bodyStart(text, list);
  const end = bodyEnd(list);
  let from = pos;
  let to = pos;
  while (from > start && isSpace(text[from - 1])) from--;
  while (to < end && isSpace(text[to])) to++;
  const comment = last(children, (n) => n.to <= pos);
  if (comment?.kind === "comment") {
    if (!text.slice(comment.to, pos).includes("\n")) return null;
    from = pos;
  }
  const gap = text.slice(from, to) || " ";
  return edit(state, { from, to, insert: ")" + gap + text.slice(list.start, start) }, from + 1);
};

export const joinLists: StructuralCommand = (state) => {
  const { text, pos, children } = read(state);
  const code = forms(children);
  const left = last(code, (n) => n.to <= pos);
  const right = code.find((n) => n.from >= pos);
  if (left?.kind !== "list" || right?.kind !== "list" || !left.closed || !right.closed) return null;
  const tight = left.to === right.from && forms(left.children).length > 0 && forms(right.children).length > 0;
  return edit(state, [
    { from: left.to - 1, to: left.to },
    { from: right.from, to: bodyStart(text, right), insert: tight ? " " : "" },
  ]);
};

/** Forms containing a range, outermost first. A form at the cursor's edge contains it. */
function formsAround(nodes: Node[], range: Range): Node[] {
  const out: Node[] = [];
  let level = nodes;
  for (;;) {
    const hit = forms(level).find((n) => n.from <= range.from && range.to <= n.to);
    if (!hit) return out;
    out.push(hit);
    if (hit.kind !== "list") return out;
    level = hit.children;
  }
}

type Expansion = { before: Range; after: Range };
const pushExpansion = StateEffect.define<Expansion>();
const popExpansion = StateEffect.define<null>();

/** Selections that expandSelection replaced, so shrinkSelection can walk back down. */
const expansions = StateField.define<Expansion[]>({
  create: () => [],
  update(stack, tr) {
    if (tr.docChanged) return [];
    for (const e of tr.effects) {
      if (e.is(pushExpansion)) {
        const top = stack[stack.length - 1];
        const continues = top && top.after.from === e.value.before.from && top.after.to === e.value.before.to;
        stack = continues ? [...stack, e.value] : [e.value];
      } else if (e.is(popExpansion)) stack = stack.slice(0, -1);
    }
    return stack;
  },
});

export const expandSelection: StructuralCommand = (state) => {
  const { from, to } = state.selection.main;
  const around = formsAround(parse(state.doc.toString()), { from, to });
  const target = last(around, (n) => n.from < from || to < n.to);
  if (!target) return null;
  const step: Expansion = { before: { from, to }, after: { from: target.from, to: target.to } };
  // The field installs itself on first use, so the keymap is the only wiring needed. A field
  // added by a transaction never sees that transaction's effects, hence the initial value.
  const effect =
    state.field(expansions, false) === undefined
      ? StateEffect.appendConfig.of(expansions.init(() => [step]))
      : pushExpansion.of(step);
  return {
    selection: EditorSelection.single(target.from, target.to),
    effects: effect,
    userEvent: "structure",
    scrollIntoView: true,
  };
};

/** Undo the last expandSelection, while the selection is still the one it made. */
export const shrinkSelection: StructuralCommand = (state) => {
  const stack = state.field(expansions, false) ?? [];
  const top = stack[stack.length - 1];
  const { from, to } = state.selection.main;
  if (!top || top.after.from !== from || top.after.to !== to) return null;
  return {
    selection: EditorSelection.single(top.before.from, top.before.to),
    effects: popExpansion.of(null),
    userEvent: "structure",
    scrollIntoView: true,
  };
};

/** To the end of the next form, or out past the enclosing list's ")". */
export const forwardForm: StructuralCommand = (state) => {
  const { pos, list, children } = read(state);
  const next = forms(children).find((n) => n.to > pos);
  if (next) return moveTo(next.to);
  return list?.closed ? moveTo(list.to) : null;
};

/** To the start of the previous form, or out before the enclosing list. */
export const backwardForm: StructuralCommand = (state) => {
  const { pos, list, children } = read(state);
  const prev = last(forms(children), (n) => n.from < pos);
  if (prev) return moveTo(prev.from);
  return list ? moveTo(list.from) : null;
};

export const upList: StructuralCommand = (state) => {
  const { list } = read(state);
  return list ? moveTo(list.from) : null;
};

export const downList: StructuralCommand = (state) => {
  const { text, pos, children } = read(state);
  const next = forms(children).find((n) => n.kind === "list" && pos <= n.start);
  return next ? moveTo(bodyStart(text, next)) : null;
};

/** Where vim-sexp's <I and >I insert: just inside the enclosing list's "(" or ")". */
export function listInsertPoint(state: EditorState, edge: "start" | "end"): number | null {
  const { text, list } = read(state);
  if (!list) return null;
  return edge === "start" ? bodyStart(text, list) : bodyEnd(list);
}

export type FormObject = { inner: boolean; topLevel: boolean };

/**
 * The range of a Vim text object over `range`, a selection whose `to` is exclusive.
 * "a form" is the enclosing list with its delimiters and prefix, "inner form" its children;
 * the topLevel variants use the top-level form instead. A selection already covering the
 * object grows to the next list out, so repeating `af` in Visual mode climbs.
 */
export function formObject(state: EditorState, range: Range, kind: FormObject): Range | null {
  const text = state.doc.toString();
  const nodes = parse(text);
  const chars = { from: range.from, to: Math.max(range.to, range.from + 1) };
  const covers = (n: Node) => n.from <= chars.from && chars.to <= n.to;
  const around: Node[] = [];
  for (let level = nodes; ; ) {
    const hit = forms(level).find(covers);
    if (!hit) break;
    around.unshift(hit);
    if (hit.kind !== "list") break;
    level = hit.children;
  }
  const candidates = kind.topLevel ? around.slice(-1) : around.filter((n) => n.kind === "list");
  const objectOf = (n: Node): Range => {
    if (!kind.inner || n.kind !== "list") return { from: n.from, to: n.to };
    const first = n.children[0];
    const lastChild = n.children[n.children.length - 1];
    return first ? { from: first.from, to: lastChild.to } : { from: bodyStart(text, n), to: bodyStart(text, n) };
  };
  const grow = range.to - range.from > 1;
  for (const n of candidates) {
    const r = objectOf(n);
    if (!grow || (r.from <= range.from && range.to <= r.to && (r.from < range.from || range.to < r.to))) return r;
  }
  return null;
}

function run(view: EditorView, command: StructuralCommand): boolean {
  const spec = command(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
}

export type StructuralBinding = {
  name: string;
  /** CodeMirror key names. */
  keys: string[];
  /** Vim key sequences, in Normal mode unless the description says otherwise. */
  vim: string[];
  description: string;
  run?: StructuralCommand;
};

/** The single source of truth for structural editing bindings, rendered by the help system. */
export const structuralCommands: StructuralBinding[] = [
  { name: "Slurp forward", keys: ["Ctrl-)"], vim: [">)"], description: "Pull the next form into the list", run: slurpForward },
  { name: "Barf forward", keys: ["Ctrl-}"], vim: ["<)"], description: "Push the list's last form out", run: barfForward },
  {
    name: "Slurp backward",
    keys: ["Ctrl-Alt-ArrowLeft", "Ctrl-("],
    vim: ["<("],
    description: "Pull the previous form into the list",
    run: slurpBackward,
  },
  {
    name: "Barf backward",
    keys: ["Ctrl-Alt-ArrowRight", "Ctrl-{"],
    vim: [">("],
    description: "Push the list's first form out",
    run: barfBackward,
  },
  { name: "Raise", keys: ["Alt-r"], vim: [], description: "Replace the enclosing list with the form at the cursor", run: raise },
  { name: "Splice", keys: ["Alt-s"], vim: ["dsf"], description: "Remove the enclosing list's parentheses", run: splice },
  { name: "Kill form", keys: ["Alt-k"], vim: [], description: "Delete the form at the cursor", run: killForm },
  { name: "Transpose", keys: ["Alt-t"], vim: [], description: "Swap the forms around the cursor", run: transpose },
  { name: "Split list", keys: ["Alt-Shift-s"], vim: [], description: "Split the enclosing list at the cursor", run: splitList },
  { name: "Join lists", keys: ["Alt-Shift-j"], vim: [], description: "Join the lists on either side of the cursor", run: joinLists },
  {
    name: "Expand selection",
    keys: ["Ctrl-Shift-Cmd-ArrowRight"],
    vim: [],
    description: "Select the form, then the enclosing list, then outward",
    run: expandSelection,
  },
  { name: "Shrink selection", keys: ["Ctrl-Shift-Cmd-ArrowLeft"], vim: [], description: "Undo the last expansion", run: shrinkSelection },
  { name: "Next form", keys: ["Ctrl-Alt-f"], vim: [], description: "Move past the next form", run: forwardForm },
  { name: "Previous form", keys: ["Ctrl-Alt-b"], vim: [], description: "Move before the previous form", run: backwardForm },
  { name: "Up a level", keys: ["Ctrl-Alt-u"], vim: [], description: "Move to the start of the enclosing list", run: upList },
  { name: "Down a level", keys: ["Ctrl-Alt-d"], vim: [], description: "Move into the next list", run: downList },
  { name: "Insert at list start", keys: [], vim: ["<I"], description: "Insert just after the enclosing list's (" },
  { name: "Insert at list end", keys: [], vim: [">I"], description: "Insert just before the enclosing list's )" },
  { name: "A form", keys: [], vim: ["af"], description: "Text object: the enclosing list, as in daf or vaf" },
  { name: "Inner form", keys: [], vim: ["if"], description: "Text object: the enclosing list's contents, as in cif" },
  { name: "A top-level form", keys: [], vim: ["aF"], description: "Text object: the top-level form, as in yaF" },
  { name: "Inner top-level form", keys: [], vim: ["iF"], description: "Text object: the top-level form's contents" },
  {
    name: "To list edge",
    keys: [],
    vim: ["d)", "d("],
    description: "After an operator other than < and >, ) and ( reach the enclosing list's end and start",
  },
];

const optionLetterCommands = new Map(
  structuralCommands.flatMap(({ keys, run: command }) =>
    command ? keys.filter((k) => /^Alt-(Shift-)?[a-z]$/.test(k)).map((k) => [k, command] as const) : [],
  ),
);

/**
 * macOS types a character for Option-letter (⌥R is "®"), and CodeMirror leaves those keys to
 * typing, so its keymap never sees "Alt-r". This reads the letter from the key code instead
 * and claims the key whenever a command is bound to it.
 */
/** Runs the structural command bound to an Option-letter key; true when the key is ours. */
export function handleOptionKey(view: EditorView, event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || !event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.keyCode < 65 || event.keyCode > 90) return false;
    const letter = String.fromCharCode(event.keyCode).toLowerCase();
    const command = optionLetterCommands.get(`Alt-${event.shiftKey ? "Shift-" : ""}${letter}`);
    if (!command) return false;
    run(view, command);
    return true;
}

export const structuralKeymap: KeyBinding[] = structuralCommands.flatMap(({ keys, run: command }) =>
  command ? keys.map((key) => ({ key, run: (view: EditorView) => run(view, command) })) : [],
);

/**
 * Option-letter commands, caught in the capture phase before CodeMirror and
 * Vim see the key. Vim's normal mode swallows composed characters such as ®,
 * and Vim must stay ahead of every keymap or Escape stops leaving insert mode.
 */
export const optionKeys = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("keydown", this.onKey, true);
    }
    onKey = (event: KeyboardEvent) => {
      if (handleOptionKey(this.view, event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    destroy() {
      this.view.contentDOM.removeEventListener("keydown", this.onKey, true);
    }
  },
);

const MAC_KEYS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
  Mod: "⌘",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

/** "Ctrl-Shift-Cmd-ArrowRight" as "⌃⇧⌘→", for menus and help. */
export function keyLabel(key: string): string {
  const parts = key.split(/-(?!$)/);
  return parts.map((p, i) => MAC_KEYS[p] ?? (i === parts.length - 1 ? p.toUpperCase() : p)).join("");
}

// Vim adapter. codemirror-vim resolves ">" to its indent operator before a second key can
// arrive, and has no text object registry, so these bind as operator-pending motions that
// read the pending operator: ">" then ")" slurps instead of indenting a sentence.

type VimApi = Pick<Vim, "defineMotion" | "mapCommand" | "handleKey">;
type Motion = (
  cm: CodeMirrorV,
  head: Pos,
  args: MotionArgs,
  vim: vimState,
  input: InputStateInterface,
) => Pos | [Pos, Pos] | null;

const viewOf = (cm: CodeMirrorV): EditorView => cm.cm6;
const offsetOf = (state: EditorState, p: Pos) => state.doc.line(p.line + 1).from + p.ch;
const posOf = (state: EditorState, offset: number): Pos => {
  const line = state.doc.lineAt(offset);
  return { line: line.number - 1, ch: offset - line.from };
};

/**
 * Vim's cursor sits on a character, so on a list's "(" or reader prefix it means that list.
 * Commands see a cursor just inside it instead.
 */
export function atVimCursor(state: EditorState): EditorState {
  const pos = state.selection.main.head;
  const text = state.doc.toString();
  const hit = formAt(parse(text), pos);
  if (hit?.kind !== "list" || pos >= bodyStart(text, hit)) return state;
  return state.update({ selection: EditorSelection.cursor(bodyStart(text, hit)) }).state;
}

/** The Vim motion behind a form text object. */
export function formObjectMotion(kind: FormObject): Motion {
  return (cm, head, _args, vim) => {
    const state = viewOf(cm).state;
    let range: Range;
    if (vim.visualMode) {
      const a = offsetOf(state, vim.sel.anchor);
      const h = offsetOf(state, vim.sel.head);
      range = { from: Math.min(a, h), to: Math.max(a, h) + 1 };
    } else {
      const at = offsetOf(state, head);
      range = { from: at, to: at + 1 };
    }
    const r = formObject(state, range, kind);
    if (!r) return null;
    // Visual selections include the character under the head; operator ranges end before it.
    const end = vim.visualMode ? Math.max(r.from, r.to - 1) : r.to;
    return [posOf(state, r.from), posOf(state, end)];
  };
}

/** Run a command from Vim's cursor. A cursor moved inside a list stays on that list's "(". */
function runForVim(view: EditorView, command: StructuralCommand): void {
  const state = atVimCursor(view.state);
  const spec = command(state);
  if (!spec) return;
  if (state === view.state) return view.dispatch(spec);
  const { changes } = view.state.update(spec);
  view.dispatch({ ...spec, selection: view.state.selection.map(changes) });
}

function onIndent(right: StructuralCommand, left: StructuralCommand, otherwise: (state: EditorState) => number | null): Motion {
  return (cm, _head, _args, _vim, input) => {
    const view = viewOf(cm);
    if (input.operator === "indent") {
      runForVim(view, input.operatorArgs?.indentRight ? right : left);
      return null;
    }
    const state = atVimCursor(view.state);
    const to = otherwise(state);
    return to === null ? null : posOf(state, to);
  };
}

export function configureStructuralVim(vim: VimApi): void {
  const pending = { context: "operatorPending" };
  vim.defineMotion("zlCloseParen", onIndent(slurpForward, barfForward, (s) => listInsertPoint(s, "end")) as never);
  vim.defineMotion("zlOpenParen", onIndent(barfBackward, slurpBackward, (s) => listInsertPoint(s, "start")) as never);
  vim.mapCommand(")", "motion", "zlCloseParen", {}, pending);
  vim.mapCommand("(", "motion", "zlOpenParen", {}, pending);

  const insertAt: Motion = (cm, _head, _args, _vim, input) => {
    if (input.operator !== "indent") return null;
    const view = viewOf(cm);
    const at = listInsertPoint(atVimCursor(view.state), input.operatorArgs?.indentRight ? "end" : "start");
    if (at === null) return null;
    view.dispatch({ selection: EditorSelection.cursor(at) });
    vim.handleKey(cm, "i", "mapping");
    return null;
  };
  vim.defineMotion("zlInsertInList", insertAt as never);
  vim.mapCommand("I", "motion", "zlInsertInList", {}, pending);

  const spliceMotion: Motion = (cm, _head, _args, _vim, input) => {
    if (input.operator === "delete") runForVim(viewOf(cm), splice);
    return null;
  };
  vim.defineMotion("zlSpliceForm", spliceMotion as never);
  vim.mapCommand("sf", "motion", "zlSpliceForm", {}, pending);

  const objects: [string, FormObject][] = [
    ["af", { inner: false, topLevel: false }],
    ["if", { inner: true, topLevel: false }],
    ["aF", { inner: false, topLevel: true }],
    ["iF", { inner: true, topLevel: true }],
  ];
  for (const [keys, kind] of objects) {
    const name = `zlFormObject_${keys}`;
    vim.defineMotion(name, formObjectMotion(kind) as never);
    for (const context of ["operatorPending", "visual"]) vim.mapCommand(keys, "motion", name, {}, { context });
  }
}
