import { create } from "zustand";
import type { AppEvent } from "./protocol/AppEvent";
import type { AssistantEvent } from "./protocol/AssistantEvent";
import type { Debugger } from "./protocol/Debugger";
import type { Definition } from "./protocol/Definition";
import type { InspectorPage } from "./protocol/InspectorPage";
import type { GitState } from "./protocol/GitState";
import type { Note } from "./protocol/Note";
import type { Profile } from "./protocol/Profile";
import type { TestRun } from "./protocol/TestRun";
import type { TraceEntry } from "./protocol/TraceEntry";
import type { Status } from "./protocol/Status";
import type { ImageInfo } from "./protocol/ImageInfo";
import type { Span } from "./protocol/Span";
import type { SystemInfo } from "./protocol/SystemInfo";
import type { Dependency } from "./protocol/Dependency";
import type { Thread } from "./protocol/Thread";

export type TranscriptItem =
  | { id: number; kind: "input"; text: string; package: string }
  | { id: number; kind: "output"; text: string }
  | { id: number; kind: "result"; text: string; presentation: number | null }
  | { id: number; kind: "condition"; thread: Thread; level: number; condition: string; type: string }
  | { id: number; kind: "notice"; text: string; tone: "info" | "error" | "success" };

export type Tab = {
  path: string;
  name: string;
  /** The file's content on disk as last read or written. */
  saved: string;
  text: string;
  /** Bumped when the file is reloaded from disk, so the editor replaces its buffer. */
  revision: number;
  /** The file changed or vanished on disk while the buffer had unsaved edits. */
  conflict: "changed" | "deleted" | null;
};

export type Location = { path: string; offset: number };

/** An editor pane: the files open in it, in tab order, and the one on show. */
export type Pane = { tabs: string[]; active: string | null };

/** A REPL besides the main one, with a listener thread of its own (swank-mrepl). */
export type ExtraRepl = {
  /** The client's channel id, which tags the REPL's messages. */
  id: number;
  name: string;
  /** Swank's channel and the listener thread, once the REPL has started. */
  channel: number | null;
  thread: number | null;
  package: string;
  transcript: TranscriptItem[];
  /** Lisp is reading a line from this REPL's standard input. */
  reading: boolean;
  busy: boolean;
};

export type SidebarMode = "files" | "search" | "packages";

export type Dialog = {
  title: string;
  message: string;
  actions: { label: string; kind?: "primary" | "danger"; run: () => void }[];
};

export type ChatItem =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; text: string; thinking: string }
  | { id: number; role: "tool"; toolId: string; name: string; input: string; output: string | null; ok: boolean | null }
  | { id: number; role: "error"; text: string };

export type Task = { output: string; running: boolean; ok: boolean | null };

export type BottomPanel = "repl" | "output" | "problems" | "tests" | "trace" | "profile";
export type RightPanel = "inspector" | "assistant" | "docs" | null;

/** A symbol shown in the documentation panel. */
export type DocTopic = { symbol: string; package: string };

export const threadKey = (t: Thread) => JSON.stringify(t);

