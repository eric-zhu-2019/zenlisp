import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { backend, inTauri } from "./backend";
import { ask, checkSoon, copyDiagnostics, refreshGit, resyncBreakpoints, showFrame, syncWithDisk } from "./actions";
import { dispatchEvent, get, set } from "./store";
import { markTour, openTour } from "./tour";
import { initParinfer } from "./editor/parinfer";
import "./styles.css";
import { guardWindowClose } from "./ui/Dialog";

await initParinfer();
guardWindowClose();
backend.onEvent((e) => {
  dispatchEvent(e);
  if (e.type === "filesChanged") {
    syncWithDisk(e.paths);
    void refreshGit();
  }
  // Loading a system compiles its files afresh.
  if (e.type === "taskFinished" || (e.type === "status" && e.session.state === "ready")) resyncBreakpoints();
  // Files opened before Lisp was ready have not been checked yet.
  if (e.type === "status" && e.session.state === "ready") for (const t of get().tabs) checkSoon(t.path, 0);
  if (e.type === "lisp" && e.event.kind === "debug" && e.event.stepping) showFrame(e.event, 0, { remember: false });
  if (e.type === "lisp" && e.event.kind === "debug" && !e.event.stepping) markTour("debug");
});

// Commits and checkouts happen outside ZenLisp, and .git is not watched.
window.addEventListener("focus", () => void refreshGit());

const MENU: Record<string, () => void> = {
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
    ask(`ZenLisp ${n.version} is available`, n.notes || "Install it now? ZenLisp restarts into the new version; save your work first.", [
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
  } else if (n.kind === "current") ask("ZenLisp is up to date", `${n.version} is the latest release.`, ok);
  else if (n.kind === "unconfigured") ask("Updates are off in this build", "It was built without an update source, so it cannot look for new releases.", ok);
  else ask("Could not check for updates", n.notes, ok);
}

if (inTauri) {
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string>("menu", (e) => MENU[e.payload]?.());
  await listen<UpdateNews>("update", (e) => announceUpdate(e.payload));
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
