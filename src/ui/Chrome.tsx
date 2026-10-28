import { useEffect, useState } from "react";
import * as actions from "../actions";
import { openExternal, pickFile, pickFolder, recentProjects } from "../platform";
import type { NewDeps } from "../protocol/NewDeps";
import type { NewLanguage } from "../protocol/NewLanguage";
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
      {status.project ? <ProjectMenu name={status.project.name} root={status.project.root} /> : (
        <span className="project-name" data-tauri-drag-region>
          ZParen
        </span>
      )}
      <button
        className="status-pill"
        title={status.session.state === "failed" || status.session.state === "exited" ? status.session.message : "Restart Lisp"}
        onClick={actions.restartSession}
      >
        <span className={`dot ${state === "exited" ? "failed" : state}`} />
        {state === "ready" ? (status.session.image ? "SBCL · image" : "SBCL") : state === "starting" ? "Starting…" : state === "failed" ? "Failed" : state === "exited" ? "Exited" : "Stopped"}
      </button>
      {status.project && <ImageChip />}
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

/** Says when the project has no startup image or an old one, and saves one on a click. */
function ImageChip() {
  const image = useStore((s) => s.image);
  const saving = useStore((s) => s.tasks["save startup image"]?.running ?? false);
  const systems = useStore((s) => s.systems);
  if (saving) return <span className="image-chip" data-testid="image-chip">Saving image…</span>;
  if (image === undefined || (image && !image.stale) || systems.length === 0) return null;
  const why = image
    ? `${image.stale} ${image.used ? "Lisp still starts from it, then compiles what changed." : "Lisp starts without it."} Click to save it again.`
    : "Lisp starts without the project's systems and loads them after it starts. Click to save an image with them loaded.";
  return (
    <button className={`image-chip ${image ? "old" : ""}`} data-testid="image-chip" title={why} onClick={() => void actions.saveImage(actions.imageSystems())}>
      {image ? "Image old" : "No image"}
    </button>
  );
}

/** The project's name in the title bar, opening the project choices: as File's, with recent projects. */
function ProjectMenu({ name, root }: { name: string; root: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && e.target instanceof Element && e.target.closest(".project-menu")) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
    };
  }, [open]);
  const choose = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  const others = recentProjects().filter((r) => r !== root);
  return (
    <div className="project-menu">
      <button className="project-name" title={root} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name}
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={choose(() => set({ newProject: true }))}>
            New Project… <span className="kbd">⇧⌘N</span>
          </button>
          <button role="menuitem" onClick={choose(() => void actions.requestOpenProject())}>
            Open Project… <span className="kbd">⌘O</span>
          </button>
          {others.length > 0 && <div className="menu-label">Recent</div>}
          {others.map((r) => (
            <button key={r} role="menuitem" title={r} onClick={choose(() => void actions.requestOpenProject(r))}>
              {r.split("/").pop()}
              <span className="menu-path">{r.replace(/\/[^/]+$/, "")}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <button role="menuitem" onClick={choose(() => void actions.closeProject())}>
            Close Project
          </button>
        </div>
      )}
    </div>
  );
}

/** The drag payload of a tab: which file, from which pane. */
const TAB_DRAG = "application/x-zparen-tab";

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
            title={actions.readOnlyFile(path) ? `${path}\nRead-only: outside the project` : path}
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
            {actions.readOnlyFile(path) && (
              <span className="tab-lock" aria-label="read-only">
                <Icon name="lock" size={11} />
              </span>
            )}
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

/** A field for a name or a path, which macOS must leave as typed. */
const PLAIN = { autoCapitalize: "off", autoCorrect: "off", autoComplete: "off", spellCheck: false } as const;

const DEPS_HINT: Record<NewDeps, string> = {
  quicklisp: "Dependencies come from Quicklisp's dists as systems load.",
  ocicl: "Each dependency's exact version is pinned in ocicl.csv, and ocicl fetches it from its registry.",
};

const LANGUAGE_HINT: Record<NewLanguage, string> = {
  lisp: "Plain Common Lisp.",
  coalton: "Statically typed code in coalton-toplevel forms, with the coalton system as a dependency.",
};

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [deps, setDeps] = useState<NewDeps>("quicklisp");
  const [language, setLanguage] = useState<NewLanguage>("lisp");
  const [ocicl, setOcicl] = useState<{ ready: boolean; missing: string } | null>(null);
  const [error, setError] = useState("");
  const nameOk = /^[a-z][a-z0-9-]*$/.test(name);
  const valid = nameOk && parent && (deps !== "ocicl" || ocicl?.ready);

  useEffect(() => {
    const recent = recentProjects()[0];
    if (recent) setParent(recent.replace(/\/[^/]+\/?$/, ""));
    actions.request({ type: "newProjectChoices" }).then(
      (r) => r.type === "newProjectChoices" && setOcicl({ ready: r.ocicl, missing: r.ociclMissing }),
      () => setOcicl(null),
    );
  }, []);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form
        className="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (await actions.newProject(parent, name, deps, language)) onClose();
          } catch (err) {
            setError(String(err instanceof Error ? err.message : err));
          }
        }}
      >
        <h2>New Lisp Project</h2>
        <label>Name</label>
        {/* Names are lowercase, as ASDF systems and their folders conventionally are. */}
        <input type="text" autoFocus {...PLAIN} placeholder="my-app" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
        {name && !nameOk && <div className="dialog-hint error-hint">Use letters, digits and dashes, starting with a letter.</div>}
        <label>Location</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input type="text" {...PLAIN} value={parent} onChange={(e) => setParent(e.target.value)} placeholder="/Users/you/projects" />
          <button type="button" className="btn" onClick={async () => setParent((await pickFolder("Choose Location")) ?? parent)}>
            Choose…
          </button>
        </div>
        {!parent && <div className="dialog-hint">Choose the folder the project goes in.</div>}
        <label>Language</label>
        <div className="segmented" role="radiogroup" aria-label="Language">
          {(["lisp", "coalton"] as const).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={language === l}
              className={language === l ? "active" : ""}
              onClick={() => setLanguage(l)}
            >
              {l === "lisp" ? "Common Lisp" : "Coalton"}
            </button>
          ))}
        </div>
        <div className="dialog-hint">{LANGUAGE_HINT[language]}</div>
        <label>Dependencies</label>
        <div className="segmented" role="radiogroup" aria-label="Dependencies">
          {(["quicklisp", "ocicl"] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={deps === d}
              className={deps === d ? "active" : ""}
              onClick={() => setDeps(d)}
            >
              {d === "quicklisp" ? "Quicklisp" : "ocicl"}
            </button>
          ))}
        </div>
        <div className="dialog-hint">
          {deps === "ocicl" && ocicl && !ocicl.ready ? ocicl.missing : DEPS_HINT[deps]}
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
      <h2>ZParen needs SBCL</h2>
      <p>SBCL is the Common Lisp compiler ZParen runs your code in. This Mac does not seem to have it.</p>
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
        <h1>ZParen</h1>
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
    ["K", "Documentation popup"],
    ["⌘D", "Describe symbol"],
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
