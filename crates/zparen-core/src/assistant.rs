use crate::sexp::Sexp;
use crate::swank::{SENT, Thread};
use crate::tools;
use crate::workbench::Workbench;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use ts_rs::TS;

/// The models offered for each provider, the default first. Any other name can be typed in.
const CLAUDE_MODELS: [&str; 4] = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"];
const OPENAI_MODELS: [&str; 4] = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"];
const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const OAUTH_BETA: &str = "oauth-2025-04-20";
const MAX_TOKENS: u32 = 64000;
const MAX_TOOL_ROUNDS: usize = 40;

const SYSTEM: &str = "You are the assistant inside ZParen, a Common Lisp IDE on SBCL. You work in the user's \
running Lisp image through tools, while the user watches and edits the same image. Inspect before you change: read \
files, describe symbols and evaluate small experiments to ground your answers. Define or fix code with compile_form, \
so compiler notes come back to you. When the debugger opens, read it with debugger_state and choose a restart with \
invoke_restart rather than leaving it open. To fix code in the user's files, change the file with edit_file, then \
compile the changed form with compile_form so its notes come back to you. When you only propose code, put it in a \
fenced ```lisp block, starting with a comment line naming the file, so the user can insert it. Keep answers short and \
concrete.";

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum AssistantEvent {
    TurnStarted,
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Thinking { text: String },
    #[serde(rename_all = "camelCase")]
    ToolStarted { id: String, name: String, input: String },
    #[serde(rename_all = "camelCase")]
    ToolFinished { id: String, ok: bool, output: String },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
    #[serde(rename_all = "camelCase")]
    TurnFinished { stop_reason: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditorContext {
    pub file: Option<String>,
    pub package: Option<String>,
    pub form: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Provider {
    Claude,
    OpenAI,
}

/// Which provider answers, and the model chosen for each. Kept in `assistant.json`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct AssistantConfig {
    pub provider: Provider,
    pub claude_model: String,
    pub openai_model: String,
}

impl Default for AssistantConfig {
    fn default() -> Self {
        AssistantConfig { provider: Provider::Claude, claude_model: CLAUDE_MODELS[0].into(), openai_model: OPENAI_MODELS[0].into() }
    }
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProviderStatus {
    pub configured: bool,
    pub source: Option<CredentialSource>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AssistantStatus {
    pub busy: bool,
    pub config: AssistantConfig,
    pub claude: ProviderStatus,
    pub openai: ProviderStatus,
}

#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CredentialSource {
    Settings,
    Environment,
    Ant,
}

#[derive(Debug, Clone)]
enum Credential {
    ApiKey(String),
    OAuth(String),
}

/// The turn being answered, and the Lisp requests its tools have sent.
struct Running {
    task: JoinHandle<()>,
    sent: Arc<std::sync::Mutex<Vec<u64>>>,
    wb: Weak<Workbench>,
}

pub struct Assistant {
    http: reqwest::Client,
    data_dir: PathBuf,
    base_url: String,
    openai_url: String,
    history: Mutex<Vec<Value>>,
    running: Mutex<Option<Running>>,
    /// Where conversations are kept, one JSON file each, so they outlive the app.
    sessions_dir: PathBuf,
    /// The id of the conversation `history` belongs to.
    session: Mutex<String>,
}

/// A saved conversation, as the history menu lists it.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionInfo {
    pub id: String,
    /// The start of its first message.
    pub title: String,
    /// The root of the project it was in, if one was open.
    pub project: Option<String>,
    /// When it last changed, in seconds since 1970.
    pub updated: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    #[serde(flatten)]
    info: SessionInfo,
    messages: Vec<Value>,
}

fn new_session_id() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    format!("{}", now.as_millis())
}

/// The words of a user message, without the editor context sent before them.
fn message_text(message: &Value) -> Option<String> {
    let content = message.get("content")?.as_array()?;
    if content.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")) {
        return None;
    }
    content.iter().rev().find_map(|b| b.get("text").and_then(Value::as_str)).map(String::from)
}

