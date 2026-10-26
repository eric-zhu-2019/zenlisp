import { useEffect, useRef, useState } from "react";
import * as actions from "../actions";
import type { Query } from "../protocol/Query";
import type { SearchResult } from "../protocol/SearchResult";
import { set, useStore } from "../store";
import { Icon } from "./Icon";

function Highlight({ text, spans }: { text: string; spans: [number, number][] }) {
  const chars = [...text];
  const first = spans[0]?.[0] ?? 0;
  // Long lines are trimmed to the first match so it stays visible.
  const from = first > 40 ? first - 30 : 0;
  const parts = [];
  let at = from;
  for (const [a, b] of spans) {
    if (b <= at) continue;
    parts.push(<span key={`t${a}`}>{chars.slice(at, Math.max(at, a)).join("")}</span>);
    parts.push(<mark key={`m${a}`}>{chars.slice(Math.max(at, a), b).join("")}</mark>);
    at = b;
  }
  parts.push(<span key="end">{chars.slice(at, at + 200).join("")}</span>);
  return (
    <>
      {from > 0 && "…"}
      {parts}
    </>
  );
}

function Toggle({ on, title, label, onClick }: { on: boolean; title: string; label: string; onClick: () => void }) {
  return (
    <button className={`search-toggle ${on ? "on" : ""}`} title={title} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );
}

export function SearchPanel() {
  const root = useStore((s) => s.status.project?.root ?? "");
  const references = useStore((s) => s.references);
  const fsNonce = useStore((s) => s.fsNonce);
  const [query, setQuery] = useState<Query>({ pattern: "", regex: false, caseSensitive: false, wholeWord: false });
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    const n = ++seq.current;
    if (!query.pattern) {
      setResult(null);
      setError("");
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await actions.search(query);
        if (n === seq.current) {
          setResult(r);
          setError("");
        }
      } catch (e) {
        if (n === seq.current) setError(String(e instanceof Error ? e.message : e));
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query, fsNonce]);

  const rel = (p: string) => (p.startsWith(root) ? p.slice(root.length + 1) : p);
  const replaceAll = async () => {
    if (!result) return;
    await actions.replaceAll(query, replacement, result.files.map((f) => f.path));
    setQuery({ ...query });
  };

  return (
    <div className="section search-panel" style={{ flex: 1 }}>
      <div className="search-inputs">
        <div className="search-row">
          <button className="icon-btn" title="Toggle replace" onClick={() => setShowReplace(!showReplace)}>
            <span className="chev">{showReplace ? "▾" : "▸"}</span>
          </button>
          <div className="search-field">
            <input
              ref={input}
              placeholder="Search project"
              value={query.pattern}
              onChange={(e) => setQuery({ ...query, pattern: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") set({ sidebar: "files" });
              }}
            />
            <Toggle on={query.caseSensitive} title="Match case" label="Aa" onClick={() => setQuery({ ...query, caseSensitive: !query.caseSensitive })} />
            <Toggle on={query.wholeWord} title="Match whole word" label="ab" onClick={() => setQuery({ ...query, wholeWord: !query.wholeWord })} />
            <Toggle on={query.regex} title="Use regular expression" label=".*" onClick={() => setQuery({ ...query, regex: !query.regex })} />
          </div>
        </div>
        {showReplace && (
          <div className="search-row">
            <span style={{ width: 24 }} />
            <div className="search-field">
              <input placeholder="Replace" value={replacement} onChange={(e) => setReplacement(e.target.value)} />
            </div>
            <button className="btn" disabled={!result?.matches} title="Replace all" onClick={replaceAll}>
              All
            </button>
          </div>
        )}
        {error && <div className="search-error">{error}</div>}
        {result && (
          <div className="search-summary">
            {result.matches === 0
              ? "No results"
              : `${result.matches} result${result.matches === 1 ? "" : "s"} in ${result.files.length} file${result.files.length === 1 ? "" : "s"}${result.truncated ? " (stopped early)" : ""}`}
          </div>
        )}
      </div>
      <div className="section-body" data-testid="search-results">
        {!query.pattern && references && (
          <>
            <div className="search-summary">
              References to <code>{references.name}</code>: {references.items.length}
            </div>
            {references.items.map((d, i) => (
              <div key={i} className="search-line" onClick={() => actions.goToLocation(d.location)} title={d.location?.file ?? ""}>
                <span className="search-text">{d.label}</span>
                <span className="search-file">{d.location?.file ? rel(d.location.file) : "no source"}</span>
              </div>
            ))}
          </>
        )}
        {result?.files.map((f) => (
          <div key={f.path}>
            <div
              className="tree-row search-file-row"
              onClick={() =>
                setCollapsed((c) => {
                  const n = new Set(c);
                  if (n.has(f.path)) n.delete(f.path);
                  else n.add(f.path);
                  return n;
                })
              }
              title={f.path}
            >
              <span className="chev">{collapsed.has(f.path) ? "▸" : "▾"}</span>
              <Icon name="file" size={12} />
              <span>{rel(f.path)}</span>
              <span className="count">{f.lines.length}</span>
            </div>
            {!collapsed.has(f.path) &&
              f.lines.map((l) => (
                <div
                  key={l.line}
                  className="search-line"
                  onClick={() => actions.navigateToLine(f.path, Number(l.line), l.spans[0]?.[0] ?? 0)}
                >
                  <span className="search-lineno">{String(l.line)}</span>
                  <span className="search-text">
                    <Highlight text={l.text} spans={l.spans} />
                  </span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
