use crate::assistant::{Assistant, AssistantConfig, AssistantEvent, AssistantStatus, EditorContext, Provider, SessionInfo};
use crate::files;
use crate::search;
use crate::ops::{Op, Reply};
use crate::project::{self, NewDeps, NewLanguage, Project};
use crate::session::{use_macos_ca_bundle, Session, SessionConfig};
use crate::sexp::Sexp;
use crate::swank::{Debugger, Event, Thread};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{Mutex, broadcast};
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum Request {
    Lisp { op: Op },
    StartSession,
    RestartSession,
    Status,
    #[serde(rename_all = "camelCase")]
    OpenProject { root: String },
    #[serde(rename_all = "camelCase")]
    NewProject { parent: String, name: String, #[serde(default)] deps: NewDeps, #[serde(default)] language: NewLanguage },
    /// Which dependency managers a new project can use on this Mac.
    NewProjectChoices,
    CloseProject,
    ProjectSystems,
    #[serde(rename_all = "camelCase")]
    LoadSystem { name: String },
    #[serde(rename_all = "camelCase")]
    TestSystem { name: String },
    #[serde(rename_all = "camelCase")]
    Build { system: String },
    InstallDeps,
    /// Updates dependencies with qlot or ocicl.
    UpdateDeps,
    /// Fetches one new dependency with qlot or ocicl.
    #[serde(rename_all = "camelCase")]
    FetchSystem { name: String },
    /// Where each of NAMES comes from and in which version.
    Dependencies { names: Vec<String> },
    /// The versions ocicl can install of NAME, newest first.
    DependencyVersions { name: String },
    /// Pins NAME to VERSION, with ocicl.
    PinDependency { name: String, version: String },
    /// Updates NAME to its latest release, with qlot or ocicl.
    UpdateDependency { name: String },
    /// Drops NAME's pin and download, with ocicl, once no system depends on it.
    UnpinDependency { name: String },
    #[serde(rename_all = "camelCase")]
    ReturnString { thread: Thread, tag: i64, text: String },
    #[serde(rename_all = "camelCase")]
    AnswerYesNo { thread: Thread, tag: i64, yes: bool },
    #[serde(rename_all = "camelCase")]
    AssistantSend { text: String, context: Option<EditorContext> },
    AssistantCancel,
    AssistantReset,
    /// The user's theme files, `themes/*.json` in the data directory, made if missing.
    Themes,
    /// Saved conversations, the latest first.
    AssistantSessions,
    /// Continues a saved conversation, answering with its messages.
    AssistantOpenSession { id: String },
    AssistantDeleteSession { id: String },
    AssistantStatus,
    #[serde(rename_all = "camelCase")]
    AssistantSetKey { provider: Provider, key: String },
    /// Chooses the provider that answers and each provider's model.
    #[serde(rename_all = "camelCase")]
    AssistantConfigure { config: AssistantConfig },
    McpInfo,
    #[serde(rename_all = "camelCase")]
    ListDir { path: String },
    #[serde(rename_all = "camelCase")]
    ReadFile { path: String },
    #[serde(rename_all = "camelCase")]
    WriteFile { path: String, content: String },
    #[serde(rename_all = "camelCase")]
    CreateFile { path: String },
    #[serde(rename_all = "camelCase")]
    CreateDir { path: String },
    #[serde(rename_all = "camelCase")]
    RenamePath { from: String, to: String },
    #[serde(rename_all = "camelCase")]
    TrashPath { path: String },
    #[serde(rename_all = "camelCase")]
    Search { query: search::Query },
    #[serde(rename_all = "camelCase")]
    Replace { query: search::Query, replacement: String, paths: Vec<String> },
    /// Finds a Common Lisp symbol's page in the local HyperSpec.
    #[serde(rename_all = "camelCase")]
    Hyperspec { symbol: String },
    LispOptions,
    /// The project's startup image, if it has one.
    Image,
    /// Builds a startup image with these systems loaded, in a separate SBCL.
    #[serde(rename_all = "camelCase")]
    SaveImage { systems: Vec<String> },
    DeleteImage,
    /// Deletes every project's startup image and the cached base cores, so each is built afresh.
    CleanImages,
    /// A file's text in the last git commit.
    #[serde(rename_all = "camelCase")]
    GitHead { path: String },
    /// The project's changed and untracked files.
    GitStatus,
    /// Saves how Lisp starts; it takes effect when Lisp next starts.
    #[serde(rename_all = "camelCase")]
    SetLispOptions { options: LispOptions },
    /// Installs SBCL with Homebrew, as a task.
    InstallSbcl,
}

/// How ZParen starts SBCL, saved in its data folder.
#[derive(Debug, Clone, Deserialize, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LispOptions {
    /// The sbcl program; empty looks on PATH and in Homebrew's and MacPorts' places.
    pub sbcl: String,
    /// Load ~/.sbclrc when Lisp starts.
    pub load_userinit: bool,
    /// SBCL's heap in megabytes; 0 keeps SBCL's default.
    pub heap_mb: u32,
    /// Compile development code for debugging (debug 3): locals and stepping work, tail calls stay.
    pub debug_code: bool,
}