type Emit = Arc<dyn Fn(AssistantEvent) + Send + Sync>;

impl Assistant {
    pub fn new(data_dir: &Path) -> Assistant {
        Assistant {
            http: reqwest::Client::new(),
            data_dir: data_dir.into(),
            base_url: std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| "https://api.anthropic.com".into()),
            openai_url: std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into()),
            history: Mutex::new(Vec::new()),
            running: Mutex::new(None),
            sessions_dir: data_dir.join("assistant-sessions"),
            session: Mutex::new(new_session_id()),
        }
    }

    /// Writes the current conversation, when it has a message, for the history menu to reopen.
    async fn save(&self, project: Option<String>) {
        let messages = self.history.lock().await.clone();
        let Some(title) = messages.iter().find(|m| m.get("role").and_then(Value::as_str) == Some("user")).and_then(message_text) else {
            return;
        };
        let title: String = title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
        let id = self.session.lock().await.clone();
        let updated = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
        let saved = SavedSession { info: SessionInfo { id: id.clone(), title, project, updated }, messages };
        let _ = std::fs::create_dir_all(&self.sessions_dir);
        if let Ok(json) = serde_json::to_vec(&saved) {
            let _ = std::fs::write(self.sessions_dir.join(format!("{id}.json")), json);
        }
    }

    /// Saved conversations, the latest first.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        let mut out: Vec<SessionInfo> = std::fs::read_dir(&self.sessions_dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<SavedSession>(&std::fs::read(e.path()).ok()?).ok())
            .map(|s| s.info)
            .collect();
        out.sort_by(|a, b| b.updated.cmp(&a.updated));
        out
    }

    /// Continues a saved conversation: its messages become the history the next turn sends.
    pub async fn open_session(&self, id: &str) -> Result<Vec<Value>, String> {
        self.cancel().await;
        let bytes = std::fs::read(self.sessions_dir.join(format!("{id}.json"))).map_err(|_| "That conversation is gone.".to_string())?;
        let saved: SavedSession = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        *self.history.lock().await = saved.messages.clone();
        *self.session.lock().await = saved.info.id;
        Ok(saved.messages)
    }

    pub async fn delete_session(&self, id: &str) {
        let _ = std::fs::remove_file(self.sessions_dir.join(format!("{id}.json")));
        if *self.session.lock().await == id {
            self.history.lock().await.clear();
            *self.session.lock().await = new_session_id();
        }
    }

    fn key_file(&self, provider: Provider) -> PathBuf {
        self.data_dir.join(match provider {
            Provider::Claude => "anthropic-api-key",
            Provider::OpenAI => "openai-api-key",
        })
    }

    pub fn config(&self) -> AssistantConfig {
        std::fs::read(self.data_dir.join("assistant.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn configure(&self, config: &AssistantConfig) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::write(self.data_dir.join("assistant.json"), serde_json::to_vec(config)?)
    }

    async fn credential(&self, provider: Provider) -> Option<(Credential, CredentialSource)> {
        if let Ok(k) = std::fs::read_to_string(self.key_file(provider)) {
            if !k.trim().is_empty() {
                return Some((Credential::ApiKey(k.trim().into()), CredentialSource::Settings));
            }
        }
        let env = match provider {
            Provider::Claude => "ANTHROPIC_API_KEY",
            Provider::OpenAI => "OPENAI_API_KEY",
        };
        if let Ok(k) = std::env::var(env) {
            if !k.is_empty() {
                return Some((Credential::ApiKey(k), CredentialSource::Environment));
            }
        }
        if provider == Provider::OpenAI {
            return None;
        }
        if let Ok(t) = std::env::var("ANTHROPIC_AUTH_TOKEN") {
            if !t.is_empty() {
                return Some((Credential::OAuth(t), CredentialSource::Environment));
            }
        }
        let out = tokio::process::Command::new("ant")
            .args(["auth", "print-credentials", "--access-token"])
            .output()
            .await
            .ok()?;
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !token.is_empty()).then_some((Credential::OAuth(token), CredentialSource::Ant))
    }

    pub async fn status(&self) -> AssistantStatus {
        AssistantStatus {
            busy: self.running.lock().await.as_ref().is_some_and(|r| !r.task.is_finished()),
            config: self.config(),
            claude: self.provider_status(Provider::Claude, &CLAUDE_MODELS).await,
            openai: self.provider_status(Provider::OpenAI, &OPENAI_MODELS).await,
        }
    }

    async fn provider_status(&self, provider: Provider, models: &[&str]) -> ProviderStatus {
        let source = self.credential(provider).await.map(|(_, s)| s);
        ProviderStatus { configured: source.is_some(), source, models: models.iter().map(|m| m.to_string()).collect() }
    }

    pub fn set_key(&self, provider: Provider, key: &str) -> std::io::Result<()> {
        let file = self.key_file(provider);
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::write(&file, key.trim())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    /// Starts a new conversation; the one before stays saved.
    pub async fn reset(&self) {
        self.cancel().await;
        self.history.lock().await.clear();
        *self.session.lock().await = new_session_id();
    }

    /// Stops the turn being answered, and the Lisp work its tools started.
    pub async fn cancel(&self) {
        let Some(run) = self.running.lock().await.take() else { return };
        run.task.abort();
        let _ = run.task.await;
        let sent = std::mem::take(&mut *run.sent.lock().unwrap());
        if let Some(wb) = run.wb.upgrade()
            && let Ok(session) = wb.session().await
        {
            let ids = session.conn.unanswered(&sent).await;
            if !ids.is_empty() {
                let ids = Sexp::list(std::iter::once(Sexp::sym("cl:list")).chain(ids.into_iter().map(|id| Sexp::Int(id as i64))));
                let _ = session.conn.rex(Sexp::list([Sexp::sym("zparen::abort-requests"), ids]), "COMMON-LISP-USER", Thread::T).await;
            }
        }
        close_tool_calls(&mut *self.history.lock().await);
    }

    /// Starts a turn in the background. Events stream through `emit`.
    pub async fn send(
        self: &Arc<Self>,
        wb: Arc<Workbench>,
        text: String,
        context: Option<EditorContext>,
        project: Option<String>,
        emit: Emit,
    ) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.as_ref().is_some_and(|r| !r.task.is_finished()) {
            return Err("the assistant is still answering".into());
        }
        let me = self.clone();
        let sent = Arc::default();
        let weak = Arc::downgrade(&wb);
        let task = tokio::spawn(SENT.scope(Arc::clone(&sent), async move {
            emit(AssistantEvent::TurnStarted);
            let stop_reason = match me.turn(&wb, user_message(&text, context.as_ref()), &emit).await {
                Ok(reason) => reason,
                Err(message) => {
                    emit(AssistantEvent::Error { message });
                    "error".into()
                }
            };
            me.save(project).await;
            emit(AssistantEvent::TurnFinished { stop_reason });
        }));
        *running = Some(Running { task, sent, wb: weak });
        Ok(())
    }

    async fn turn(&self, wb: &Arc<Workbench>, user: Value, emit: &Emit) -> Result<String, String> {
        let config = self.config();
        let (cred, _) = self.credential(config.provider).await.ok_or(match config.provider {
            Provider::Claude => "No Anthropic credentials. Add an API key in the assistant settings, set ANTHROPIC_API_KEY, or run `ant auth login`.",
            Provider::OpenAI => "No OpenAI API key. Add one in the assistant settings or set OPENAI_API_KEY.",
        })?;
        // History only grows: we append the user's message and each response
        // whole, thinking blocks included, so cached prefixes stay valid.
        self.history.lock().await.push(user);
        for _ in 0..MAX_TOOL_ROUNDS {
            let messages = self.history.lock().await.clone();
            let reply = match config.provider {
                Provider::Claude => self.stream_message(&cred, &config.claude_model, &claude_messages(&messages), emit).await?,
                Provider::OpenAI => self.stream_openai(&cred, &config.openai_model, &messages, emit).await?,
            };
            match reply.stop_reason.as_str() {
                // A declined turn may stop mid-output, so its partial content is dropped.
                "refusal" => return Err(format!("The model declined this request{}", reply.refusal_note())),
                _ => self.history.lock().await.push(json!({ "role": "assistant", "content": reply.content })),
            }
            let calls = reply.tool_uses();
            if calls.is_empty() {
                return Ok(reply.stop_reason);
            }
            let truncated = reply.stop_reason == "max_tokens";
            let results = futures::future::join_all(calls.into_iter().map(|call| run_tool(wb, call, truncated, emit))).await;
            self.history.lock().await.push(json!({ "role": "user", "content": results }));
            if truncated {
                return Err("The response hit the output limit in the middle of a tool call.".into());
            }
        }
        Err(format!("Stopped after {MAX_TOOL_ROUNDS} rounds of tool calls."))
    }

    fn body(&self, model: &str, messages: &[Value]) -> Value {
        let tools: Vec<Value> = tools::specs()
            .into_iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                    "eager_input_streaming": true,
                })
            })
            .collect();
        json!({
            "model": model,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            "system": [{ "type": "text", "text": SYSTEM, "cache_control": { "type": "ephemeral" } }],
            "tools": tools,
            "messages": messages,
            "thinking": { "type": "adaptive", "display": "summarized" },
            "output_config": { "effort": "high" },
            "fallbacks": "default",
            "cache_control": { "type": "ephemeral" },
        })
    }

    async fn stream_message(&self, cred: &Credential, model: &str, messages: &[Value], emit: &Emit) -> Result<Reply, String> {
        let mut betas = vec![FALLBACK_BETA];
        let mut req = self
            .http
            .post(format!("{}/v1/messages", self.base_url))
            .header("content-type", "application/json")
            .header("anthropic-version", API_VERSION);
        match cred {
            Credential::ApiKey(k) => req = req.header("x-api-key", k),
            Credential::OAuth(t) => {
                req = req.header("authorization", format!("Bearer {t}"));
                betas.push(OAUTH_BETA);
            }
        }
        let resp = req
            .header("anthropic-beta", betas.join(","))
            .json(&self.body(model, messages))
            .send()
            .await
            .map_err(|e| format!("could not reach the Anthropic API: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(String::from))
                .unwrap_or(body);
            return Err(format!("Anthropic API error {status}: {message}"));
        }
        let mut stream = resp.bytes_stream();
        let mut sse = SseBuffer::default();
        let mut reply = Reply::default();
        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("stream interrupted: {e}"))?;
            for data in sse.push(&chunk) {
                let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
                reply.apply(&event, emit)?;
            }
        }
        Ok(reply)
    }

    /// One OpenAI Responses call. Text streams to `emit`; the reply is read
    /// from the finished response, its output items kept whole for the next call.
    async fn stream_openai(&self, cred: &Credential, model: &str, messages: &[Value], emit: &Emit) -> Result<Reply, String> {
        let (Credential::ApiKey(key) | Credential::OAuth(key)) = cred;
        let tools: Vec<Value> = tools::specs()
            .into_iter()
            .map(|t| json!({ "type": "function", "name": t.name, "description": t.description, "parameters": t.input_schema, "strict": false }))
            .collect();
        let body = json!({
            "model": model,
            "instructions": SYSTEM,
            "input": openai_input(messages),
            "tools": tools,
            "stream": true,
            "store": false,
            "include": ["reasoning.encrypted_content"],
            "reasoning": { "effort": "high" },
            "max_output_tokens": MAX_TOKENS,
        });
        let resp = self
            .http
            .post(format!("{}/responses", self.openai_url))
            .bearer_auth(key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("could not reach the OpenAI API: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            let message = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(String::from))
                .unwrap_or(body);
            return Err(format!("OpenAI API error {status}: {message}"));
        }
        let mut stream = resp.bytes_stream();
        let mut sse = SseBuffer::default();
        use futures::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("stream interrupted: {e}"))?;
            for data in sse.push(&chunk) {
                let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
                match event["type"].as_str().unwrap_or_default() {
                    "response.output_text.delta" => emit(AssistantEvent::Text { text: event["delta"].as_str().unwrap_or_default().into() }),
                    "response.completed" | "response.incomplete" => return Ok(openai_reply(&event["response"])),
                    "response.failed" => return Err(event["response"]["error"]["message"].as_str().unwrap_or("the response failed").into()),
                    "error" => return Err(event["message"].as_str().unwrap_or("stream error").into()),
                    _ => {}
                }
            }
        }
        Err("The OpenAI stream ended before the response finished.".into())
    }
}

