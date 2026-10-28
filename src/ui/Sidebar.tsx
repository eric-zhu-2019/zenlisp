import { useEffect, useRef, useState } from "react";
import * as actions from "../actions";
import type { DepManager } from "../protocol/DepManager";
import type { DirEntry } from "../protocol/DirEntry";
import type { GitState } from "../protocol/GitState";
import type { SystemInfo } from "../protocol/SystemInfo";
import { DependencyPicker } from "./Dependencies";
import { set, useStore } from "../store";
import { revealInFinder } from "../platform";
import { Icon } from "./Icon";
import { PackagesPanel } from "./Packages";
import { EdgeHandle } from "./EdgeHandle";
import { SIDEBAR_WIDTH, updateSettings, useSettings } from "../settings";
import { SearchPanel } from "./Search";

const GIT_LETTER: Record<GitState, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", conflicted: "!" };
const GIT_TITLE: Record<GitState, string> = {
  modified: "Changed since the last commit",
  added: "Added to the next commit",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Not in git yet",
  conflicted: "Has merge conflicts",
};

type Editing = { kind: "newFile" | "newDir"; dir: string } | { kind: "rename"; path: string };
type Menu = { x: number; y: number; entry: DirEntry | null };

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
const isLisp = (name: string) => /\.(lisp|asd|lsp|cl|ct)$/.test(name);

/** The file tree as one model: which folders are open, and what each one holds. */
function useFileTree(root: string) {
  const fsNonce = useStore((s) => s.fsNonce);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [listings, setListings] = useState<Record<string, DirEntry[]>>({});

  const list = async (dir: string) => {
    const entries = await actions.listDir(dir).catch(() => []);
    setListings((l) => ({ ...l, [dir]: entries }));
  };

  useEffect(() => {
    setExpanded(new Set());
    setListings({});
    list(root);
  }, [root]);

  useEffect(() => {
    for (const dir of [root, ...expanded]) list(dir);
  }, [fsNonce]);

  const open = (dir: string) => {
    setExpanded((e) => new Set(e).add(dir));
    list(dir);
  };
  const toggle = (dir: string) => {
    if (expanded.has(dir)) setExpanded((e) => new Set([...e].filter((d) => d !== dir)));
    else open(dir);
  };
  const refresh = () => {
    for (const dir of [root, ...expanded]) list(dir);
  };
  return { expanded, listings, open, toggle, refresh };
}

function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="tree-input"
      autoFocus
      value={value}
      onFocus={(e) => e.target.setSelectionRange(0, initial.lastIndexOf(".") > 0 ? initial.lastIndexOf(".") : initial.length)}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value.trim() || null);
        if (e.key === "Escape") finish(null);
        e.stopPropagation();
      }}
    />
  );
}

