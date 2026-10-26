import { create } from "zustand";

export type Settings = {
  vim: boolean;
  /** SLIME's key sequences such as C-x C-e and M-., alongside Vim or alone. */
  emacs: boolean;
  parinfer: boolean;
  /** Compile each file in the background as it is edited, for its warnings. */
  liveCheck: boolean;
  /** Saving compiles the top-level forms that changed into the running Lisp. */
  compileOnSave: boolean;
  fontSize: number;
  /** The font family for code: the editor, the REPL and code in panels. Empty keeps SF Mono. */
  editorFont: string;
  /** The font family for everything else. Empty keeps the system font. */
  uiFont: string;
  theme: "system" | "light" | "dark";
};

const KEY = "zenlisp.settings";

function load(): Settings {
  const defaults: Settings = { vim: true, emacs: true, parinfer: true, liveCheck: true, compileOnSave: true, fontSize: 13, editorFont: "", uiFont: "", theme: "system" };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}

export const useSettings = create<Settings>(load);

useSettings.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
  }
});

export const updateSettings = (patch: Partial<Settings>) => useSettings.setState(patch);
