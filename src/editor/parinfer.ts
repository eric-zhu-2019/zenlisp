import {
  EditorState,
  Extension,
  StateCommand,
  StateEffect,
  StateField,
  Text,
  Transaction,
  TransactionSpec,
} from "@codemirror/state";
import { run_parinfer, text_width } from "./parinfer/pkg/parinfer_wasm.js";
import { fromRegion, type Region, regionOf, toRegion } from "./region";

export {
  default as initParinfer,
  initSync as initParinferSync,
} from "./parinfer/pkg/parinfer_wasm.js";

export type ParinferMode = "smart" | "indent" | "paren";

export type ParinferErrorName =
  | "quote-danger"
  | "eol-backslash"
  | "unclosed-quote"
  | "unclosed-paren"
  | "unmatched-close-paren"
  | "unmatched-open-paren"
  | "leading-close-paren"
  | "utf8-error"
  | "json-error"
  | "panic";

export interface ParinferError {
  name: ParinferErrorName;
  message: string;
  pos: number | null;
}

export interface ParinferStatus {
  enabled: boolean;
  mode: ParinferMode;
  error: ParinferError | null;
}

export interface ParinferOptions {
  enabled?: boolean;
  mode?: ParinferMode;
}

interface Change {
  lineNo: number;
  x: number;
  oldText: string;
  newText: string;
}

interface Answer {
  text: string;
  success: boolean;
  error: { name: ParinferErrorName; message: string; x: number; lineNo: number } | null;
  cursorX: number | null;
  cursorLine: number | null;
}

export const setParinferMode = StateEffect.define<ParinferMode>();
export const setParinferEnabled = StateEffect.define<boolean>();
const reportError = StateEffect.define<ParinferError | null>();

export const parinferStatus = StateField.define<ParinferStatus>({
  create: () => ({ enabled: true, mode: "smart", error: null }),
  update(status, tr) {
    let next = tr.docChanged && status.error ? { ...status, error: null } : status;
    for (const effect of tr.effects) {
      if (effect.is(setParinferMode)) next = { ...next, mode: effect.value, error: null };
      else if (effect.is(setParinferEnabled)) next = { ...next, enabled: effect.value, error: null };
      else if (effect.is(reportError)) next = { ...next, error: effect.value };
    }
    return next;
  },
});

export const toggleParinfer: StateCommand = ({ state, dispatch }) => {
  dispatch(state.update({ effects: setParinferEnabled.of(!state.field(parinferStatus).enabled) }));
  return true;
};

export function parinfer(opts: ParinferOptions = {}): Extension {
  return [
    parinferStatus.init(() => ({
      enabled: opts.enabled ?? true,
      mode: opts.mode ?? "smart",
      error: null,
    })),
    EditorState.transactionFilter.of(correct),
  ];
}

// Vim edits arrive as "input.type.compose"; "move" is drag-and-drop. Undo and redo are left
// alone so they restore exactly the state history recorded.
const USER_EDITS = ["input", "delete", "move"];

function correct(tr: Transaction): Transaction | readonly (Transaction | TransactionSpec)[] {
  if (!tr.docChanged || !USER_EDITS.some((event) => tr.isUserEvent(event))) return tr;
  const status = tr.startState.field(parinferStatus, false);
  if (!status?.enabled) return tr;

  const region = regionOf(tr.state);
  const head = toRegion(region, tr.newSelection.main.head);
  if (head === null) return tr;
  const doc = region.text;
  let answer: Answer;
  try {
    answer = JSON.parse(run_parinfer(JSON.stringify(request(status.mode, tr, region, regionOf(tr.startState)))));
  } catch (e) {
    const error: ParinferError = { name: "panic", message: String(e), pos: null };
    return [tr, { effects: reportError.of(error), sequential: true }];
  }

  if (!answer.success) {
    // Upstream's inputX lands one past the offending character, while x points at it.
    const { name, message, lineNo, x } = answer.error!;
    const error: ParinferError = { name, message, pos: fromRegion(region, offsetOf(doc, lineNo, x)) };
    return [tr, { effects: reportError.of(error), sequential: true }];
  }

  const fixed = Text.of(answer.text.split("\n"));
  const main = tr.newSelection.main;
  const placeCursor =
    answer.cursorLine != null && answer.cursorX != null && tr.newSelection.ranges.length === 1 && main.empty;
  return [
    tr,
    {
      changes: diffLines(doc, fixed)
        // The prompt's padding is not the user's text.
        .filter((c) => c.from >= region.pad)
        .map((c) => ({ ...c, from: fromRegion(region, c.from), to: fromRegion(region, c.to) })),
      selection: placeCursor ? { anchor: fromRegion(region, offsetOf(fixed, answer.cursorLine!, answer.cursorX!)) } : undefined,
      effects: reportError.of(null),
      sequential: true,
    },
  ];
}

function request(mode: ParinferMode, tr: Transaction, region: Region, prev: Region) {
  const doc = region.text;
  const changes: Change[] = [];
  tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    const at = toRegion(region, fromB);
    if (at === null) return;
    const { lineNo, x } = pointOf(doc, at);
    changes.push({ lineNo, x, oldText: tr.startState.sliceDoc(fromA, toA), newText: inserted.toString() });
  });
  const main = tr.newSelection.main;
  const cursor = pointOf(doc, toRegion(region, main.head)!);
  const prevCursor = pointOf(prev.text, toRegion(prev, tr.startState.selection.main.head) ?? 0);
  return {
    mode,
    text: doc.toString(),
    options: {
      cursorX: cursor.x,
      cursorLine: cursor.lineNo,
      prevCursorX: prevCursor.x,
      prevCursorLine: prevCursor.lineNo,
      // Parinfer drops from smart to plain indent mode whenever this is set, so only a real
      // selection sends it.
      selectionStartLine: main.empty ? undefined : doc.lineAt(toRegion(region, main.from) ?? 0).number - 1,
      changes,
      lispVlineSymbols: true,
      lispBlockComments: true,
    },
  };
}

// Parinfer measures columns in display width (wide CJK counts 2, combining marks 0, code tabs 2),
// while CodeMirror counts UTF-16 units. They agree on printable ASCII.
const PLAIN = /^[\x20-\x7e]*$/;

function pointOf(doc: Text, pos: number): { lineNo: number; x: number } {
  const line = doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  return { lineNo: line.number - 1, x: PLAIN.test(before) ? before.length : text_width(before) };
}

function offsetOf(doc: Text, lineNo: number, x: number): number {
  const line = doc.line(Math.min(lineNo + 1, doc.lines));
  if (PLAIN.test(line.text)) return line.from + Math.min(x, line.length);
  let col = 0;
  for (const ch of line.text) {
    if (text_width(line.text.slice(0, col)) >= x) break;
    col += ch.length;
  }
  return line.from + col;
}

// Parinfer keeps the line count, so diffing per line yields small changes that keep marks,
// folds, and diagnostics on untouched lines anchored.
function diffLines(doc: Text, fixed: Text): Edit[] {
  if (doc.lines !== fixed.lines) return [diffRange(doc.toString(), fixed.toString(), 0)];
  const changes: Edit[] = [];
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = fixed.line(n).text;
    if (line.text !== text) changes.push(diffRange(line.text, text, line.from));
  }
  return changes;
}

type Edit = { from: number; to: number; insert: string };

function diffRange(a: string, b: string, offset: number): Edit {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { from: offset + start, to: offset + a.length - end, insert: b.slice(start, b.length - end) };
}
