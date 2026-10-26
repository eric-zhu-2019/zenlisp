import { useEffect, useRef, useState } from "react";
import * as actions from "./actions";
import { Editor } from "./editor/Editor";
import { fontStack } from "./fonts";
import { emacsKeyHandler, handleWindowKey } from "./keys";
import { useSettings } from "./settings";
import { set, useStore } from "./store";
import { allThemes, applyTheme, readThemeFiles, themeFor, useThemes } from "./themes";
import { EditorEmpty, isTabDrag, NewProjectDialog, readTabDrag, Tabs, TitleBar, Welcome } from "./ui/Chrome";
import { ConflictBanner, DialogHost } from "./ui/Dialog";
import { HelpScreen } from "./ui/Help";
import { Tour } from "./ui/Tour";
import { isMarkdown, MarkdownPreview } from "./ui/MarkdownPreview";
import { SettingsScreen } from "./ui/Settings";
import { Palette } from "./ui/Palette";
import { BottomPanel, RightPanel, StatusBar } from "./ui/Panels";
import { Sidebar } from "./ui/Sidebar";

function useGlobalShortcuts() {
  useEffect(() => {
    // Emacs sequences first, so a key typed after a prefix such as C-x belongs to it.
    const emacs = emacsKeyHandler();
    window.addEventListener("keydown", emacs, true);
    window.addEventListener("keydown", handleWindowKey, true);
    return () => {
      window.removeEventListener("keydown", emacs, true);
      window.removeEventListener("keydown", handleWindowKey, true);
    };
  }, []);
}

function setFont(variable: string, stack: string | null) {
  if (stack) document.documentElement.style.setProperty(variable, stack);
  else document.documentElement.style.removeProperty(variable);
}

function useAppearance() {
  const theme = useSettings((s) => s.theme);
  const lightTheme = useSettings((s) => s.lightTheme);
  const darkTheme = useSettings((s) => s.darkTheme);
  const userThemes = useThemes((s) => s.user);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const fontSize = useSettings((s) => s.fontSize);
  const editorFont = useSettings((s) => s.editorFont);
  const uiFont = useSettings((s) => s.uiFont);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    void actions.request({ type: "themes" }).then((r) => r.type === "themes" && readThemeFiles(r.dir, r.files));
  }, []);
  useEffect(() => {
    const kind = theme === "system" ? (systemDark ? "dark" : "light") : theme;
    applyTheme(themeFor(kind, kind === "dark" ? darkTheme : lightTheme, allThemes(userThemes)));
  }, [theme, systemDark, lightTheme, darkTheme, userThemes]);
  useEffect(() => {
    document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  }, [fontSize]);
  useEffect(() => setFont("--mono", fontStack(editorFont, "monospace")), [editorFont]);
  useEffect(() => setFont("--sans", fontStack(uiFont, "sans-serif")), [uiFont]);
}

function useSplitter() {
  const [height, setHeight] = useState(300);
  const drag = useRef<{ y: number; h: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) setHeight(Math.max(120, Math.min(window.innerHeight - 200, drag.current.h + drag.current.y - e.clientY)));
    };
    const up = () => (drag.current = null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);
  return { height, start: (e: React.MouseEvent) => (drag.current = { y: e.clientY, h: height }) };
}

/** One editor pane, or two side by side; a tab dropped on the right half of a lone pane splits it. */
function EditorPanes({ hasTabs }: { hasTabs: boolean }) {
  const count = useStore((s) => s.panes.length);
  const focused = useStore((s) => s.focusedPane);
  const panes = useStore((s) => s.panes);
  const previews = useStore((s) => s.previews);
  const empty = panes.map((p) => p.tabs.length === 0);
  const [splitting, setSplitting] = useState(false);
  return (
    <div className={`panes ${count > 1 ? "two" : ""}`}>
      {Array.from({ length: count }, (_, i) => (
        <section key={i} className={`pane ${count > 1 && focused === i ? "focused" : ""}`} data-testid={`pane-${i}`}>
          <Tabs pane={i} />
          <div
            className="editor-area"
            onDragOver={(e) => {
              if (!isTabDrag(e)) return;
              e.preventDefault();
              const box = e.currentTarget.getBoundingClientRect();
              setSplitting(count === 1 && e.clientX > box.left + box.width / 2);
            }}
            onDragLeave={() => setSplitting(false)}
            onDrop={(e) => {
              const from = readTabDrag(e);
              const split = splitting;
              setSplitting(false);
              if (!from) return;
              e.preventDefault();
              const target = split ? 1 : i;
              if (target === from.pane) return;
              // A lone file dragged to split shows in both panes, rather than leaving the first empty.
              const alone = useStore.getState().panes[from.pane].tabs.length === 1;
              if (split && alone) actions.splitEditor();
              else actions.moveTab(from.path, from.pane, target);
            }}
          >
            {focused === i && <ConflictBanner />}
            <Editor pane={i} />
            {isMarkdown(panes[i].active) && (
              <>
                {previews.includes(panes[i].active!) && <MarkdownPreview path={panes[i].active!} />}
                <button className="btn md-toggle" title="Show it rendered, or as text (⇧⌘V)" onClick={() => actions.togglePreview(panes[i].active!)}>
                  {previews.includes(panes[i].active!) ? "Edit" : "Preview"}
                </button>
              </>
            )}
            {(!hasTabs || empty[i]) && (
              <div style={{ position: "absolute", inset: 0, background: "var(--bg-editor)" }}>
                <EditorEmpty />
              </div>
            )}
            {splitting && i === 0 && <div className="split-drop" aria-hidden />}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function App() {
  const project = useStore((s) => s.status.project);
  const statusKnown = useStore((s) => s.statusKnown);
  const hasTabs = useStore((s) => s.tabs.length > 0);
  const newOpen = useStore((s) => s.newProject);
  const openNew = () => set({ newProject: true });
  const split = useSplitter();
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
  const rightWidth = useSettings((s) => s.rightWidth);
  useGlobalShortcuts();
  useAppearance();

  useEffect(() => {
    actions.refreshStatus().catch(() => set({ statusKnown: true }));
  }, []);

  return (
    <div className="app">
      <TitleBar />
      {project ? (
        <div className="workspace" style={{ "--sidebar-w": `${sidebarWidth}px`, "--right-w": `${rightWidth}px` } as React.CSSProperties}>
          <Sidebar />
          <main className="center" style={{ "--bottom-h": `${split.height}px` } as React.CSSProperties}>
            <EditorPanes hasTabs={hasTabs} />
            <div className="splitter" onMouseDown={split.start} />
            <BottomPanel />
          </main>
          <RightPanel />
        </div>
      ) : statusKnown ? (
        <Welcome onNew={openNew} />
      ) : (
        <div />
      )}
      <StatusBar />
      <Palette openNew={openNew} />
      {newOpen && <NewProjectDialog onClose={() => set({ newProject: false })} />}
      <HelpScreen />
      <Tour />
      <SettingsScreen />
      <DialogHost />
    </div>
  );
}
