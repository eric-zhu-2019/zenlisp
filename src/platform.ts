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

const RECENT = "zenlisp.recent";

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
}

export async function revealInFinder(path: string) {
  if (inTauri) {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  }
}
