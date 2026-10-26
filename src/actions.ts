import { backend } from "./backend";
import { afterSave, beforeSave } from "./plugins";
import type { Op } from "./protocol/Op";
import type { Reply } from "./protocol/Reply";
import type { Request } from "./protocol/Request";
import type { SourceLocation } from "./protocol/SourceLocation";
import type { Query } from "./protocol/Query";
import type { TestNode } from "./protocol/TestNode";
import type { Thread } from "./protocol/Thread";
import { activeEditor, viewPath } from "./editor/commands";
import { forgetDocs } from "./editor/hover";
import { pickFolder, rememberProject } from "./platform";
import { markTour, offerTour } from "./tour";
import type { Debugger } from "./protocol/Debugger";
import type { EditorContext } from "./protocol/EditorContext";
import { chatFromHistory } from "./ui/chatHistory";
import type { NewDeps } from "./protocol/NewDeps";
import type { Note } from "./protocol/Note";
import { useSettings } from "./settings";
import type { SystemInfo } from "./protocol/SystemInfo";
import { addDependency as addDep, removeDependency as removeDep } from "./lisp/asd";
import { definitionOf, definitions } from "./lisp/tree";
import { packageAt, topLevelForms } from "./lisp/forms";
import {
  activeDebugger,
  appendTranscript,
  emptyPanes,
  get,
  settlePanes,
  set,
  threadKey,
  withItem,
  withoutTab,
  withTab,
  type ExtraRepl,
  type Location,
  type Pane,
  type Tab,
} from "./store";

export async function request(req: Request) {
  try {
    return await backend.request(req);
  } catch (e) {
    appendTranscript({ kind: "notice", tone: "error", text: String(e instanceof Error ? e.message : e) });
    throw e;
  }
}

const CHANGES_CODE = new Set(["eval", "replEval", "compileForm", "compileFile", "loadFile"]);

/** Debugger controls leave the debugger by unwinding, so Swank answers them with an abort. */
const UNWINDS = new Set(["invokeRestart", "step", "debuggerAbort", "debuggerTopLevel", "debuggerContinue", "restartFrame", "returnFromFrame"]);

export async function lisp(op: Op): Promise<Reply> {
  if (CHANGES_CODE.has(op.op)) forgetDocs();
  if (UNWINDS.has(op.op)) {
    const r = await backend.request({ type: "lisp", op }).catch(() => null);
    return r?.type === "lisp" ? r.reply : { kind: "none" };
  }
  const r = await request({ type: "lisp", op });
  // New code has none of the old code's breakpoints, so they go back in.
  const compiled = op.op === "compileFile" || op.op === "loadFile" ? op.path : op.op === "compileForm" ? op.file : null;
  if (compiled) void syncBreakpoints(compiled);
  // Running code is what records traced calls.
  if (CHANGES_CODE.has(op.op) && get().traces.specs.length) void refreshTraces();
  return r.type === "lisp" ? r.reply : { kind: "none" };
}

const lispString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** Sends a file's breakpoints to Lisp, which installs them on the code compiled from it. */
export async function syncBreakpoints(path: string) {
  const list = get().breakpoints[path];
  if (!list || get().status.session.state !== "ready") return;
  const tab = get().tabs.find((t) => t.path === path);
  const label = (b: { from: number; to: number }) => {
    const text = (tab?.text.slice(b.from, b.to) ?? "").replace(/\s+/g, " ");
    return lispString(text.length > 48 ? `${text.slice(0, 47)}…` : text);
  };
  const ranges = list.map((b) => `(${b.from} ${b.to} ${label(b)})`).join(" ");
  const r = await lisp({ op: "eval", form: `(zenlisp::set-breakpoints ${lispString(path)} '(${ranges}))`, package: "COMMON-LISP-USER" }).catch(() => null);
  const bound = r?.kind === "evaluated" ? (r.value.match(/\d+/g) ?? []).map(Number) : [];
  set((s) => ({ boundBreakpoints: { ...s.boundBreakpoints, [path]: bound } }));
}

export function resyncBreakpoints() {
  for (const path of Object.keys(get().breakpoints)) void syncBreakpoints(path);
}

export function breakpointsChanged(path: string, list: { from: number; to: number }[], toggled: boolean) {
  set((s) => ({ breakpoints: { ...s.breakpoints, [path]: list } }));
  if (toggled) void syncBreakpoints(path);
}

export async function refreshStatus() {
  const r = await request({ type: "status" });
  if (r.type === "status") set({ status: { session: r.session, project: r.project }, statusKnown: true });
}

export async function startSession() {
  await request({ type: "startSession" });
  await refreshPackages();
}

export async function restartSession() {
  set({ debuggers: {}, inspector: null, traces: { specs: [], total: 0, entries: [] }, profiling: null, repls: [], activeRepl: null });
  appendTranscript({ kind: "notice", tone: "info", text: "Restarting Lisp…" });
  await request({ type: "restartSession" });
  await refreshPackages();
}

export async function refreshPackages() {
  const r = await lisp({ op: "listPackages" });
  if (r.kind === "names") set({ packages: r.items });
}

/** Runs `input` in the REPL; `shown` is how the transcript shows it, when that differs. */
/** Inputs the main REPL is running, waiting in the debugger or for typed input included. */
let replRunning = 0;

export async function replEval(input: string, shown = input) {
  markTour("repl");
  appendTranscript({ kind: "input", text: shown, package: get().package });
  set({ bottom: "repl" });
  replRunning++;
  try {
    await lisp({ op: "replEval", input });
  } finally {
    replRunning--;
  }
}

/**
 * Interrupts the REPL on show: the main one, or an extra REPL's thread. An
 * idle REPL is left alone; interrupting it would only open the debugger.
 */
export async function interrupt() {
  const extra = activeExtraRepl();
  if (extra ? !extra.busy : replRunning === 0) return flash("Nothing is running in the REPL");
  if (extra?.thread != null) return void (await lisp({ op: "interruptThread", thread: { id: extra.thread } }));
  await lisp({ op: "interrupt" });
}

export const activeExtraRepl = () => get().repls.find((r) => r.id === get().activeRepl) ?? null;

let nextRepl = 1;

const editRepl = (replId: number, f: (r: ExtraRepl) => Partial<ExtraRepl>) =>
  set((s) => ({ repls: s.repls.map((r) => (r.id === replId ? { ...r, ...f(r) } : r)) }));

