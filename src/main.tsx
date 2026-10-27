import "./renamed";
import React from "react";
import { fetchManifest, usePlugins } from "./plugins";
import ReactDOM from "react-dom/client";
import App from "./App";
import { backend, inTauri } from "./backend";
import { ask, checkSoon, closeProject, loadSystem, compileOutsideChanges, requestOpenProject, copyDiagnostics, refreshGit, resyncBreakpoints, showFrame, syncWithDisk, trackLoadedFiles } from "./actions";
import { appendTranscript, dispatchEvent, get, set } from "./store";
import { markTour, openTour } from "./tour";
import { initParinfer } from "./editor/parinfer";
import "./styles.css";
import { clearRecentProjects, loadedSystems, rememberLoaded, syncRecentMenu } from "./platform";
import { useSettings } from "./settings";
import { guardWindowClose } from "./ui/Dialog";

await initParinfer();
guardWindowClose();
/** The session state last reported, so a reload happens once per Lisp that becomes ready. */
let lastState: string | null = null;
backend.onEvent((e) => {
  dispatchEvent(e);
  if (e.type === "filesChanged") {
    syncWithDisk(e.paths);
    void compileOutsideChanges(e.paths);
    void refreshGit();
  }
  // Loading a system compiles its files afresh.
  if (e.type === "taskFinished" || (e.type === "status" && e.session.state === "ready")) resyncBreakpoints();
  const root = get().status.project?.root;
  if (root && e.type === "taskFinished" && e.ok && e.task.startsWith("load ")) rememberLoaded(root, e.task.slice(5));
  // A fresh Lisp has nothing of the project; load again what the last session loaded.
  const becameReady = e.type === "status" && e.session.state === "ready" && lastState !== "ready";
  if (e.type === "status") lastState = e.session.state;
  if (becameReady) void fetchManifest();
  else if (e.type === "status" && e.session.state !== "ready") usePlugins.setState({ manifest: null });
  if (root && becameReady && useSettings.getState().reloadSystems) {
    const systems = loadedSystems(root).filter((name) => get().systems.some((s) => s.name === name) || get().systems.length === 0);
    if (systems.length) {
      appendTranscript({ kind: "notice", tone: "info", text: `Loading ${systems.join(", ")}, as in the last session. Settings ▸ General turns this off.` });
      for (const name of systems) void loadSystem(name);
    }
  }
  // Lisp now has these systems' files as they are on disk.
  if ((e.type === "taskFinished" && e.ok) || (e.type === "status" && e.session.state === "ready")) void trackLoadedFiles();
  // Files opened before Lisp was ready have not been checked yet, and a load
  // defines what open files use, which changes what their checks report.
  if (e.type === "taskFinished" || (e.type === "status" && e.session.state === "ready")) for (const t of get().tabs) checkSoon(t.path, 0);
  if (e.type === "lisp" && e.event.kind === "debug" && e.event.stepping) showFrame(e.event, 0, { remember: false });
  if (e.type === "lisp" && e.event.kind === "debug" && !e.event.stepping) markTour("debug");
});

// Commits and checkouts happen outside ZParen, and .git is not watched.
window.addEventListener("focus", () => void refreshGit());

const MENU: Record<string, () => void> = {
  "new-project": () => set({ palette: null, newProject: true }),
  "open-project": () => void requestOpenProject(),
  "close-project": () => void closeProject(),
  "recent-clear": clearRecentProjects,
  "help-shortcuts": () => set({ palette: null, help: true }),
  "help-docs": () => set({ right: get().right === "docs" ? null : "docs" }),
  "help-tour": openTour,
  "help-report": () => void copyDiagnostics(),
  settings: () => set({ palette: null, settingsOpen: true }),
};

type UpdateNews = { kind: "available" | "current" | "unconfigured" | "error"; version: string; notes: string };

function announceUpdate(n: UpdateNews) {
  const ok = [{ label: "OK", kind: "primary" as const, run: () => {} }];
  if (n.kind === "available") {
    ask(`ZParen ${n.version} is available`, n.notes || "Install it now? ZParen restarts into the new version; save your work first.", [
      {
        label: "Install and Restart",
        kind: "primary",
        run: async () => {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("install_update").catch((e) => ask("The update did not install", String(e), ok));
        },
      },
      { label: "Later", run: () => {} },
    ]);
  } else if (n.kind === "current") ask("ZParen is up to date", `${n.version} is the latest release.`, ok);
  else if (n.kind === "unconfigured") ask("Updates are off in this build", "It was built without an update source, so it cannot look for new releases.", ok);
  else ask("Could not check for updates", n.notes, ok);
}

if (inTauri) {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("menu", (e) => (e.payload.startsWith("recent:") ? void requestOpenProject(e.payload.slice(7)) : MENU[e.payload]?.()));
  void syncRecentMenu();
  await listen<UpdateNews>("update", (e) => announceUpdate(e.payload));
}

// Every one-line field holds a name, a path, a symbol or code, which macOS must
// not capitalize, correct or spell-check as it does prose.
document.addEventListener("focusin", (e) => {
  if (!(e.target instanceof HTMLInputElement)) return;
  for (const [attr, value] of [["autocapitalize", "off"], ["autocorrect", "off"], ["autocomplete", "off"], ["spellcheck", "false"]]) {
    if (!e.target.hasAttribute(attr)) e.target.setAttribute(attr, value);
  }
}, true);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
