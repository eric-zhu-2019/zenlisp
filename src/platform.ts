import { inTauri } from "./backend";

export async function pickFolder(title: string): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: true, title });
    return typeof r === "string" ? r : null;
  }
  return window.prompt(`${title} (absolute path)`);
}

export async function pickFile(title: string): Promise<string | null> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: false, title });
    return typeof r === "string" ? r : null;
  }
  return window.prompt(`${title} (absolute path)`);
}

export async function openExternal(url: string) {
  if (inTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank");
}

const RECENT = "zparen.recent";

export function recentProjects(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]");
  } catch {
    return [];
  }
}

export function rememberProject(root: string) {
  try {
    const list = [root, ...recentProjects().filter((r) => r !== root)].slice(0, 8);
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
  }
  void syncRecentMenu();
}

export function clearRecentProjects() {
  try {
    localStorage.removeItem(RECENT);
  } catch {
  }
  void syncRecentMenu();
}

/** Shows the recent projects in File ▸ Open Recent. */
export async function syncRecentMenu() {
  if (!inTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_recent_projects", { paths: recentProjects() }).catch(() => null);
}

export async function revealInFinder(path: string) {
  if (inTauri) {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  }
}

const LOADED = "zparen.loaded";

/** The systems loaded in a project's last session, which its next session loads again. */
export function loadedSystems(root: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(LOADED) ?? "{}")[root] ?? [];
  } catch {
    return [];
  }
}

export function rememberLoaded(root: string, system: string) {
  try {
    const all = JSON.parse(localStorage.getItem(LOADED) ?? "{}");
    const list: string[] = all[root] ?? [];
    if (!list.includes(system)) all[root] = [...list, system];
    localStorage.setItem(LOADED, JSON.stringify(all));
  } catch {
  }
}
