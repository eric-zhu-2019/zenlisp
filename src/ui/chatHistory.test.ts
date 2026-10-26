import { describe, expect, it } from "vitest";
import { chatFromHistory } from "./chatHistory";

describe("a saved conversation shown again", () => {
  it("shows what was typed, the replies, and each tool call with its result", () => {
    const items = chatFromHistory([
      { role: "user", content: [{ type: "text", text: "Editor context:\nFile: /p/main.lisp" }, { type: "text", text: "What is (* 6 7)?" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Evaluate it." },
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "t1", name: "eval", input: { form: "(* 6 7)" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }] },
      { role: "assistant", content: [{ type: "text", text: "It is **42**." }] },
    ]);
    expect(items.map((i) => i.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(items[0]).toMatchObject({ role: "user", text: "What is (* 6 7)?" });
    expect(items[1]).toMatchObject({ text: "Let me check.", thinking: "Evaluate it." });
    expect(items[2]).toMatchObject({ name: "eval", input: '{"form":"(* 6 7)"}', output: "42", ok: true });
    expect(items[3]).toMatchObject({ text: "It is **42**." });
  });

  it("marks a failed tool call and reads results given as text blocks", () => {
    const items = chatFromHistory([
      { role: "user", content: [{ type: "text", text: "Fix it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "edit_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: [{ type: "text", text: "no match" }] }] },
    ]);
    expect(items.find((i) => i.role === "tool")).toMatchObject({ output: "no match", ok: false });
  });
});
