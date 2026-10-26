import { useEffect, useState } from "react";
import * as actions from "../actions";
import { openExternal, pickFile, pickFolder, recentProjects, rememberProject } from "../platform";
import { set, useStore } from "../store";
import { Icon } from "./Icon";

export const openProjectFlow = actions.requestOpenProject;

export function TitleBar() {
  const status = useStore((s) => s.status);
  const pkg = useStore((s) => s.package);
  const packages = useStore((s) => s.packages);
  const right = useStore((s) => s.right);
  const state = status.session.state;

  return (
    <header className="titlebar" data-tauri-drag-region>
      <span className="project-name" data-tauri-drag-region>
        {status.project?.name ?? "ZenLisp"}
      </span>
      <button
        className="status-pill"
        title={status.session.state === "failed" || status.session.state === "exited" ? status.session.message : "Restart Lisp"}
        onClick={actions.restartSession}
      >
        <span className={`dot ${state === "exited" ? "failed" : state}`} />
        {state === "ready" ? (status.session.image ? "SBCL · image" : "SBCL") : state === "starting" ? "Starting…" : state === "failed" ? "Failed" : state === "exited" ? "Exited" : "Stopped"}
      </button>
      <span className="spacer" data-tauri-drag-region />
      {state === "ready" && (
        <select className="select" value={pkg} title="Current package" onChange={(e) => actions.setPackage(e.target.value)}>
          {!packages.includes(pkg) && <option value={pkg}>{pkg}</option>}
          {packages.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      )}
      <button className="btn" title="Command palette (⇧⌘P)" onClick={() => set({ palette: "commands" })}>
        <Icon name="search" size={12} /> <span className="kbd">⇧⌘P</span>
      </button>
      <button
        className={`icon-btn`}
        title="Inspector (⌥⌘I)"
        style={right === "inspector" ? { color: "var(--accent)" } : undefined}
        onClick={() => set({ right: right === "inspector" ? null : "inspector" })}
      >
        <Icon name="eye" />
      </button>
      <button
        className="icon-btn"
        title="AI assistant (⌘L)"
        style={right === "assistant" ? { color: "var(--accent)" } : undefined}
        onClick={() => set({ right: right === "assistant" ? null : "assistant" })}
      >
        <Icon name="sparkle" />
      </button>
    </header>
  );
}

/** The drag payload of a tab: which file, from which pane. */
const TAB_DRAG = "application/x-zenlisp-tab";

export function readTabDrag(e: React.DragEvent): { path: string; pane: number } | null {
  try {
    return JSON.parse(e.dataTransfer.getData(TAB_DRAG));
  } catch {
    return null;
  }
}

export const isTabDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_DRAG);

const NO_TABS: string[] = [];

/** A pane's tab strip. Tabs drag to reorder, and onto the other pane to move. */
export function Tabs({ pane }: { pane: number }) {
  const strip = useStore((s) => s.panes[pane]);
  const paths = strip?.tabs ?? NO_TABS;
  const active = useStore((s) => s.panes[pane]?.active ?? null);
  const focused = useStore((s) => s.focusedPane === pane);
  const buffers = useStore((s) => s.tabs);
  const [over, setOver] = useState<number | null>(null);
  if (paths.length === 0) return <div />;
  const drop = (e: React.DragEvent, index: number) => {
    const from = readTabDrag(e);
    setOver(null);
    if (!from) return;
    e.preventDefault();
    // Moving right within a pane, the tab's own removal shifts the target left.
    const shift = from.pane === pane && paths.indexOf(from.path) < index ? 1 : 0;
    actions.moveTab(from.path, from.pane, pane, index - shift);
  };
  return (
    <div
      className={`tabs ${focused ? "focused" : ""}`}
      data-pane={pane}
      onDragOver={(e) => isTabDrag(e) && (e.preventDefault(), setOver(paths.length))}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => drop(e, paths.length)}
    >
      {paths.map((path, i) => {
        const t = buffers.find((b) => b.path === path);
        if (!t) return null;
        return (
          <div
            key={path}
            className={`tab ${path === active ? "active" : ""} ${over === i ? "drop-before" : ""}`}
            title={path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DRAG, JSON.stringify({ path, pane }));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!isTabDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              setOver(i);
            }}
            onDrop={(e) => {
              e.stopPropagation();
              drop(e, i);
            }}
            onMouseDown={(e) => {
              if (e.button === 1) actions.requestCloseTab(path, pane);
              else actions.showTab(pane, path);
            }}
          >
            {t.name}
            <span
              className={`close ${t.text !== t.saved ? "is-dirty" : ""}`}
              title={t.text !== t.saved ? "Unsaved changes" : "Close"}
              onMouseDown={(e) => {
                e.stopPropagation();
                actions.requestCloseTab(path, pane);
              }}
            >
              <span className="dirty" />
              <span className="x">×</span>
            </span>
          </div>
        );
      })}
      {over === paths.length && <div className="tab-drop-end" />}
    </div>
  );
}

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [error, setError] = useState("");
  const valid = /^[a-z][a-z0-9-]*$/.test(name) && parent;

  useEffect(() => {
    const recent = recentProjects()[0];
    if (recent) setParent(recent.replace(/\/[^/]+\/?$/, ""));
  }, []);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await actions.newProject(parent, name);
            rememberProject(`${parent}/${name}`);
            onClose();
          } catch (err) {
            setError(String(err instanceof Error ? err.message : err));
          }
        }}
      >
        <h2>New Lisp Project</h2>
        <label>Name</label>
        <input type="text" autoFocus placeholder="my-app" value={name} onChange={(e) => setName(e.target.value)} />
        <label>Location</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input type="text" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="/Users/you/projects" />
          <button type="button" className="btn" onClick={async () => setParent((await pickFolder("Choose Location")) ?? parent)}>
            Choose…
          </button>
        </div>
        <div style={{ color: "var(--text-dim)", fontSize: 12, marginTop: 10 }}>
          Creates an ASDF system with src/, a test system, and an executable build target.
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!valid}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Shown before anything else when no SBCL can be found, with the ways to get one.
 * It checks again after an install, and when the window comes back to the front.
 */