/** Opens another REPL, with a listener thread of its own, so it can run while another REPL is busy. */
export async function newRepl() {
  const replId = nextRepl++;
  const repl: ExtraRepl = { id: replId, name: `REPL ${replId + 1}`, channel: null, thread: null, package: "COMMON-LISP-USER", transcript: [], reading: false, busy: true };
  set((s) => ({ repls: [...s.repls, repl], activeRepl: replId, bottom: "repl" }));
  const r = await lisp({ op: "createRepl", remote: replId }).catch(() => null);
  if (r?.kind === "repl") editRepl(replId, () => ({ channel: r.channel, thread: r.thread, package: r.package, busy: false }));
  else closeRepl(replId);
}

export function replSend(replId: number, code: string, shown = code) {
  const repl = get().repls.find((r) => r.id === replId);
  if (!repl || repl.channel === null) return;
  const reading = repl.reading;
  editRepl(replId, (r) => ({
    busy: true,
    transcript: withItem(r.transcript, { kind: "input", text: shown, package: reading ? "" : r.package }),
  }));
  // A line typed before Lisp says it is reading still ends the line it reads.
  void lisp({ op: "replSend", channel: repl.channel, text: `${code}\n` });
}

/** Clears the transcript of the REPL on show. */
export function clearRepl() {
  const extra = activeExtraRepl();
  if (extra) editRepl(extra.id, () => ({ transcript: [] }));
  else set({ transcript: [] });
}

export function closeRepl(replId: number) {
  const repl = get().repls.find((r) => r.id === replId);
  set((s) => ({ repls: s.repls.filter((r) => r.id !== replId), activeRepl: s.activeRepl === replId ? null : s.activeRepl }));
  if (repl?.thread != null) void lisp({ op: "endThread", thread: repl.thread }).catch(() => null);
}

export async function setPackage(name: string) {
  const r = await lisp({ op: "setPackage", name });
  if (r.kind === "text") set({ package: name });
}

export async function openProject(root: string) {
  const r = await request({ type: "openProject", root });
  if (r.type === "project") {
    // The root as the backend names it, so the project menu can tell it is the open one.
    rememberProject(r.project.root);
    set({ tabs: [], ...emptyPanes(), notes: {} });
    appendTranscript({ kind: "notice", tone: "info", text: `Opened ${r.project.name}` });
    markTour("project");
    offerTour();
    await Promise.all([refreshSystems(), refreshStatus(), refreshPackages()]);
    void refreshGit();
  }
}

/**
 * Whether the open project may be left: true when nothing is unsaved, or once
 * the user saves or discards the unsaved files; false when they cancel.
 */
export function leaveProject(): Promise<boolean> {
  const project = get().status.project;
  const dirty = dirtyTabs();
  if (!project || dirty.length === 0) return Promise.resolve(true);
  return new Promise((resolve) =>
    ask(`Save changes to ${project.name} first?`, `Unsaved: ${dirty.map((t) => t.name).join(", ")}.`, [
      { label: "Save All", kind: "primary", run: () => void saveAll().then(() => resolve(true)) },
      { label: "Don't Save", kind: "danger", run: () => resolve(true) },
      { label: "Cancel", run: () => resolve(false) },
    ]),
  );
}

export async function requestOpenProject(root?: string) {
  const dir = root ?? (await pickFolder("Open Lisp Project"));
  if (!dir || !(await leaveProject())) return;
  await openProject(dir);
}

/** Creates and opens a project; false when the user chose to stay in the open one. */
export async function newProject(parent: string, name: string, deps: NewDeps = "quicklisp") {
  if (!(await leaveProject())) return false;
  const r = await request({ type: "newProject", parent, name, deps });
  if (r.type !== "project") return false;
  rememberProject(r.project.root);
  set({ tabs: [], ...emptyPanes(), notes: {} });
  markTour("project");
  offerTour();
  await Promise.all([refreshSystems(), refreshStatus(), refreshPackages()]);
  void refreshGit();
  await openFile(`${r.project.root}/src/main.lisp`);
  return true;
}

export async function closeProject() {
  if (!(await leaveProject())) return;
  await request({ type: "closeProject" });
  set({ tabs: [], ...emptyPanes(), notes: {}, systems: [], transcript: [], inspector: null, debuggers: {}, right: null });
}

export async function refreshSystems() {
  const r = await request({ type: "projectSystems" });
  if (r.type !== "systems") return;
  set({ systems: r.systems });
  await refreshDependencies();
}

/** The systems the project's own systems depend on, each once, by name. */
export function dependencyNames(systems: SystemInfo[]) {
  const own = new Set(systems.map((s) => s.name));
  return [...new Set(systems.flatMap((s) => s.dependsOn))].filter((n) => !own.has(n)).sort();
}

export async function refreshDependencies() {
  const names = dependencyNames(get().systems);
  if (names.length === 0) return set({ deps: [] });
  const r = await backend.request({ type: "dependencies", names }).catch(() => null);
  if (r?.type === "dependencies") set({ deps: r.deps });
}

/** Whether the project's manager updates one dependency at a time: qlot and ocicl do, Quicklisp does dists. */
export const updatesOne = () => usesProgramManager();

/** Updates one dependency, or with Quicklisp the dists that hold every one. */
export async function updateDependency(name: string) {
  if (!updatesOne()) return updateDeps();
  set({ bottom: "output" });
  await runTask(`update ${name}`, { type: "updateDependency", name });
}

export async function dependencyVersions(name: string) {
  const r = await request({ type: "dependencyVersions", name });
  return r.type === "dependencyVersions" ? r.versions : [];
}

export async function pinDependency(name: string, version: string) {
  set({ bottom: "output" });
  await runTask(`pin ${name} ${version}`, { type: "pinDependency", name, version });
}

/** Removes `name` from every project system that depends on it, then, with ocicl, its pin. */
export async function dropDependency(name: string) {
  for (const system of get().systems.filter((s) => s.dependsOn.includes(name))) await removeDependency(system, name);
  if (get().status.project?.managers.some((m) => m.kind === "ocicl")) {
    set({ bottom: "output" });
    await runTask(`unpin ${name}`, { type: "unpinDependency", name });
  }
  await refreshSystems();
}

function runTask(task: string, req: Request) {
  set((s) => ({ tasks: { ...s.tasks, [task]: { output: "", running: true, ok: null } }, activeTask: task }));
  return request(req);
}

/** Runs a system's entry point in the REPL, loading the system first, as its built program would start. */
export function runSystem(system: SystemInfo) {
  if (!system.entryPoint) return;
  set({ bottom: "repl" });
  replEval(`(progn (zenlisp:load-system ${lispString(system.name)}) (uiop:call-function ${lispString(system.entryPoint)}))`);
}