function FileTree({ root }: { root: string }) {
  const tree = useFileTree(root);
  const activeTab = useStore((s) => s.activeTab);
  const git = useStore((s) => s.gitStatus);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);

  const startCreate = (kind: "newFile" | "newDir", dir: string) => {
    if (dir !== root) tree.open(dir);
    setEditing({ kind, dir });
  };

  const finish = async (name: string | null) => {
    const e = editing;
    setEditing(null);
    if (!e || !name) return;
    try {
      if (e.kind === "rename") await actions.renamePath(e.path, `${parentOf(e.path)}/${name}`);
      else if (e.kind === "newFile") await actions.createFile(`${e.dir}/${name}`);
      else await actions.createDir(`${e.dir}/${name}`);
    } finally {
      tree.refresh();
    }
  };

  const createRow = (dir: string, depth: number) =>
    editing && editing.kind !== "rename" && editing.dir === dir ? (
      <div className="tree-row" style={{ paddingLeft: 6 + depth * 14 }}>
        <span className="chev" />
        <span className="file-icon">
          <Icon name={editing.kind === "newDir" ? "folder" : "file"} size={13} />
        </span>
        <NameInput initial={editing.kind === "newDir" ? "" : ".lisp"} onDone={finish} />
      </div>
    ) : null;

  const gitOf = (entry: DirEntry): GitState | undefined => {
    if (!entry.isDir) return git[entry.path];
    const inside = `${entry.path}/`;
    return Object.keys(git).some((p) => p.startsWith(inside)) ? "modified" : undefined;
  };

  const rows = (dir: string, depth: number): React.ReactNode[] =>
    (tree.listings[dir] ?? []).flatMap((entry) => {
      const open = entry.isDir && tree.expanded.has(entry.path);
      const renaming = editing?.kind === "rename" && editing.path === entry.path;
      const row = (
        <div
          key={entry.path}
          className={`tree-row ${activeTab === entry.path ? "active" : ""} ${isLisp(entry.name) ? "lisp" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.path}
          onClick={() => (entry.isDir ? tree.toggle(entry.path) : actions.openFile(entry.path))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, entry });
          }}
        >
          <span className="chev">{entry.isDir ? (open ? "▾" : "▸") : ""}</span>
          <span className="file-icon">
            <Icon name={entry.isDir ? "folder" : isLisp(entry.name) ? "lambda" : "file"} size={13} />
          </span>
          {renaming ? <NameInput initial={entry.name} onDone={finish} /> : <span className={`name git-${gitOf(entry) ?? "clean"}`}>{entry.name}</span>}
          {!renaming && gitOf(entry) && (
            <span className={`git-mark ${gitOf(entry)}`} title={GIT_TITLE[gitOf(entry)!]}>
              {entry.isDir ? "•" : GIT_LETTER[gitOf(entry)!]}
            </span>
          )}
        </div>
      );
      return open ? [row, createRow(entry.path, depth + 1), ...rows(entry.path, depth + 1)] : [row];
    });

  const target = menu?.entry;
  const targetDir = target ? (target.isDir ? target.path : parentOf(target.path)) : root;

  return (
    <div className="section" style={{ flex: 1 }}>
      <div className="section-header">
        <span className="grow">Files</span>
        <button className="icon-btn" title="New file" onClick={() => startCreate("newFile", root)}>
          <Icon name="plus" size={12} />
        </button>
        <button className="icon-btn" title="New folder" onClick={() => startCreate("newDir", root)}>
          <Icon name="folder" size={12} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={tree.refresh}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <div
        className="section-body"
        style={{ flex: 1 }}
        data-testid="file-tree"
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, entry: null });
        }}
      >
        {createRow(root, 0)}
        {rows(root, 0)}
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => (setMenu(null), startCreate("newFile", targetDir))}>New File…</button>
          <button onClick={() => (setMenu(null), startCreate("newDir", targetDir))}>New Folder…</button>
          {target && (
            <>
              <hr />
              <button onClick={() => (setMenu(null), setEditing({ kind: "rename", path: target.path }))}>Rename…</button>
              <button onClick={() => (setMenu(null), revealInFinder(target.path))}>Reveal in Finder</button>
              <button onClick={() => (setMenu(null), navigator.clipboard.writeText(target.path))}>Copy Path</button>
              <hr />
              <button onClick={() => (setMenu(null), actions.trashPath(target.path, target.isDir))}>Move to Trash</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function managerDetail(m: DepManager) {
  switch (m.kind) {
    case "qlot":
      return m.installed ? `Project Quicklisp from ${m.setup}` : "qlfile found. Install dependencies to create .qlot/";
    case "ocicl":
      return "ocicl fetches missing systems into ocicl/ as they load";
    case "vendor":
      return m.dirs.join("\n");
    case "quicklisp":
      return `Quicklisp from ${m.setup}`;
  }
}

function managerLabel(m: DepManager) {
  switch (m.kind) {
    case "qlot":
      return m.installed ? "qlot" : "qlot (not installed)";
    case "ocicl":
      return "ocicl";
    case "vendor":
      return `vendor (${m.dirs.length})`;
    case "quicklisp":
      return "Quicklisp";
  }
}

export function Sidebar() {
  const project = useStore((s) => s.status.project);
  const systems = useStore((s) => s.systems);
  const sidebar = useStore((s) => s.sidebar);
  const [adding, setAdding] = useState<SystemInfo | null>(null);
  const sidebarWidth = useSettings((s) => s.sidebarWidth);
  if (!project) return <aside className="sidebar" />;

  const canInstall = project.managers.some((m) => m.kind === "qlot" || m.kind === "ocicl");
  const canUpdate = canInstall || project.managers.some((m) => m.kind === "quicklisp");

  return (
    <aside className="sidebar">
      <EdgeHandle
        side="right"
        label="Sidebar width"
        width={sidebarWidth}
        min={180}
        max={() => Math.min(640, window.innerWidth * 0.45)}
        fallback={SIDEBAR_WIDTH}
        onResize={(sidebarWidth) => updateSettings({ sidebarWidth })}
      />
      <div className="sidebar-modes">
        <button className={sidebar === "files" ? "on" : ""} onClick={() => set({ sidebar: "files" })}>
          Files
        </button>
        <button className={sidebar === "search" ? "on" : ""} title="Search project (⇧⌘F)" onClick={() => set({ sidebar: "search" })}>
          Search
        </button>
        <button className={sidebar === "packages" ? "on" : ""} title="Dependencies of the project's systems" onClick={() => set({ sidebar: "packages" })}>
          Packages
        </button>
      </div>
      {sidebar === "files" ? <FileTree root={project.root} /> : sidebar === "search" ? <SearchPanel /> : <PackagesPanel />}
      <div className="section" style={{ maxHeight: "45%", borderTop: "1px solid var(--border)" }}>
        <div className="section-header">
          <span className="grow">Systems</span>
          {canInstall && (
            <button className="icon-btn" title="Install dependencies" onClick={actions.installDeps}>
              <Icon name="download" size={12} />
            </button>
          )}
          {canUpdate && (
            <button className="icon-btn" title="Update dependencies to their latest releases" onClick={actions.updateDeps}>
              <Icon name="upgrade" size={12} />
            </button>
          )}
          <button className="icon-btn" title="Rescan systems" onClick={actions.refreshSystems}>
            <Icon name="refresh" size={12} />
          </button>
        </div>
        <div className="managers">
          {project.managers.map((m) => (
            <span className="chip" key={m.kind} title={managerDetail(m)}>
              {managerLabel(m)}
            </span>
          ))}
        </div>
        <div className="section-body">
          {systems.length === 0 && <div className="tree-row" style={{ color: "var(--text-faint)" }}>No .asd systems found</div>}
          {systems.map((s) => (
            <div className="system" key={s.name}>
              <div className="name">
                {s.loaded && <span className="loaded-dot" title="Loaded" />}
                {s.name}
              </div>
              {s.description && s.description !== s.name && <div className="meta">{s.description}</div>}
              <div className="deps" aria-label={`${s.name} depends on`}>
                {s.dependsOn.map((d) => (
                  <span className="dep" key={d}>
                    {d}
                    <button title={`Remove ${d} from ${s.name}'s dependencies`} onClick={() => actions.removeDependency(s, d)}>
                      <Icon name="x" size={8} />
                    </button>
                  </span>
                ))}
                <button className="dep add" title={`Add a dependency to ${s.name}`} onClick={() => setAdding(s)}>
                  <Icon name="plus" size={9} /> dependency
                </button>
              </div>
              <div className="actions">
                {s.entryPoint && (
                  <button className="btn" title={`Load ${s.name} and call ${s.entryPoint} in the REPL`} onClick={() => actions.runSystem(s)}>
                    <Icon name="play" size={11} /> Run
                  </button>
                )}
                <button className="btn" onClick={() => actions.loadSystem(s.name).then(() => setTimeout(actions.refreshSystems, 500))}>
                  <Icon name="download" size={11} /> Load
                </button>
                <button className="btn" onClick={() => actions.testSystem(s.name)}>
                  <Icon name="check" size={11} /> Test
                </button>
                <button className="btn" onClick={() => actions.buildSystem(s.name)}>
                  <Icon name="hammer" size={11} /> Build
                </button>
                <button className="btn" onClick={() => actions.openFile(s.file)} title={s.file}>
                  .asd
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {adding && <DependencyPicker system={adding} onClose={() => setAdding(null)} />}
    </aside>
  );
}