function NeedSbcl({ onFound }: { onFound: () => void }) {
  const installing = useStore((s) => s.tasks["install sbcl"]);
  const [error, setError] = useState("");
  const done = installing && !installing.running;
  useEffect(() => {
    if (done) onFound();
  }, [done]);
  return (
    <div className="need-sbcl" data-testid="need-sbcl">
      <h2>ZenLisp needs SBCL</h2>
      <p>SBCL is the Common Lisp compiler ZenLisp runs your code in. This Mac does not seem to have it.</p>
      <div className="actions">
        <button
          className="btn primary"
          disabled={installing?.running}
          onClick={() => {
            setError("");
            actions.request({ type: "installSbcl" }).then(
              () => set((s) => ({ tasks: { ...s.tasks, "install sbcl": { output: "", running: true, ok: null } } })),
              (e) => setError(String(e?.message ?? e)),
            );
          }}
        >
          {installing?.running ? "Installing with Homebrew…" : "Install with Homebrew"}
        </button>
        <button
          className="btn"
          onClick={async () => {
            const path = await pickFile("Choose the sbcl program");
            if (!path) return;
            const r = await actions.request({ type: "lispOptions" });
            if (r.type === "lispOptions") await actions.request({ type: "setLispOptions", options: { ...r.options, sbcl: path } });
            onFound();
          }}
        >
          Choose sbcl…
        </button>
        <button className="btn" onClick={() => openExternal("https://www.sbcl.org/platform-table.html")}>
          Download from sbcl.org
        </button>
      </div>
      {installing && <pre className="need-sbcl-output">{installing.output.split("\n").slice(-8).join("\n")}</pre>}
      {installing?.ok === false && <div className="docs-error">Homebrew could not install SBCL. Its output is above.</div>}
      {error && <div className="docs-error">{error}</div>}
    </div>
  );
}

export function Welcome({ onNew }: { onNew: () => void }) {
  const recent = recentProjects();
  const [sbcl, setSbcl] = useState<"found" | "missing" | "unknown">("unknown");
  const check = () =>
    actions.request({ type: "lispOptions" }).then(
      (r) => r.type === "lispOptions" && setSbcl(r.sbcl ? "found" : "missing"),
      () => setSbcl("unknown"),
    );
  useEffect(() => {
    void check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  if (sbcl === "missing") {
    return (
      <div className="empty">
        <div>
          <div className="lambda">λ</div>
          <NeedSbcl onFound={check} />
        </div>
      </div>
    );
  }
  return (
    <div className="empty">
      <div>
        <div className="lambda">λ</div>
        <h1>ZenLisp</h1>
        <div>A live Common Lisp workbench on SBCL.</div>
        <div className="actions">
          <button className="btn primary" onClick={() => openProjectFlow()}>
            Open Project…
          </button>
          <button className="btn" onClick={onNew}>
            <Icon name="plus" size={12} /> New Project
          </button>
        </div>
        {recent.length > 0 && (
          <div className="recent">
            <div className="section-header" style={{ padding: "0 6px 4px" }}>
              Recent
            </div>
            {recent.map((r) => (
              <div key={r} className="tree-row" onClick={() => openProjectFlow(r)} title={r}>
                <Icon name="folder" size={13} /> {r.split("/").pop()}
                <span style={{ color: "var(--text-faint)", marginLeft: 6, overflow: "hidden", textOverflow: "ellipsis" }}>{r}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function EditorEmpty() {
  const rows: [string, string][] = [
    ["⌘↩", "Evaluate form"],
    ["⇧⌘↩", "Compile form"],
    ["⌘B", "Compile and load file"],
    ["⇧⌘M", "Macroexpand"],
    ["F12 / gd", "Go to definition"],
    ["⌘D / K", "Describe symbol"],
    ["⌘P", "Open file"],
    ["⇧⌘P", "Commands"],
  ];
  return (
    <div className="empty">
      <div>
        <div className="lambda">λ</div>
        <div className="shortcuts">
          {rows.map(([k, label]) => (
            <div key={k} style={{ display: "contents" }}>
              <span className="kbd" style={{ justifySelf: "end" }}>
                {k}
              </span>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
