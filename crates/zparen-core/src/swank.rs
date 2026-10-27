use crate::sexp::Sexp;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use ts_rs::TS;
use tokio::net::TcpStream;
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::{Mutex, broadcast, oneshot};

pub fn encode(msg: &Sexp) -> Vec<u8> {
    let body = msg.to_string().into_bytes();
    let mut out = format!("{:06x}", body.len()).into_bytes();
    out.extend(body);
    out
}

pub async fn read_frame(r: &mut (impl AsyncRead + Unpin)) -> std::io::Result<String> {
    let mut header = [0u8; 6];
    r.read_exact(&mut header).await?;
    let len = std::str::from_utf8(&header)
        .ok()
        .and_then(|h| usize::from_str_radix(h, 16).ok())
        .ok_or_else(|| std::io::Error::other(format!("bad swank header {header:?}")))?;
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    String::from_utf8(body).map_err(std::io::Error::other)
}

/// The thread a request runs in. `T` asks Swank for a fresh worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, serde::Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Thread {
    T,
    Repl,
    Id(i64),
}

impl Thread {
    fn to_sexp(self) -> Sexp {
        match self {
            Thread::T => Sexp::t(),
            Thread::Repl => Sexp::kw("repl-thread"),
            Thread::Id(i) => Sexp::Int(i),
        }
    }
    fn from_sexp(s: &Sexp) -> Thread {
        match s {
            Sexp::Int(i) => Thread::Id(*i),
            Sexp::Kw(k) if k == "repl-thread" => Thread::Repl,
            _ => Thread::T,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Restart {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub index: i64,
    pub description: String,
    pub restartable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Debugger {
    pub thread: Thread,
    pub level: i64,
    pub condition: String,
    pub condition_type: String,
    pub restarts: Vec<Restart>,
    pub frames: Vec<Frame>,
    /// The single stepper stopped before a form, which frame 0's source shows.
    pub stepping: bool,
}

/// Everything Swank sends that is not a reply to a request we made.
#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Output { text: String, target: Option<String> },
    #[serde(rename_all = "camelCase")]
    PresentationStart { id: i64 },
    #[serde(rename_all = "camelCase")]
    PresentationEnd { id: i64 },
    #[serde(rename_all = "camelCase")]
    NewPackage { name: String, prompt: String },
    Debug(Debugger),
    #[serde(rename_all = "camelCase")]
    DebugActivate { thread: Thread, level: i64 },
    #[serde(rename_all = "camelCase")]
    DebugReturn { thread: Thread, level: i64, stepping: bool },
    #[serde(rename_all = "camelCase")]
    ReadString { thread: Thread, tag: i64 },
    #[serde(rename_all = "camelCase")]
    ReadAborted { thread: Thread, tag: i64 },
    #[serde(rename_all = "camelCase")]
    YOrNP { thread: Thread, tag: i64, question: String },
    #[serde(rename_all = "camelCase")]
    BackgroundMessage { text: String },
    #[serde(rename_all = "camelCase")]
    Inspect { thread: Thread, tag: i64 },
    #[serde(rename_all = "camelCase")]
    ProtocolError { message: String },
    #[serde(rename_all = "camelCase")]
    IndentationUpdate { specs: Vec<IndentSpec> },
    /// A message to the client end of a channel, such as an extra REPL's output.
    #[serde(rename_all = "camelCase")]
    Channel { channel: i64, message: ChannelMessage },
    Disconnected,
}

/// What swank-mrepl sends an extra REPL.
#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChannelMessage {
    #[serde(rename_all = "camelCase")]
    WriteString { text: String },
    /// The printed values of an evaluation, one per line.
    #[serde(rename_all = "camelCase")]
    WriteResult { text: String },
    /// The REPL is ready for input in `package`.
    #[serde(rename_all = "camelCase")]
    Prompt { package: String },
    EvaluationAborted,
    /// True while Lisp reads standard input, false when it evaluates again.
    #[serde(rename_all = "camelCase")]
    ReadMode { reading: bool },
    #[serde(rename_all = "camelCase")]
    Other { text: String },
}

/// How Swank says to indent a macro: `spec` is SLIME's indentation spec,
/// such as 1, or (4 &body), as JSON.
#[derive(Debug, Clone, Serialize, PartialEq, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct IndentSpec {
    pub name: String,
    pub spec: serde_json::Value,
    pub packages: Vec<String>,
}

fn sexp_json(s: &Sexp) -> serde_json::Value {
    use serde_json::Value;
    match s {
        Sexp::Nil => Value::Null,
        Sexp::Int(i) => Value::from(*i),
        Sexp::Num(n) | Sexp::Str(n) | Sexp::Sym(n) => Value::String(n.clone()),
        Sexp::Kw(k) => Value::String(format!(":{k}")),
        Sexp::List(v) => Value::Array(v.iter().map(sexp_json).collect()),
        Sexp::Dotted(v, tail) => Value::Array(v.iter().chain([tail.as_ref()]).map(sexp_json).collect()),
    }
}

#[derive(Debug, PartialEq)]
pub enum Message {
    Return { id: u64, result: Result<Sexp, String> },
    Ping { thread: Sexp, tag: Sexp },
    Eval { thread: Sexp, tag: Sexp },
    /// REPL output that blocks its writer until we send `:write-done`.
    FlowControlledOutput { event: Event, thread: Sexp },
    Event(Event),
    Ignored,
}

fn string_at(v: &[Sexp], i: usize) -> String {
    v.get(i).and_then(Sexp::as_str).unwrap_or_default().to_string()
}

fn int_at(v: &[Sexp], i: usize) -> i64 {
    v.get(i).and_then(Sexp::as_int).unwrap_or_default()
}

fn thread_at(v: &[Sexp], i: usize) -> Thread {
    v.get(i).map(Thread::from_sexp).unwrap_or(Thread::T)
}

fn parse_debugger(v: &[Sexp]) -> Debugger {
    let condition = v.get(3).map(Sexp::items).unwrap_or_default();
    Debugger {
        thread: thread_at(v, 1),
        level: int_at(v, 2),
        condition: string_at(condition, 0),
        condition_type: string_at(condition, 1),
        restarts: v
            .get(4)
            .map(Sexp::items)
            .unwrap_or_default()
            .iter()
            .map(|r| Restart {
                name: string_at(r.items(), 0),
                description: string_at(r.items(), 1),
            })
            .collect(),
        frames: v.get(5).map(Sexp::items).unwrap_or_default().iter().map(parse_frame).collect(),
        stepping: condition
            .get(2)
            .map(Sexp::items)
            .unwrap_or_default()
            .iter()
            .any(|extra| extra.items().first().is_some_and(|k| k.is_kw("show-frame-source"))),
    }
}

pub fn parse_frame(f: &Sexp) -> Frame {
    let items = f.items();
    Frame {
        index: int_at(items, 0),
        description: string_at(items, 1),
        restartable: items
            .get(2)
            .and_then(|p| p.plist_get("restartable"))
            .is_some_and(|r| !r.is_nil()),
    }
}

impl Message {
    pub fn parse(msg: Sexp) -> Message {
        let v = msg.items();
        let Some(Sexp::Kw(head)) = v.first() else {
            return Message::Event(Event::ProtocolError { message: format!("unexpected message {msg}") });
        };
        let event = match head.as_str() {
            "return" => {
                let value = v.get(1).map(Sexp::items).unwrap_or_default();
                let result = match value.first() {
                    Some(k) if k.is_kw("ok") => Ok(value.get(1).cloned().unwrap_or(Sexp::Nil)),
                    _ => Err(value.get(1).and_then(Sexp::as_str).unwrap_or("aborted").to_string()),
                };
                return Message::Return { id: int_at(v, 2) as u64, result };
            }
            "ping" => {
                return Message::Ping { thread: v[1].clone(), tag: v[2].clone() };
            }
            "eval" => {
                return Message::Eval { thread: v[1].clone(), tag: v[2].clone() };
            }
            "write-string" => {
                let event = Event::Output {
                    text: string_at(v, 1),
                    target: v.get(2).and_then(|t| match t {
                        Sexp::Kw(k) => Some(k.clone()),
                        _ => None,
                    }),
                };
                return match v.get(3) {
                    Some(thread) => Message::FlowControlledOutput { event, thread: thread.clone() },
                    None => Message::Event(event),
                };
            }
            "presentation-start" => Event::PresentationStart { id: int_at(v, 1) },
            "presentation-end" => Event::PresentationEnd { id: int_at(v, 1) },
            "new-package" => Event::NewPackage { name: string_at(v, 1), prompt: string_at(v, 2) },
            "debug" => Event::Debug(parse_debugger(v)),
            "debug-activate" => Event::DebugActivate { thread: thread_at(v, 1), level: int_at(v, 2) },
            "debug-return" => Event::DebugReturn {
                thread: thread_at(v, 1),
                level: int_at(v, 2),
                stepping: v.get(3).is_some_and(|s| !s.is_nil()),
            },
            "read-string" => Event::ReadString { thread: thread_at(v, 1), tag: int_at(v, 2) },
            "read-aborted" => Event::ReadAborted { thread: thread_at(v, 1), tag: int_at(v, 2) },
            "y-or-n-p" => Event::YOrNP { thread: thread_at(v, 1), tag: int_at(v, 2), question: string_at(v, 3) },
            "background-message" => Event::BackgroundMessage { text: string_at(v, 1) },
            "inspect" => Event::Inspect { thread: thread_at(v, 2), tag: int_at(v, 3) },
            "invalid-rpc" => Event::ProtocolError { message: string_at(v, 2) },
            "indentation-update" => Event::IndentationUpdate {
                specs: v
                    .get(1)
                    .map(Sexp::items)
                    .unwrap_or_default()
                    .iter()
                    .map(|e| {
                        let e = e.items();
                        IndentSpec {
                            name: string_at(e, 0).to_lowercase(),
                            spec: e.get(1).map(sexp_json).unwrap_or_default(),
                            packages: e.get(2).map(Sexp::items).unwrap_or_default().iter().filter_map(|p| p.as_str().map(String::from)).collect(),
                        }
                    })
                    .collect(),
            },
            "channel-send" => {
                let msg = v.get(2).map(Sexp::items).unwrap_or_default();
                let message = match msg.first() {
                    Some(k) if k.is_kw("write-string") => ChannelMessage::WriteString { text: string_at(msg, 1) },
                    Some(k) if k.is_kw("write-result") => ChannelMessage::WriteResult { text: string_at(msg, 1) },
                    Some(k) if k.is_kw("prompt") => ChannelMessage::Prompt { package: string_at(msg, 1) },
                    Some(k) if k.is_kw("evaluation-aborted") => ChannelMessage::EvaluationAborted,
                    Some(k) if k.is_kw("set-read-mode") => ChannelMessage::ReadMode { reading: msg.get(1).is_some_and(|m| m.is_kw("read")) },
                    _ => ChannelMessage::Other { text: v.get(2).map(Sexp::to_string).unwrap_or_default() },
                };
                Event::Channel { channel: int_at(v, 1), message }
            }
            "reader-error" => Event::ProtocolError { message: format!("reader error: {}", string_at(v, 2)) },
            _ => return Message::Ignored,
        };
        Message::Event(event)
    }
}

#[derive(Debug, thiserror::Error, Clone, PartialEq)]
pub enum RexError {
    #[error("evaluation aborted: {0}")]
    Aborted(String),
    #[error("lisp connection closed")]
    Disconnected,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Sexp, String>>>>>;

tokio::task_local! {
    /// Collects the ids of the requests sent inside it, so whoever started them can stop them.
    pub static SENT: Arc<std::sync::Mutex<Vec<u64>>>;
}

/// A live Swank connection. Cheap to clone.
#[derive(Clone)]
pub struct Connection {
    writer: Arc<Mutex<OwnedWriteHalf>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    events: broadcast::Sender<Event>,
}

impl Connection {
    pub async fn connect(port: u16) -> std::io::Result<Connection> {
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        stream.set_nodelay(true)?;
        let (mut reader, writer) = stream.into_split();
        let (events, _) = broadcast::channel(4096);
        let conn = Connection {
            writer: Arc::new(Mutex::new(writer)),
            pending: Arc::default(),
            next_id: Arc::new(AtomicU64::new(1)),
            events,
        };
        let c = conn.clone();
        let trace = std::env::var_os("ZPAREN_TRACE").is_some();
        tokio::spawn(async move {
            while let Ok(frame) = read_frame(&mut reader).await {
                if trace {
                    eprintln!("swank<- {frame}");
                }
                let msg = match Sexp::parse(&frame) {
                    Ok(s) => Message::parse(s),
                    Err(e) => Message::Event(Event::ProtocolError { message: format!("{e}: {frame}") }),
                };
                c.dispatch(msg).await;
            }
            for (_, tx) in c.pending.lock().await.drain() {
                let _ = tx.send(Err(String::new()));
            }
            let _ = c.events.send(Event::Disconnected);
        });
        Ok(conn)
    }