/// Blocks in the history holding an OpenAI response's output items, replayed
/// to OpenAI as they came and left out for Claude.
const OPENAI_OUTPUT: &str = "openai_output";

/// The history as Claude takes it: without OpenAI's own items.
fn claude_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|m| {
            let mut m = m.clone();
            if let Some(content) = m["content"].as_array_mut() {
                content.retain(|b| b["type"] != OPENAI_OUTPUT);
                if content.is_empty() {
                    return None;
                }
            }
            Some(m)
        })
        .collect()
}

/// The history as OpenAI Responses input items. Claude's thinking is left out.
fn openai_input(messages: &[Value]) -> Vec<Value> {
    let mut items = Vec::new();
    for m in messages {
        let content = m["content"].as_array().cloned().unwrap_or_default();
        if m["role"] == "user" {
            let mut texts = Vec::new();
            for b in &content {
                match b["type"].as_str() {
                    Some("tool_result") => {
                        let output = match &b["content"] {
                            Value::String(s) => s.clone(),
                            Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect(),
                            _ => String::new(),
                        };
                        items.push(json!({ "type": "function_call_output", "call_id": b["tool_use_id"], "output": output }));
                    }
                    Some("text") => texts.push(json!({ "type": "input_text", "text": b["text"] })),
                    _ => {}
                }
            }
            if !texts.is_empty() {
                items.push(json!({ "role": "user", "content": texts }));
            }
        } else if let Some(own) = content.iter().find(|b| b["type"] == OPENAI_OUTPUT) {
            items.extend(own["items"].as_array().cloned().unwrap_or_default());
        } else {
            for b in &content {
                match b["type"].as_str() {
                    Some("text") => items.push(json!({ "role": "assistant", "content": [{ "type": "output_text", "text": b["text"] }] })),
                    Some("tool_use") => items.push(json!({ "type": "function_call", "call_id": b["id"], "name": b["name"], "arguments": b["input"].to_string() })),
                    _ => {}
                }
            }
        }
    }
    items
}