export const loadSystem = (name: string) => runTask(`load ${name}`, { type: "loadSystem", name });
export async function testSystem(name: string) {
  if (get().testing) return;
  markTour("tests");
  set({ testing: name, bottom: "tests" });
  try {
    const r = await lisp({ op: "runTests", system: name });
    if (r.kind === "tests") set({ tests: { system: name, run: r } });
  } finally {
    set({ testing: null });
  }
}

/** The named tests that failed, deepest first, so a nested test reruns rather than its whole parent. */
export function failedTests(nodes: TestNode[]): TestNode[] {
  return nodes.flatMap((n) => {
    if (n.status !== "failed" || n.kind === "check") return [];
    const inner = failedTests(n.children);
    return inner.length ? inner : n.id ? [n] : [];
  });
}

/** Runs tests again by name. Rove cannot run one test and report it, so its tests rerun their system. */
export async function rerunTests(tests: TestNode[]) {
  const current = get().tests;
  if (!current || get().testing || tests.length === 0) return;
  if (tests.some((t) => t.framework === "rove")) return testSystem(current.system);
  set({ testing: tests.length === 1 ? tests[0].name : `${tests.length} tests`, bottom: "tests" });
  try {
    const r = await lisp({ op: "rerunTests", tests: tests.map((t) => ({ framework: t.framework, id: t.id! })) });
    if (r.kind === "tests") set({ tests: { system: current.system, run: r } });
  } finally {
    set({ testing: null });
  }
}

/** Opens where a test is defined, found by its defining form in the project's files. */
export async function goToTest(node: TestNode) {
  const name = shortName(node.id ?? node.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = await search({
    pattern: `\\((?:[\\w.-]+:{1,2})?(?:test|def-test|deftest|define-test)\\s+\\(?${name}(?:[\\s)]|$)`,
    regex: true,
    caseSensitive: false,
    wholeWord: false,
  });
  const hit = r?.files[0];
  if (!hit) {
    appendTranscript({ kind: "notice", tone: "info", text: `No definition found for test ${node.name}` });
    return;
  }
  await navigateToLine(hit.path, hit.lines[0].line, hit.lines[0].spans[0]?.[0] ?? 0);
}
export async function buildSystem(name: string) {
  set({ bottom: "output" });
  await runTask(`build ${name}`, { type: "build", system: name });
}
/** Writes a file's new text, through its tab when it is open so the editor shows it. */
async function writeText(path: string, text: string) {
  if (get().tabs.some((t) => t.path === path)) {
    updateTab(path, text);
    set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, revision: t.revision + 1 } : t)) }));
    await saveTab(path);
  } else {
    await request({ type: "writeFile", path, content: text });
  }
}

async function readText(path: string) {
  const open = get().tabs.find((t) => t.path === path);
  if (open) return open.text;
  const r = await request({ type: "readFile", path });
  return r.type === "file" ? r.content : null;
}

/** Runs a Lisp form as a named task, shown in the Output panel like a build. */
async function lispTask(task: string, form: string) {
  set((s) => ({ tasks: { ...s.tasks, [task]: { output: "", running: true, ok: null } }, activeTask: task, bottom: "output" }));
  const r = await lisp({ op: "eval", form, package: "COMMON-LISP-USER" }).catch((e) => ({ kind: "text" as const, text: String(e.message ?? e) }));
  const ok = r.kind === "evaluated";
  const output = r.kind === "evaluated" ? `${r.output}${r.value}\n` : r.kind === "text" ? r.text : "";
  set((s) => ({ tasks: { ...s.tasks, [task]: { output, running: false, ok } } }));
  appendTranscript({ kind: "notice", tone: ok ? "success" : "error", text: `${task}: ${ok ? "done" : output}` });
  return ok;
}

const usesProgramManager = () => get().status.project?.managers.some((m) => m.kind === "qlot" || m.kind === "ocicl") ?? false;

/** Declares `dep` in `system`'s .asd, then fetches it with the project's dependency manager. */
export async function addDependency(system: SystemInfo, dep: string) {
  const text = await readText(system.file);
  if (text === null) return;
  const next = addDep(text, system.name, dep);
  if (next === null) {
    appendTranscript({ kind: "notice", tone: "error", text: `${baseName(system.file)} does not define ${system.name} in a form ZenLisp can edit.` });
    return;
  }
  if (next !== text) await writeText(system.file, next);
  if (usesProgramManager()) {
    set({ bottom: "output" });
    await runTask(`fetch ${dep}`, { type: "fetchSystem", name: dep });
  } else {
    await lispTask(`fetch ${dep}`, `(progn (zenlisp:load-system ${lispString(dep)}) t)`);
  }
  await refreshSystems();
}

export async function removeDependency(system: SystemInfo, dep: string) {
  const text = await readText(system.file);
  if (text === null) return;
  const next = removeDep(text, system.name, dep);
  if (next !== null && next !== text) await writeText(system.file, next);
  await refreshSystems();
}

/** Updates every dependency to its latest release. */
export async function updateDeps() {
  if (usesProgramManager()) {
    set({ bottom: "output" });
    await runTask("update dependencies", { type: "updateDeps" });
  } else {
    await lispTask("update dependencies", '(if (find-package "QL") (funcall (intern "UPDATE-ALL-DISTS" "QL") :prompt nil) (error "Quicklisp is not installed."))');
  }
}

export async function saveImage(systems: string[]) {
  set({ bottom: "output" });
  await runTask("save startup image", { type: "saveImage", systems });
}

export async function installDeps() {
  set({ bottom: "output" });
  await runTask("install dependencies", { type: "installDeps" });
}

export async function listDir(path: string) {
  const r = await request({ type: "listDir", path });
  return r.type === "dir" ? r.entries : [];
}

const HISTORY_LIMIT = 100;

function here(): Location | null {
  const v = activeEditor.view;
  const path = v && viewPath.get(v);
  return path ? { path, offset: v.state.selection.main.head } : null;
}

/**
 * Opens `path`, recording where the user came from so Back returns there.
 * False when the file cannot be read, and then nothing is recorded.
 */
export async function navigate(path: string, offset?: number) {
  const from = here();
  if (!(await loadTab(path))) return false;
  if (from && (from.path !== path || offset !== undefined)) {
    set((s) => ({ history: { back: [...s.history.back, from].slice(-HISTORY_LIMIT), forward: [] } }));
  }
  await openFile(path, offset);
  return true;
}

