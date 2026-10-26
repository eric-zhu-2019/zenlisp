import { useEffect } from "react";
import * as actions from "../actions";
import { set, useStore } from "../store";
import { useReturnFocus } from "./focus";

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  useReturnFocus(dialog !== null);
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") set({ dialog: null });
      if (e.key === "Enter") dialog.actions.find((a) => a.kind === "primary")?.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dialog]);
  if (!dialog) return null;
  return (
    <div className="overlay" onMouseDown={() => set({ dialog: null })}>
      <div className="dialog" role="alertdialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{dialog.title}</h2>
        <div style={{ color: "var(--text-dim)" }}>{dialog.message}</div>
        <div className="row">
          {dialog.actions.map((a) => (
            <button key={a.label} className={`btn ${a.kind ?? ""}`} onClick={a.run}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ConflictBanner() {
  const tab = useStore((s) => s.tabs.find((t) => t.path === s.activeTab));
  if (!tab?.conflict) return null;
  return (
    <div className="conflict-banner" role="status">
      {tab.conflict === "changed" ? (
        <>
          <span>{tab.name} changed on disk, and you have unsaved edits.</span>
          <button className="btn" onClick={() => actions.reloadFromDisk(tab.path)}>
            Reload from disk
          </button>
          <button className="btn" onClick={() => actions.keepMine(tab.path)}>
            Keep my version
          </button>
        </>
      ) : (
        <>
          <span>{tab.name} was deleted on disk.</span>
          <button className="btn" onClick={() => actions.saveTab(tab.path)}>
            Save to recreate it
          </button>
          <button className="btn" onClick={() => actions.closeTab(tab.path)}>
            Close
          </button>
        </>
      )}
    </div>
  );
}

/** Asks before the window closes with unsaved files. */
export async function guardWindowClose() {
  const { inTauri } = await import("../backend");
  if (!inTauri) {
    window.addEventListener("beforeunload", (e) => {
      if (actions.dirtyTabs().length) e.preventDefault();
    });
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { listen } = await import("@tauri-apps/api/event");
  const { invoke } = await import("@tauri-apps/api/core");
  const quit = () => invoke("quit");
  const askThenQuit = () => {
    const dirty = actions.dirtyTabs();
    if (dirty.length === 0) return void quit();
    const names = dirty.map((t) => t.name).join(", ");
    actions.ask(`Save changes before quitting?`, `Unsaved: ${names}.`, [
      { label: "Save All", kind: "primary", run: () => actions.saveAll().then(quit) },
      { label: "Don't Save", kind: "danger", run: quit },
      { label: "Cancel", run: () => {} },
    ]);
  };
  await getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    askThenQuit();
  });
  await listen("quit-requested", askThenQuit);
}