/// A finished Responses object as a reply in the history's own blocks.
fn openai_reply(response: &Value) -> Reply {
    let output = response["output"].as_array().cloned().unwrap_or_default();
    let mut reply = Reply::default();
    let mut refusal = None;
    for item in &output {
        match item["type"].as_str() {
            Some("message") => {
                for part in item["content"].as_array().into_iter().flatten() {
                    match part["type"].as_str() {
                        Some("output_text") if part["text"].as_str().is_some_and(|t| !t.is_empty()) => {
                            reply.content.push(json!({ "type": "text", "text": part["text"] }));
                            reply.partial_json.push(String::new());
                        }
                        Some("refusal") => refusal = Some(part["refusal"].clone()),
                        _ => {}
                    }
                }
            }
            Some("function_call") => {
                let raw = item["arguments"].as_str().unwrap_or_default().to_string();
                let input = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}));
                reply.content.push(json!({ "type": "tool_use", "id": item["call_id"], "name": item["name"], "input": input }));
                reply.partial_json.push(raw);
            }
            _ => {}
        }
    }
    reply.content.push(json!({ "type": OPENAI_OUTPUT, "items": output }));
    reply.partial_json.push(String::new());
    let incomplete = response["incomplete_details"]["reason"].as_str();
    reply.stop_reason = if refusal.is_some() || incomplete == Some("content_filter") {
        reply.stop_details = refusal.map(|r| json!({ "explanation": r }));
        "refusal"
    } else if incomplete == Some("max_output_tokens") {
        "max_tokens"
    } else if reply.content.iter().any(|b| b["type"] == "tool_use") {
        "tool_use"
    } else {
        "end_turn"
    }
    .into();
    reply
}

