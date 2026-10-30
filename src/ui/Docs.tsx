import { useEffect, useState } from "react";
import * as actions from "../actions";
import { hyperspecUrl } from "../backend";
import { trimDoc } from "../editor/hover";
import type { SymbolInfo } from "../protocol/SymbolInfo";
import { set, useStore } from "../store";
import { openExternal } from "../platform";
import { Icon } from "./Icon";

type Shown = {
  arglist: string | null;
  doc: string | null;
  standard: boolean;
  hyperspec: { installed: boolean; page: string | null };
  /** Coalton's manual on the symbol, for Coalton's operators and library, and the package a library entry is in. */
  manual: { page: string; packageName: string | null; packagePage: string | null } | null;
};

const COALTON_SITE = "https://coalton-lang.github.io/";

/** The parts of Coalton's manual that are about no one symbol. */
const COALTON_PAGES: [string, string][] = [
  ["Manual", "manual/"],
  ["Introduction", "manual/topics/introduction/"],
  ["Whirlwind tour", "manual/topics/whirlwind-tour/"],
  ["Operators", "manual/operators/"],
  ["Library reference", "reference/"],
  ["Lisp interop", "manual/topics/lisp-interop/"],
  ["Macros", "manual/topics/macros/"],
  ["Debugging", "manual/topics/debugging/"],
  ["Configuring Coalton", "manual/topics/configuring-coalton/"],
  ["Parallel programming", "manual/topics/parallel-programming/"],
];