export interface State {
  status: Status;
  /** False until the backend has reported its status once. */
  statusKnown: boolean;
  transcript: TranscriptItem[];
  repls: ExtraRepl[];
  /** The REPL shown: an extra REPL's id, or null for the main one. */
  activeRepl: number | null;
  openPresentation: number | null;
  package: string;
  packages: string[];
  /** The open project's startup image: null when it has none, undefined until known. */
  image: ImageInfo | null | undefined;
  debuggers: Record<string, Debugger[]>;
  /** The thread that entered a debugger most recently. */
  lastDebugThread: string | null;
  /** Where a debugger level is stopped, shown in the editor while that level lasts. */
  debugSpot: { thread: string; level: number; path: string; offset: number } | null;
  /** Breakpoint forms per file, kept here so they outlive the file's tab. */
  breakpoints: Record<string, { from: number; to: number }[]>;
  /** Per file, the breakpoint starts Lisp bound to compiled code. */
  boundBreakpoints: Record<string, number[]>;
  inspector: InspectorPage | null;
  /** The documentation panel's symbol, and the ones shown before it. */
  docs: { topic: DocTopic | null; back: DocTopic[]; follow: boolean };
  /** Traced functions and the calls recorded for them, newest last. */
  traces: { specs: string[]; total: number; entries: TraceEntry[] };
  /** The last profile, with the form it ran when it profiled one. */
  profile: (Profile & { label: string | null }) | null;
  /** "form" while a form runs under the profiler, "all" between start and stop. */
  profiling: "form" | "all" | null;
  inputRequest: { thread: Thread; tag: number } | null;
  /** The last test run, and the system it tested; null system for a rerun of chosen tests. */
  tests: { system: string; run: TestRun } | null;
  /** What is being tested right now. */
  testing: string | null;
  tasks: Record<string, Task>;
  activeTask: string | null;
  systems: SystemInfo[];
  /** What the project's systems depend on, with where each comes from. */
  deps: Dependency[];
  /** Markdown files shown rendered rather than as text. */
  previews: string[];
  /** Every open file's buffer, whichever panes show it. */
  tabs: Tab[];
  /** One pane, or two side by side. */
  panes: Pane[];
  focusedPane: number;
  /** The focused pane's file, which commands act on. */
  activeTab: string | null;
  notes: Record<string, Note[]>;
  /** Changed and untracked files, by path, as git reports them. */
  gitStatus: Record<string, GitState>;
  /** Open files' text in the last commit; null when git does not track the file. */
  gitHeads: Record<string, string | null>;
  /** Files showing their changes since the last commit inline. */
  diffOn: string[];
  reveal: { path: string; offset: number; nonce: number } | null;
  bottom: BottomPanel;
  right: RightPanel;
  palette: "commands" | "files" | "symbols" | null;
  hint: { text: string; active: Span | null } | null;
  vimMode: string;
  /** An Emacs prefix being typed, such as "C-x-", shown in the status bar. */
  chord: string | null;
  /** A short-lived message for the status bar, such as what saving compiled. */
  flash: { text: string; tone: "info" | "error" } | null;
  parinfer: { mode: string; error: string | null } | null;
  chat: ChatItem[];
  chatBusy: boolean;
  /** Places the user jumped from, for back and forward. */
  history: { back: Location[]; forward: Location[] };
  sidebar: SidebarMode;
  help: boolean;
  settingsOpen: boolean;
  /** The getting-started list, and the steps done from it. */
  tourOpen: boolean;
  tourDone: string[];
  newProject: boolean;
  /** The last find-references result, shown in the search panel. */
  references: { name: string; items: Definition[] } | null;
  /** Bumped when files change on disk, so the file tree re-lists. */
  fsNonce: number;
  dialog: Dialog | null;
  /** Indentation specs Swank reports for macros, keyed by lowercase name. */
  indentSpecs: Record<string, unknown>;
}

let nextId = 1;
const id = () => nextId++;

export const useStore = create<State>(() => ({
  status: { session: { state: "stopped" }, project: null },
  statusKnown: false,
  transcript: [],
  repls: [],
  activeRepl: null,
  openPresentation: null,
  package: "COMMON-LISP-USER",
  packages: [],
  image: undefined,
  debuggers: {},
  lastDebugThread: null,
  debugSpot: null,
  breakpoints: {},
  boundBreakpoints: {},
  inspector: null,
  docs: { topic: null, back: [], follow: true },
  traces: { specs: [], total: 0, entries: [] },
  profile: null,
  profiling: null,
  inputRequest: null,
  tests: null,
  testing: null,
  tasks: {},
  activeTask: null,
  systems: [],
  deps: [],
  previews: [],
  tabs: [],
  panes: [{ tabs: [], active: null }],
  focusedPane: 0,
  activeTab: null,
  notes: {},
  gitStatus: {},
  gitHeads: {},
  diffOn: [],
  reveal: null,
  bottom: "repl",
  right: null,
  palette: null,
  hint: null,
  vimMode: "normal",
  chord: null,
  flash: null,
  parinfer: null,
  chat: [],
  chatBusy: false,
  indentSpecs: {},
  fsNonce: 0,
  dialog: null,
  history: { back: [], forward: [] },
  sidebar: "files",
  help: false,
  settingsOpen: false,
  tourOpen: false,
  tourDone: [],
  newProject: false,
  references: null,
}));

export const set = useStore.setState;
export const get = useStore.getState;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** A transcript keeps its latest items; the REPL buffer drops old text on its own. */
const TRANSCRIPT_ITEMS = 5000;

const capped = (list: TranscriptItem[]) => (list.length > TRANSCRIPT_ITEMS ? list.slice(-TRANSCRIPT_ITEMS) : list);

export const withItem = (list: TranscriptItem[], item: WithoutId<TranscriptItem>) => capped([...list, { ...item, id: id() } as TranscriptItem]);

export function appendTranscript(item: WithoutId<TranscriptItem>) {
  set((s) => ({ transcript: withItem(s.transcript, item) }));
}