fn user_message(text: &str, context: Option<&EditorContext>) -> Value {
    let mut content = Vec::new();
    if let Some(c) = context {
        let mut note = String::from("Editor context:");
        if let Some(f) = &c.file {
            note.push_str(&format!("\nFile: {f}"));
        }
        if let Some(p) = &c.package {
            note.push_str(&format!("\nPackage: {p}"));
        }
        if let Some(form) = &c.form {
            note.push_str(&format!("\nForm at the cursor:\n```lisp\n{form}\n```"));
        }
        content.push(json!({ "type": "text", "text": note }));
    }
    content.push(json!({ "type": "text", "text": text }));
    json!({ "role": "user", "content": content })
}

/// A turn stopped while its tools ran leaves their calls without results,
/// which the next request may not; each gets one saying it was stopped.
fn close_tool_calls(history: &mut Vec<Value>) {
    let Some(last) = history.last().filter(|m| m["role"] == "assistant") else { return };
    let results: Vec<Value> = last["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "tool_use")
        .map(|b| json!({ "type": "tool_result", "tool_use_id": b["id"], "content": "Stopped by the user before it finished.", "is_error": true }))
        .collect();
    if !results.is_empty() {
        history.push(json!({ "role": "user", "content": results }));
    }
}

async fn run_tool(wb: &Arc<Workbench>, call: ToolCall, truncated: bool, emit: &Emit) -> Value {
    emit(AssistantEvent::ToolStarted { id: call.id.clone(), name: call.name.clone(), input: call.raw.clone() });
    let result = if truncated {
        Err("The tool input was cut off by the output limit, so the tool did not run.".to_string())
    } else {
        match &call.input {
            Ok(args) => tools::call(wb, &call.name, args.clone()).await,
            Err(_) => Err(json!({ "INVALID_JSON": call.raw }).to_string()),
        }
    };
    let (ok, output) = match result {
        Ok(o) => (true, o),
        Err(e) => (false, e),
    };
    emit(AssistantEvent::ToolFinished { id: call.id.clone(), ok, output: output.clone() });
    json!({ "type": "tool_result", "tool_use_id": call.id, "content": output, "is_error": !ok })
}

struct ToolCall {
    id: String,
    name: String,
    raw: String,
    input: Result<Value, String>,
}

#[derive(Default)]
struct Reply {
    content: Vec<Value>,
    partial_json: Vec<String>,
    stop_reason: String,
    stop_details: Option<Value>,
}

impl Reply {
    /// Folds one SSE event in. An `error` event fails the stream; an event
    /// with an unknown shape is skipped, as the API may add new ones.
    fn apply(&mut self, event: &Value, emit: &Emit) -> Result<(), String> {
        if event["type"] == "error" {
            return Err(event["error"]["message"].as_str().unwrap_or("stream error").to_string());
        }
        self.fold(event, emit);
        Ok(())
    }

    fn fold(&mut self, event: &Value, emit: &Emit) -> Option<()> {
        match event["type"].as_str()? {
            "content_block_start" => {
                let i = event["index"].as_u64()? as usize;
                while self.content.len() <= i {
                    self.content.push(Value::Null);
                    self.partial_json.push(String::new());
                }
                self.content[i] = event["content_block"].clone();
            }
            "content_block_delta" => {
                let i = event["index"].as_u64()? as usize;
                let delta = &event["delta"];
                let block = self.content.get_mut(i)?;
                match delta["type"].as_str()? {
                    "text_delta" => {
                        let t = delta["text"].as_str().unwrap_or_default();
                        append(block, "text", t);
                        emit(AssistantEvent::Text { text: t.into() });
                    }
                    "thinking_delta" => {
                        let t = delta["thinking"].as_str().unwrap_or_default();
                        append(block, "thinking", t);
                        emit(AssistantEvent::Thinking { text: t.into() });
                    }
                    "signature_delta" => append(block, "signature", delta["signature"].as_str().unwrap_or_default()),
                    "input_json_delta" => self.partial_json[i].push_str(delta["partial_json"].as_str().unwrap_or_default()),
                    "citations_delta" => {
                        if let Some(list) = block.get_mut("citations").and_then(Value::as_array_mut) {
                            list.push(delta["citation"].clone());
                        } else {
                            block["citations"] = json!([delta["citation"].clone()]);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let i = event["index"].as_u64()? as usize;
                let block = self.content.get_mut(i)?;
                if block["type"] == "tool_use" {
                    let raw = &self.partial_json[i];
                    block["input"] = if raw.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(raw).unwrap_or_else(|_| json!({}))
                    };
                }
            }
            "message_delta" => {
                if let Some(r) = event["delta"]["stop_reason"].as_str() {
                    self.stop_reason = r.into();
                }
                if !event["delta"]["stop_details"].is_null() {
                    self.stop_details = Some(event["delta"]["stop_details"].clone());
                }
            }
            _ => {}
        }
        Some(())
    }

    fn tool_uses(&self) -> Vec<ToolCall> {
        self.content
            .iter()
            .zip(&self.partial_json)
            .filter(|(b, _)| b["type"] == "tool_use")
            .map(|(b, raw)| {
                let raw = if raw.trim().is_empty() { "{}".to_string() } else { raw.clone() };
                ToolCall {
                    id: b["id"].as_str().unwrap_or_default().into(),
                    name: b["name"].as_str().unwrap_or_default().into(),
                    input: serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()).and_then(|v| {
                        if v.is_object() { Ok(v) } else { Err("tool input is not an object".into()) }
                    }),
                    raw,
                }
            })
            .collect()
    }

    fn refusal_note(&self) -> String {
        match self.stop_details.as_ref().and_then(|d| d["explanation"].as_str()) {
            Some(e) => format!(": {e}"),
            None => ".".into(),
        }
    }
}

fn append(block: &mut Value, field: &str, text: &str) {
    let current = block[field].as_str().unwrap_or_default().to_string();
    block[field] = Value::String(current + text);
}

#[derive(Default)]
struct SseBuffer {
    pending: String,
}

impl SseBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.push_str(&String::from_utf8_lossy(bytes).replace("\r\n", "\n"));
        let mut out = Vec::new();
        while let Some(end) = self.pending.find("\n\n") {
            let frame: String = self.pending.drain(..end + 2).collect();
            let data: Vec<&str> = frame.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect();
            if !data.is_empty() {
                out.push(data.join("\n"));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_frames_split_across_chunks() {
        let mut b = SseBuffer::default();
        assert!(b.push(b"event: a\ndata: {\"x\"").is_empty());
        assert_eq!(b.push(b":1}\n\nevent: b\ndata: 2\n\n"), vec!["{\"x\":1}".to_string(), "2".to_string()]);
    }

    #[test]
    fn accumulates_blocks_like_an_unstreamed_reply() {
        let emit: Emit = Arc::new(|_| {});
        let mut r = Reply::default();
        for e in [
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"eval","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"form\":"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"(+ 1 2)\"}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
        ] {
            assert!(r.apply(&e, &emit).is_ok());
        }
        assert_eq!(r.content[0], json!({"type":"thinking","thinking":"hmm","signature":"sig"}));
        assert_eq!(r.content[1]["input"], json!({"form":"(+ 1 2)"}));
        let calls = r.tool_uses();
        assert_eq!(calls[0].input, Ok(json!({"form":"(+ 1 2)"})));
    }

    #[test]
    fn invalid_tool_json_is_reported_not_run() {
        let emit: Emit = Arc::new(|_| {});
        let mut r = Reply::default();
        r.apply(&json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"eval","input":{}}}), &emit).unwrap();
        r.apply(&json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"form\": \"(a"}}), &emit).unwrap();
        assert!(r.tool_uses()[0].input.is_err());
    }
}