export async function goBack() {
  const { back, forward } = get().history;
  const to = back[back.length - 1];
  const from = here();
  if (!to) return;
  set({ history: { back: back.slice(0, -1), forward: from ? [...forward, from] : forward } });
  await openFile(to.path, to.offset);
}

export async function goForward() {
  const { back, forward } = get().history;
  const to = forward[forward.length - 1];
  const from = here();
  if (!to) return;
  set({ history: { back: from ? [...back, from] : back, forward: forward.slice(0, -1) } });
  await openFile(to.path, to.offset);
}

export async function assistantSessions() {
  const r = await request({ type: "assistantSessions" });
  return r.type === "assistantSessions" ? r.sessions : [];
}

/** Continues a saved conversation: the chat shows it, and the next message carries it on. */
export async function openAssistantSession(id: string) {
  const r = await request({ type: "assistantOpenSession", id });
  if (r.type === "assistantSession") set({ chat: chatFromHistory(r.messages), chatBusy: false });
}

export async function deleteAssistantSession(id: string) {
  await request({ type: "assistantDeleteSession", id });
}

/** Sends `text` to the assistant, with the editor's context when there is one, as the chat's Send does. */
export async function askAssistant(text: string, context: EditorContext | null) {
  set((s) => ({ chat: [...s.chat, { id: Date.now(), role: "user", text }] }));
  await request({ type: "assistantSend", text, context });
}

/**
 * Asks the assistant to fix a problem in `path`. Unsaved edits are saved first,
 * since the assistant reads and changes the file on disk.
 */
export async function askToFix(path: string, text: string, context: EditorContext) {
  if (get().chatBusy) return;
  const tab = get().tabs.find((t) => t.path === path);
  if (tab && tab.text !== tab.saved) await saveTab(path, { compileChanges: false });
  set({ right: "assistant" });
  await askAssistant(text, context);
}

/** Opens `path` at a 1-based line and 0-based character column. */
export async function navigateToLine(path: string, line: number, column = 0) {
  // The file is read, not shown, so the jump list records where the jump started.
  const tab = await loadTab(path);
  if (!tab) return false;
  let offset = 0;
  for (let i = 1; i < line; i++) {
    const nl = tab.text.indexOf("\n", offset);
    if (nl < 0) break;
    offset = nl + 1;
  }
  return navigate(path, offset + column);
}

/** The buffer for `path`, read from disk the first time, without showing it. */
async function loadTab(path: string): Promise<Tab | null> {
  const open = get().tabs.find((t) => t.path === path);
  if (open) return open;
  const r = await request({ type: "readFile", path });
  if (r.type !== "file") return null;
  const tab: Tab = { path, name: baseName(path), saved: r.content, text: r.content, revision: 0, conflict: null };
  set((s) => (s.tabs.some((t) => t.path === path) ? {} : { tabs: [...s.tabs, tab] }));
  void backend
    .request({ type: "gitHead", path })
    .then((h) => h.type === "gitHead" && set((s) => ({ gitHeads: { ...s.gitHeads, [path]: h.text } })))
    .catch(() => null);
  return get().tabs.find((t) => t.path === path) ?? tab;
}

/** Shows a Markdown file rendered, or as text again. */
export function togglePreview(path: string) {
  set((s) => ({ previews: s.previews.includes(path) ? s.previews.filter((p) => p !== path) : [...s.previews, path] }));
}

/** Opens `path` in a pane, the focused one by default, and focuses it there. */
export async function openFile(path: string, offset?: number, pane = get().focusedPane) {
  if (!(await loadTab(path))) return;
  set((s) => ({
    ...settlePanes(
      s.panes.map((p, i) => (i === pane ? (p.tabs.includes(path) ? { ...p, active: path } : withTab(p, path)) : p)),
      pane,
    ),
    reveal: offset === undefined ? null : { path, offset, nonce: Date.now() },
  }));
}

/** Shows a file already open in a pane. */
export function showTab(pane: number, path: string) {
  set((s) => settlePanes(s.panes.map((p, i) => (i === pane ? { ...p, active: path } : p)), pane));
}

export function focusPane(pane: number) {
  if (get().focusedPane !== pane && get().panes[pane]) set((s) => settlePanes(s.panes, pane));
}

/** Shows the focused file in a second pane beside the first, or focuses the second pane if there is one. */
export function splitEditor() {
  const s = get();
  if (s.panes.length > 1) return focusPane(s.focusedPane === 0 ? 1 : 0);
  if (!s.activeTab) return;
  set(settlePanes([...s.panes, { tabs: [s.activeTab], active: s.activeTab }], 1));
}

/** Moves a tab to a pane, at `index` or its end; moving to pane 1 with one pane opens it. */
export function moveTab(path: string, from: number, to: number, index?: number) {
  set((s) => {
    const panes: Pane[] = s.panes.length > to ? [...s.panes] : [...s.panes, { tabs: [], active: null }];
    if (from !== to) panes[from] = withoutTab(panes[from], path);
    panes[to] = withTab(panes[to], path, index);
    return settlePanes(panes, to);
  });
}

/** Puts every tab back in one pane. */
export function joinPanes() {
  set((s) => {
    const first = s.panes.reduce((acc, p) => p.tabs.reduce((a, t) => (a.tabs.includes(t) ? a : { ...a, tabs: [...a.tabs, t] }), acc));
    return settlePanes([{ ...first, active: s.activeTab ?? first.active }], 0);
  });
}

const baseName = (path: string) => path.split("/").pop() ?? path;

const isDirty = (t: Tab) => t.text !== t.saved || t.conflict === "deleted";

export function ask(title: string, message: string, actions: NonNullable<ReturnType<typeof get>["dialog"]>["actions"]) {
  set({ dialog: { title, message, actions: actions.map((a) => ({ ...a, run: () => (set({ dialog: null }), a.run()) })) } });
}

/** Closes a file in a pane, asking first when that loses unsaved changes. */
export function requestCloseTab(path: string, pane = get().focusedPane) {
  const tab = get().tabs.find((t) => t.path === path);
  // Another pane still shows the file, so closing this one loses nothing.
  const elsewhere = get().panes.some((p, i) => i !== pane && p.tabs.includes(path));
  if (!tab || !isDirty(tab) || elsewhere) return closeTab(path, pane);
  ask(`Save changes to ${tab.name}?`, "Your changes will be lost if you don't save them.", [
    { label: "Save", kind: "primary", run: () => saveTab(path).then(() => closeTab(path, pane)) },
    { label: "Don't Save", kind: "danger", run: () => closeTab(path, pane) },
    { label: "Cancel", run: () => {} },
  ]);
}