/** Adds output to a transcript, continuing the output item it ends with. */
export function withOutput(list: TranscriptItem[], text: string): TranscriptItem[] {
  const last = list[list.length - 1];
  if (last?.kind === "output") return [...list.slice(0, -1), { ...last, text: last.text + text }];
  return capped([...list, { id: id(), kind: "output", text }]);
}

function appendOutput(s: State, text: string): Partial<State> {
  return { transcript: withOutput(s.transcript, text) };
}

function updateRepl(s: State, replId: number, f: (r: ExtraRepl) => Partial<ExtraRepl>): Partial<State> {
  return { repls: s.repls.map((r) => (r.id === replId ? { ...r, ...f(r) } : r)) };
}

function appendResult(s: State, text: string): Partial<State> {
  const last = s.transcript[s.transcript.length - 1];
  // Swank sends the newline after a presented value outside the presentation.
  const trailing = s.openPresentation === null && text.trim() === "";
  if (last?.kind === "result" && (trailing || (s.openPresentation !== null && last.presentation === s.openPresentation))) {
    return { transcript: [...s.transcript.slice(0, -1), { ...last, text: last.text + text }] };
  }
  return {
    transcript: [...s.transcript, { id: id(), kind: "result", text, presentation: s.openPresentation }],
  };
}

export function reduce(s: State, e: AppEvent): Partial<State> {
  switch (e.type) {
    case "status":
      return { status: { session: e.session, project: e.project }, statusKnown: true };
    case "taskOutput": {
      const t = s.tasks[e.task] ?? { output: "", running: true, ok: null };
      return { tasks: { ...s.tasks, [e.task]: { ...t, output: t.output + e.text } } };
    }
    case "taskFinished": {
      const t = s.tasks[e.task] ?? { output: "", running: false, ok: null };
      const tone = e.ok ? "success" : "error";
      return {
        tasks: { ...s.tasks, [e.task]: { ...t, running: false, ok: e.ok } },
        transcript: [
          ...s.transcript,
          { id: id(), kind: "notice", tone, text: `${e.task}: ${e.ok ? "done" : e.message}` },
        ],
      };
    }
    case "assistant":
      return reduceAssistant(s, e.event);
    case "filesChanged":
      return { fsNonce: s.fsNonce + 1 };
    case "lisp":
      break;
  }
  const ev = e.event;
  switch (ev.kind) {
    case "output":
      if (ev.target === "repl-result") return appendResult(s, ev.text);
      return appendOutput(s, ev.text);
    case "presentationStart":
      return { openPresentation: ev.id };
    case "presentationEnd":
      return { openPresentation: null };
    case "newPackage":
      return { package: ev.name };
    case "debug": {
      const key = threadKey(ev.thread);
      // Swank names every interrupt as coming from Emacs, SLIME's home.
      const condition = ev.condition.replace(/^Interrupt from Emacs/, "Interrupted");
      const levels = (s.debuggers[key] ?? []).filter((d) => d.level < ev.level);
      return {
        debuggers: { ...s.debuggers, [key]: [...levels, { ...ev, condition }] },
        lastDebugThread: key,
        debugSpot: null,
        // The debugger shows beside the REPL; a stop elsewhere would go unseen.
        bottom: "repl",
        // Each step stops in the debugger; the stepper shows those stops, so the transcript skips them.
        transcript: ev.stepping ? s.transcript : [
          ...s.transcript,
          {
            id: id(),
            kind: "condition",
            thread: ev.thread,
            level: ev.level,
            condition,
            type: ev.conditionType.trim(),
          },
        ],
      };
    }
    case "debugReturn": {
      const key = threadKey(ev.thread);
      const levels = (s.debuggers[key] ?? []).filter((d) => d.level < ev.level);
      const debuggers = { ...s.debuggers };
      if (levels.length) debuggers[key] = levels;
      else delete debuggers[key];
      return { debuggers };
    }
    case "indentationUpdate": {
      const indentSpecs = { ...s.indentSpecs };
      for (const spec of ev.specs) indentSpecs[spec.name] = spec.spec;
      return { indentSpecs };
    }
    case "readString":
      return { inputRequest: { thread: ev.thread, tag: ev.tag } };
    case "readAborted":
      return { inputRequest: null };
    case "disconnected":
      // Extra REPLs' threads die with the image.
      return { debuggers: {}, inputRequest: null, openPresentation: null, repls: [], activeRepl: null, package: "COMMON-LISP-USER" };
    case "channel": {
      const m = ev.message;
      return updateRepl(s, ev.channel, (r) => {
        switch (m.kind) {
          case "writeString":
            return { transcript: withOutput(r.transcript, m.text) };
          case "writeResult":
            return { transcript: withItem(r.transcript, { kind: "result", text: m.text, presentation: null }) };
          case "prompt":
            return { package: m.package, busy: false, reading: false };
          case "evaluationAborted":
            return { busy: false, reading: false, transcript: withItem(r.transcript, { kind: "notice", tone: "error", text: "Evaluation aborted" }) };
          case "readMode":
            return { reading: m.reading };
          case "other":
            return {};
        }
      });
    }
    case "protocolError":
    case "backgroundMessage":
      return {
        transcript: [...s.transcript, { id: id(), kind: "notice", tone: "info", text: ev.kind === "protocolError" ? ev.message : ev.text }],
      };
    default:
      return {};
  }
}

