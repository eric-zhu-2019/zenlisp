import { useEffect, useState } from "react";
import * as actions from "../actions";
import type { AvailableSystem } from "../protocol/AvailableSystem";
import type { SystemInfo } from "../protocol/SystemInfo";
import { useReturnFocus } from "./focus";

/** Finds a system to depend on, in Quicklisp's dists and among systems ASDF knows. */
export function DependencyPicker({ system, onClose }: { system: SystemInfo; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AvailableSystem[] | null>(null);
  const [index, setIndex] = useState(0);
  useReturnFocus(true);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setItems(null);
    const t = setTimeout(async () => {
      const r = await actions.lisp({ op: "findSystems", query: q }).catch(() => null);
      setItems(r?.kind === "systems" ? r.items.filter((s) => s.name !== system.name) : []);
      setIndex(0);
    }, 200);
    return () => clearTimeout(t);
  }, [query, system.name]);

  const choose = (name: string) => {
    onClose();
    void actions.addDependency(system, name);
  };
  // A name typed exactly can be added even when no dist lists it, for vendored systems.
  const typed = query.trim().toLowerCase();
  const options = items ?? [];

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={`Add a dependency to ${system.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={`Add a dependency to ${system.name}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(options.length - 1, i + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
            else if (e.key === "Enter") {
              e.preventDefault();
              const pick = options[index]?.name ?? typed;
              if (pick) choose(pick);
            }
          }}
        />
        <div className="items" data-testid="dependency-results">
          {items === null && <div className="item sub">Type part of a system's name, such as alexandria or cl-ppcre.</div>}
          {items?.length === 0 && <div className="item sub">No system matches. ↩ adds “{typed}” as written.</div>}
          {options.map((s, i) => (
            <div key={s.name} className={`item ${i === index ? "selected" : ""}`} onMouseEnter={() => setIndex(i)} onMouseDown={() => choose(s.name)}>
              <span className="label">{s.name}</span>
              <span className="sub">{s.source === "local" ? "on this Mac" : s.installed ? "Quicklisp, installed" : "Quicklisp"}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