export const dirtyTabs = () => get().tabs.filter(isDirty);

export async function saveAll() {
  for (const t of dirtyTabs()) await saveTab(t.path);
}

/** Brings open tabs in line with the disk after other programs change files. */
export async function syncWithDisk(paths: string[]) {
  const changed = new Set(paths);
  for (const tab of get().tabs.filter((t) => changed.has(t.path))) {
    const r = await backend.request({ type: "readFile", path: tab.path }).catch(() => null);
    const disk = r?.type === "file" ? r.content : null;
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.path !== tab.path) return t;
        if (disk === null) return { ...t, conflict: "deleted" };
        if (disk === t.saved) return { ...t, conflict: null };
        if (t.text === t.saved) return { ...t, saved: disk, text: disk, revision: t.revision + 1, conflict: null };
        return { ...t, conflict: "changed" };
      }),
    }));
  }
}

export async function reloadFromDisk(path: string) {
  const r = await request({ type: "readFile", path });
  if (r.type !== "file") return;
  set((s) => ({
    tabs: s.tabs.map((t) =>
      t.path === path ? { ...t, saved: r.content, text: r.content, revision: t.revision + 1, conflict: null } : t,
    ),
  }));
}

export function keepMine(path: string) {
  set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, conflict: null } : t)) }));
}

export async function createFile(path: string) {
  await request({ type: "createFile", path });
  await openFile(path);
}

export const createDir = (path: string) => request({ type: "createDir", path });

export async function renamePath(from: string, to: string) {
  await request({ type: "renamePath", from, to });
  const moved = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  set((s) => ({
    tabs: s.tabs.map((t) => (moved(t.path) === t.path ? t : { ...t, path: moved(t.path), name: baseName(moved(t.path)) })),
    ...settlePanes(
      s.panes.map((p) => ({ tabs: p.tabs.map(moved), active: p.active && moved(p.active) })),
      s.focusedPane,
    ),
  }));
}

export function trashPath(path: string, isDir: boolean) {
  ask(`Move ${baseName(path)} to the Trash?`, isDir ? "The folder and everything in it move to the Trash." : "You can restore it from the Trash in Finder.", [
    {
      label: "Move to Trash",
      kind: "danger",
      run: async () => {
        await request({ type: "trashPath", path });
        const gone = (p: string) => p === path || p.startsWith(`${path}/`);
        set((s) => ({
          tabs: s.tabs.filter((t) => !gone(t.path)),
          ...settlePanes(
            s.panes.map((p) => p.tabs.filter(gone).reduce(withoutTab, p)),
            s.focusedPane,
          ),
        }));
      },
    },
    { label: "Cancel", run: () => {} },
  ]);
}

/** Takes a file out of a pane; its buffer goes once no pane shows it. */
export function closeTab(path: string, pane = get().focusedPane) {
  set((s) => {
    const panes = s.panes.map((p, i) => (i === pane ? withoutTab(p, path) : p));
    const shown = panes.some((p) => p.tabs.includes(path));
    return { ...settlePanes(panes, pane), tabs: shown ? s.tabs : s.tabs.filter((t) => t.path !== path) };
  });
}

export function updateTab(path: string, text: string) {
  set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, text } : t)) }));
}

/** Asks git again what changed: the file tree's status and the open files' committed text. */
export async function refreshGit() {
  if (!get().status.project) return;
  const st = await backend.request({ type: "gitStatus" }).catch(() => null);
  if (st?.type === "gitStatus") set({ gitStatus: Object.fromEntries(st.files.map((f) => [f.path, f.state])) });
  const heads = await Promise.all(
    get().tabs.map(async (t) => {
      const r = await backend.request({ type: "gitHead", path: t.path }).catch(() => null);
      return [t.path, r?.type === "gitHead" ? r.text : null] as const;
    }),
  );
  set({ gitHeads: Object.fromEntries(heads) });
}

/** Shows or hides a file's changes since the last commit, inline in the editor. */
export function toggleDiff(path: string) {
  if (get().gitHeads[path] == null) {
    appendTranscript({ kind: "notice", tone: "info", text: `${baseName(path)} is not in a git commit yet.` });
    return;
  }
  set((s) => ({ diffOn: s.diffOn.includes(path) ? s.diffOn.filter((p) => p !== path) : [...s.diffOn, path] }));
}

/** Saves a file and, unless asked not to, compiles what changed in it into Lisp. */
export async function saveTab(path: string, { compileChanges = true } = {}) {
  const tab = get().tabs.find((t) => t.path === path);
  if (!tab) return;
  if (readOnlyFile(path)) return flash(`${tab.name} is outside the project, so it is read-only`, "error");
  const text = await beforeSave(path, tab.text);
  await request({ type: "writeFile", path, content: text });
  set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, saved: text, conflict: null } : t)) }));
  void refreshGit();
  void afterSave(path);
  if (compileChanges && useSettings.getState().compileOnSave && inProject(path)) void inOrder(path, () => compileChangedForms(path, text));
}

const compiling = new Map<string, Promise<void>>();

/**
 * Runs compiles of one file one after another. A save is followed by the
 * watcher's report of that same write; run after it, that finds nothing new.
 */
function inOrder(path: string, run: () => Promise<void>) {
  const next = (compiling.get(path) ?? Promise.resolve()).then(run, run);
  compiling.set(path, next);
  return next;
}

/**
 * Records the project files that loaded systems consist of, as on disk now,
 * since that is what Lisp loaded. Their later changes compile form by form.
 */
let tracking: Promise<void> = Promise.resolve();

export function trackLoadedFiles() {
  tracking = tracking.then(recordLoadedFiles, recordLoadedFiles);
  return tracking;
}

async function recordLoadedFiles() {
  const root = get().status.project?.root;
  if (!root || get().status.session.state !== "ready") return;
  // Which systems are loaded changes too, and a changed .asd of a loaded one asks for a load.
  void refreshSystems();
  const r = await backend.request({ type: "lisp", op: { op: "eval", form: `(zenlisp::loaded-source-files ${lispString(root)})`, package: "COMMON-LISP-USER" } }).catch(() => null);
  if (r?.type !== "lisp" || r.reply.kind !== "evaluated") return;
  // The value is a printed Lisp string: quoted, with " and \ escaped and newlines as they are.
  const listed = r.reply.value.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").split("\n").filter(Boolean);
  for (const rel of listed) {
    const path = `${root}/${rel}`;
    const file = await backend.request({ type: "readFile", path }).catch(() => null);
    if (file?.type === "file") compiledAll(path, file.content);
  }
}