function reduceAssistant(s: State, e: AssistantEvent): Partial<State> {
  const chat = [...s.chat];
  const last = chat[chat.length - 1];
  const assistantTail = () => {
    if (last?.role === "assistant") return last;
    const item: ChatItem = { id: id(), role: "assistant", text: "", thinking: "" };
    chat.push(item);
    return item;
  };
  switch (e.kind) {
    case "turnStarted":
      return { chatBusy: true };
    case "text": {
      const a = assistantTail() as Extract<ChatItem, { role: "assistant" }>;
      chat[chat.length - 1] = { ...a, text: a.text + e.text };
      return { chat };
    }
    case "thinking": {
      const a = assistantTail() as Extract<ChatItem, { role: "assistant" }>;
      chat[chat.length - 1] = { ...a, thinking: a.thinking + e.text };
      return { chat };
    }
    case "toolStarted":
      chat.push({ id: id(), role: "tool", toolId: e.id, name: e.name, input: e.input, output: null, ok: null });
      return { chat };
    case "toolFinished":
      return {
        chat: chat.map((c) => (c.role === "tool" && c.toolId === e.id ? { ...c, output: e.output, ok: e.ok } : c)),
      };
    case "error":
      chat.push({ id: id(), role: "error", text: e.message });
      return { chat };
    case "turnFinished":
      return {
        chatBusy: false,
        chat: chat.map((c) => (c.role === "tool" && c.ok === null ? { ...c, ok: false, output: "Stopped by the user before it finished." } : c)),
      };
  }
}

export function dispatchEvent(e: AppEvent) {
  set((s) => reduce(s, e));
}

export function liveDebugSpot(s: State) {
  const spot = s.debugSpot;
  return spot && s.debuggers[spot.thread]?.some((d) => d.level === spot.level) ? spot : null;
}

export function activeDebugger(s: State): Debugger | null {
  const levels = (s.lastDebugThread && s.debuggers[s.lastDebugThread]) || Object.values(s.debuggers)[0];
  return levels ? levels[levels.length - 1] : null;
}

export const emptyPanes = (): Pick<State, "panes" | "focusedPane" | "activeTab"> => ({ panes: [{ tabs: [], active: null }], focusedPane: 0, activeTab: null });

/**
 * Panes after an edit, kept consistent: a second pane with no files closes,
 * the focus stays on a pane that exists, and `activeTab` follows it.
 */
export function settlePanes(panes: Pane[], focused: number): Pick<State, "panes" | "focusedPane" | "activeTab"> {
  const kept = panes.filter((p, i) => i === 0 || p.tabs.length > 0);
  const still = panes[focused] ? kept.indexOf(panes[focused]) : -1;
  // A closed pane hands the focus to the one beside it.
  const focusedPane = still >= 0 ? still : kept.length - 1;
  return { panes: kept, focusedPane, activeTab: kept[focusedPane].active };
}

/** A pane with `path` taken out, showing a neighbour if it was on show. */
export function withoutTab(pane: Pane, path: string): Pane {
  const i = pane.tabs.indexOf(path);
  if (i < 0) return pane;
  const tabs = pane.tabs.filter((p) => p !== path);
  return { tabs, active: pane.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : pane.active };
}

/** A pane with `path` among its tabs, at `index` or the end, and on show. */
export function withTab(pane: Pane, path: string, index?: number): Pane {
  const rest = pane.tabs.filter((p) => p !== path);
  const at = index === undefined ? rest.length : Math.max(0, Math.min(index, rest.length));
  return { tabs: [...rest.slice(0, at), path, ...rest.slice(at)], active: path };
}
