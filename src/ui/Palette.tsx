import { useEffect, useMemo, useState } from "react";
import * as actions from "../actions";
import { updateSettings, useSettings } from "../settings";
import { definitions } from "../lisp/tree";
import { get, set, useStore } from "../store";
import { openProjectFlow } from "./Chrome";
import { openTour } from "../tour";
import { useReturnFocus } from "./focus";
import { displayKey } from "../keys";
import { reloadPlugins, runPluginCommand, usePlugins } from "../plugins";
import { isMarkdown } from "./MarkdownPreview";

export type Command = { id: string; label: string; keys?: string; run: () => void };

export function commands(openNew: () => void): Command[] {
  const s = get();
  const tab = s.activeTab;
  const systems = s.systems.flatMap((sys) => [
    { id: `load:${sys.name}`, label: `Load System: ${sys.name}`, run: () => actions.loadSystem(sys.name) },
    { id: `test:${sys.name}`, label: `Test System: ${sys.name}`, run: () => actions.testSystem(sys.name) },
    { id: `build:${sys.name}`, label: `Build Executable: ${sys.name}`, run: () => actions.buildSystem(sys.name) },
  ]);
  const settings = useSettings.getState();
  return [
    { id: "open", label: "Open Project…", keys: "⌘O", run: () => openProjectFlow() },
    { id: "new", label: "New Project…", keys: "⇧⌘N", run: openNew },
    { id: "files", label: "Go to File…", keys: "⌘P", run: () => set({ palette: "files" }) },
    ...(tab ? [{ id: "symbols", label: "Go to Definition in File…", keys: "⇧⌘O", run: () => set({ palette: "symbols" }) }] : []),
    { id: "search", label: "Search in Project", keys: "⇧⌘F", run: () => set({ sidebar: "search" }) },
    { id: "packages", label: "Show Packages", run: () => set({ sidebar: "packages" }) },
    ...(isMarkdown(get().activeTab) ? [{ id: "md-preview", label: "Toggle Markdown Preview", keys: "⇧⌘V", run: () => actions.togglePreview(get().activeTab!) }] : []),
    { id: "wrap", label: "Toggle Word Wrap", keys: "⌥Z", run: () => updateSettings({ wordWrap: !useSettings.getState().wordWrap }) },
    { id: "back", label: "Go Back", keys: "⌃O", run: actions.goBack },
    { id: "forward", label: "Go Forward", keys: "⌃⇧O", run: actions.goForward },
    ...(s.status.project ? [{ id: "close", label: "Close Project", run: actions.closeProject }] : []),
    ...(tab
      ? [
          { id: "save", label: "Save File", keys: "⌘S", run: () => actions.saveTab(tab) },
          { id: "diff", label: s.diffOn.includes(tab) ? "Hide Changes Since Last Commit" : "Show Changes Since Last Commit", run: () => actions.toggleDiff(tab) },
          { id: "split", label: s.panes.length > 1 ? "Go to the Other Pane" : "Split Editor Right", keys: "⌘\\", run: actions.splitEditor },
          ...(s.panes.length > 1
            ? [
                { id: "move", label: "Move File to the Other Pane", run: () => actions.moveTab(tab, s.focusedPane, s.focusedPane === 0 ? 1 : 0) },
                { id: "join", label: "Join Editor Panes", run: actions.joinPanes },
              ]
            : []),
          { id: "compile", label: "Compile and Load File", keys: "⌘B", run: () => actions.compileFile(tab) },
        ]
      : []),
    ...(usePlugins.getState().manifest?.commands ?? []).map((c) => ({
      id: `plugin:${c.id}`,
      label: c.title,
      keys: c.key ? displayKey(c.key) : undefined,
      run: () => void runPluginCommand(c.id),
    })),
    ...(usePlugins.getState().manifest ? [{ id: "reload-plugins", label: "Reload Plugins", run: () => void reloadPlugins() }] : []),
    { id: "restart", label: "Restart Lisp", run: actions.restartSession },
    { id: "tour", label: "Getting Started", run: openTour },
    { id: "settings", label: "Settings…", keys: "⌘,", run: () => set({ settingsOpen: true }) },
    { id: "diagnostics", label: "Copy Diagnostics for a Report", run: actions.copyDiagnostics },
    { id: "interrupt", label: "Interrupt Lisp", keys: "⌃C", run: actions.interrupt },
    { id: "clear", label: "Clear REPL", keys: "⌘K", run: actions.clearRepl },
    { id: "new-repl", label: "New REPL in Its Own Thread", run: actions.newRepl },
    { id: "inspector", label: "Toggle Inspector", keys: "⌥⌘I", run: () => set({ right: get().right === "inspector" ? null : "inspector" }) },
    { id: "docs", label: "Toggle Documentation", run: () => set({ right: get().right === "docs" ? null : "docs" }) },
    { id: "assistant", label: "Toggle AI Assistant", keys: "⌘L", run: () => set({ right: get().right === "assistant" ? null : "assistant" }) },
    { id: "trace", label: "Show Traced Calls", run: () => set({ bottom: "trace" }) },
    ...(s.traces.specs.length ? [{ id: "untrace", label: "Untrace All Functions", run: actions.untraceAll }] : []),
    s.profiling === "all"
      ? { id: "profile", label: "Stop Profiling and Report", run: actions.stopProfiling }
      : { id: "profile", label: "Start Profiling Every Thread", run: actions.startProfiling },
    { id: "rescan", label: "Rescan Systems", run: actions.refreshSystems },
    { id: "deps", label: "Install Dependencies", run: actions.installDeps },
    ...systems,
    { id: "vim", label: `${settings.vim ? "Disable" : "Enable"} Vim Keybindings`, run: () => updateSettings({ vim: !settings.vim }) },
    { id: "emacs", label: `${settings.emacs ? "Disable" : "Enable"} Emacs Key Sequences`, run: () => updateSettings({ emacs: !settings.emacs }) },
    {
      id: "parinfer",
      label: `${settings.parinfer ? "Disable" : "Enable"} Parinfer`,
      run: () => updateSettings({ parinfer: !settings.parinfer }),
    },
    {
      id: "theme",
      label: `Theme: ${settings.theme === "dark" ? "Light" : settings.theme === "light" ? "System" : "Dark"}`,
      run: () => updateSettings({ theme: settings.theme === "dark" ? "light" : settings.theme === "light" ? "system" : "dark" }),
    },
    { id: "bigger", label: "Increase Font Size", keys: "⌘+", run: () => updateSettings({ fontSize: settings.fontSize + 1 }) },
    { id: "smaller", label: "Decrease Font Size", keys: "⌘-", run: () => updateSettings({ fontSize: Math.max(9, settings.fontSize - 1) }) },
  ];
}

