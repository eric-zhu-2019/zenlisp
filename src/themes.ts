// Themes: values for the color variables styles.css defines. A theme sets
// any of them; the rest keep ZenLisp's own value for the theme's kind.

import { create } from "zustand";
import type { ThemeFile } from "./protocol/ThemeFile";

export const TOKENS = [
  "bg", "bg-editor", "bg-sidebar", "bg-panel", "bg-hover", "bg-active", "bg-input",
  "border", "border-strong", "text", "text-dim", "text-faint",
  "accent", "accent-text", "danger", "danger-bg", "warning", "success", "shadow", "keycap-bg", "keycap-edge",
  "syn-comment", "syn-string", "syn-number", "syn-keyword-arg", "syn-special", "syn-def", "syn-symbol", "syn-meta", "syn-paren",
  "paren-0", "paren-1", "paren-2", "paren-3", "paren-4", "paren-5",
] as const;

export type Token = (typeof TOKENS)[number];
export type ThemeKind = "light" | "dark";

export type Theme = {
  id: string;
  name: string;
  kind: ThemeKind;
  colors: Partial<Record<Token, string>>;
  /** The file a user theme came from; none for a built-in one. */
  file?: string;
};

const solarized = (kind: ThemeKind): Theme["colors"] => {
  const [bg, panel, faint, dim, text] =
    kind === "light" ? ["#fdf6e3", "#eee8d5", "#93a1a1", "#839496", "#586e75"] : ["#002b36", "#073642", "#586e75", "#839496", "#93a1a1"];
  return {
    bg, "bg-editor": bg, "bg-sidebar": panel, "bg-panel": panel, "bg-input": bg,
    text, "text-dim": dim, "text-faint": faint,
    accent: "#268bd2", "accent-text": "#fdf6e3", "bg-active": "rgba(38, 139, 210, 0.16)",
    danger: "#dc322f", warning: "#b58900", success: "#859900",
    "syn-comment": faint, "syn-string": "#2aa198", "syn-number": "#d33682", "syn-keyword-arg": "#6c71c4",
    "syn-special": "#859900", "syn-def": "#268bd2", "syn-symbol": text, "syn-meta": dim, "syn-paren": faint,
    "paren-0": dim, "paren-1": "#268bd2", "paren-2": "#6c71c4", "paren-3": "#cb4b16", "paren-4": "#2aa198", "paren-5": "#d33682",
  };
};

