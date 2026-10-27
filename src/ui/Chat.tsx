import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as actions from "../actions";
import { editorContext, insertAtCursor } from "../editor/commands";
import type { AssistantStatus } from "../protocol/AssistantStatus";
import type { McpInfo } from "../protocol/McpInfo";
import type { Provider } from "../protocol/Provider";
import { set, useStore, type ChatItem } from "../store";
import { Icon } from "./Icon";
import type { SessionInfo } from "../protocol/SessionInfo";

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

const NAMES: Record<Provider, string> = { claude: "Claude", openai: "OpenAI" };

/** The active provider's model, chosen among both providers' models. */
function ModelMenu({ status, onChange }: { status: AssistantStatus; onChange: (s: AssistantStatus) => void }) {
  const { config } = status;
  const models = (p: Provider) => {
    const chosen = p === "claude" ? config.claudeModel : config.openaiModel;
    return status[p].models.includes(chosen) ? status[p].models : [chosen, ...status[p].models];
  };
  return (
    <select
      className="select chat-model"
      aria-label="Model"
      value={`${config.provider}:${config.provider === "claude" ? config.claudeModel : config.openaiModel}`}
      onChange={(e) => {
        const [provider, model] = e.target.value.split(/:(.*)/) as [Provider, string];
        const next = { ...config, provider, ...(provider === "claude" ? { claudeModel: model } : { openaiModel: model }) };
        actions.request({ type: "assistantConfigure", config: next }).then((r) => r.type === "assistant" && onChange(r));
      }}
    >
      {(["claude", "openai"] as const).map((p) => (
        <optgroup key={p} label={NAMES[p]}>
          {models(p).map((m) => (
            <option key={m} value={`${p}:${m}`}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function Setup({ status, onSaved }: { status: AssistantStatus | null; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [mcp, setMcp] = useState<McpInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    actions.request({ type: "mcpInfo" }).then((r) => r.type === "mcp" && setMcp(r.info));
  }, []);
  const provider = status?.config.provider ?? "claude";
  return (
    <div className="chat-setup">
      {status && !status[provider].configured && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await actions.request({ type: "assistantSetKey", provider, key });
            setKey("");
            onSaved();
          }}
        >
          <h3>Connect {NAMES[provider]}</h3>
          {provider === "claude" ? (
            <p>
              Paste an Anthropic API key. ZParen also uses <code>ANTHROPIC_API_KEY</code> or an <code>ant auth login</code> profile
              when present. The key is stored only on this Mac.
            </p>
          ) : (
            <p>
              Paste an OpenAI API key. ZParen also uses <code>OPENAI_API_KEY</code> when present. The key is stored only on this Mac.
            </p>
          )}
          <input type="password" placeholder={provider === "claude" ? "sk-ant-…" : "sk-…"} value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn primary" disabled={!key.trim()}>
            Save key
          </button>
        </form>
      )}
      <div className="chat-mcp">
        <h3>Use Claude Code with this image</h3>
        <p>ZParen runs an MCP server, so an agent in your terminal can evaluate, compile and debug in this Lisp.</p>
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

let restored = false;

/** Opening the assistant the first time reopens the project's latest conversation, if the chat is empty. */
async function restoreLatest() {
  if (restored) return;
  restored = true;
  if (useStore.getState().chat.length || useStore.getState().chatBusy) return;
  const root = useStore.getState().status.project?.root ?? null;
  const latest = (await actions.assistantSessions()).find((s) => s.project === root);
  if (latest && useStore.getState().chat.length === 0) await actions.openAssistantSession(latest.id);
}

function ago(seconds: number) {
  const d = Date.now() / 1000 - seconds;
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}

/** Saved conversations, the latest first, to continue or delete. */
function SessionList({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const root = useStore((s) => s.status.project?.root ?? null);
  const load = () => actions.assistantSessions().then(setSessions);
  useEffect(() => void load(), []);
  return (
    <div className="session-list" role="menu" aria-label="Earlier conversations">
      {sessions === null ? (
        <div className="session-note">Loading…</div>
      ) : sessions.length === 0 ? (
        <div className="session-note">No earlier conversations yet.</div>
      ) : (
        sessions.map((s) => (
          <div key={s.id} className="session">
            <button role="menuitem" className="session-open" title={s.title} onClick={() => void actions.openAssistantSession(s.id).then(onClose)}>
              <span className="session-title">{s.title}</span>
              <span className="session-meta">
                {s.project && s.project !== root ? `${s.project.split("/").pop()} · ` : ""}
                {ago(s.updated)}
              </span>
            </button>
            <button className="icon-btn" title="Delete this conversation" onClick={() => void actions.deleteAssistantSession(s.id).then(load)}>
              <Icon name="x" size={10} />
            </button>
          </div>
        ))
      )}
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
  const [showHistory, setShowHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const settingsOpen = useStore((s) => s.settingsOpen);
  const refresh = () => actions.request({ type: "assistantStatus" }).then((r) => r.type === "assistant" && setStatus(r));
  useEffect(() => void restoreLatest(), []);
  // Settings may have changed the model or a key.
  useEffect(() => {
    if (!settingsOpen) void refresh();
  }, [settingsOpen]);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [chat]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    await actions.askAssistant(t, withContext ? editorContext() : null);
  };

  const needsSetup = status !== null && !status[status.config.provider].configured;
  const name = NAMES[status?.config.provider ?? "claude"];

  return (
    <>
      <div className="right-header">
        <Icon name="sparkle" />
        <span className="title">Assistant</span>
        <button className="icon-btn" title="Earlier conversations" aria-expanded={showHistory} onClick={() => setShowHistory(!showHistory)}>
          <Icon name="history" size={13} />
        </button>
        <button className="icon-btn" title="New conversation" onClick={() => (actions.request({ type: "assistantReset" }), set({ chat: [] }), setShowHistory(false))}>
          <Icon name="plus" size={12} />
        </button>
        <button className="icon-btn" title="Assistant settings" onClick={() => setShowSetup(!showSetup)}>
          <Icon name="gear" size={13} />
        </button>
        <button className="icon-btn" title="Close" onClick={() => set({ right: null })}>
          <Icon name="x" size={12} />
        </button>
      </div>
      {showHistory && <SessionList onClose={() => setShowHistory(false)} />}
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
          placeholder={needsSetup ? `Connect ${name} above to start` : `Ask ${name}…  ⏎ to send`}
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
          {status && <ModelMenu status={status} onChange={setStatus} />}
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