impl Default for LispOptions {
    fn default() -> Self {
        LispOptions { sbcl: String::new(), load_userinit: false, heap_mb: 0, debug_code: true }
    }
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum Response {
    Lisp { reply: Reply },
    Status(Status),
    Project { project: Project },
    #[serde(rename_all = "camelCase")]
    Systems { systems: Vec<SystemInfo> },
    #[serde(rename_all = "camelCase")]
    Dependencies { deps: Vec<Dependency> },
    #[serde(rename_all = "camelCase")]
    DependencyVersions { versions: Vec<String> },
    /// `ocicl` says whether ocicl is set up; `ocicl_missing` says how to set it up.
    #[serde(rename_all = "camelCase")]
    NewProjectChoices { ocicl: bool, ocicl_missing: String },
    #[serde(rename_all = "camelCase")]
    Dir { entries: Vec<DirEntry> },
    #[serde(rename_all = "camelCase")]
    File { content: String },
    Assistant(AssistantStatus),
    #[serde(rename_all = "camelCase")]
    Themes { dir: String, files: Vec<ThemeFile> },
    #[serde(rename_all = "camelCase")]
    AssistantSessions { sessions: Vec<SessionInfo> },
    /// The Anthropic messages of a reopened conversation, for the chat to show.
    #[serde(rename_all = "camelCase")]
    AssistantSession { messages: Vec<serde_json::Value> },
    Search(search::SearchResult),
    #[serde(rename_all = "camelCase")]
    Replaced { count: usize },
    #[serde(rename_all = "camelCase")]
    Mcp { info: Option<McpInfo> },
    /// `page` is relative to the HyperSpec root, as its server serves it;
    /// `installed` is false when no local HyperSpec was found.
    #[serde(rename_all = "camelCase")]
    Hyperspec { installed: bool, page: Option<String> },
    /// The saved options, and the sbcl they find, if any.
    #[serde(rename_all = "camelCase")]
    LispOptions { options: LispOptions, sbcl: Option<String> },
    #[serde(rename_all = "camelCase")]
    Image { image: Option<ImageInfo> },
    /// None when the file is untracked or not in a repository.
    #[serde(rename_all = "camelCase")]
    GitHead { text: Option<String> },
    #[serde(rename_all = "camelCase")]
    GitStatus { files: Vec<crate::git::GitFile> },
    Ok,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct McpInfo {
    pub url: String,
    pub claude_command: String,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum SessionState {
    Stopped,
    Starting,
    /// `image` is true when Lisp started from the project's saved image.
    #[serde(rename_all = "camelCase")]
    Ready { pid: u32, version: String, image: bool },
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
    /// Lisp ended without being asked to, such as a crash or `(exit)`.
    #[serde(rename_all = "camelCase")]
    Exited { message: String },
}

/// A project's saved startup image.
#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageInfo {
    pub path: String,
    /// Seconds since the Unix epoch.
    pub saved: u64,
    pub megabytes: u64,
    /// Why the image no longer matches the project or ZParen, if it does not.
    pub stale: Option<String>,
    /// Whether Lisp starts from it. An image built on another base core holds
    /// that core's Swank and ZParen code, so Lisp starts from the base core instead.
    pub used: bool,
}

/// What a startup image was built from, saved beside it.
#[derive(Debug, Serialize, Deserialize)]
struct ImageManifest {
    /// The base core's file name.
    core: String,
    /// Each project file the image holds, relative to the root, with its size and modification time in nanoseconds.
    files: std::collections::BTreeMap<String, (u64, u128)>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Status {
    pub session: SessionState,
    pub project: Option<Project>,
}

/// Where a dependency comes from.
#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DepSource {
    /// Pinned in the project's ocicl.csv.
    Ocicl,
    /// A release in a Quicklisp dist.
    Quicklisp,
    /// A system ASDF knows from elsewhere, such as the project or SBCL.
    Local,
    /// Nothing provides it yet.
    Missing,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Dependency {
    pub name: String,
    /// Empty when the source names no version.
    pub version: String,
    pub source: DepSource,
    /// Downloaded where the source keeps it.
    pub installed: bool,
    pub loaded: bool,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SystemInfo {
    pub name: String,
    pub file: String,
    pub description: String,
    pub version: String,
    pub depends_on: Vec<String>,
    pub loaded: bool,
    /// The function its built program starts in, such as `my-app:main`; empty when it has none.
    pub entry_point: String,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum AppEvent {
    Lisp { event: Event },
    Status(Status),
    #[serde(rename_all = "camelCase")]
    TaskOutput { task: String, text: String },
    #[serde(rename_all = "camelCase")]
    TaskFinished { task: String, ok: bool, message: String },
    Assistant { event: AssistantEvent },
    #[serde(rename_all = "camelCase")]
    FilesChanged { paths: Vec<String> },
}

struct Inner {
    session: Option<Arc<Session>>,
    state: SessionState,
    project: Option<Project>,
    debuggers: HashMap<Thread, Vec<Debugger>>,
    watcher: Option<notify::RecommendedWatcher>,
}

pub struct Workbench {
    config: SessionConfig,
    options: std::sync::Mutex<LispOptions>,
    inner: Mutex<Inner>,
    events: broadcast::Sender<AppEvent>,
    assistant: Arc<Assistant>,
    mcp: std::sync::Mutex<Option<McpInfo>>,
}

type Result<T> = std::result::Result<T, String>;

impl Workbench {
    pub fn new(config: SessionConfig) -> Arc<Workbench> {
        Arc::new(Workbench {
            assistant: Arc::new(Assistant::new(&config.data_dir)),
            options: std::sync::Mutex::new(load_options(&config.data_dir)),
            mcp: std::sync::Mutex::new(None),
            config,
            inner: Mutex::new(Inner { session: None, state: SessionState::Stopped, project: None, debuggers: HashMap::new(), watcher: None }),
            events: broadcast::channel(8192).0,
        })
    }

    /// Where a project's startup image lives: in the data folder, named for the project's path.
    fn image_path(&self, p: &Project) -> PathBuf {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in p.root.as_bytes() {
            h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
        }
        self.config.data_dir.join("images").join(format!("{}-{h:016x}.core", p.name))
    }

    /// The session config with the saved options applied.
    fn configured(&self) -> SessionConfig {
        let o = self.options.lock().unwrap().clone();
        let mut cfg = self.config.clone();
        if o.sbcl.trim().is_empty() {
            cfg.resolve_sbcl();
        } else {
            cfg.sbcl = PathBuf::from(o.sbcl.trim());
            cfg.sbcl_home = None;
        }
        cfg.load_userinit = o.load_userinit;
        cfg.dynamic_space_mb = (o.heap_mb > 0).then_some(o.heap_mb);
        cfg.debug_code = o.debug_code;
        cfg
    }

    pub fn data_dir(&self) -> &Path {
        &self.config.data_dir
    }

    pub fn set_mcp(&self, info: McpInfo) {
        *self.mcp.lock().unwrap() = Some(info);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AppEvent> {
        self.events.subscribe()
    }

    pub(crate) fn emit(&self, e: AppEvent) {
        let _ = self.events.send(e);
    }

    pub async fn status(&self) -> Status {
        let inner = self.inner.lock().await;
        Status { session: inner.state.clone(), project: inner.project.clone() }
    }

    /// The innermost open debugger of each thread that is stopped in one.
    pub async fn debuggers(&self) -> Vec<Debugger> {
        let inner = self.inner.lock().await;
        let mut v: Vec<Debugger> = inner.debuggers.values().filter_map(|levels| levels.last().cloned()).collect();
        v.sort_by_key(|d| d.level);
        v
    }

    async fn set_state(&self, state: SessionState) {
        self.inner.lock().await.state = state;
        self.emit(AppEvent::Status(self.status().await));
    }

    /// The running session, starting one if needed.
    pub async fn session(self: &Arc<Self>) -> Result<Arc<Session>> {
        if let Some(s) = self.inner.lock().await.session.clone() {
            return Ok(s);
        }
        self.start().await
    }

    async fn start(self: &Arc<Self>) -> Result<Arc<Session>> {
        self.set_state(SessionState::Starting).await;
        let project = self.inner.lock().await.project.clone();
        let mut cfg = self.configured();
        if let Some(p) = &project {
            cfg.cwd = PathBuf::from(&p.root);
            let image = self.image_path(p);
            if let Ok(core) = crate::session::core_path(&cfg).await
                && image_info(&image, &core, Path::new(&p.root)).is_some_and(|i| i.used)
            {
                cfg.core = Some(image);
            }
        }
        let session = match Session::start(&cfg).await {
            Ok(s) => Arc::new(s),
            Err(e) => {
                self.set_state(SessionState::Failed { message: e.to_string() }).await;
                return Err(e.to_string());
            }
        };
        self.forward(&session);
        if let Some(p) = &project {
            for form in p.setup_forms() {
                let op = Op::Eval { form: form.to_string(), package: "COMMON-LISP-USER".into() };
                if let Err(e) = op.run(&session.conn).await {
                    let message = format!("project setup failed at {form}: {e}");
                    self.set_state(SessionState::Failed { message: message.clone() }).await;
                    return Err(message);
                }
            }
        }
        let version_op = Op::Eval { form: "(lisp-implementation-version)".into(), package: "CL-USER".into() };
        let version = match version_op.run(&session.conn).await {
            Ok(Reply::Evaluated { value, .. }) => value.trim_matches('"').to_string(),
            _ => String::new(),
        };
        self.inner.lock().await.session = Some(session.clone());
        self.set_state(SessionState::Ready { pid: session.pid.unwrap_or_default(), version, image: cfg.core.is_some() }).await;
        Ok(session)
    }

    fn forward(self: &Arc<Self>, session: &Arc<Session>) {
        let mut rx = session.conn.subscribe();
        let wb = Arc::downgrade(self);
        let me = Arc::downgrade(session);
        tokio::spawn(async move {
            loop {
                let event = match rx.recv().await {
                    Ok(e) => e,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                let Some(wb) = wb.upgrade() else { break };
                let disconnected = event == Event::Disconnected;
                if matches!(event, Event::Debug(_) | Event::DebugReturn { .. } | Event::Disconnected) {
                    let mut inner = wb.inner.lock().await;
                    if inner.session.as_ref().is_some_and(|c| Arc::downgrade(c).ptr_eq(&me)) {
                        track_debugger(&mut inner.debuggers, &event);
                    }
                }
                wb.emit(AppEvent::Lisp { event });
                if disconnected {
                    let mut inner = wb.inner.lock().await;
                    let current = inner.session.as_ref().map(Arc::downgrade);
                    if current.is_some_and(|c| c.ptr_eq(&me)) {
                        // Still the current session, so nobody stopped it: it died.
                        let message = match inner.session.take() {
                            Some(s) => s.exit_report().await,
                            None => "Lisp closed its connection.".into(),
                        };
                        inner.state = SessionState::Exited { message };
                        drop(inner);
                        wb.emit(AppEvent::Status(wb.status().await));
                    }
                    break;
                }
            }
        });
    }

    pub async fn stop(&self) {
        let session = {
            let mut inner = self.inner.lock().await;
            inner.debuggers.clear();
            inner.session.take()
        };
        if let Some(s) = session {
            s.stop().await;
        }
        self.set_state(SessionState::Stopped).await;
    }

    async fn lisp(self: &Arc<Self>, op: Op) -> Result<Reply> {
        let s = self.session().await?;
        op.run(&s.conn).await.map_err(|e| e.to_string())
    }

    async fn call(self: &Arc<Self>, form: Sexp) -> Result<Sexp> {
        let s = self.session().await?;
        s.conn.rex(form, "COMMON-LISP-USER", Thread::T).await.map_err(|e| e.to_string())
    }

    async fn project(&self) -> Result<Project> {
        self.inner.lock().await.project.clone().ok_or_else(|| "no project is open".to_string())
    }

    pub async fn handle(self: &Arc<Self>, req: Request) -> Result<Response> {
        match req {
            Request::Lisp { op } => Ok(Response::Lisp { reply: self.lisp(op).await? }),
            Request::StartSession => {
                self.session().await?;
                Ok(Response::Status(self.status().await))
            }
            Request::RestartSession => {
                self.stop().await;
                self.start().await?;
                Ok(Response::Status(self.status().await))
            }
            Request::Status => Ok(Response::Status(self.status().await)),
            Request::OpenProject { root } => self.open_project(Path::new(&root)).await,
            Request::NewProject { parent, name, deps, language } => {
                let root = project::create(Path::new(&parent), &name, deps, language).map_err(|e| e.to_string())?;
                self.open_project(&root).await
            }
            Request::NewProjectChoices => Ok(Response::NewProjectChoices {
                ocicl: project::ocicl_runtime().is_some(),
                ocicl_missing: project::OCICL_MISSING.into(),
            }),
            Request::CloseProject => {
                self.stop().await;
                let mut inner = self.inner.lock().await;
                inner.project = None;
                inner.watcher = None;
                drop(inner);
                self.emit(AppEvent::Status(self.status().await));
                Ok(Response::Status(self.status().await))
            }
            Request::ProjectSystems => {
                let p = self.project().await?;
                let v = self.call(Sexp::list([Sexp::sym("zparen:project-systems"), Sexp::str(&p.root)])).await?;
                Ok(Response::Systems { systems: v.items().iter().map(parse_system).collect() })
            }
            Request::LoadSystem { name } => {
                self.session().await?;
                tokio::spawn(self.clone().system_task(SystemTask::Load, name));
                Ok(Response::Ok)
            }
            Request::TestSystem { name } => {
                self.session().await?;
                tokio::spawn(self.clone().system_task(SystemTask::Test, name));
                Ok(Response::Ok)
            }
            Request::Build { system } => {
                let p = self.project().await?;
                let mut cmd = self.configured().sbcl_command();
                cmd.args(p.build_args(&system));
                self.process_task(format!("build {system}"), cmd, &p.root);
                Ok(Response::Ok)
            }
            Request::InstallDeps => {
                let p = self.project().await?;
                let argv = p.install_command().ok_or("this project's dependencies install when its systems load")?;
                self.process_task("install dependencies".into(), manager_command(&argv), &p.root);
                Ok(Response::Ok)
            }
            Request::UpdateDeps => {
                let p = self.project().await?;
                let argv = p.update_command().ok_or("this project's dependencies update through Quicklisp")?;
                self.process_task("update dependencies".into(), manager_command(&argv), &p.root);
                Ok(Response::Ok)
            }
            Request::FetchSystem { name } => {
                let p = self.project().await?;
                let argv = p.fetch_command(&name).ok_or("Quicklisp fetches this system when it loads")?;
                self.process_task(format!("fetch {name}"), manager_command(&argv), &p.root);
                Ok(Response::Ok)
            }
            Request::Dependencies { names } => {
                let p = self.project().await?;
                let v = self
                    .call(Sexp::list([
                        Sexp::sym("zparen::dependency-info"),
                        Sexp::str(&p.root),
                        Sexp::list([Sexp::sym("cl:list")].into_iter().chain(names.iter().map(|n| Sexp::str(n)))),
                    ]))
                    .await?;
                Ok(Response::Dependencies { deps: v.items().iter().map(parse_dependency).collect() })
            }
            Request::DependencyVersions { name } => {
                let p = self.project().await?;
                p.pin_command(&name, "").ok_or("Only ocicl lists the versions of one system")?;
                let out = tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    manager_command(&["ocicl".into(), "list".into(), name.clone()]).current_dir(&p.root).output(),
                )
                .await
                .map_err(|_| "ocicl list took over a minute".to_string())?
                .map_err(|e| format!("ocicl: {e}"))?;
                Ok(Response::DependencyVersions { versions: ocicl_versions(&String::from_utf8_lossy(&out.stdout)) })
            }
            Request::PinDependency { name, version } => {
                let p = self.project().await?;
                let argv = p.pin_command(&name, &version).ok_or("Only ocicl pins one system's version")?;
                self.process_task(format!("pin {name} {version}"), manager_command(&argv), &p.root);
                Ok(Response::Ok)
            }
            Request::UpdateDependency { name } => {
                let p = self.project().await?;
                let argv = p.update_one_command(&name).ok_or("Quicklisp updates whole dists, not one system")?;
                self.process_task(format!("update {name}"), manager_command(&argv), &p.root);
                Ok(Response::Ok)
            }
            Request::UnpinDependency { name } => {
                let p = self.project().await?;
                let argv = p.unpin_command(&name).ok_or("Only ocicl pins systems")?;
                self.process_task(format!("unpin {name}"), manager_command(&argv), &p.root);
                Ok(Response::Ok)
            }
            Request::ReturnString { thread, tag, text } => {
                let s = self.session().await?;
                s.conn.return_string(thread, tag, &text).await.map_err(|e| e.to_string())?;
                Ok(Response::Ok)
            }
            Request::AnswerYesNo { thread, tag, yes } => {
                let s = self.session().await?;
                s.conn.return_value(thread, tag, Sexp::bool(yes)).await.map_err(|e| e.to_string())?;
                Ok(Response::Ok)
            }
            Request::AssistantSend { text, context } => {
                let events = self.events.clone();
                let emit = Arc::new(move |event| {
                    let _ = events.send(AppEvent::Assistant { event });
                });
                let project = self.status().await.project.map(|p| p.root);
                self.assistant.send(self.clone(), text, context, project, emit).await?;
                Ok(Response::Ok)
            }
            Request::AssistantCancel => {
                self.assistant.cancel().await;
                self.emit(AppEvent::Assistant { event: AssistantEvent::TurnFinished { stop_reason: "cancelled".into() } });
                Ok(Response::Ok)
            }
            Request::AssistantReset => {
                self.assistant.reset().await;
                Ok(Response::Ok)
            }
            Request::Themes => {
                let dir = self.config.data_dir.join("themes");
                std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                let mut files: Vec<ThemeFile> = std::fs::read_dir(&dir)
                    .map_err(|e| e.to_string())?
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "json"))
                    .filter_map(|p| Some(ThemeFile { name: p.file_name()?.to_string_lossy().into(), text: std::fs::read_to_string(&p).ok()? }))
                    .collect();
                files.sort_by(|a, b| a.name.cmp(&b.name));
                Ok(Response::Themes { dir: dir.to_string_lossy().into(), files })
            }
            Request::AssistantSessions => Ok(Response::AssistantSessions { sessions: self.assistant.sessions() }),
            Request::AssistantOpenSession { id } => Ok(Response::AssistantSession { messages: self.assistant.open_session(&id).await? }),
            Request::AssistantDeleteSession { id } => {
                self.assistant.delete_session(&id).await;
                Ok(Response::Ok)
            }
            Request::AssistantStatus => Ok(Response::Assistant(self.assistant.status().await)),
            Request::AssistantSetKey { provider, key } => {
                self.assistant.set_key(provider, &key).map_err(|e| e.to_string())?;
                Ok(Response::Assistant(self.assistant.status().await))
            }
            Request::AssistantConfigure { config } => {
                self.assistant.configure(&config).map_err(|e| e.to_string())?;
                Ok(Response::Assistant(self.assistant.status().await))
            }
            Request::McpInfo => Ok(Response::Mcp { info: self.mcp.lock().unwrap().clone() }),
            Request::InstallSbcl => {
                let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
                    .into_iter()
                    .find(|b| Path::new(b).is_file())
                    .ok_or("Homebrew is not installed. Get it from brew.sh, or download SBCL from sbcl.org.")?;
                let mut cmd = tokio::process::Command::new(brew);
                cmd.args(["install", "sbcl"]);
                let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
                self.process_task("install sbcl".into(), cmd, &home);
                Ok(Response::Ok)
            }
            Request::GitHead { path } => {
                let text = tokio::task::spawn_blocking(move || crate::git::head_text(Path::new(&path))).await.map_err(|e| e.to_string())?;
                Ok(Response::GitHead { text })
            }
            Request::GitStatus => {
                let root = PathBuf::from(self.project().await?.root);
                let files = tokio::task::spawn_blocking(move || crate::git::status(&root)).await.map_err(|e| e.to_string())?;
                Ok(Response::GitStatus { files })
            }
            Request::Image => {
                let p = self.project().await?;
                let core = crate::session::core_path(&self.configured()).await.map_err(|e| e.to_string())?;
                Ok(Response::Image { image: image_info(&self.image_path(&p), &core, Path::new(&p.root)) })
            }
            Request::DeleteImage => {
                let p = self.project().await?;
                let path = self.image_path(&p);
                if path.is_file() {
                    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                }
                let _ = std::fs::remove_file(path.with_extension("json"));
                Ok(Response::Image { image: None })
            }
            Request::CleanImages => {
                let images = self.config.data_dir.join("images");
                if images.is_dir() {
                    std::fs::remove_dir_all(&images).map_err(|e| e.to_string())?;
                }
                // A running SBCL has already read its core, so deleting it is safe.
                let cache = &self.configured().cache_dir;
                for entry in std::fs::read_dir(cache).into_iter().flatten().flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("zparen-") && name.ends_with(".core") {
                        std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
                    }
                }
                Ok(Response::Image { image: None })
            }
            Request::SaveImage { systems } => {
                let p = self.project().await?;
                let cfg = self.configured();
                let core = crate::session::ensure_core(&cfg).await.map_err(|e| e.to_string())?;
                let path = self.image_path(&p);
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                let tmp = path.with_extension("tmp");
                let listed = path.with_extension("files");
                let started = std::time::SystemTime::now();
                let mut cmd = cfg.sbcl_command();
                cmd.arg("--core").arg(&core).args(["--noinform", "--non-interactive", "--no-userinit"]);
                for form in p.setup_forms() {
                    cmd.arg("--eval").arg(form.to_string());
                }
                for s in &systems {
                    cmd.arg("--eval").arg(Sexp::list([Sexp::sym("zparen:load-system"), Sexp::str(s)]).to_string());
                }
                let list = Sexp::list([
                    Sexp::sym("with-open-file"),
                    Sexp::list([Sexp::sym("s"), Sexp::str(&listed.display().to_string()), Sexp::kw("direction"), Sexp::kw("output"), Sexp::kw("if-exists"), Sexp::kw("supersede")]),
                    Sexp::list([Sexp::sym("write-string"), Sexp::list([Sexp::sym("zparen::loaded-source-files"), Sexp::str(&p.root)]), Sexp::sym("s")]),
                ]);
                cmd.arg("--eval").arg(list.to_string());
                let save = Sexp::list([Sexp::sym("sb-ext:save-lisp-and-die"), Sexp::str(&tmp.display().to_string())]);
                cmd.arg("--eval").arg(save.to_string());
                let core_name = core.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let root = PathBuf::from(&p.root);
                // The image is renamed into place only once it is complete.
                self.process_task_then("save startup image".into(), cmd, &p.root, move |ok| {
                    let loaded = std::fs::read_to_string(&listed).unwrap_or_default();
                    let _ = std::fs::remove_file(&listed);
                    if !ok {
                        let _ = std::fs::remove_file(&tmp);
                        return;
                    }
                    let files = loaded
                        .lines()
                        .filter(|l| !l.is_empty())
                        .map(str::to_string)
                        .chain(root_files(&root))
                        .map(|f| {
                            // A file changed during the build may not be what the image holds.
                            let fp = fingerprint(&root.join(&f)).filter(|&(_, m)| m <= nanos(started)).unwrap_or_default();
                            (f, fp)
                        })
                        .collect();
                    let manifest = ImageManifest { core: core_name, files };
                    if std::fs::rename(&tmp, &path).is_ok() {
                        let _ = std::fs::write(path.with_extension("json"), serde_json::to_string(&manifest).unwrap_or_default());
                    }
                });
                Ok(Response::Ok)
            }
            Request::LispOptions => {
                let options = self.options.lock().unwrap().clone();
                let sbcl = self.configured().sbcl;
                Ok(Response::LispOptions { options, sbcl: sbcl.is_file().then(|| sbcl.display().to_string()) })
            }
            Request::SetLispOptions { options } => {
                std::fs::create_dir_all(&self.config.data_dir).map_err(|e| e.to_string())?;
                let json = serde_json::to_string_pretty(&options).map_err(|e| e.to_string())?;
                std::fs::write(self.config.data_dir.join(OPTIONS_FILE), json).map_err(|e| e.to_string())?;
                *self.options.lock().unwrap() = options;
                Ok(Response::Ok)
            }
            Request::Hyperspec { symbol } => Ok(match crate::docs::hyperspec() {
                Some(hs) => Response::Hyperspec { installed: true, page: hs.page(&symbol).map(String::from) },
                None => Response::Hyperspec { installed: false, page: None },
            }),
            Request::ListDir { path } => Ok(Response::Dir { entries: list_dir(Path::new(&path))? }),
            Request::ReadFile { path } => {
                Ok(Response::File { content: std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))? })
            }
            Request::WriteFile { path, content } => {
                std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))?;
                Ok(Response::Ok)
            }
            Request::CreateFile { path } => {
                files::create_file(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
                Ok(Response::Ok)
            }
            Request::CreateDir { path } => {
                files::create_dir(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
                Ok(Response::Ok)
            }
            Request::RenamePath { from, to } => {
                files::rename(Path::new(&from), Path::new(&to)).map_err(|e| format!("{from}: {e}"))?;
                Ok(Response::Ok)
            }
            Request::Search { query } => {
                let root = PathBuf::from(self.project().await?.root);
                let result = tokio::task::spawn_blocking(move || search::search(&root, &query))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(Response::Search(result))
            }
            Request::Replace { query, replacement, paths } => {
                let root = self.project().await?.root;
                if let Some(outside) = paths.iter().find(|p| !p.starts_with(&root)) {
                    return Err(format!("{outside} is outside the project"));
                }
                let count = tokio::task::spawn_blocking(move || search::replace(&paths, &query, &replacement))
                    .await
                    .map_err(|e| e.to_string())??;
                Ok(Response::Replaced { count })
            }
            Request::TrashPath { path } => {
                files::trash(Path::new(&path)).map_err(|e| format!("{path}: {e}"))?;
                Ok(Response::Ok)
            }
        }
    }

    async fn open_project(self: &Arc<Self>, root: &Path) -> Result<Response> {
        let root = root.canonicalize().map_err(|e| format!("{}: {e}", root.display()))?;
        let project = Project::detect(&root);
        self.stop().await;
        let events = self.events.clone();
        let watcher = files::watch(&root, move |paths| {
            let _ = events.send(AppEvent::FilesChanged { paths });
        })
        .map_err(|e| format!("cannot watch {}: {e}", root.display()))?;
        {
            let mut inner = self.inner.lock().await;
            inner.project = Some(project.clone());
            inner.watcher = Some(watcher);
        }
        self.start().await?;
        Ok(Response::Project { project })
    }

    /// Loads or tests a system and waits for it to finish. Output streams
    /// through the REPL, and completion is also announced as `TaskFinished`.
    /// `Err` means the task failed; an error that stops in the debugger keeps
    /// this waiting until a restart is chosen.
    pub async fn system_task(self: Arc<Self>, kind: SystemTask, name: String) -> Result<String> {
        let (verb, helper) = match kind {
            SystemTask::Load => ("load", "zparen:load-system"),
            SystemTask::Test => ("test", "zparen:test-system"),
        };
        let task = format!("{verb} {name}");
        let r = self.call(Sexp::list([Sexp::sym(helper), Sexp::str(&name)])).await.map(|v| v.to_string());
        let (ok, message) = match &r {
            Ok(m) => (true, m.clone()),
            Err(m) => (false, m.clone()),
        };
        self.emit(AppEvent::TaskFinished { task, ok, message });
        r
    }

    fn process_task(self: &Arc<Self>, task: String, cmd: tokio::process::Command, cwd: &str) {
        self.process_task_then(task, cmd, cwd, |_| {});
    }

    /// Runs a program as a task, calling `done` with its success before announcing the end.
    fn process_task_then(self: &Arc<Self>, task: String, mut cmd: tokio::process::Command, cwd: &str, done: impl FnOnce(bool) + Send + 'static) {
        cmd.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let wb = self.clone();
        tokio::spawn(async move {
            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    wb.emit(AppEvent::TaskFinished { task, ok: false, message: e.to_string() });
                    return;
                }
            };
            let pump = |r: Box<dyn tokio::io::AsyncRead + Unpin + Send>, wb: Arc<Workbench>, task: String| {
                tokio::spawn(async move {
                    let mut lines = BufReader::new(r).lines();
                    while let Ok(Some(l)) = lines.next_line().await {
                        wb.emit(AppEvent::TaskOutput { task: task.clone(), text: l + "\n" });
                    }
                })
            };
            let a = pump(Box::new(child.stdout.take().unwrap()), wb.clone(), task.clone());
            let b = pump(Box::new(child.stderr.take().unwrap()), wb.clone(), task.clone());
            let status = child.wait().await;
            let _ = tokio::join!(a, b);
            let (ok, message) = match status {
                Ok(s) if s.success() => (true, "finished".to_string()),
                Ok(s) => (false, format!("exited with {s}")),
                Err(e) => (false, e.to_string()),
            };
            done(ok);
            wb.emit(AppEvent::TaskFinished { task, ok, message });
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SystemTask {
    Load,
    Test,
}

/// Swank leaves a debugger level with `:debug-return` for that level, so a
/// level and everything nested in it close together.
fn track_debugger(debuggers: &mut HashMap<Thread, Vec<Debugger>>, event: &Event) {
    match event {
        Event::Debug(d) => {
            let levels = debuggers.entry(d.thread).or_default();
            levels.retain(|l| l.level < d.level);
            levels.push(d.clone());
        }
        Event::DebugReturn { thread, level, .. } => {
            if let Some(levels) = debuggers.get_mut(thread) {
                levels.retain(|l| l.level < *level);
                if levels.is_empty() {
                    debuggers.remove(thread);
                }
            }
        }
        Event::Disconnected => debuggers.clear(),
        _ => {}
    }
}

fn parse_dependency(v: &Sexp) -> Dependency {
    let text = |k: &str| v.plist_get(k).and_then(Sexp::as_str).unwrap_or_default().to_string();
    let flag = |k: &str| v.plist_get(k).is_some_and(|l| !l.is_nil());
    Dependency {
        name: text("name"),
        version: text("version"),
        source: match text("source").as_str() {
            "ocicl" => DepSource::Ocicl,
            "quicklisp" => DepSource::Quicklisp,
            "local" => DepSource::Local,
            _ => DepSource::Missing,
        },
        installed: flag("installed"),
        loaded: flag("loaded"),
    }
}

/// The versions in `ocicl list` output: a header line, then one indented version a line.
fn ocicl_versions(out: &str) -> Vec<String> {
    out.lines()
        .filter(|l| l.starts_with(' '))
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "latest")
        .map(String::from)
        .collect()
}

fn parse_system(v: &Sexp) -> SystemInfo {
    let text = |k: &str| v.plist_get(k).and_then(Sexp::as_str).unwrap_or_default().to_string();
    SystemInfo {
        name: text("name"),
        file: text("file"),
        description: text("description"),
        version: text("version"),
        depends_on: v
            .plist_get("depends-on")
            .map(Sexp::items)
            .unwrap_or_default()
            .iter()
            .filter_map(|d| d.as_str().map(String::from))
            .collect(),
        loaded: v.plist_get("loaded").is_some_and(|l| !l.is_nil()),
        entry_point: text("entry-point"),
    }
}

fn list_dir(dir: &Path) -> Result<Vec<DirEntry>> {
    const HIDDEN: [&str; 6] = [".git", ".qlot", "node_modules", "target", ".DS_Store", "ocicl"];
    let mut entries: Vec<DirEntry> = std::fs::read_dir(dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter(|e| !HIDDEN.contains(&e.file_name().to_string_lossy().as_ref()))
        .filter(|e| !e.file_name().to_string_lossy().ends_with(".fasl"))
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().display().to_string(),
            is_dir: e.path().is_dir(),
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

fn manager_command(argv: &[String]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    use_macos_ca_bundle(&mut cmd);
    cmd
}

const OPTIONS_FILE: &str = "lisp-options.json";

/// A theme file as written; the interface reads and checks it.
#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThemeFile {
    pub name: String,
    pub text: String,
}

fn load_options(data_dir: &Path) -> LispOptions {
    std::fs::read_to_string(data_dir.join(OPTIONS_FILE)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// The image at `path`, and whether it still matches the base core `core` and the project at `root`.
fn image_info(path: &Path, core: &Path, root: &Path) -> Option<ImageInfo> {
    let meta = std::fs::metadata(path).ok()?;
    let saved = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let manifest: Option<ImageManifest> = std::fs::read_to_string(path.with_extension("json")).ok().and_then(|s| serde_json::from_str(&s).ok());
    let (stale, used) = match manifest {
        None => (Some("It was saved by an earlier ZParen, which kept no record of what it holds.".to_string()), false),
        Some(m) if Some(m.core.as_str()) != core.file_name().and_then(|n| n.to_str()) => {
            (Some("It was built on another version of ZParen or SBCL.".to_string()), false)
        }
        Some(m) => {
            let mut changed: Vec<String> = m.files.iter().filter(|(f, fp)| fingerprint(&root.join(f)) != Some(**fp)).map(|(f, _)| f.clone()).collect();
            changed.extend(root_files(root).filter(|f| !m.files.contains_key(f)));
            let stale = match changed.len() {
                0 => None,
                1 => Some(format!("{} changed since it was saved.", changed[0])),
                n => Some(format!("{} and {} more files changed since it was saved.", changed[0], n - 1)),
            };
            (stale, true)
        }
    };
    Some(ImageInfo { path: path.display().to_string(), saved, megabytes: meta.len() / 1_000_000, stale, used })
}

/// The files at a project's root that decide what loads: its .asd files and dependency lists.
fn root_files(root: &Path) -> impl Iterator<Item = String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.ends_with(".asd") || matches!(n.as_str(), "qlfile" | "qlfile.lock" | "ocicl.csv"))
        .collect();
    names.sort();
    names.into_iter()
}

/// A file's size and modification time, which change when it is written.
fn fingerprint(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), nanos(meta.modified().ok()?)))
}

fn nanos(t: std::time::SystemTime) -> u128 {
    t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default()
}