/**
 * Compiles what changed in loaded files that something other than ZenLisp
 * wrote, such as git or another editor. A file with unsaved edits is left to
 * the conflict it raises; a changed .asd needs a load to take effect.
 */
export async function compileOutsideChanges(paths: string[]) {
  if (!useSettings.getState().compileOnChange || get().status.session.state !== "ready") return;
  await tracking;
  for (const path of paths) {
    const system = get().systems.find((s) => s.file === path && s.loaded);
    if (system) flash(`${baseName(path)} changed; Load ${system.name} to apply it`);
    if (!compiledForms.has(path)) continue;
    const tab = get().tabs.find((t) => t.path === path);
    if (tab && tab.text !== tab.saved) continue;
    void inOrder(path, async () => {
      const r = await backend.request({ type: "readFile", path }).catch(() => null);
      // A save's own write comes back from the watcher; its forms were just compiled, or just failed to.
      if (r?.type === "file" && r.content !== lastCompiled.get(path)) await compileChangedForms(path, r.content, " from disk");
    });
  }
}

/** Per file, the text of each top-level form as Lisp last compiled it, or as last saved. */
const compiledForms = new Map<string, Set<string>>();
/** Per file, the whole text its changed forms were last compiled from. */
const lastCompiled = new Map<string, string>();

const formTexts = (text: string) => topLevelForms(text).map((f) => text.slice(f.from, f.to));

/** Records that Lisp now has the forms of `text`, as after compiling the whole file. */
export function compiledAll(path: string, text: string) {
  compiledForms.set(path, new Set(formTexts(text)));
}

export function flash(text: string, tone: "info" | "error" = "info") {
  set({ flash: { text, tone } });
  setTimeout(() => get().flash?.text === text && set({ flash: null }), 3500);
}

/**
 * Compiles, in file order, the top-level forms of `text` that Lisp does not
 * have, so Lisp keeps up with the file without recompiling all of it. Lisp has
 * the forms it compiled or loaded; of a file it never loaded it has none, and
 * the whole file compiles. Forms in a package Lisp lacks are left alone, since
 * their file needs another file of the project loaded first.
 */
