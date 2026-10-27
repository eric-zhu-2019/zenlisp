import { useMemo, useState } from "react";
import { bindings, displayKey, pluginBindings, type Category } from "../keys";
import { usePlugins } from "../plugins";
import { set, useStore } from "../store";
import { useReturnFocus } from "./focus";

const ORDER: Category[] = ["Lisp", "Structure", "Navigation", "Editing", "REPL", "Debugger", "Tools", "Project", "Window", "Plugins"];

export function HelpScreen() {
  const open = useStore((s) => s.help);
  const [query, setQuery] = useState("");
  const commands = usePlugins((s) => s.manifest?.commands);
  useReturnFocus(open);
  const groups = useMemo(() => {
    // Every word typed must appear: a scattered match is noise across long labels.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [...bindings, ...pluginBindings(commands)].filter((b) => {
      const text = `${b.label} ${b.key ? displayKey(b.key) : ""} ${b.key ?? ""} ${b.vim ?? ""} ${b.emacs ?? ""} ${b.note ?? ""}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
    return ORDER.map((c) => [c, hits.filter((b) => b.category === c)] as const).filter(([, list]) => list.length);
  }, [query, commands]);
  if (!open) return null;
  const close = () => set({ help: false });
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="help" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h2>Keyboard shortcuts</h2>
          <input
            autoFocus
            placeholder="Filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && close()}
          />
        </div>
        <div className="help-body">
          {groups.map(([category, list]) => (
            <section key={category}>
              <table>
                <thead>
                  <tr>
                    <th>{category}</th>
                    <th className="keys">Key</th>
                    <th className="keys">{list.some((b) => b.vim) && "Vim"}</th>
                    <th className="keys">{list.some((b) => b.emacs) && "Emacs"}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((b) => (
                    <tr key={b.id}>
                      <td>
                        {b.label}
                        {b.note && <div className="note">{b.note}</div>}
                      </td>
                      <td className="keys">{b.key && <kbd className="keycap">{displayKey(b.key)}</kbd>}</td>
                      <td className="keys">{b.vim && <kbd className="keycap mono">{b.vim}</kbd>}</td>
                      <td className="keys">{b.emacs && <kbd className="keycap mono">{b.emacs}</kbd>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          {groups.length === 0 && <div className="note">No shortcut matches “{query}”.</div>}
        </div>
        <div className="help-foot">
          Vim bindings work in normal mode. Emacs sequences work in any mode; C-g cancels one. Turn either off from the command
          palette.
        </div>
      </div>
    </div>
  );
}
