import { describe, expect, it } from "vitest";
import { bindings, displayKey, EmacsChords, emacsKeyMatches, matches } from "./keys";

const key = (init: Partial<KeyboardEvent>) =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, code: "", ...init }) as KeyboardEvent;

const ctrl = (letter: string) => key({ key: letter, code: `Key${letter.toUpperCase()}`, ctrlKey: true });

describe("Emacs key sequences", () => {
  it("reads keys by physical key, since ⌥ makes macOS type a composed character", () => {
    expect(emacsKeyMatches(key({ key: "≥", code: "Period", altKey: true }), "M-.")).toBe(true);
    expect(emacsKeyMatches(key({ key: "≈", code: "KeyX", altKey: true, ctrlKey: true }), "C-M-x")).toBe(true);
    expect(emacsKeyMatches(key({ key: "I", code: "KeyI", shiftKey: true }), "I")).toBe(true);
    expect(emacsKeyMatches(key({ key: "i", code: "KeyI" }), "I")).toBe(false);
    expect(emacsKeyMatches(key({ key: "Enter" }), "RET")).toBe(true);
    expect(emacsKeyMatches(ctrl("e"), "C-x")).toBe(false);
  });

  it("follows prefixes to the bound command", () => {
    const chords = new EmacsChords();
    expect(chords.feed(ctrl("x"))).toEqual({ kind: "pending", prefix: "C-x" });
    expect(chords.feed(key({ key: "Control" }))).toEqual({ kind: "pending", prefix: "C-x" });
    expect(chords.feed(ctrl("e"))).toMatchObject({ kind: "run", binding: { id: "eval-last" } });
    expect(chords.feed(ctrl("c"))).toEqual({ kind: "pending", prefix: "C-c" });
    expect(chords.feed(ctrl("d"))).toEqual({ kind: "pending", prefix: "C-c C-d" });
    expect(chords.feed(key({ key: "d", code: "KeyD" }))).toMatchObject({ kind: "run", binding: { id: "describe" } });
  });

  it("lets ordinary typing through, cancels on C-g, and swallows unknown sequences", () => {
    const chords = new EmacsChords();
    expect(chords.feed(key({ key: "a", code: "KeyA" }))).toEqual({ kind: "pass" });
    chords.feed(ctrl("c"));
    expect(chords.feed(ctrl("g"))).toEqual({ kind: "cancel" });
    expect(chords.feed(key({ key: "a", code: "KeyA" }))).toEqual({ kind: "pass" });
    chords.feed(ctrl("x"));
    expect(chords.feed(ctrl("q"))).toEqual({ kind: "undefined", sequence: "C-x C-q" });
  });

  it("never binds one sequence twice or as the prefix of another", () => {
    const seqs = bindings.flatMap((b) => (b.emacs ? [b.emacs] : []));
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const a of seqs) for (const b of seqs) if (a !== b) expect(b.startsWith(`${a} `), `${a} hides ${b}`).toBe(false);
  });
});

describe("key registry", () => {
  it("shows keys the way macOS menus do", () => {
    expect(displayKey("Mod-Shift-p")).toBe("⇧⌘P");
    expect(displayKey("Ctrl-Shift--")).toBe("⌃⇧-");
    expect(displayKey("Mod-Enter")).toBe("⌘↩");
    expect(displayKey("F12")).toBe("F12");
  });

  it("matches keydown events exactly, by physical key for punctuation", () => {
    expect(matches(key({ key: "p", metaKey: true, shiftKey: true }), "Mod-Shift-p")).toBe(true);
    expect(matches(key({ key: "p", metaKey: true }), "Mod-Shift-p")).toBe(false);
    expect(matches(key({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }), "Ctrl-Shift--")).toBe(true);
    expect(matches(key({ key: "-", code: "Minus", ctrlKey: true }), "Ctrl-Shift--")).toBe(false);
  });

  it("never gives two editor, window or structure bindings the same key", () => {
    const seen = new Map<string, string>();
    for (const b of bindings) {
      if (!b.key || (b.scope === "elsewhere" && b.category !== "Structure")) continue;
      const id = b.key.replace(/\bCmd\b/, "Mod");
      expect(seen.get(id), `${b.id} and ${seen.get(id)} both use ${b.key}`).toBeUndefined();
      seen.set(id, b.id);
    }
  });
});

describe("key registry against CodeMirror's built-in keymaps", () => {
  it("never claims a window shortcut that an editor built-in already uses", async () => {
    const commands = await import("@codemirror/commands");
    const { defaultKeymap, historyKeymap } = commands;
    const lint = await import("@codemirror/lint");
    const { searchKeymap } = await import("@codemirror/search");
    const { completionKeymap } = await import("@codemirror/autocomplete");
    const { lintKeymap } = await import("@codemirror/lint");
    const builtIn = new Set(
      [...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, ...lintKeymap].flatMap((b) => [b.key, b.mac].filter(Boolean)),
    );
    const runs = new Map(
      [...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, ...lintKeymap].flatMap((b) =>
        [b.key, b.mac].filter(Boolean).map((k) => [k!, b.run] as const),
      ),
    );
    for (const b of bindings) {
      if (b.scope !== "window" || !b.key) continue;
      if (b.overrides) {
        // Some commands are built anonymously, so they are compared as exported, not by name.
        const named = { ...commands, ...lint } as Record<string, unknown>;
        expect(runs.get(b.key), `${b.id} says it overrides ${b.overrides}`).toBe(named[b.overrides]);
        continue;
      }
      expect(builtIn.has(b.key), `${b.id} uses ${b.key}, which the editor also binds`).toBe(false);
    }
  });
});