    async fn dispatch(&self, msg: Message) {
        match msg {
            Message::Return { id, result } => {
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let _ = tx.send(result);
                }
            }
            Message::Ping { thread, tag } => {
                let _ = self.send(&Sexp::list([Sexp::kw("emacs-pong"), thread, tag])).await;
            }
            Message::Eval { thread, tag } => {
                let reply = Sexp::list([Sexp::kw("abort"), Sexp::str("ZParen does not evaluate editor code")]);
                let _ = self.send(&Sexp::list([Sexp::kw("emacs-return"), thread, tag, reply])).await;
            }
            Message::FlowControlledOutput { event, thread } => {
                let _ = self.events.send(event);
                let _ = self.send(&Sexp::list([Sexp::kw("write-done"), thread])).await;
            }
            Message::Event(e) => {
                let _ = self.events.send(e);
            }
            Message::Ignored => {}
        }
    }

    pub fn emit(&self, e: Event) {
        let _ = self.events.send(e);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub async fn send(&self, msg: &Sexp) -> std::io::Result<()> {
        if std::env::var_os("ZPAREN_TRACE").is_some() {
            eprintln!("swank-> {msg}");
        }
        let mut w = self.writer.lock().await;
        w.write_all(&encode(msg)).await?;
        w.flush().await
    }

    /// Evaluates `form` in Swank and waits for its `:return`.
    /// Which of `ids` Lisp has not answered yet.
    pub async fn unanswered(&self, ids: &[u64]) -> Vec<u64> {
        let pending = self.pending.lock().await;
        ids.iter().copied().filter(|id| pending.contains_key(id)).collect()
    }

    pub async fn rex(&self, form: Sexp, package: &str, thread: Thread) -> Result<Sexp, RexError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let _ = SENT.try_with(|sent| sent.lock().unwrap().push(id));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let msg = Sexp::list([Sexp::kw("emacs-rex"), form, Sexp::str(package), thread.to_sexp(), Sexp::Int(id as i64)]);
        if self.send(&msg).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(RexError::Disconnected);
        }
        match rx.await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) if e.is_empty() => Err(RexError::Disconnected),
            Ok(Err(e)) => Err(RexError::Aborted(e)),
            Err(_) => Err(RexError::Disconnected),
        }
    }

    pub async fn interrupt(&self, thread: Thread) -> std::io::Result<()> {
        self.send(&Sexp::list([Sexp::kw("emacs-interrupt"), thread.to_sexp()])).await
    }

    pub async fn return_string(&self, thread: Thread, tag: i64, text: &str) -> std::io::Result<()> {
        self.send(&Sexp::list([Sexp::kw("emacs-return-string"), thread.to_sexp(), Sexp::Int(tag), Sexp::str(text)]))
            .await
    }

    pub async fn return_value(&self, thread: Thread, tag: i64, value: Sexp) -> std::io::Result<()> {
        self.send(&Sexp::list([Sexp::kw("emacs-return"), thread.to_sexp(), Sexp::Int(tag), value])).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Message {
        Message::parse(Sexp::parse(s).unwrap())
    }

    #[test]
    fn frames_with_utf8_byte_length() {
        let bytes = encode(&Sexp::str("λ"));
        assert_eq!(&bytes[..6], b"000004");
    }

    #[tokio::test]
    async fn reads_frames() {
        let mut data: &[u8] = b"000006(:a 1)";
        assert_eq!(read_frame(&mut data).await.unwrap(), "(:a 1)");
    }

    #[test]
    fn parses_returns() {
        assert_eq!(parse("(:return (:ok \"3\") 7)"), Message::Return { id: 7, result: Ok(Sexp::str("3")) });
        assert_eq!(parse("(:return (:abort \"boom\") 2)"), Message::Return { id: 2, result: Err("boom".into()) });
    }

    #[test]
    fn parses_debugger() {
        let m = parse(
            r#"(:debug 12 1 ("boom" "   [Condition of type SIMPLE-ERROR]" nil)
                (("RETRY" "Retry SLIME REPL evaluation request.") ("*ABORT" "Return to SLIME's top level."))
                ((0 "(FOO)" (:restartable t)) (1 "(EVAL (FOO))"))
                (nil))"#,
        );
        let Message::Event(Event::Debug(d)) = m else { panic!("{m:?}") };
        assert_eq!(d.thread, Thread::Id(12));
        assert_eq!(d.condition, "boom");
        assert_eq!(d.restarts[1].name, "*ABORT");
        assert!(d.frames[0].restartable);
        assert!(!d.frames[1].restartable);
        assert!(!d.stepping);
    }

    #[test]
    fn parses_a_step() {
        let m = parse(
            r#"(:debug 12 1 ("Evaluating call: (HELPER X)" "   [Condition of type STEP-FORM-CONDITION]" ((:show-frame-source 0)))
                (("STEP-CONTINUE" "Resume normal execution")) ((0 "(STEPME 3)")) (nil))"#,
        );
        let Message::Event(Event::Debug(d)) = m else { panic!("{m:?}") };
        assert!(d.stepping);
    }

    #[test]
    fn repl_output_needs_an_ack() {
        assert_eq!(
            parse("(:write-string \"x\" nil 42)"),
            Message::FlowControlledOutput {
                event: Event::Output { text: "x".into(), target: None },
                thread: Sexp::Int(42)
            }
        );
    }

    #[test]
    fn parses_indentation_updates() {
        let m = parse(r#"(:indentation-update (("with-weak-cache" 1 ("SB-DI")) ("defsystem*" (4 &body) ("ASDF"))))"#);
        let Message::Event(Event::IndentationUpdate { specs }) = m else { panic!("{m:?}") };
        assert_eq!(specs[0].spec, serde_json::json!(1));
        assert_eq!(specs[1].spec, serde_json::json!([4, "&body"]));
        assert_eq!(specs[1].packages, vec!["ASDF".to_string()]);
    }

    #[test]
    fn parses_output() {
        assert_eq!(
            parse("(:write-string \"3\" :repl-result)"),
            Message::Event(Event::Output { text: "3".into(), target: Some("repl-result".into()) })
        );
    }
}
