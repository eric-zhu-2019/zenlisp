import { describe, expect, it } from "vitest";
import type { Debugger } from "./protocol/Debugger";
import { activeDebugger, reduce, settlePanes, type State, useStore, withTab, withoutTab } from "./store";

const dbg = (thread: number, level: number, condition: string): Debugger => ({
  thread: { id: thread },
  level,
  condition,
  conditionType: "[Condition of type SIMPLE-ERROR]",
  restarts: [],
  frames: [],
  stepping: false,
});

describe("debugger state", () => {
  it("shows the debugger entered most recently, and falls back when it returns", () => {
    let s = useStore.getState();
    const apply = (e: Parameters<typeof reduce>[1]) => (s = { ...s, ...reduce(s, e) });
    apply({ type: "lisp", event: { kind: "debug", ...dbg(20, 1, "first") } });
    apply({ type: "lisp", event: { kind: "debug", ...dbg(3, 1, "second") } });
    expect(activeDebugger(s)?.condition).toBe("second");
    apply({ type: "lisp", event: { kind: "debug", ...dbg(3, 2, "nested") } });
    expect(activeDebugger(s)?.condition).toBe("nested");
    apply({ type: "lisp", event: { kind: "debugReturn", thread: { id: 3 }, level: 1, stepping: false } });
    expect(activeDebugger(s)?.condition).toBe("first");
  });

  it("merges the newline Swank sends after a presented result", () => {
    let s = useStore.getState();
    const apply = (e: Parameters<typeof reduce>[1]) => (s = { ...s, ...reduce(s, e) });
    apply({ type: "lisp", event: { kind: "presentationStart", id: 1 } });
    apply({ type: "lisp", event: { kind: "output", text: "42", target: "repl-result" } });
    apply({ type: "lisp", event: { kind: "presentationEnd", id: 1 } });
    apply({ type: "lisp", event: { kind: "output", text: "\n", target: "repl-result" } });
    const results = s.transcript.filter((t) => t.kind === "result");
    expect(results).toHaveLength(1);
  });
});

describe("extra REPLs", () => {
  it("collect their own output, results and prompts", () => {
    let s: State = { ...useStore.getState(), repls: [{ id: 3, name: "REPL 4", channel: 9, thread: 12, package: "CL-USER", transcript: [], reading: false, busy: true }] };
    const apply = (e: Parameters<typeof reduce>[1]) => (s = { ...s, ...reduce(s, e) });
    const channel = (message: object) => apply({ type: "lisp", event: { kind: "channel", channel: 3, message } as never });
    channel({ kind: "writeString", text: "hi " });
    channel({ kind: "writeString", text: "there\n" });
    channel({ kind: "writeResult", text: "42\n" });
    channel({ kind: "prompt", package: "ZEN" });
    const [repl] = s.repls;
    expect(repl.transcript.map((t) => ("text" in t ? t.text : ""))).toEqual(["hi there\n", "42\n"]);
    expect([repl.package, repl.busy]).toEqual(["ZEN", false]);
    expect(s.transcript, "the main REPL is untouched").toEqual(useStore.getState().transcript);
  });
});

describe("editor panes", () => {
  it("closes an emptied second pane and moves the focus to the first", () => {
    const panes = [{ tabs: ["/a", "/b"], active: "/a" }, withoutTab({ tabs: ["/c"], active: "/c" }, "/c")];
    expect(settlePanes(panes, 1)).toEqual({ panes: [panes[0]], focusedPane: 0, activeTab: "/a" });
  });

  it("shows the next tab when the one on show closes, and keeps the first pane even when empty", () => {
    expect(withoutTab({ tabs: ["/a", "/b", "/c"], active: "/b" }, "/b")).toEqual({ tabs: ["/a", "/c"], active: "/c" });
    expect(settlePanes([{ tabs: [], active: null }], 0)).toEqual({ panes: [{ tabs: [], active: null }], focusedPane: 0, activeTab: null });
  });

  it("puts a tab where it is dropped", () => {
    expect(withTab({ tabs: ["/a", "/b", "/c"], active: "/a" }, "/c", 0)).toEqual({ tabs: ["/c", "/a", "/b"], active: "/c" });
    expect(withTab({ tabs: ["/a"], active: "/a" }, "/z")).toEqual({ tabs: ["/a", "/z"], active: "/z" });
  });
});