export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 3 : 1;
    if (i === 0 || /[\s/:._-]/.test(t[i - 1])) score += 2;
    prev = i;
    ti = i + 1;
  }
  return score - t.length * 0.01;
}

async function projectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6 || out.length > 3000) return;
    for (const e of await actions.listDir(dir)) {
      if (e.isDir) await walk(e.path, depth + 1);
      else out.push(e.path);
    }
  };
  await walk(root, 0);
  return out;
}

export function Palette({ openNew }: { openNew: () => void }) {
  const mode = useStore((s) => s.palette);
  const root = useStore((s) => s.status.project?.root);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  useReturnFocus(mode !== null);

  useEffect(() => {
    setQuery("");
    setSelected(0);
    if (mode === "files" && root) projectFiles(root).then(setFiles);
  }, [mode, root]);

  const items = useMemo(() => {
    const tab = get().tabs.find((t) => t.path === get().activeTab);
    const source: Command[] =
      mode === "files"
        ? files.map((f) => ({ id: f, label: root ? f.slice(root.length + 1) : f, run: () => actions.navigate(f) }))
        : mode === "symbols" && tab
          ? definitions(tab.text).map((d) => ({
              id: `${d.offset}`,
              label: d.name,
              keys: d.kind,
              run: () => actions.navigate(tab.path, d.offset),
            }))
          : commands(openNew);
    return source
      .map((c) => ({ c, score: fuzzyScore(query, c.label) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score! - a.score!)
      .slice(0, 60)
      .map((x) => x.c);
  }, [mode, files, query]);

  if (!mode) return null;
  const close = () => set({ palette: null });
  // Run after the key event finishes, or the Enter that chose a command
  // lands in the editor the command focuses.
  const run = (c?: Command) => {
    if (!c) return;
    close();
    setTimeout(c.run, 0);
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={mode === "files" ? "Go to file…" : mode === "symbols" ? "Go to definition in file…" : "Type a command…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") (e.preventDefault(), setSelected((i) => Math.min(items.length - 1, i + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSelected((i) => Math.max(0, i - 1)));
            else if (e.key === "Enter") (e.preventDefault(), run(items[selected]));
          }}
        />
        <div className="items">
          {items.map((c, i) => (
            <div
              key={c.id}
              className={`item ${i === selected ? "selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(c)}
            >
              <span className="label">{c.label}</span>
              {c.keys && <span className="kbd">{c.keys}</span>}
            </div>
          ))}
          {items.length === 0 && <div className="item sub">No matches</div>}
        </div>
      </div>
    </div>
  );
}
