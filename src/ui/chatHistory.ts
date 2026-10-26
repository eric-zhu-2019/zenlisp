// A saved conversation's Anthropic messages, turned back into the chat items
// the assistant panel shows as a turn streams.

import type { ChatItem } from "../store";

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Message = { role?: string; content?: unknown };

const blocks = (m: Message): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []);

/** A tool result's text, which the API allows as a string or as text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: Block) => b.text ?? "").join("");
  return "";
}

export function chatFromHistory(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  let id = 1;
  for (const m of messages as Message[]) {
    const content = blocks(m);
    if (m.role === "user") {
      const results = content.filter((b) => b.type === "tool_result");
      for (const r of results) {
        const i = items.findIndex((c) => c.role === "tool" && c.toolId === r.tool_use_id);
        const tool = items[i];
        if (tool?.role === "tool") items[i] = { ...tool, output: resultText(r.content), ok: !r.is_error };
      }
      // The words typed come last; an editor context block before them is not shown.
      const text = results.length ? null : [...content].reverse().find((b) => b.type === "text")?.text;
      if (text) items.push({ id: id++, role: "user", text });
    } else if (m.role === "assistant") {
      let text = "";
      let thinking = "";
      const flush = () => {
        if (text || thinking) items.push({ id: id++, role: "assistant", text, thinking });
        text = "";
        thinking = "";
      };
      for (const b of content) {
        if (b.type === "text") text += b.text ?? "";
        else if (b.type === "thinking") thinking += b.thinking ?? "";
        else if (b.type === "tool_use") {
          flush();
          items.push({ id: id++, role: "tool", toolId: b.id ?? "", name: b.name ?? "", input: JSON.stringify(b.input ?? {}), output: null, ok: null });
        }
      }
      flush();
    }
  }
  return items;
}
