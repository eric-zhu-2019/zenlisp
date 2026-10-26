import { createServer } from "node:http";

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const start = { type: "message_start", message: { id: "msg", type: "message", role: "assistant", content: [], model: "claude-opus-5-5" } };

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { messages } = JSON.parse(body);
    const last = messages[messages.length - 1];
    const answered = Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Asked to fix a note: change the file with edit_file, then say so.
    const asked = messages.findLast((m) => m.role === "user" && !(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")));
    const fix = JSON.stringify(asked).match(/SBCL reports this [a-z ]+ in (\S+) at line/);
    if (fix) {
      const call = { path: fix[1], old_text: '(hello2 "good")', new_text: '(list "good")' };
      const reply = answered
        ? [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
           { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "`hello2` is not defined anywhere; I replaced the call." } },
           { type: "content_block_stop", index: 0 },
           { type: "message_delta", delta: { stop_reason: "end_turn" } }]
        : [{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fix", name: "edit_file", input: {} } },
           { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call) } },
           { type: "content_block_stop", index: 0 },
           { type: "message_delta", delta: { stop_reason: "tool_use" } }];
      res.end(sse([start, ...reply, { type: "message_stop" }]));
      return;
    }
    if (!answered) {
      res.end(
        sse([
          start,
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_e2e", name: "eval", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"form": "(* 6 7)"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" } },
          { type: "message_stop" },
        ]),
      );
    } else {
      const text = "The image says **42**. Here is a helper:\n\n```lisp\n(defun answer () (* 6 7))\n```\n";
      res.end(
        sse([
          start,
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
        ]),
      );
    }
  });
}).listen(7899, "127.0.0.1");
