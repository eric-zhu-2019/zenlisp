import { useLayoutEffect, useRef, useState } from "react";
import * as actions from "../actions";
import { activeDebugger, set, useStore } from "../store";
import { Chat } from "./Chat";
import { DebuggerPanel } from "./Debugger";
import { DocsPanel } from "./Docs";
import { Icon } from "./Icon";
import { EdgeHandle } from "./EdgeHandle";
import { RIGHT_WIDTH, updateSettings, useSettings } from "../settings";
import { Repl } from "./Repl";
import { ProfilePanel, TestsPanel, TracePanel } from "./Tools";

export function Inspector() {
  const page = useStore((s) => s.inspector);
  return (
    <>
      <div className="right-header">
        <button className="icon-btn" title="Back" onClick={actions.inspectorBack}>
          <Icon name="back" />
        </button>
        <button className="icon-btn" title="Forward" onClick={actions.inspectorForward}>
          <Icon name="forward" />
        </button>
        <button className="icon-btn" title="Refresh" onClick={actions.inspectorRefresh}>
          <Icon name="refresh" />
        </button>
        <span className="title">Inspector</span>
        <button className="icon-btn" title="Close" onClick={() => set({ right: null })}>
          <Icon name="x" size={12} />
        </button>
      </div>
      {!page ? (
        <div className="empty" style={{ padding: 20 }}>
          <div>Click a REPL result, a local in the debugger, or press ⌘I on a symbol to inspect it.</div>
        </div>
      ) : (
        <>
          <div className="inspector-title" data-testid="inspector-title">
            {page.title}
          </div>
          <div className="inspector-body" data-testid="inspector-body">
            {page.parts.map((p, i) =>
              p.kind === "text" ? (
                <span key={i}>{p.text}</span>
              ) : p.kind === "value" ? (
                <span key={i} className="value" onClick={() => actions.inspectPart(p.index)}>
                  {p.text}
                </span>
              ) : (
                <span key={i} className="action" onClick={() => actions.inspectorAction(p.index)}>
                  {p.text}
                </span>
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}

export function RightPanel() {
  const right = useStore((s) => s.right);
  const rightWidth = useSettings((s) => s.rightWidth);
  if (!right) return null;
  return (
    <div className="right">
      <EdgeHandle
        side="left"
        label="Panel width"
        width={rightWidth}
        min={260}
        max={() => Math.min(900, window.innerWidth * 0.6)}
        fallback={RIGHT_WIDTH}
        onResize={(rightWidth) => updateSettings({ rightWidth })}
      />
      {right === "inspector" ? <Inspector /> : right === "docs" ? <DocsPanel /> : <Chat />}
    </div>
  );
}

function Output() {
  const tasks = useStore((s) => s.tasks);
  const active = useStore((s) => s.activeTask);
  const ref = useRef<HTMLDivElement>(null);
  const task = active ? tasks[active] : undefined;
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [task?.output]);
  return (
    <div className="output" ref={ref} data-testid="output">
      {!task && "Builds and dependency installs stream here."}
      {task && (
        <>
          <div style={{ color: "var(--text)", fontWeight: 600, marginBottom: 6 }}>
            {active} {task.running ? "· running…" : task.ok ? "· finished" : "· failed"}
          </div>
          {task.output}
        </>
      )}
    </div>
  );
}

const SEVERITY_ORDER = ["read-error", "error", "warning", "style-warning", "note", "redefinition"];

function Problems() {
  const notes = useStore((s) => s.notes);
  const root = useStore((s) => s.status.project?.root ?? "");
  const files = Object.entries(notes).filter(([, list]) => list.length > 0);
  if (files.length === 0) return <div className="output">No compiler notes. Compile a form (⇧⌘↩) or a file (⌘B) to check it.</div>;
  return (
    <div className="problems" data-testid="problems">
      {files.map(([path, list]) => (
        <div key={path}>
          <div className="problems-file">{path.startsWith(root) ? path.slice(root.length + 1) : path}</div>
          {[...list]
            .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
            .map((n, i) => (
              <div key={i} className="problem" onClick={() => actions.navigate(path, n.location?.offset ?? 0)}>
                <span className={`severity ${n.severity}`}>{n.severity.replace("-", " ")}</span>
                <span className="message">{n.message}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/** Says when Lisp died or failed to start, why, and offers to start it again. */
function SessionBanner() {
  const session = useStore((s) => s.status.session);
  const [details, setDetails] = useState(false);
  if (session.state !== "exited" && session.state !== "failed") return null;
  const [first, ...rest] = session.message.split("\n");
  return (
    <div className="session-banner" role="alert" data-testid="session-banner">
      <div className="session-banner-row">
        <strong>{session.state === "exited" ? "Lisp stopped." : "Lisp did not start."}</strong>
        <span className="session-banner-why">{first}</span>
        <span className="grow" />
        {rest.length > 0 && (
          <button className="btn" onClick={() => setDetails(!details)}>
            {details ? "Hide output" : "Show output"}
          </button>
        )}
        <button className="btn primary" onClick={actions.restartSession}>
          Restart Lisp
        </button>
      </div>
      {details && <pre className="session-banner-output">{rest.join("\n")}</pre>}
    </div>
  );
}

export function BottomPanel() {
  const bottom = useStore((s) => s.bottom);
  const dbg = useStore(activeDebugger);
  const tasks = useStore((s) => s.tasks);
  const running = Object.values(tasks).some((t) => t.running);
  const problemCount = useStore((s) => Object.values(s.notes).reduce((n, list) => n + list.length, 0));
  const traced = useStore((s) => s.traces.specs.length);
  const failedTests = useStore((s) => s.tests?.run.failed ?? 0);
  const testing = useStore((s) => s.testing !== null);
  const profiling = useStore((s) => s.profiling);
  const ready = useStore((s) => s.status.session.state === "ready");

  return (
    <div className="bottom">
      <div className="panel-tabs">
        <button className={`panel-tab ${bottom === "repl" ? "active" : ""}`} onClick={() => set({ bottom: "repl" })}>
          <Icon name="terminal" size={12} /> REPL
          {dbg && <span className="badge">{dbg.level}</span>}
        </button>
        <button className={`panel-tab ${bottom === "problems" ? "active" : ""}`} onClick={() => set({ bottom: "problems" })}>
          Problems {problemCount > 0 && <span className="count-badge">{problemCount}</span>}
        </button>
        <button className={`panel-tab ${bottom === "output" ? "active" : ""}`} onClick={() => set({ bottom: "output" })}>
          <Icon name="hammer" size={12} /> Output {running && <span className="dot starting" />}
        </button>
        <button className={`panel-tab ${bottom === "tests" ? "active" : ""}`} onClick={() => set({ bottom: "tests" })}>
          Tests {testing ? <span className="dot starting" /> : failedTests > 0 && <span className="count-badge failed">{failedTests}</span>}
        </button>
        <button className={`panel-tab ${bottom === "trace" ? "active" : ""}`} onClick={() => set({ bottom: "trace" })}>
          Trace {traced > 0 && <span className="count-badge">{traced}</span>}
        </button>
        <button className={`panel-tab ${bottom === "profile" ? "active" : ""}`} onClick={() => set({ bottom: "profile" })}>
          Profile {profiling && <span className="dot starting" />}
        </button>
        <span className="grow" />
        {bottom === "repl" && (
          <button className="icon-btn" title="New REPL, in a thread of its own" disabled={!ready} onClick={actions.newRepl}>
            <Icon name="plus" size={12} />
          </button>
        )}
        <button className="icon-btn" title="Interrupt (⌃C)" onClick={actions.interrupt}>
          <Icon name="stop" size={11} />
        </button>
        {dbg && (
          <button className="icon-btn" title="Close the debugger, returning every stopped thread to its top level" onClick={() => void actions.closeDebuggers()}>
            <Icon name="bug" size={12} />
          </button>
        )}
        <button className="icon-btn" title="Clear REPL (⌘K or ⌃L)" onClick={actions.clearRepl}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      <SessionBanner />
      <div className={`bottom-body ${bottom === "repl" && dbg ? "split" : ""}`}>
        {bottom === "repl" ? (
          <>
            <Repl />
            {dbg && <DebuggerPanel />}
          </>
        ) : bottom === "problems" ? (
          <Problems />
        ) : bottom === "tests" ? (
          <TestsPanel />
        ) : bottom === "trace" ? (
          <TracePanel />
        ) : bottom === "profile" ? (
          <ProfilePanel />
        ) : (
          <Output />
        )}
      </div>
    </div>
  );
}

export function StatusBar() {
  const status = useStore((s) => s.status.session);
  const hint = useStore((s) => s.hint);
  const vimMode = useStore((s) => s.vimMode);
  const chord = useStore((s) => s.chord);
  const flashed = useStore((s) => s.flash);
  const pi = useStore((s) => s.parinfer);
  const vimOn = useSettings((s) => s.vim);
  const editing = useStore((s) => s.activeTab !== null);
  const parinferOn = useSettings((s) => s.parinfer);

  const hintView = hint && (
    <span className="hint" title={hint.text}>
      {hint.active ? (
        <>
          {hint.text.slice(0, hint.active.start)}
          <span className="active">{hint.text.slice(hint.active.start, hint.active.end)}</span>
          {hint.text.slice(hint.active.end)}
        </>
      ) : (
        hint.text
      )}
    </span>
  );

  return (
    <footer className="statusbar">
      {vimOn && editing && <span className={`mode ${vimMode.startsWith("insert") ? "insert" : ""}`}>{vimMode}</span>}
      {parinferOn && editing && pi && (
        <span title={pi.error ?? "Parinfer is keeping parens balanced"} style={{ color: pi.error ? "var(--danger)" : undefined }}>
          parinfer {pi.mode}
          {pi.error ? ` · ${pi.error}` : ""}
        </span>
      )}
      {chord ? (
        <span className="hint chord" data-testid="chord">
          {chord}
        </span>
      ) : flashed ? (
        <span className={`hint flash ${flashed.tone}`} data-testid="flash">
          {flashed.text}
        </span>
      ) : (
        (hintView ?? <span className="hint" />)
      )}
      <span>
        {status.state === "ready"
          ? `SBCL ${status.version}`
          : status.state === "failed"
            ? "Lisp failed to start"
            : status.state === "exited"
              ? "Lisp stopped"
              : status.state === "starting"
                ? "Starting Lisp…"
                : "Lisp is not running"}
      </span>
    </footer>
  );
}