async function compileChangedForms(path: string, text: string, source = "") {
  if (!path.endsWith(".lisp") || get().status.session.state !== "ready") return;
  const baseline = compiledForms.get(path) ?? new Set<string>();
  const changed = topLevelForms(text)
    .map((f) => ({ ...f, text: text.slice(f.from, f.to) }))
    .filter((f) => !baseline.has(f.text) && !/^\(\s*(cl:|common-lisp:)?in-package\s/i.test(f.text));
  if (changed.length === 0) return;
  const pkg = packageAt(text, changed[0].from) ?? "COMMON-LISP-USER";
  const exists = await backend.request({ type: "lisp", op: { op: "eval", form: `(and (find-package ${lispString(pkg)}) t)`, package: "COMMON-LISP-USER" } }).catch(() => null);
  if (!(exists?.type === "lisp" && exists.reply.kind === "evaluated" && exists.reply.value === "T")) return;
  const failed = new Set<string>();
  const done: string[] = [];
  for (const f of changed) {
    const r = await lisp({ op: "compileForm", form: f.text, package: packageAt(text, f.from) ?? "COMMON-LISP-USER", buffer: path, file: path, offset: f.from }).catch(() => null);
    const ok = r?.kind === "compiled" && r.success && !r.notes.some((n) => n.severity === "error" || n.severity === "read-error");
    if (ok) done.push(definitionOfForm(f.text));
    else failed.add(f.text);
  }
  compiledForms.set(path, new Set(formTexts(text).filter((t) => !failed.has(t))));
  lastCompiled.set(path, text);
  if (failed.size) flash(`${failed.size} changed form${failed.size > 1 ? "s" : ""} did not compile; see Problems`, "error");
  else flash(`Compiled ${done.join(", ")}${source}`);
  // What other files use may have just been defined.
  for (const t of get().tabs) checkSoon(t.path, 0);
}

/** A form's name for a message: what it defines, or how it starts. */
function definitionOfForm(text: string) {
  const d = definitions(text)[0];
  return d ? d.name.toLowerCase() : `${text.replace(/\s+/g, " ").slice(0, 24)}…`;
}

const checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
const checking = new Set<string>();
const checkAgain = new Set<string>();

/** Notes about a package the project defines but has not loaded yet say nothing about the code. */
const packageMissing = (n: Note) => n.severity === "read-error" && /package|does not exist/i.test(n.message);

/**
 * Whether `path` is in the open project. Files outside it, such as SBCL's own
 * sources that go to definition opens, belong to code already loaded:
 * compiling them again redefines Lisp itself, which package locks refuse.
 */
export function inProject(path: string) {
  const root = get().status.project?.root;
  return !!root && path.startsWith(`${root}/`);
}

/**
 * Whether `path` opens read-only: a file outside the open project, such as
 * SBCL's sources or a library's, reached by go to definition. Saving one would
 * change the installed SBCL or library under every project.
 */
export function readOnlyFile(path: string) {
  return !!get().status.project && !inProject(path);
}

/**
 * Checks a file's code shortly after typing stops: its text is compiled, not
 * loaded, and the compiler's warnings replace the file's notes.
 */
export function checkSoon(path: string, delay = 600) {
  if (!useSettings.getState().liveCheck || !path.endsWith(".lisp") || !inProject(path) || get().status.session.state !== "ready") return;
  clearTimeout(checkTimers.get(path));
  checkTimers.set(path, setTimeout(() => void checkNow(path), delay));
}

async function checkNow(path: string) {
  if (checking.has(path)) return void checkAgain.add(path);
  const text = get().tabs.find((t) => t.path === path)?.text;
  if (text === undefined) return;
  checking.add(path);
  try {
    // Straight to the backend: a check that fails has nothing to tell the REPL.
    const r = await backend.request({ type: "lisp", op: { op: "checkText", text, package: "COMMON-LISP-USER", file: path } }).catch(() => null);
    const still = get().tabs.find((t) => t.path === path)?.text === text;
    if (r?.type === "lisp" && r.reply.kind === "compiled" && still) {
      const notes = r.reply.notes.filter((n) => !packageMissing(n));
      set((s) => ({ notes: { ...s.notes, [path]: notes } }));
    }
  } finally {
    checking.delete(path);
    if (checkAgain.delete(path)) void checkNow(path);
  }
}

export async function compileFile(path: string) {
  await saveTab(path, { compileChanges: false });
  const r = await lisp({ op: "compileFile", path, load: true });
  // The files it depends on may have loaded first.
  void trackLoadedFiles();
  if (r.kind === "compiled") {
    const text = get().tabs.find((t) => t.path === path)?.text;
    if (r.success && text !== undefined) compiledAll(path, text);
    set((s) => ({ notes: { ...s.notes, [path]: r.notes }, bottom: r.notes.length ? "problems" : s.bottom }));
    const failures = r.notes.filter((n) => n.severity === "error" || n.severity === "read-error").length;
    appendTranscript({
      kind: "notice",
      tone: r.success && failures === 0 ? "success" : "error",
      text: `Compiled ${path.split("/").pop()} in ${r.seconds.toFixed(2)}s: ${r.notes.length} note${r.notes.length === 1 ? "" : "s"}`,
    });
  }
}

export async function goToLocation(loc: SourceLocation | null) {
  // Forms compiled from an editor buffer carry the buffer name, which is the file's path.
  const file = loc?.file ?? (loc?.buffer?.startsWith("/") ? loc.buffer : null);
  if (!loc || !file) return false;
  return navigate(file, loc.offset ?? 0);
}

export async function search(query: Query) {
  const r = await request({ type: "search", query });
  return r.type === "search" ? r : null;
}

export async function replaceAll(query: Query, replacement: string, paths: string[]) {
  const dirty = get().tabs.filter((t) => paths.includes(t.path) && t.text !== t.saved);
  if (dirty.length) {
    appendTranscript({ kind: "notice", tone: "error", text: `Save ${dirty.map((t) => t.name).join(", ")} before replacing.` });
    return 0;
  }
  const r = await request({ type: "replace", query, replacement, paths });
  return r.type === "replaced" ? r.count : 0;
}

export async function findReferences(name: string, pkg: string) {
  const [callers, refs] = await Promise.all([
    lisp({ op: "xref", kind: "callers", name, package: pkg }),
    lisp({ op: "xref", kind: "references", name, package: pkg }),
  ]);
  const items = [callers, refs].flatMap((r) => (r.kind === "definitions" ? r.items : []));
  set({ references: { name, items }, sidebar: "search" });
}

/**
 * Goes to where `name` is defined: Lisp's record of it for loaded code, else
 * a defining form in the open file, else one anywhere in the project, since
 * code not yet compiled is unknown to Lisp. False when nothing defines it.
 */
/**
 * How directly a definition defines its name, lowest first: a function, macro
 * or generic before its methods, those before variables and types, and all of
 * them before compiler machinery such as compiler macros and transforms.
 */
export function definitionRank(label: string): number {
  const kind = label.replace(/^\(/, "").split(/\s/)[0].toUpperCase();
  if (/^(DEFUN|DEFMACRO|DEFGENERIC|DEFINE-SETF-EXPANDER)$/.test(kind)) return 0;
  if (kind === "DEFMETHOD") return 1;
  if (/^(DEFVAR|DEFPARAMETER|DEFCONSTANT|DEFCLASS|DEFSTRUCT|DEFINE-CONDITION|DEFTYPE|DEFPACKAGE)$/.test(kind)) return 2;
  return 3;
}

/** Goes to a definition from a panel, saying so in the REPL when there is none. */
export async function showDefinition(name: string, pkg: string) {
  if (!(await findDefinition(name, pkg))) appendTranscript({ kind: "notice", tone: "info", text: `No definition of ${name} found` });
}

export async function findDefinition(name: string, pkg: string, from?: { path: string; text: string }) {
  const r = await lisp({ op: "findDefinitions", name, package: pkg }).catch(() => null);
  if (r?.kind === "definitions" && r.items.length) {
    const best = [...r.items].sort((a, b) => definitionRank(a.label) - definitionRank(b.label));
    for (const d of best) if (await goToLocation(d.location)) return true;
  }
  if (from) {
    const offset = definitionOf(from.text, name);
    if (offset !== null && (await navigate(from.path, offset))) return true;
  }
  const symbol = name.replace(/^.*?::?(?=[^:])/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = await search({
    pattern: `\\((?:[\\w.-]+:{1,2})?def[\\w-]*\\s+\\(?(?:setf\\s+)?${symbol}(?:[\\s)]|$)`,
    regex: true,
    caseSensitive: false,
    wholeWord: false,
  }).catch(() => null);
  const hit = found?.files.find((f) => f.path.endsWith(".lisp") || f.path.endsWith(".asd")) ?? found?.files[0];
  if (!hit) return false;
  return navigateToLine(hit.path, hit.lines[0].line, hit.lines[0].spans[0]?.[0] ?? 0);
}

async function showInspector(r: Reply) {
  if (r.kind === "inspector") set({ inspector: { title: r.title, parts: r.parts }, right: "inspector" });
}

export const inspectForm = async (form: string, pkg: string) => showInspector(await lisp({ op: "inspect", form, package: pkg }));
export const inspectPresentation = async (id: number) => showInspector(await lisp({ op: "inspectPresentation", id }));
export const inspectPart = async (index: number) => showInspector(await lisp({ op: "inspectPart", index }));
export const inspectorAction = async (index: number) => showInspector(await lisp({ op: "inspectorAction", index }));
export const inspectorBack = async () => showInspector(await lisp({ op: "inspectorBack" }));
export const inspectorForward = async () => showInspector(await lisp({ op: "inspectorForward" }));
export const inspectorRefresh = async () => showInspector(await lisp({ op: "inspectorRefresh" }));
export const inspectFrameVar = async (thread: Thread, frame: number, v: number) =>
  showInspector(await lisp({ op: "inspectFrameVar", thread, frame, var: v }));
export const inspectCondition = async (thread: Thread) => showInspector(await lisp({ op: "inspectCondition", thread }));

export const invokeRestart = (thread: Thread, level: number, index: number) => (
  markTour("restart"), lisp({ op: "invokeRestart", thread, level, index })
);
export const restartFrame = (thread: Thread, frame: number) => (markTour("restart"), lisp({ op: "restartFrame", thread, frame }));
/** Leaves every debugger, each stopped thread back at its top level. */
export async function closeDebuggers() {
  const stopped = Object.values(get().debuggers).map((levels) => levels[levels.length - 1].thread);
  await Promise.all(stopped.map((thread) => lisp({ op: "debuggerTopLevel", thread })));
}

export const debuggerAbort = (thread: Thread) => (markTour("restart"), lisp({ op: "debuggerAbort", thread }));
export const debuggerContinue = (thread: Thread) => lisp({ op: "debuggerContinue", thread });
export const step = (thread: Thread, frame: number, how: "into" | "over" | "out") => lisp({ op: "step", thread, frame, how });

/** Steps the stopped stepper, if there is one; "continue" runs on without stepping. */
export function stepActive(how: "into" | "over" | "out" | "continue") {
  const dbg = activeDebugger(get());
  if (!dbg?.stepping) return;
  if (how !== "continue") return void step(dbg.thread, 0, how);
  // A step has STEP-CONTINUE; a breakpoint has CONTINUE.
  const index = dbg.restarts.findIndex((r) => r.name === "STEP-CONTINUE" || r.name === "CONTINUE");
  if (index >= 0) invokeRestart(dbg.thread, dbg.level, index);
}

/**
 * Opens a frame's source and marks the form it is at. Each step shows its form
 * this way, so stepping follows the code without adding to the jump list.
 */
export async function showFrame(dbg: Debugger, frame: number, { remember = true } = {}) {
  const r = await lisp({ op: "frameSource", thread: dbg.thread, frame }).catch(() => null);
  if (r?.kind !== "location") return false;
  const path = r.location?.file ?? (r.location?.buffer?.startsWith("/") ? r.location.buffer : null);
  if (!path) return false;
  const offset = r.location?.offset ?? 0;
  await (remember ? navigate(path, offset) : openFile(path, offset));
  set({ debugSpot: { thread: threadKey(dbg.thread), level: dbg.level, path, offset } });
  return true;
}

export async function refreshTraces() {
  const r = await lisp({ op: "traceReport" }).catch(() => null);
  if (r?.kind === "traces") set({ traces: { specs: r.specs, total: r.total, entries: r.entries } });
}

/** Starts or stops tracing `name`, and says which it did. */
export async function toggleTrace(name: string, pkg: string) {
  await lisp({ op: "toggleTrace", name, package: pkg });
  const before = get().traces.specs;
  await refreshTraces();
  const now = get().traces.specs;
  const added = now.find((spec) => !before.includes(spec));
  if (added) set({ bottom: "trace" });
  return added ? `tracing ${shortName(added)}` : `stopped tracing ${name.toUpperCase()}`;
}

export async function untraceAll() {
  await lisp({ op: "untraceAll" });
  await refreshTraces();
}

export async function clearTraces() {
  await lisp({ op: "clearTraces" });
  await refreshTraces();
}

export const inspectTracePart = async (id: number, part: number, value: boolean) =>
  showInspector(await lisp({ op: "inspectTracePart", id, part, value }));

/** "ZEN-DEMO::GREET" as "GREET", for display; the full name stays for reading it back. */
export const shortName = (spec: string) => spec.replace(/^[^\s():"|]+?::?(?=[^:])/, "");

export async function profileForm(form: string, pkg: string) {
  if (get().profiling) return;
  set({ profiling: "form", bottom: "profile" });
  try {
    const r = await lisp({ op: "profileForm", form, package: pkg });
    const label = form.replace(/\s+/g, " ").trim();
    if (r.kind === "profile") set({ profile: { ...r, label: label.length > 60 ? `${label.slice(0, 59)}…` : label } });
  } finally {
    set({ profiling: null });
  }
}

export async function startProfiling() {
  if (get().profiling) return;
  await lisp({ op: "profileStart" });
  set({ profiling: "all", bottom: "profile" });
}

export async function stopProfiling() {
  if (get().profiling !== "all") return;
  const r = await lisp({ op: "profileStop" }).finally(() => set({ profiling: null }));
  if (r.kind === "profile") set({ profile: { ...r, label: null } });
}

/** Shows a symbol in the documentation panel, remembering the one it replaces. */
export function showDocs(symbol: string, pkg: string, { open = true } = {}) {
  if (open) markTour("docs");
  set((s) => {
    const was = s.docs.topic;
    if (was && was.symbol.toLowerCase() === symbol.toLowerCase() && was.package === pkg) return open ? { right: "docs" } : {};
    return {
      docs: { ...s.docs, topic: { symbol, package: pkg }, back: was ? [...s.docs.back, was].slice(-50) : s.docs.back },
      ...(open ? { right: "docs" as const } : {}),
    };
  });
}

export function docsBack() {
  set((s) => {
    const back = [...s.docs.back];
    const topic = back.pop() ?? s.docs.topic;
    return { docs: { ...s.docs, topic, back } };
  });
}

/** Installs the HyperSpec through Quicklisp's "clhs" release. */
export async function installHyperspec() {
  const r = await lisp({
    op: "eval",
    form: '(if (find-package "QL") (progn (funcall (intern "QUICKLOAD" "QL") "clhs" :silent t) "installed") "no-quicklisp")',
    package: "COMMON-LISP-USER",
  });
  return r.kind === "evaluated" && r.value.includes("installed");
}

/** What a bug report needs, copied for pasting: versions, the project and recent errors. */
export async function copyDiagnostics() {
  const s = get();
  const session = s.status.session;
  const problems = s.transcript
    .filter((t) => t.kind === "condition" || (t.kind === "notice" && t.tone === "error"))
    .slice(-20)
    .map((t) => (t.kind === "condition" ? `${t.type}: ${t.condition}` : t.kind === "notice" ? t.text : ""));
  const text = [
    "ZenLisp diagnostics",
    `Lisp: ${session.state === "ready" ? `SBCL ${session.version}` : session.state === "failed" ? `failed to start: ${session.message}` : session.state === "exited" ? `exited: ${session.message}` : session.state}`,
    `Project: ${s.status.project ? `${s.status.project.name} (${s.status.project.managers.map((m) => m.kind).join(", ") || "no dependency manager"})` : "none"}`,
    `System: ${navigator.userAgent}`,
    "",
    "Recent errors:",
    ...(problems.length ? problems : ["none"]),
  ].join("\n");
  try {
    await navigator.clipboard.writeText(text);
    appendTranscript({ kind: "notice", tone: "info", text: "Diagnostics copied. Paste them into your report." });
  } catch {
    ask("Diagnostics", text, [{ label: "Close", run: () => {} }]);
  }
}

export async function answerInput(text: string) {
  const req = get().inputRequest;
  if (!req) return;
  set({ inputRequest: null });
  appendTranscript({ kind: "input", text, package: "" });
  await request({ type: "returnString", thread: req.thread, tag: req.tag, text: text + "\n" });
}