export const BUILT_IN: Theme[] = [
  { id: "zenlisp-light", name: "ZenLisp Light", kind: "light", colors: {} },
  { id: "zenlisp-dark", name: "ZenLisp Dark", kind: "dark", colors: {} },
  { id: "solarized-light", name: "Solarized Light", kind: "light", colors: solarized("light") },
  { id: "solarized-dark", name: "Solarized Dark", kind: "dark", colors: solarized("dark") },
  {
    id: "nord",
    name: "Nord",
    kind: "dark",
    colors: {
      bg: "#2e3440", "bg-editor": "#2e3440", "bg-sidebar": "#3b4252", "bg-panel": "#3b4252", "bg-input": "#434c5e",
      text: "#eceff4", "text-dim": "#d8dee9", "text-faint": "#7b88a1",
      accent: "#88c0d0", "accent-text": "#2e3440", "bg-active": "rgba(136, 192, 208, 0.16)",
      danger: "#bf616a", warning: "#ebcb8b", success: "#a3be8c",
      "syn-comment": "#7b88a1", "syn-string": "#a3be8c", "syn-number": "#b48ead", "syn-keyword-arg": "#8fbcbb",
      "syn-special": "#81a1c1", "syn-def": "#88c0d0", "syn-symbol": "#d8dee9", "syn-meta": "#7b88a1", "syn-paren": "#616e88",
      "paren-0": "#7b88a1", "paren-1": "#88c0d0", "paren-2": "#b48ead", "paren-3": "#d08770", "paren-4": "#81a1c1", "paren-5": "#a3be8c",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    kind: "dark",
    colors: {
      bg: "#282828", "bg-editor": "#282828", "bg-sidebar": "#32302f", "bg-panel": "#32302f", "bg-input": "#3c3836",
      text: "#ebdbb2", "text-dim": "#a89984", "text-faint": "#7c6f64",
      accent: "#8ec07c", "accent-text": "#282828", "bg-active": "rgba(142, 192, 124, 0.16)",
      danger: "#fb4934", warning: "#fabd2f", success: "#b8bb26",
      "syn-comment": "#928374", "syn-string": "#b8bb26", "syn-number": "#d3869b", "syn-keyword-arg": "#83a598",
      "syn-special": "#fb4934", "syn-def": "#fabd2f", "syn-symbol": "#ebdbb2", "syn-meta": "#928374", "syn-paren": "#7c6f64",
      "paren-0": "#a89984", "paren-1": "#8ec07c", "paren-2": "#d3869b", "paren-3": "#fe8019", "paren-4": "#83a598", "paren-5": "#fabd2f",
    },
  },
];

export const DEFAULT_THEME: Record<ThemeKind, string> = { light: "zenlisp-light", dark: "zenlisp-dark" };

/**
 * A theme file's theme, or what is wrong with it. The file is JSON:
 * `{ "name": "Paper", "kind": "light", "colors": { "bg": "#fff", "syn-string": "#a31515" } }`.
 */
export function parseTheme(file: ThemeFile): Theme | string {
  let data: unknown;
  try {
    data = JSON.parse(file.text);
  } catch (e) {
    return `${file.name}: not JSON (${(e as Error).message})`;
  }
  const d = data as { name?: unknown; kind?: unknown; colors?: unknown };
  if (typeof d !== "object" || d === null) return `${file.name}: not a JSON object`;
  if (d.kind !== "light" && d.kind !== "dark") return `${file.name}: "kind" must be "light" or "dark"`;
  if (typeof d.colors !== "object" || d.colors === null) return `${file.name}: "colors" must be an object`;
  const colors: Theme["colors"] = {};
  for (const [key, value] of Object.entries(d.colors)) {
    const token = key.replace(/^--/, "");
    if (!(TOKENS as readonly string[]).includes(token)) return `${file.name}: no color is named "${key}"`;
    if (typeof value !== "string" || !CSS.supports(token === "shadow" ? "box-shadow" : "color", value)) return `${file.name}: "${key}" is not a color: ${JSON.stringify(value)}`;
    colors[token as Token] = value;
  }
  const base = file.name.replace(/\.json$/i, "");
  return { id: `user:${base}`, name: typeof d.name === "string" && d.name ? d.name : base, kind: d.kind, colors, file: file.name };
}

export const useThemes = create<{ dir: string; user: Theme[]; problems: string[] }>(() => ({ dir: "", user: [], problems: [] }));

export function readThemeFiles(dir: string, files: ThemeFile[]) {
  const parsed = files.map(parseTheme);
  useThemes.setState({
    dir,
    user: parsed.filter((t): t is Theme => typeof t !== "string"),
    problems: parsed.filter((t): t is string => typeof t === "string"),
  });
}

export const allThemes = (user: Theme[]) => [...BUILT_IN, ...user];

/** The theme for `kind` among `themes`, by id, falling back to ZenLisp's own. */
export function themeFor(kind: ThemeKind, id: string, themes: Theme[]): Theme {
  return themes.find((t) => t.id === id && t.kind === kind) ?? BUILT_IN.find((t) => t.id === DEFAULT_THEME[kind])!;
}

let applied: Token[] = [];

/** Shows `theme`: its kind picks the base colors, and its own colors go over them. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme.kind;
  for (const token of applied) root.style.removeProperty(`--${token}`);
  applied = Object.keys(theme.colors) as Token[];
  for (const token of applied) root.style.setProperty(`--${token}`, theme.colors[token]!);
}
