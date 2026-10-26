import { useEffect, useMemo, useState } from "react";
import * as actions from "../actions";
import type { ProfileCall } from "../protocol/ProfileCall";
import type { TestNode } from "../protocol/TestNode";
import type { TraceEntry } from "../protocol/TraceEntry";
import { useStore } from "../store";
import { Icon } from "./Icon";

function TraceCall({ entry, kids, depth }: { entry: TraceEntry; kids: Map<number, TraceEntry[]>; depth: number }) {
  const children = kids.get(entry.id) ?? [];
  const [open, setOpen] = useState(depth < 2);
  return (
    <>
      <div className="trace-call" style={{ paddingLeft: 8 + depth * 14 }}>
        <button className={`disclosure ${children.length ? "" : "leaf"}`} onClick={() => setOpen(!open)} aria-label={open ? "Collapse" : "Expand"}>
          {children.length ? (open ? "▾" : "▸") : ""}
        </button>
        <span className="fn" title={entry.name}>
          {actions.shortName(entry.name)}
        </span>
        <span className="args">
          (
          {entry.args.map((a, i) => (
            <span key={i}>
              {i > 0 && " "}
              <span className="value" title="Inspect" onClick={() => actions.inspectTracePart(entry.id, i, false)}>
                {a}
              </span>
            </span>
          ))}
          )
        </span>
        {entry.done ? (
          <span className="returns">
            <span className="arrow">⇒</span>
            {entry.values.length === 0 && <span className="none">no values</span>}
            {entry.values.map((v, i) => (
              <span key={i} className="value" title="Inspect" onClick={() => actions.inspectTracePart(entry.id, i, true)}>
                {v}
              </span>
            ))}
          </span>
        ) : (
          <span className="returns none">running, or left without returning</span>
        )}
      </div>
      {open && children.map((c) => <TraceCall key={c.id} entry={c} kids={kids} depth={depth + 1} />)}
    </>
  );
}

export function TracePanel() {
  const { specs, total, entries } = useStore((s) => s.traces);
  useEffect(() => void actions.refreshTraces(), []);
  const { roots, kids } = useMemo(() => {
    const ids = new Set(entries.map((e) => e.id));
    const kids = new Map<number, TraceEntry[]>();
    const roots: TraceEntry[] = [];
    for (const e of entries) {
      if (e.parent !== null && ids.has(e.parent)) kids.set(e.parent, [...(kids.get(e.parent) ?? []), e]);
      else roots.push(e);
    }
    return { roots, kids };
  }, [entries]);

  return (
    <div className="tool-panel" data-testid="trace">
      <div className="tool-bar">
        {specs.length === 0 ? (
          <span className="dim">Nothing traced</span>
        ) : (
          specs.map((spec) => (
            <span key={spec} className="chip" title={spec}>
              {actions.shortName(spec)}
              <button title={`Stop tracing ${actions.shortName(spec)}`} onClick={() => actions.toggleTrace(spec, "COMMON-LISP-USER")}>
                <Icon name="x" size={9} />
              </button>
            </span>
          ))
        )}
        <span className="grow" />
        {total > 0 && (
          <span className="dim">
            {total} call{total === 1 ? "" : "s"}
            {total > entries.length ? `, latest ${entries.length} shown` : ""}
          </span>
        )}
        <button className="btn" onClick={actions.refreshTraces}>
          <Icon name="refresh" size={12} /> Refresh
        </button>
        <button className="btn" disabled={total === 0} onClick={actions.clearTraces}>
          Clear
        </button>
        <button className="btn" disabled={specs.length === 0} onClick={actions.untraceAll}>
          Untrace all
        </button>
      </div>
      <div className="tool-body">
        {entries.length === 0 ? (
          <div className="tool-empty">
            {specs.length === 0
              ? "Trace a function with ⌥⌘T on its name (,t in Vim). Each call it makes is recorded here with its arguments and what it returned."
              : "No calls yet. Run code that calls a traced function."}
          </div>
        ) : (
          roots.map((e) => <TraceCall key={e.id} entry={e} kids={kids} depth={0} />)
        )}
      </div>
    </div>
  );
}

