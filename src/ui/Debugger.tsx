import { useEffect, useState } from "react";
import * as actions from "../actions";
import type { Debugger as Dbg } from "../protocol/Debugger";
import type { Local } from "../protocol/Local";
import { activeDebugger, set, threadKey, useStore } from "../store";
import { Icon } from "./Icon";

function FrameDetail({ dbg, frame }: { dbg: Dbg; frame: number }) {
  const [locals, setLocals] = useState<Local[] | null>(null);
  const [form, setForm] = useState("");
  const [out, setOut] = useState("");
  const restartable = dbg.frames.find((f) => f.index === frame)?.restartable;

  useEffect(() => {
    setLocals(null);
    actions.lisp({ op: "frameLocals", thread: dbg.thread, frame }).then((r) => {
      if (r.kind === "locals") setLocals(r.items);
    });
  }, [dbg, frame]);

  const evalInFrame = async () => {
    const r = await actions.lisp({ op: "evalInFrame", thread: dbg.thread, frame, form, package: useStore.getState().package });
    if (r.kind === "text") setOut(r.text);
  };

  return (
    <div className="frame-detail">
      {locals === null && <div style={{ color: "var(--text-faint)" }}>Loading locals…</div>}
      {locals?.length === 0 && <div style={{ color: "var(--text-faint)" }}>No locals available. Compile with (debug 3) for more.</div>}
      {locals?.map((l) => (
        <div className="local" key={l.id}>
          <span className="name">{l.name}</span>
          <span className="value" title="Inspect" onClick={() => actions.inspectFrameVar(dbg.thread, frame, l.id)}>
            {l.value}
          </span>
        </div>
      ))}
      <div className="frame-actions">
        <button className="btn" onClick={() => actions.showFrame(dbg, frame)}>
          Show source
        </button>
        <button
          className="btn"
          disabled={!restartable}
          title={restartable ? "Unwind to this frame and call it again, using current definitions" : "This frame cannot be restarted"}
          onClick={() => actions.restartFrame(dbg.thread, frame)}
        >
          <Icon name="restart" size={11} /> Restart frame
        </button>
        <button
          className="btn"
          disabled={!form.trim()}
          title="Make this frame return the value of the form below"
          onClick={() => actions.lisp({ op: "returnFromFrame", thread: dbg.thread, frame, form })}
        >
          Return value
        </button>
      </div>
      <form
        className="frame-eval"
        onSubmit={(e) => {
          e.preventDefault();
          evalInFrame();
        }}
      >
        <input placeholder="Evaluate in this frame, or a value to return…" value={form} onChange={(e) => setForm(e.target.value)} />
      </form>
      {out && <div className="frame-eval out">{out}</div>}
    </div>
  );
}

export function DebuggerPanel() {
  const dbg = useStore(activeDebugger);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => setSelected(null), [dbg]);

  useEffect(() => {
    if (!dbg) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(".cm-editor, input, textarea")) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n < dbg.restarts.length) actions.invokeRestart(dbg.thread, dbg.level, n);
      if (e.key === "q") actions.debuggerAbort(dbg.thread);
      const how = dbg.stepping && ({ s: "into", x: "over", o: "out", c: "continue" } as const)[e.key as "s"];
      if (how) actions.stepActive(how);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dbg]);

  if (!dbg) return null;

  return (
    <div className="debugger" data-testid="debugger">
      <Threads current={threadKey(dbg.thread)} />
      {dbg.stepping ? <Stepper dbg={dbg} /> : <Condition dbg={dbg} />}
      <div className="frames">
        {dbg.frames.map((f) => (
          <div key={f.index}>
            <div
              className={`frame-row ${selected === f.index ? "selected" : ""}`}
              onClick={() => setSelected(selected === f.index ? null : f.index)}
            >
              <span className="idx">{f.index}</span>
              <span className="desc">{f.description}</span>
            </div>
            {selected === f.index && <FrameDetail dbg={dbg} frame={f.index} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Every thread stopped in the debugger, so an error in a background thread is not hidden behind the REPL's. */
function Threads({ current }: { current: string }) {
  const debuggers = useStore((s) => s.debuggers);
  const keys = Object.keys(debuggers);
  if (keys.length < 2) return null;
  return (
    <div className="dbg-threads" data-testid="debugger-threads">
      {keys.map((key) => {
        const top = debuggers[key][debuggers[key].length - 1];
        const t = top.thread;
        return (
          <button key={key} className={`dbg-thread ${key === current ? "active" : ""}`} onClick={() => set({ lastDebugThread: key })}>
            <span className="tid">{typeof t === "object" && "id" in t ? `thread ${t.id}` : "repl"}</span>
            <span className="msg">{top.condition.split("\n")[0]}</span>
          </button>
        );
      })}
    </div>
  );
}

const STEPS = [
  { how: "into", icon: "stepInto", label: "Into", key: "F7" },
  { how: "over", icon: "stepOver", label: "Over", key: "F8" },
  { how: "out", icon: "stepOut", label: "Out", key: "⇧F8" },
  { how: "continue", icon: "play", label: "Continue", key: "F9" },
] as const;

function Stepper({ dbg }: { dbg: Dbg }) {
  return (
    <div className="dbg-head stepper" data-testid="stepper">
      <div className="kind">
        <Icon name="stepInto" size={12} />
        {dbg.condition.startsWith("Breakpoint at") ? "Breakpoint" : "Stepping"}
        <span style={{ flex: 1 }} />
        <button className="btn" title="Stop stepping and abort (q)" onClick={() => actions.debuggerAbort(dbg.thread)}>
          <Icon name="stop" size={11} /> Abort
        </button>
      </div>
      <div className="cond">{dbg.condition.replace(/\s+/g, " ").replace(/ With arguments:\s*$/, "").trim()}</div>
      <div className="step-actions">
        {STEPS.map((s) => (
          <button key={s.how} className="btn" title={`${s.label} (${s.key})`} onClick={() => actions.stepActive(s.how)}>
            <Icon name={s.icon} size={12} /> {s.label} <kbd>{s.key}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}

function Condition({ dbg }: { dbg: Dbg }) {
  return (
    <>
      <div className="dbg-head">
        <div className="kind">
          <Icon name="bug" size={12} />
          {dbg.conditionType.replace(/^\s*\[Condition of type |\]\s*$/g, "")}
          <span className="badge">level {dbg.level}</span>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => actions.inspectCondition(dbg.thread)}>
            <Icon name="eye" size={12} /> Inspect
          </button>
        </div>
        <div className="cond">{dbg.condition}</div>
      </div>
      <div className="restarts">
        {dbg.restarts.map((r, i) => (
          <button key={i} className="restart" onClick={() => actions.invokeRestart(dbg.thread, dbg.level, i)} title={r.description}>
            <span className="n">{i}</span>
            <span className="name">{r.name.replace(/^\*/, "")}</span>
            <span className="desc">{r.description.replace(/SLIME('s)? /g, "")}</span>
          </button>
        ))}
      </div>
    </>
  );
}
