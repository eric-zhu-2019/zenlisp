import { useEffect, useState } from "react";
import * as actions from "../actions";
import type { Dependency } from "../protocol/Dependency";
import { useStore } from "../store";
import { DependencyPicker } from "./Dependencies";
import { Icon } from "./Icon";

const SOURCE: Record<Dependency["source"], string> = {
  ocicl: "ocicl",
  quicklisp: "Quicklisp",
  local: "local",
  missing: "missing",
};

function state(d: Dependency) {
  if (d.source === "missing") return "Nothing provides it yet; Load fetches it if the manager can";
  if (d.loaded) return "Loaded";
  return d.installed ? "Installed, not loaded" : "Not downloaded yet";
}

/** The versions ocicl offers for one dependency, fetched when opened. */
function VersionMenu({ dep, onClose }: { dep: Dependency; onClose: () => void }) {
  const [versions, setVersions] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    actions.dependencyVersions(dep.name).then(setVersions, (e) => setError(String(e?.message ?? e)));
  }, [dep.name]);
  return (
    <div className="pkg-versions" role="menu" aria-label={`Versions of ${dep.name}`}>
      {error ? (
        <div className="pkg-note">{error}</div>
      ) : versions === null ? (
        <div className="pkg-note">Asking ocicl…</div>
      ) : versions.length === 0 ? (
        <div className="pkg-note">ocicl lists no versions.</div>
      ) : (
        versions.map((v) => (
          <button
            key={v}
            role="menuitem"
            className={v === dep.version ? "current" : ""}
            onClick={() => {
              onClose();
              if (v !== dep.version) void actions.pinDependency(dep.name, v);
            }}
          >
            {v}
            {v === dep.version && <span className="pkg-note">pinned</span>}
          </button>
        ))
      )}
    </div>
  );
}

/** The project's dependencies: where each comes from, in which version, and what to do with it. */
export function PackagesPanel() {
  const project = useStore((s) => s.status.project);
  const systems = useStore((s) => s.systems);
  const deps = useStore((s) => s.deps);
  const [target, setTarget] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [versions, setVersions] = useState<string | null>(null);
  if (!project) return null;
  const pins = project.managers.some((m) => m.kind === "ocicl");
  // New dependencies go to the main system unless another is chosen; test systems are the rest.
  const main = systems.find((s) => s.name === project.name) ?? systems[0];
  const system = systems.find((s) => s.name === target) ?? main;
  const usedBy = (name: string) => systems.filter((s) => s.dependsOn.includes(name)).map((s) => s.name);

  return (
    <div className="packages" data-testid="packages">
      <div className="packages-bar">
        {systems.length > 1 && (
          <select className="select" aria-label="Add to system" value={system?.name} onChange={(e) => setTarget(e.target.value)}>
            {systems.map((s) => (
              <option key={s.name}>{s.name}</option>
            ))}
          </select>
        )}
        <button className="btn" disabled={!system} onClick={() => setAdding(true)}>
          <Icon name="plus" size={11} /> Add
        </button>
        <span className="grow" />
        <button
          className="icon-btn"
          title={actions.updatesOne() ? "Update every dependency to its latest release" : "Update the Quicklisp dists"}
          onClick={() => void actions.updateDeps()}
        >
          <Icon name="upgrade" size={12} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void actions.refreshSystems()}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {adding && system && <DependencyPicker system={system} onClose={() => setAdding(false)} />}
      {deps.length === 0 ? (
        <div className="packages-empty">No dependencies yet. Add one, and {pins ? "ocicl pins its version in ocicl.csv" : "Quicklisp fetches it as it loads"}.</div>
      ) : (
        <ul className="packages-list">
          {deps.map((d) => {
            const users = usedBy(d.name);
            return (
              <li key={d.name} className="pkg" data-testid={`dep-${d.name}`}>
                <div className="pkg-line">
                  <span className={`dot ${d.loaded ? "ready" : d.source === "missing" ? "failed" : ""}`} title={state(d)} />
                  <span className="pkg-name">{d.name}</span>
                  <span className="pkg-version" title={state(d)}>
                    {d.version || "—"}
                  </span>
                  <span className={`pkg-source ${d.source}`}>{SOURCE[d.source]}</span>
                  <span className="pkg-actions">
                    {(d.source === "ocicl" || actions.updatesOne()) && (
                      <button className="icon-btn" title={`Update ${d.name} to its latest release`} onClick={() => void actions.updateDependency(d.name)}>
                        <Icon name="upgrade" size={11} />
                      </button>
                    )}
                    {pins && (
                      <button className="icon-btn" title={`Choose the version of ${d.name}`} onClick={() => setVersions(versions === d.name ? null : d.name)}>
                        <Icon name="forward" size={11} />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      title={`Remove ${d.name}`}
                      onClick={() =>
                        actions.ask(`Remove ${d.name}?`, `It goes from ${users.join(", ")}${pins ? ", and from ocicl.csv" : ""}.`, [
                          { label: "Remove", kind: "danger", run: () => void actions.dropDependency(d.name) },
                          { label: "Cancel", run: () => {} },
                        ])
                      }
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                </div>
                {users.length > 0 && !(users.length === 1 && users[0] === main?.name) && <div className="pkg-users">used by {users.join(", ")}</div>}
                {versions === d.name && <VersionMenu dep={d} onClose={() => setVersions(null)} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
