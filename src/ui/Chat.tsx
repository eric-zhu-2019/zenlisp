import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as actions from "../actions";
import { editorContext, insertAtCursor } from "../editor/commands";
import type { AssistantStatus } from "../protocol/AssistantStatus";
import type { McpInfo } from "../protocol/McpInfo";
import { set, useStore, type ChatItem } from "../store";
import { Icon } from "./Icon";

function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i}>{p.slice(1, -1)}</code>
        ) : p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [done, setDone] = useState("");
  const lisp = /^(lisp|common-lisp|cl|)$/i.test(lang);
  const flash = (msg: string) => {
    setDone(msg);
    setTimeout(() => setDone(""), 1500);
  };
  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span>{lang || "code"}</span>
        <span className="grow" />
        {done && <span className="chat-done">{done}</span>}
        <button className="btn" onClick={() => navigator.clipboard.writeText(code).then(() => flash("Copied"))}>
          Copy
        </button>
        {lisp && (
          <>
            <button className="btn" onClick={() => flash(insertAtCursor(code) ? "Inserted" : "Open a file first")}>
              Insert
            </button>
            <button className="btn" onClick={() => actions.replEval(code)}>
              <Icon name="play" size={10} /> Eval
            </button>
          </>
        )}
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function Markdown({ text }: { text: string }) {
  const chunks = text.split(/```(\w*)\n([\s\S]*?)(?:```|$)/g);
  const out = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const prose = chunks[i];
    if (prose.trim())
      out.push(
        ...prose
          .trim()
          .split(/\n{2,}/)
          .map((para, j) => (
            <p key={`${i}-${j}`}>
              {para.split("\n").map((line, k) => (
                <span key={k}>
                  {k > 0 && <br />}
                  <Inline text={line} />
                </span>
              ))}
            </p>
          )),
      );
    if (i + 2 < chunks.length) out.push(<CodeBlock key={`c${i}`} lang={chunks[i + 1]} code={chunks[i + 2].replace(/\n$/, "")} />);
  }
  return <>{out}</>;
}

function ToolChip({ item }: { item: Extract<ChatItem, { role: "tool" }> }) {
  const [open, setOpen] = useState(false);
  let summary = item.input;
  try {
    const args = JSON.parse(item.input);
    summary = Object.values(args).map(String).join(" ").slice(0, 90);
  } catch {
  }
  return (
    <div className={`chat-tool ${item.ok === false ? "failed" : ""}`}>
      <div className="chat-tool-head" onClick={() => setOpen(!open)}>
        <span className={`dot ${item.ok === null ? "starting" : item.ok ? "ready" : "failed"}`} />
        <span className="chat-tool-name">{item.name.replace(/_/g, " ")}</span>
        <span className="chat-tool-args">{summary}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="chat-tool-body">
          <div className="label">Input</div>
          <pre>{item.input}</pre>
          {item.output !== null && (
            <>
              <div className="label">Result</div>
              <pre>{item.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  switch (item.role) {
    case "user":
      return <div className="chat-user">{item.text}</div>;
    case "assistant":
      return (
        <div className="chat-assistant">
          {item.thinking && (
            <details className="chat-thinking">
              <summary>Thought process</summary>
              <div>{item.thinking}</div>
            </details>
          )}
          <Markdown text={item.text} />
        </div>
      );
    case "tool":
      return <ToolChip item={item} />;
    case "error":
      return <div className="chat-error">{item.text}</div>;
  }
}

function Setup({ status, onSaved }: { status: AssistantStatus | null; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    actions.request({ type: "mcpInfo" }).then((r) => r.type === "mcp" && setMcp(r.info));
  }, []);
  return (
    <div className="chat-setup">
      {!status?.configured && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await actions.request({ type: "assistantSetKey", key });
            setKey("");
            onSaved();
          }}
        >
          <h3>Connect Claude</h3>
          <p>
            Paste an Anthropic API key. ZenLisp also uses <code>ANTHROPIC_API_KEY</code> or an <code>ant auth login</code> profile
            when present. The key is stored only on this Mac.
          </p>
          <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn primary" disabled={!key.trim()}>
            Save key
          </button>
        </form>
      )}
      <div className="chat-mcp">
        <h3>Use Claude Code with this image</h3>
        <p>ZenLisp runs an MCP server, so an agent in your terminal can evaluate, compile and debug in this Lisp.</p>
        {mcp ? (
          <>
            <pre>{mcp.claudeCommand}</pre>
            <button
              className="btn"
              onClick={() => navigator.clipboard.writeText(mcp.claudeCommand).then(() => setCopied(true))}
            >
              {copied ? "Copied" : "Copy command"}
            </button>
          </>
        ) : (
          <p className="dim">The MCP server is not running.</p>
        )}
      </div>
    </div>
  );
}

export function Chat() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [text, setText] = useState("");
  const [withContext, setWithContext] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const refresh = () => actions.request({ type: "assistantStatus" }).then((r) => r.type === "assistant" && setStatus(r));
  useEffect(() => {
    refresh();
  }, []);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    await actions.askAssistant(t, withContext ? editorContext() : null);
  };

  const needsSetup = status !== null && !status.configured;

  return (
    <>
      <div className="right-header">
        <Icon name="sparkle" />
        <span className="title">Assistant</span>
        <button className="icon-btn" title="New conversation" onClick={() => (actions.request({ type: "assistantReset" }), set({ chat: [] }))}>
          <Icon name="plus" size={12} />
        </button>
        <button className="icon-btn" title="Assistant settings" onClick={() => setShowSetup(!showSetup)}>
          <Icon name="gear" size={13} />
        </button>
        <button className="icon-btn" title="Close" onClick={() => set({ right: null })}>
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="chat-scroll" ref={scroller}>
        {(needsSetup || showSetup) && (
          <Setup
            status={status}
            onSaved={() => {
              refresh();
              setShowSetup(false);
            }}
          />
        )}
        {!needsSetup && chat.length === 0 && !showSetup && (
          <div className="chat-empty">
            Ask about your code. The assistant works in your live image: it can evaluate, compile, read files, run tests and
            drive the debugger.
          </div>
        )}
        {chat.map((item) => (
          <Message key={item.id} item={item} />
        ))}
        {busy && <div className="chat-working">Working…</div>}
      </div>
      <div className="chat-input">
        <textarea
          rows={3}
          placeholder={needsSetup ? "Connect Claude above to start" : "Ask Claude…  ⏎ to send"}
          value={text}
          disabled={needsSetup}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-input-bar">
          <label className="toggle" title="Send the current file and the form at the cursor">
            <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} /> Include current form
          </label>
          <span className="grow" />
          {busy ? (
            <button className="btn danger" onClick={() => actions.request({ type: "assistantCancel" })}>
              <Icon name="stop" size={10} /> Stop
            </button>
          ) : (
            <button className="btn primary" disabled={!text.trim() || needsSetup} onClick={send}>
              Send
            </button>
          )}
        </div>
      </div>
    </>
  );
}