/** The page, package name and package page `zparen::coalton-manual-page-named` prints, as a list of strings or NIL. */
function parseManual(value: string): Shown["manual"] {
  const [page, packageName, packagePage] = [...value.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (!page?.startsWith(COALTON_SITE)) return null;
  return { page, packageName: packageName ?? null, packagePage: packagePage?.startsWith(COALTON_SITE) ? packagePage : null };
}

const lispString = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** ZParen's own forms run in CL-USER, as in a package that uses Coalton they would run as Coalton. */
async function lookUp(symbol: string, pkg: string): Promise<Shown> {
  const standard = `(let ((s (ignore-errors (let ((*read-eval* nil) (*package* (or (find-package ${lispString(pkg)}) *package*)))
                                   (read-from-string ${lispString(symbol)})))))
  (and s (symbolp s) (eq (symbol-package s) (find-package "COMMON-LISP"))))`;
  const [described, arglist, hs, cl, coalton] = await Promise.all([
    actions.lisp({ op: "describe", symbol, package: pkg }).catch(() => null),
    actions.lisp({ op: "autodoc", form: [symbol, "", { cursor: true }], package: pkg }).catch(() => null),
    actions.request({ type: "hyperspec", symbol }).catch(() => null),
    actions.lisp({ op: "eval", form: standard, package: "COMMON-LISP-USER" }).catch(() => null),
    actions
      .lisp({ op: "eval", form: `(zparen::coalton-manual-page-named ${lispString(symbol)} ${lispString(pkg)})`, package: "COMMON-LISP-USER" })
      .catch(() => null),
  ]);
  return {
    doc: described?.kind === "text" ? trimDoc(described.text, Infinity) : null,
    arglist: arglist?.kind === "arglist" && arglist.text.startsWith("(") ? arglist.text : null,
    standard: cl?.kind === "evaluated" && cl.value === "T",
    hyperspec: hs?.type === "hyperspec" ? { installed: hs.installed, page: hs.page } : { installed: false, page: null },
    manual: coalton?.kind === "evaluated" ? parseManual(coalton.value) : null,
  };
}

function Apropos({ onPick }: { onPick: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SymbolInfo[] | null>(null);
  useEffect(() => {
    if (query.trim().length < 2) return setItems(null);
    const t = setTimeout(async () => {
      // Swank matches a name only, so a package prefix, as in coalton:boolean, names the package to search.
      const [, pkg, name] = /^([^:\s]+)::?(.*)$/.exec(query.trim()) ?? [null, null, query.trim()];
      const r = await actions.lisp({ op: "apropos", query: name, package: pkg }).catch(() => null);
      setItems(r?.kind === "symbols" ? r.items.slice(0, 60) : []);
    }, 220);
    return () => clearTimeout(t);
  }, [query]);
  return (
    <div className="apropos">
      <input placeholder="Search symbols in every package" value={query} onChange={(e) => setQuery(e.target.value)} />
      {items && (
        <ul className="apropos-results" data-testid="apropos">
          {items.length === 0 && <li className="dim">No symbol matches.</li>}
          {items.map((s) => (
            <li
              key={s.name}
              onClick={() => {
                setQuery("");
                onPick(s.name);
              }}
            >
              <code>{s.name.toLowerCase()}</code>
              <span className="kinds">{s.kinds.map((k) => k.replace(/-/g, " ")).join(", ")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HyperSpecPage({ page }: { page: string }) {
  return <iframe className="hyperspec" title="Common Lisp HyperSpec" src={hyperspecUrl(page)} data-testid="hyperspec" />;
}

const REFERENCE = `${COALTON_SITE}reference/`;
let headingIds: Promise<Map<string, string>> | null = null;

/** The reference's anchors, each with the id of the heading it is in. */
function referenceHeadingIds(): Promise<Map<string, string>> {
  headingIds ??= fetch(REFERENCE)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
    .then((html) => {
      const ids = new Map<string, string>();
      for (const a of new DOMParser().parseFromString(html, "text/html").querySelectorAll("a[name]")) {
        const heading = a.closest("h1, h2, h3, h4, h5, h6");
        if (heading?.id) ids.set(a.getAttribute("name")!, heading.id);
      }
      return ids;
    })
    .catch(() => {
      headingIds = null;
      return new Map();
    });
  return headingIds;
}

/** The address to show for a part of the reference. WebKit scrolls past a heading when the address names the
 * anchor at the heading's end, as the reference's own links do, but not when it names the heading's id. */
async function landing(url: string): Promise<string> {
  if (!url.startsWith(`${REFERENCE}#`)) return url;
  const id = (await referenceHeadingIds()).get(url.slice(REFERENCE.length + 1));
  return id ? `${REFERENCE}#${id}` : url;
}

function CoaltonManualPage({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    landing(url).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [url]);
  if (!src) return <div className="dim">Loading the manual…</div>;
  return <iframe className="hyperspec" title="Coalton manual" src={src} data-testid="coalton-manual" />;
}

function InstallHyperSpec({ symbol, onInstalled }: { symbol: string; onInstalled: () => void }) {
  const [state, setState] = useState<"idle" | "installing" | "failed">("idle");
  return (
    <div className="docs-card">
      <div>
        <strong>{symbol.toUpperCase()}</strong> is part of Common Lisp. Its HyperSpec page can show here once the HyperSpec is
        installed. Quicklisp installs a complete copy, about 18 MB.
      </div>
      <div className="docs-card-actions">
        <button
          className="btn primary"
          disabled={state === "installing"}
          onClick={async () => {
            setState("installing");
            const ok = await actions.installHyperspec().catch(() => false);
            setState(ok ? "idle" : "failed");
            if (ok) onInstalled();
          }}
        >
          {state === "installing" ? "Installing…" : "Install the HyperSpec"}
        </button>
        <button className="btn" onClick={() => openExternal(`https://www.lispworks.com/documentation/HyperSpec/Front/X_Symbol.htm`)}>
          Open it online
        </button>
      </div>
      {state === "failed" && <div className="docs-error">Installing needs Quicklisp. Install Quicklisp, or open the HyperSpec online.</div>}
    </div>
  );
}

export function DocsPanel() {
  const { topic, back, follow } = useStore((s) => s.docs);
  const [shown, setShown] = useState<Shown | null>(null);
  const [nonce, setNonce] = useState(0);
  const [view, setView] = useState<"hyperspec" | "docstring">("hyperspec");
  /** A page of Coalton's manual chosen to read, which shows in place of the topic until the topic changes. */
  const [reading, setReading] = useState<string | null>(null);
  const [coaltonLoaded, setCoaltonLoaded] = useState(false);

  useEffect(() => {
    setReading(null);
    let live = true;
    actions
      .lisp({ op: "eval", form: `(and (find-package "COALTON") t)`, package: "COMMON-LISP-USER" })
      .then((r) => live && setCoaltonLoaded(r.kind === "evaluated" && r.value === "T"))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [topic]);

  useEffect(() => {
    if (!topic) return;
    let live = true;
    setShown(null);
    lookUp(topic.symbol, topic.package).then((r) => live && setShown(r));
    return () => {
      live = false;
    };
  }, [topic, nonce]);

  const pick = (name: string) => actions.showDocs(name, useStore.getState().package);

  return (
    <div className="docs" data-testid="docs">
      <div className="right-header">
        <button className="icon-btn" title="Back" disabled={!back.length} onClick={actions.docsBack}>
          <Icon name="back" />
        </button>
        <span className="title">Documentation</span>
        <label className="check-label" title="Show the symbol at the editor's cursor">
          <input type="checkbox" checked={follow} onChange={(e) => set((s) => ({ docs: { ...s.docs, follow: e.target.checked } }))} /> Follow cursor
        </label>
        <button className="icon-btn" title="Close" onClick={() => set({ right: null })}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <Apropos onPick={pick} />
      {coaltonLoaded && (
        <select
          className="coalton-pages"
          aria-label="Coalton manual"
          value=""
          onChange={(e) => {
            if (e.target.value) setReading(e.target.value);
          }}
        >
          <option value="">Coalton manual…</option>
          {COALTON_PAGES.map(([label, path]) => (
            <option key={path} value={COALTON_SITE + path}>
              {label}
            </option>
          ))}
        </select>
      )}
      {reading ? (
        <div className="docs-body">
          <button className="btn" onClick={() => openExternal(reading)}>
            Open in the browser
          </button>
          <CoaltonManualPage url={reading} />
        </div>
      ) : !topic ? (
        <div className="docs-empty">
          Put the cursor on a symbol, or search above. Lisp's own documentation for it shows here, with its HyperSpec page for
          Common Lisp symbols and Coalton's manual for Coalton's operators and library.
        </div>
      ) : (
        <div className="docs-body">
          <div className="docs-head">
            <code className="docs-symbol" data-testid="docs-symbol">
              {topic.symbol.toLowerCase()}
            </code>
            <button className="btn" onClick={() => actions.showDefinition(topic.symbol, topic.package)}>
              Go to source
            </button>
          </div>
          {!shown ? (
            <div className="dim">Looking it up…</div>
          ) : (
            <>
              {shown.arglist && <code className="docs-arglist">{shown.arglist}</code>}
              {(shown.hyperspec.page || shown.manual) && shown.doc && (
                <div className="segmented" role="tablist">
                  {(["hyperspec", "docstring"] as const).map((v) => (
                    <button key={v} role="tab" className={view === v ? "active" : ""} onClick={() => setView(v)}>
                      {v === "docstring" ? "Docstring" : shown.hyperspec.page ? "HyperSpec" : "Coalton manual"}
                    </button>
                  ))}
                </div>
              )}
              {shown.manual && !shown.hyperspec.page && (
                <div className="docs-card-actions">
                  {shown.manual.packagePage && (
                    <button className="btn" onClick={() => setReading(shown.manual!.packagePage)}>
                      Package {shown.manual.packageName}
                    </button>
                  )}
                  <button className="btn" onClick={() => openExternal(shown.manual!.page)}>
                    Open in the browser
                  </button>
                </div>
              )}
              {shown.doc && ((!shown.hyperspec.page && !shown.manual) || view === "docstring") ? (
                <pre className="docs-text">{shown.doc}</pre>
              ) : (
                !shown.doc && !shown.hyperspec.page && !shown.manual && <div className="dim">No documentation.</div>
              )}
              {shown.manual && !shown.hyperspec.page && view === "hyperspec" && <CoaltonManualPage url={shown.manual.page} />}
              {shown.hyperspec.page ? (
                view === "hyperspec" && <HyperSpecPage page={shown.hyperspec.page} />
              ) : (
                !shown.hyperspec.installed &&
                shown.standard && <InstallHyperSpec symbol={topic.symbol} onInstalled={() => setNonce((n) => n + 1)} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