const percent = (n: number, of: number) => (of ? (100 * n) / of : 0);
const pct = (n: number, of: number) => `${percent(n, of).toFixed(1)}%`;

type CallListProps = { title: string; none: string; calls: ProfileCall[]; samples: number; onPick: (name: string) => void };

function CallList({ title, none, calls, samples, onPick }: CallListProps) {
  return (
    <div className="calls">
      <div className="calls-title">{title}</div>
      {calls.length === 0 && <div className="dim">{none}</div>}
      {calls.slice(0, 12).map((c) => (
        <div key={c.name} className="call" onClick={() => onPick(c.name)}>
          <span className="num">{pct(c.samples, samples)}</span>
          <span className="fn">{c.name}</span>
        </div>
      ))}
    </div>
  );
}

export function ProfilePanel() {
  const profile = useStore((s) => s.profile);
  const profiling = useStore((s) => s.profiling);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [profile]);
  const samples = profile?.samples ?? 0;
  const row = profile?.rows.find((r) => r.name === selected) ?? null;
  const goTo = (name: string) => actions.showDefinition(name, "COMMON-LISP-USER");

  return (
    <div className="tool-panel" data-testid="profile">
      <div className="tool-bar">
        {profiling === "form" ? (
          <span className="dim">Profiling…</span>
        ) : profiling === "all" ? (
          <span className="recording">Sampling every thread</span>
        ) : profile ? (
          <span className="summary">
            {profile.label && <code>{profile.label}</code>}
            <span className="dim">
              {samples} sample{samples === 1 ? "" : "s"}
              {profile.seconds !== null && ` in ${profile.seconds.toFixed(2)} s`}
            </span>
            {profile.value !== null && <span className="dim">⇒ {profile.value}</span>}
          </span>
        ) : (
          <span className="dim">No profile yet</span>
        )}
        <span className="grow" />
        {profiling === "all" ? (
          <button className="btn primary" onClick={actions.stopProfiling}>
            <Icon name="stop" size={11} /> Stop and report
          </button>
        ) : (
          <button className="btn" disabled={profiling !== null} title="Sample every thread until you stop, for servers and background work" onClick={actions.startProfiling}>
            <Icon name="play" size={11} /> Start profiling
          </button>
        )}
      </div>
      {!profile || profile.rows.length === 0 ? (
        <div className="tool-body">
          <div className="tool-empty">
            {profile
              ? "The profiler took no samples in your code. Profile something that runs longer, such as a loop around the call."
              : "Profile a form with ⌥⌘P (,p in Vim): it runs under SBCL's statistical profiler, and the functions it spent its time in are listed here."}
          </div>
        </div>
      ) : (
        <div className="profile">
          <div className="tool-body">
            {samples < 50 && (
              <div className="tool-note">Only {samples} samples, so these shares are rough. A longer run gives steadier numbers.</div>
            )}
            <table className="profile-table">
              <thead>
                <tr>
                  <th>Total</th>
                  <th>Self</th>
                  <th>Function</th>
                </tr>
              </thead>
              <tbody>
                {profile.rows.map((r) => (
                  <tr
                    key={r.name}
                    className={r.name === selected ? "selected" : ""}
                    onClick={() => setSelected(r.name)}
                    onDoubleClick={() => goTo(r.name)}
                  >
                    <td className="num">
                      <span className="bar" style={{ width: `${percent(r.total, samples)}%` }} />
                      <span>{pct(r.total, samples)}</span>
                    </td>
                    <td className="num">{pct(r.own, samples)}</td>
                    <td className="fn">{r.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {row && (
            <div className="profile-detail">
              <div className="detail-head">
                <span className="fn">{row.name}</span>
                <button className="btn" onClick={() => goTo(row.name)}>
                  Go to source
                </button>
              </div>
              <CallList title="Called from" none="Only the profiled form" calls={row.callers} samples={samples} onPick={setSelected} />
              <CallList title="Calls" none="Nothing sampled" calls={row.callees} samples={samples} onPick={setSelected} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_MARK = { passed: "✓", failed: "✕", skipped: "–" } as const;

function TestRow({ node, depth, failuresOnly }: { node: TestNode; depth: number; failuresOnly: boolean }) {
  const [open, setOpen] = useState(node.status === "failed" || node.kind === "suite");
  const children = failuresOnly ? node.children.filter((c) => c.status !== "passed") : node.children;
  if (node.kind === "check") {
    return (
      <div className={`test-check ${node.status}`} style={{ paddingLeft: 26 + depth * 16 }}>
        <code>{node.name}</code>
        {node.message && <div className="message">{node.message}</div>}
      </div>
    );
  }
  return (
    <>
      <div className={`test-row ${node.kind}`} style={{ paddingLeft: 8 + depth * 16 }}>
        <button className={`disclosure ${children.length ? "" : "leaf"}`} onClick={() => setOpen(!open)} aria-label={open ? "Collapse" : "Expand"}>
          {children.length ? (open ? "▾" : "▸") : ""}
        </button>
        <span className={`mark ${node.status}`} aria-label={node.status}>
          {STATUS_MARK[node.status]}
        </span>
        <button className="name" title={`Go to ${node.name}`} onClick={() => actions.goToTest(node)}>
          {node.name}
        </button>
        {node.id && (
          <button className="run" title={`Run ${node.name} again`} onClick={() => actions.rerunTests([node])}>
            <Icon name="play" size={10} />
          </button>
        )}
      </div>
      {open && children.map((c, i) => <TestRow key={`${c.name}-${i}`} node={c} depth={depth + 1} failuresOnly={failuresOnly} />)}
    </>
  );
}

export function TestsPanel() {
  const tests = useStore((s) => s.tests);
  const testing = useStore((s) => s.testing);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const run = tests?.run;
  const failed = run ? actions.failedTests(run.tests) : [];
  const roots = run ? (failuresOnly ? run.tests.filter((t) => t.status !== "passed") : run.tests) : [];

  return (
    <div className="tool-panel" data-testid="tests">
      <div className="tool-bar">
        {testing ? (
          <span className="dim">Testing {testing}…</span>
        ) : run ? (
          <span className="summary">
            <span className="count passed">{run.passed} passed</span>
            {run.failed > 0 && <span className="count failed">{run.failed} failed</span>}
            {run.skipped > 0 && <span className="count">{run.skipped} skipped</span>}
            <span className="dim">
              {tests!.system} · {run.seconds.toFixed(2)} s{run.frameworks.length ? ` · ${run.frameworks.join(", ")}` : ""}
            </span>
          </span>
        ) : (
          <span className="dim">No test run yet</span>
        )}
        <span className="grow" />
        <label className="check-label">
          <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} /> Failures only
        </label>
        <button className="btn" disabled={!failed.length || testing !== null} onClick={() => actions.rerunTests(failed)}>
          Rerun failed
        </button>
        <button className="btn" disabled={!tests || testing !== null} onClick={() => tests && actions.testSystem(tests.system)}>
          <Icon name="refresh" size={12} /> Run again
        </button>
      </div>
      <div className="tool-body">
        {!run ? (
          <div className="tool-empty">Test a system from the sidebar or the command palette. FiveAM, Parachute and Rove results appear here as a tree.</div>
        ) : run.tests.length === 0 ? (
          <div className="tool-empty">
            The test run finished without FiveAM, Parachute or Rove results. Its output is in the REPL.
          </div>
        ) : (
          roots.map((n, i) => <TestRow key={`${n.name}-${i}`} node={n} depth={0} failuresOnly={failuresOnly} />)
        )}
      </div>
    </div>
  );
}
