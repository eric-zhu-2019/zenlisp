//! Every Lisp call runs under `watch`: Swank traps any error into the
//! debugger and the request never returns, so a tool that only awaited its
//! reply would hang on the first mistake.

use crate::ops::{Op, Reply, SourceLocation, XrefKind};
use crate::swank::{Connection, Debugger, Event, Thread};
use crate::workbench::{AppEvent, Request, Response, SessionState, SystemTask, Workbench};
use serde_json::{Map, Value, json};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

type Run = fn(Arc<Workbench>, Args) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

struct Tool {
    name: &'static str,
    description: &'static str,
    params: &'static [Param],
    run: Run,
}

#[derive(Clone, Copy)]
enum Kind {
    String,
    Integer,
    Boolean,
}

struct Param {
    name: &'static str,
    kind: Kind,
    required: bool,
    description: &'static str,
}

const fn req(name: &'static str, kind: Kind, description: &'static str) -> Param {
    Param { name, kind, required: true, description }
}

const fn opt(name: &'static str, kind: Kind, description: &'static str) -> Param {
    Param { name, kind, required: false, description }
}

const PACKAGE: Param = opt(
    "package",
    Kind::String,
    "The package to read and evaluate in, such as \"MY-APP\". The default is COMMON-LISP-USER.",
);

const TOOLS: &[Tool] = &[
    Tool {
        name: "eval",
        description: "Evaluate one Common Lisp form in the user's running Lisp image. Returns the printed output and the return values. \
Use it to call functions, check state, or define things interactively. The image is live and shared with the user: \
definitions and side effects stay. If the form signals an error, the image stops in the debugger and this tool returns \
the condition, the restarts and the top frames. Then use debugger_state and invoke_restart.",
        params: &[req("form", Kind::String, "One Lisp form, as source text."), PACKAGE],
        run: |wb, a| Box::pin(eval(wb, a)),
    },
    Tool {
        name: "describe_symbol",
        description: "Describe a symbol: what it names (function, macro, variable, class), its arglist, its documentation and its current value. \
Use it before you call or change something you have not read.",
        params: &[req("symbol", Kind::String, "The symbol name, optionally package-qualified, such as \"alexandria:flatten\"."), PACKAGE],
        run: |wb, a| Box::pin(describe_symbol(wb, a)),
    },
    Tool {
        name: "apropos",
        description: "Find symbols whose names contain a substring, with what each one names and the first line of its documentation. \
Use it to discover functions when you know part of a name.",
        params: &[
            req("query", Kind::String, "A substring of the symbol name, such as \"hash-table\"."),
            opt("package", Kind::String, "Only search this package. The default searches all packages."),
        ],
        run: |wb, a| Box::pin(apropos(wb, a)),
    },
    Tool {
        name: "find_definitions",
        description: "Find where a symbol is defined: each definition (function, method, class, variable) with its source file and line. \
Use it to locate code before you read or edit it with read_file.",
        params: &[req("name", Kind::String, "The symbol name, optionally package-qualified."), PACKAGE],
        run: |wb, a| Box::pin(find_definitions(wb, a)),
    },
    Tool {
        name: "who_calls",
        description: "List the functions that call a function, each with its source file and line. \
Use it to find the callers you must check before you change a function's behavior or signature.",
        params: &[req("name", Kind::String, "The function name, optionally package-qualified."), PACKAGE],
        run: |wb, a| Box::pin(who_calls(wb, a)),
    },
    Tool {
        name: "macroexpand",
        description: "Expand a macro form and return the expansion. By default it expands only the outermost macro once. \
Use it to understand or debug a macro.",
        params: &[
            req("form", Kind::String, "The macro form, as source text."),
            PACKAGE,
            opt("all", Kind::Boolean, "Expand all macros in the form, including nested ones. The default is false."),
        ],
        run: |wb, a| Box::pin(macroexpand(wb, a)),
    },
    Tool {
        name: "compile_form",
        description: "Compile one top-level form (such as a defun) with the file compiler and load it into the image. \
Returns success and each compiler note with its severity (error, warning, style-warning, note) and line. \
Prefer this to eval for definitions: it reports warnings such as undefined variables and type mismatches. \
After you edit a definition in a file, pass file and line so the notes use file lines and the definition records its source.",
        params: &[
            req("form", Kind::String, "One top-level form, as source text."),
            PACKAGE,
            opt("file", Kind::String, "The file the form comes from, relative to the project root or absolute."),
            opt("line", Kind::Integer, "The 1-based line in file where the form starts. Requires file."),
        ],
        run: |wb, a| Box::pin(compile_form(wb, a)),
    },
    Tool {
        name: "list_packages",
        description: "List every package in the image. Use it to find the package name to pass to other tools.",
        params: &[],
        run: |wb, _| Box::pin(list_packages(wb)),
    },
    Tool {
        name: "project_info",
        description: "Show the open project: its root directory, its dependency managers (Quicklisp, qlot, ocicl, vendored), \
its ASDF systems with their dependencies and whether each is loaded, and the Lisp session state. \
Call it first to learn the system names for load_system and run_tests.",
        params: &[],
        run: |wb, _| Box::pin(project_info(wb)),
    },
    Tool {
        name: "load_system",
        description: "Load an ASDF system into the image, fetching missing dependencies through Quicklisp when it is available. \
Waits until the load finishes and returns pass or fail with the compiler output. \
Use it after you change several files, or to load the project before you work on it. \
If loading signals an error, the image stops in the debugger and this tool returns the condition and restarts.",
        params: &[req("name", Kind::String, "The ASDF system name, such as \"my-app\".")],
        run: |wb, a| Box::pin(system_task(wb, a, SystemTask::Load)),
    },
    Tool {
        name: "run_tests",
        description: "Run an ASDF system's tests (asdf:test-system) and wait for them to finish. Returns the test output and pass or fail. \
Pass means the test run returned without an unhandled error. Some frameworks only print failures, so read the output's summary. \
If a test signals an error, the image stops in the debugger and this tool returns the condition and restarts.",
        params: &[req("name", Kind::String, "The ASDF system name, such as \"my-app\". Its test-op usually runs the tests system.")],
        run: |wb, a| Box::pin(system_task(wb, a, SystemTask::Test)),
    },
    Tool {
        name: "debugger_state",
        description: "Show each thread that is stopped in the debugger: the condition, the numbered restarts, and the top stack frames with their local variables. \
Use it after a tool reports that the image stopped in the debugger, to find the cause before you choose a restart.",
        params: &[
            opt("thread", Kind::Integer, "Only show this thread's debugger."),
            opt("frames", Kind::Integer, "How many top frames to show with locals. The default is 5."),
        ],
        run: |wb, a| Box::pin(debugger_state(wb, a)),
    },
    Tool {
        name: "invoke_restart",
        description: "Leave the debugger by invoking one of its restarts, by number from debugger_state. \
An ABORT restart cancels the failed evaluation. Other restarts retry, continue or use a value. \
You can fix the cause first (for example redefine a function with compile_form) and then retry.",
        params: &[
            req("restart", Kind::Integer, "The restart number from debugger_state."),
            opt("thread", Kind::Integer, "The debugger's thread. Required only when more than one thread is in the debugger."),
        ],
        run: |wb, a| Box::pin(invoke_restart(wb, a)),
    },
    Tool {
        name: "read_file",
        description: "Read a text file in the project, with line numbers. Paths are relative to the project root; files outside it are refused. \
Use start_line and end_line for large files.",
        params: &[
            req("path", Kind::String, "The file path, relative to the project root or absolute."),
            opt("start_line", Kind::Integer, "The first line to return, 1-based. The default is 1."),
            opt("end_line", Kind::Integer, "The last line to return. The default returns up to 2000 lines."),
        ],
        run: |wb, a| Box::pin(read_file(wb, a)),
    },
    Tool {
        name: "edit_file",
        description: "Change a project file by replacing one exact piece of its text. old_text must appear in the file exactly once, \
with its whitespace and line breaks; read_file the lines first, and leave out the line numbers it shows. The editor shows the change \
at once and the user can undo it. The file is saved, not compiled: compile the changed form with compile_form to check it.",
        params: &[
            req("path", Kind::String, "The file path, relative to the project root or absolute."),
            req("old_text", Kind::String, "The text to replace, exactly as in the file, long enough to occur only once."),
            req("new_text", Kind::String, "The text to put in its place."),
        ],
        run: |wb, a| Box::pin(edit_file(wb, a)),
    },
    Tool {
        name: "list_files",
        description: "List the files and directories in a project directory, one level deep. Directories end in \"/\". \
Build output, fasls and dependency caches are hidden. Paths outside the project root are refused.",
        params: &[opt("path", Kind::String, "The directory, relative to the project root. The default is the root.")],
        run: |wb, a| Box::pin(list_files(wb, a)),
    },
];

pub fn specs() -> Vec<ToolSpec> {
    TOOLS
        .iter()
        .map(|t| {
            let properties: Map<String, Value> = t
                .params
                .iter()
                .map(|p| {
                    let ty = match p.kind {
                        Kind::String => "string",
                        Kind::Integer => "integer",
                        Kind::Boolean => "boolean",
                    };
                    (p.name.to_string(), json!({ "type": ty, "description": p.description }))
                })
                .collect();
            let required: Vec<&str> = t.params.iter().filter(|p| p.required).map(|p| p.name).collect();
            ToolSpec {
                name: t.name.into(),
                description: t.description.into(),
                input_schema: json!({
                    "type": "object",
                    "properties": properties,
                    "required": required,
                    "additionalProperties": false,
                }),
            }
        })
        .collect()
}

/// Runs a tool. `Ok` and `Err` are both text for the model; `Err` marks a
/// failed call, such as bad arguments or an error that stopped in the debugger.
/// Boxed because the assistant calls tools from inside `Workbench::handle`,
/// and Rust cannot name a recursive async type.
pub fn call<'a>(
    wb: &'a Arc<Workbench>,
    name: &'a str,
    args: Value,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
    Box::pin(async move {
        let tool = TOOLS.iter().find(|t| t.name == name).ok_or_else(|| format!("unknown tool {name}"))?;
        let args = Args::parse(tool, args)?;
        (tool.run)(wb.clone(), args).await
    })
}

#[derive(Debug)]
struct Args(Map<String, Value>);

impl Args {
    fn parse(tool: &Tool, args: Value) -> Result<Args, String> {
        let map = match args {
            Value::Object(m) => m,
            Value::Null => Map::new(),
            other => return Err(format!("{}: arguments must be an object, got {other}", tool.name)),
        };
        for (k, v) in &map {
            let Some(p) = tool.params.iter().find(|p| p.name == k) else {
                return Err(format!("{}: unknown argument {k}", tool.name));
            };
            let ok = match p.kind {
                Kind::String => v.is_string(),
                Kind::Integer => v.is_i64(),
                Kind::Boolean => v.is_boolean(),
            } || v.is_null();
            if !ok {
                return Err(format!("{}: argument {k} has the wrong type: {v}", tool.name));
            }
        }
        if let Some(p) = tool.params.iter().find(|p| p.required && map.get(p.name).is_none_or(Value::is_null)) {
            return Err(format!("{}: missing required argument {}", tool.name, p.name));
        }
        Ok(Args(map))
    }

    fn str(&self, k: &str) -> String {
        self.opt_str(k).unwrap_or_default()
    }

    fn opt_str(&self, k: &str) -> Option<String> {
        self.0.get(k).and_then(Value::as_str).map(String::from)
    }

    fn opt_int(&self, k: &str) -> Option<i64> {
        self.0.get(k).and_then(Value::as_i64)
    }

    fn flag(&self, k: &str) -> bool {
        self.0.get(k).and_then(Value::as_bool).unwrap_or(false)
    }

    fn package(&self) -> String {
        self.opt_str("package").unwrap_or_else(|| "COMMON-LISP-USER".into())
    }
}

enum Outcome<T> {
    Done(T),
    Debugger(Debugger),
}

async fn watch<T>(wb: &Workbench, conn: &Connection, work: impl Future<Output = T>) -> (Outcome<T>, String) {
    let mut raw = conn.subscribe();
    let mut app = wb.subscribe();
    let before: Vec<Thread> = wb.debuggers().await.iter().map(|d| d.thread).collect();
    let mut output = String::new();
    let mut raw_open = true;
    tokio::pin!(work);
    let outcome = loop {
        tokio::select! {
            r = &mut work => break Outcome::Done(r),
            Ok(e) = app.recv() => {
                if let AppEvent::Lisp { event: Event::Debug(d) } = e
                    && d.level == 1
                    && !before.contains(&d.thread)
                {
                    break Outcome::Debugger(d);
                }
            }
            e = raw.recv(), if raw_open => match e {
                Ok(e) => collect_output(&mut output, e),
                Err(broadcast::error::RecvError::Closed) => raw_open = false,
                Err(broadcast::error::RecvError::Lagged(_)) => {}
            },
        }
    };
    while let Ok(e) = raw.try_recv() {
        collect_output(&mut output, e);
    }
    (outcome, output)
}

fn collect_output(out: &mut String, e: Event) {
    if let Event::Output { text, target: None } = e {
        out.push_str(&text);
    }
}

async fn conn(wb: &Arc<Workbench>) -> Result<Connection, String> {
    Ok(wb.session().await?.conn.clone())
}

async fn run_keeping_debugger(wb: &Arc<Workbench>, op: Op) -> Result<(Reply, String), String> {
    let c = conn(wb).await?;
    match watch(wb, &c, op.run(&c)).await {
        (Outcome::Done(r), out) => Ok((r.map_err(|e| e.to_string())?, out)),
        (Outcome::Debugger(d), out) => Err(stopped(&d, &out)),
    }
}

async fn run_aborting_debugger(wb: &Arc<Workbench>, op: Op) -> Result<Reply, String> {
    let c = conn(wb).await?;
    match watch(wb, &c, op.run(&c)).await {
        (Outcome::Done(r), _) => r.map_err(|e| e.to_string()),
        (Outcome::Debugger(d), _) => {
            leave(wb, &c, &d, Op::DebuggerAbort { thread: d.thread }).await;
            Err(format!("{}\n{}", d.condition, d.condition_type.trim()))
        }
    }
}

/// Sends `op`, which unwinds out of debugger `d`, and waits until the
/// debugger has closed. Swank answers the request before it reports the
/// level closed, so the reply alone is too early. Returns whether it closed.
async fn leave(wb: &Workbench, c: &Connection, d: &Debugger, op: Op) -> bool {
    let mut events = wb.subscribe();
    let _ = tokio::time::timeout(Duration::from_secs(10), op.run(c)).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match events.recv().await {
                Ok(AppEvent::Lisp { event: Event::DebugReturn { thread, level, .. } }) if thread == d.thread && level <= d.level => {
                    return true;
                }
                Err(broadcast::error::RecvError::Closed) => return false,
                _ => {}
            }
        }
    })
    .await
    .unwrap_or(false)
}

fn stopped(d: &Debugger, output: &str) -> String {
    let mut s = String::new();
    if !output.is_empty() {
        s.push_str(&format!("Output:\n{}\n\n", clip(output)));
    }
    s.push_str("The image stopped in the debugger.\n");
    s.push_str(&debugger_text(d, 10));
    s.push_str("\nThe debugger is waiting. Use debugger_state for locals, then invoke_restart.");
    s
}

fn debugger_text(d: &Debugger, frames: usize) -> String {
    let mut s = format!(
        "Thread {}, level {}\nCondition: {}\n{}\nRestarts:\n",
        thread_id(d.thread),
        d.level,
        d.condition,
        d.condition_type.trim()
    );
    for (i, r) in d.restarts.iter().enumerate() {
        s.push_str(&format!("  {i}: [{}] {}\n", r.name, r.description));
    }
    if frames > 0 {
        s.push_str("Backtrace:\n");
    }
    for f in d.frames.iter().take(frames) {
        s.push_str(&format!("  {}: {}\n", f.index, f.description));
    }
    s
}

fn thread_id(t: Thread) -> String {
    match t {
        Thread::Id(i) => i.to_string(),
        Thread::Repl => "repl".into(),
        Thread::T => "new".into(),
    }
}

const MAX_OUTPUT: usize = 20_000;

fn clip(s: &str) -> String {
    let n = s.chars().count();
    if n <= MAX_OUTPUT {
        return s.to_string();
    }
    let tail: String = s.chars().skip(n - MAX_OUTPUT).collect();
    format!("[{} earlier characters omitted]\n{tail}", n - MAX_OUTPUT)
}

async fn eval(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let (reply, stream) = run_keeping_debugger(&wb, Op::Eval { form: a.str("form"), package: a.package() }).await?;
    let Reply::Evaluated { output, value } = reply else { return Ok(format!("{reply:?}")) };
    let mut s = String::new();
    let output = output + &stream;
    if !output.is_empty() {
        s.push_str(&format!("Output:\n{}\n", clip(&output)));
    }
    s.push_str(&format!("Values:\n{}", if value.is_empty() { "; No values" } else { &value }));
    Ok(s)
}

async fn describe_symbol(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    match run_aborting_debugger(&wb, Op::Describe { symbol: a.str("symbol"), package: a.package() }).await? {
        Reply::Text { text } => Ok(text),
        _ => Ok(format!("{} is not a known symbol.", a.str("symbol"))),
    }
}

async fn apropos(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    const LIMIT: usize = 100;
    let Reply::Symbols { items } = run_aborting_debugger(&wb, Op::Apropos { query: a.str("query"), package: a.opt_str("package") }).await? else {
        return Ok("No matches.".into());
    };
    if items.is_empty() {
        return Ok("No matches.".into());
    }
    let mut s = String::new();
    for i in items.iter().take(LIMIT) {
        let kinds: Vec<&str> = i.kinds.iter().map(String::as_str).collect();
        let doc = i.doc.as_deref().and_then(|d| d.lines().next()).filter(|d| *d != ":not-documented");
        s.push_str(&format!("{} ({}){}\n", i.name, kinds.join(", "), doc.map(|d| format!(": {d}")).unwrap_or_default()));
    }
    if items.len() > LIMIT {
        s.push_str(&format!("[{} more; use a longer query]\n", items.len() - LIMIT));
    }
    Ok(s)
}

async fn find_definitions(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let reply = run_aborting_debugger(&wb, Op::FindDefinitions { name: a.str("name"), package: a.package() }).await?;
    Ok(definitions(reply, &format!("No definitions found for {}.", a.str("name"))))
}

async fn who_calls(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let reply = run_aborting_debugger(&wb, Op::Xref { kind: XrefKind::Callers, name: a.str("name"), package: a.package() }).await?;
    Ok(definitions(reply, &format!("No known callers of {}.", a.str("name"))))
}

fn definitions(reply: Reply, none: &str) -> String {
    let Reply::Definitions { items } = reply else { return none.into() };
    if items.is_empty() {
        return none.into();
    }
    items.iter().map(|d| format!("{}\n  {}\n", d.label, place(d.location.as_ref()))).collect()
}

/// `file:line` for a Swank location, which carries a character offset.
fn place(loc: Option<&SourceLocation>) -> String {
    let Some(loc) = loc else { return "source location unknown".into() };
    match (&loc.file, &loc.buffer, loc.offset) {
        (Some(f), _, Some(o)) => match std::fs::read_to_string(f) {
            Ok(text) => format!("{f}:{}", line_at(&text, o)),
            Err(_) => f.clone(),
        },
        (Some(f), _, None) => f.clone(),
        (None, Some(b), _) => format!("compiled from {b}, not a file"),
        _ => loc.snippet.clone().unwrap_or_else(|| "source location unknown".into()),
    }
}

fn line_at(text: &str, offset: i64) -> usize {
    text.chars().take(offset.max(0) as usize).filter(|c| *c == '\n').count() + 1
}

async fn macroexpand(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    match run_aborting_debugger(&wb, Op::Macroexpand { form: a.str("form"), package: a.package(), all: a.flag("all") }).await? {
        Reply::Text { text } => Ok(text),
        other => Ok(format!("{other:?}")),
    }
}

async fn compile_form(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let form = a.str("form");
    let line = a.opt_int("line").unwrap_or(1).max(1) as usize;
    let (file, offset) = match a.opt_str("file") {
        Some(f) => {
            let path = within_project(&wb, Some(&f)).await?;
            let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let offset = text.split_inclusive('\n').take(line - 1).map(|l| l.chars().count()).sum::<usize>();
            (Some(path.display().to_string()), offset as i64)
        }
        None if a.opt_int("line").is_some() => return Err("line requires file".into()),
        None => (None, 0),
    };
    let buffer = file.clone().unwrap_or_else(|| "agent-form".into());
    let op = Op::CompileForm { form: form.clone(), package: a.package(), buffer, file: file.clone(), offset };
    let (reply, stream) = run_keeping_debugger(&wb, op).await?;
    let Reply::Compiled { success, notes, .. } = reply else { return Ok(format!("{reply:?}")) };
    let mut s = String::from(if success { "Compiled and loaded." } else { "Compilation failed. Nothing was loaded." });
    if notes.is_empty() {
        s.push_str(" No compiler notes.");
    }
    let base = file.as_deref().map(|f| format!("{f}:")).unwrap_or_else(|| "form line ".into());
    for n in &notes {
        let at = match n.location.as_ref().and_then(|l| l.offset) {
            Some(o) => format!("{base}{}", line - 1 + line_at(&form, o - offset)),
            None => "unknown line".into(),
        };
        s.push_str(&format!("\n{}: {at}: {}", n.severity, n.message));
    }
    if !stream.is_empty() {
        s.push_str(&format!("\n\nOutput:\n{}", clip(&stream)));
    }
    if success { Ok(s) } else { Err(s) }
}

async fn list_packages(wb: Arc<Workbench>) -> Result<String, String> {
    match run_aborting_debugger(&wb, Op::ListPackages).await? {
        Reply::Names { items } => Ok(items.join("\n")),
        other => Ok(format!("{other:?}")),
    }
}

async fn project_info(wb: Arc<Workbench>) -> Result<String, String> {
    let status = wb.status().await;
    let session = match &status.session {
        SessionState::Ready { pid, version, .. } => format!("running, SBCL {version}, pid {pid}"),
        SessionState::Starting => "starting".into(),
        SessionState::Stopped => "stopped".into(),
        SessionState::Failed { message } => format!("failed: {message}"),
        SessionState::Exited { message } => format!("exited unexpectedly: {message}"),
    };
    let Some(p) = status.project else {
        return Ok(format!("No project is open. Lisp session: {session}."));
    };
    let mut s = format!("Project {}\nRoot: {}\nLisp session: {session}\nDependency managers:\n", p.name, p.root);
    if p.managers.is_empty() {
        s.push_str("  none (plain ASDF)\n");
    }
    for m in &p.managers {
        s.push_str(&format!("  {}\n", serde_json::to_string(m).unwrap_or_default()));
    }
    s.push_str("Systems:\n");
    match wb.handle(Request::ProjectSystems).await {
        Ok(Response::Systems { systems }) => {
            for sys in systems {
                s.push_str(&format!(
                    "  {}{} ({})\n    depends on: {}\n",
                    sys.name,
                    if sys.loaded { " [loaded]" } else { "" },
                    sys.file,
                    if sys.depends_on.is_empty() { "nothing".into() } else { sys.depends_on.join(", ") },
                ));
            }
        }
        Ok(_) => {}
        Err(e) => s.push_str(&format!("  could not list systems: {e}\n")),
    }
    Ok(s)
}

async fn system_task(wb: Arc<Workbench>, a: Args, kind: SystemTask) -> Result<String, String> {
    let c = conn(&wb).await?;
    let work = wb.clone().system_task(kind, a.str("name"));
    // The load goes on in a task of its own, so it records what it sends where the caller does.
    let task = match crate::swank::SENT.try_with(Arc::clone) {
        Ok(sent) => tokio::spawn(crate::swank::SENT.scope(sent, work)),
        Err(_) => tokio::spawn(work),
    };
    let (outcome, output) = watch(&wb, &c, task).await;
    let shown = if output.is_empty() { String::new() } else { format!("\n\nOutput:\n{}", clip(&output)) };
    match outcome {
        Outcome::Done(Ok(Ok(_))) => Ok(format!("PASS{shown}")),
        Outcome::Done(Ok(Err(e))) => Err(format!("FAIL: {e}{shown}")),
        Outcome::Done(Err(e)) => Err(format!("FAIL: {e}{shown}")),
        Outcome::Debugger(d) => Err(format!("FAIL\n{}", stopped(&d, &output))),
    }
}

async fn debugger_state(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let frames = a.opt_int("frames").unwrap_or(5).clamp(0, 50);
    let mut debuggers = wb.debuggers().await;
    if let Some(t) = a.opt_int("thread") {
        debuggers.retain(|d| d.thread == Thread::Id(t));
    }
    if debuggers.is_empty() {
        return Ok("No thread is in the debugger.".into());
    }
    let c = conn(&wb).await?;
    let mut s = String::new();
    for d in &debuggers {
        s.push_str(&debugger_text(d, 0));
        s.push_str("Frames:\n");
        for f in d.frames.iter().take(frames as usize) {
            s.push_str(&format!("  {}: {}\n", f.index, f.description));
            let locals = Op::FrameLocals { thread: d.thread, frame: f.index };
            if let Ok(Ok(Reply::Locals { items })) = tokio::time::timeout(Duration::from_secs(5), locals.run(&c)).await {
                for l in items {
                    s.push_str(&format!("      {} = {}\n", l.name, l.value));
                }
            }
        }
        s.push('\n');
    }
    Ok(s)
}

async fn invoke_restart(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let debuggers = wb.debuggers().await;
    let d = match a.opt_int("thread") {
        Some(t) => debuggers.iter().find(|d| d.thread == Thread::Id(t)).ok_or(format!("thread {t} is not in the debugger"))?,
        None => match debuggers.as_slice() {
            [] => return Err("No thread is in the debugger.".into()),
            [d] => d,
            many => {
                let ids: Vec<String> = many.iter().map(|d| thread_id(d.thread)).collect();
                return Err(format!("Several threads are in the debugger ({}). Pass thread.", ids.join(", ")));
            }
        },
    };
    let index = a.opt_int("restart").unwrap_or_default();
    let restart = d
        .restarts
        .get(usize::try_from(index).unwrap_or(usize::MAX))
        .ok_or(format!("restart {index} does not exist; there are {}", d.restarts.len()))?;
    let c = conn(&wb).await?;
    let closed = leave(&wb, &c, d, Op::InvokeRestart { thread: d.thread, level: d.level, index }).await;
    let mut s = format!("Invoked restart {index} [{}] on thread {}.", restart.name, thread_id(d.thread));
    s.push_str(if closed { " The debugger closed." } else { " The debugger has not closed yet." });
    let remaining = wb.debuggers().await;
    if !remaining.is_empty() {
        s.push_str(&format!(" {} debugger(s) still open; see debugger_state.", remaining.len()));
    }
    Ok(s)
}

async fn within_project(wb: &Workbench, path: Option<&str>) -> Result<PathBuf, String> {
    let project = wb.status().await.project.ok_or("No project is open, so there are no project files.")?;
    let root = Path::new(&project.root);
    let p = Path::new(path.unwrap_or("."));
    let full = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let full = full.canonicalize().map_err(|e| format!("{}: {e}", full.display()))?;
    // A root under a symlink, such as /var on macOS, canonicalizes to another spelling; the
    // path keeps the root's spelling, which is how the editor names its files.
    let real_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    match full.strip_prefix(&real_root) {
        Ok(rest) => Ok(root.join(rest)),
        Err(_) => Err(format!("{} is outside the project root {}", full.display(), root.display())),
    }
}

async fn read_file(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    const MAX_LINES: i64 = 2000;
    let path = within_project(&wb, a.opt_str("path").as_deref()).await?;
    let Response::File { content } = wb.handle(Request::ReadFile { path: path.display().to_string() }).await? else {
        return Err("unexpected reply".into());
    };
    let total = content.lines().count() as i64;
    let start = a.opt_int("start_line").unwrap_or(1).max(1);
    let end = a.opt_int("end_line").unwrap_or(start + MAX_LINES - 1).min(start + MAX_LINES - 1).min(total);
    let mut s: String = content
        .lines()
        .enumerate()
        .skip(start as usize - 1)
        .take((end - start + 1).max(0) as usize)
        .map(|(i, l)| format!("{:>5}  {l}\n", i + 1))
        .collect();
    if end < total && a.opt_int("end_line").is_none() {
        s.push_str(&format!("[lines {}-{total} not shown; pass start_line to read on]\n", end + 1));
    }
    if s.is_empty() {
        s = format!("[{} has {total} lines]", path.display());
    }
    Ok(s)
}

async fn edit_file(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let path = within_project(&wb, a.opt_str("path").as_deref()).await?;
    let name = path.display().to_string();
    let content = std::fs::read_to_string(&path).map_err(|e| format!("{name}: {e}"))?;
    let (old, new) = (a.str("old_text"), a.str("new_text"));
    if old.is_empty() {
        return Err("old_text is empty; give the exact text to replace.".into());
    }
    let at = match content.match_indices(&old).map(|(i, _)| i).collect::<Vec<_>>()[..] {
        [at] => at,
        [] => return Err(format!("old_text does not occur in {name}. Read the file again and copy the text exactly.")),
        ref many => return Err(format!("old_text occurs {} times in {name}. Include more of the text around it.", many.len())),
    };
    let edited = format!("{}{new}{}", &content[..at], &content[at + old.len()..]);
    std::fs::write(&path, &edited).map_err(|e| format!("{name}: {e}"))?;
    wb.emit(AppEvent::FilesChanged { paths: vec![name.clone()] });
    let line = content[..at].matches('\n').count() + 1;
    Ok(format!("Replaced the text at line {line} of {name}."))
}

async fn list_files(wb: Arc<Workbench>, a: Args) -> Result<String, String> {
    let dir = within_project(&wb, a.opt_str("path").as_deref()).await?;
    let root = PathBuf::from(wb.status().await.project.map(|p| p.root).unwrap_or_default());
    let Response::Dir { entries } = wb.handle(Request::ListDir { path: dir.display().to_string() }).await? else {
        return Err("unexpected reply".into());
    };
    if entries.is_empty() {
        return Ok("The directory is empty.".into());
    }
    Ok(entries
        .iter()
        .map(|e| {
            let rel = Path::new(&e.path).strip_prefix(&root).map(|p| p.display().to_string()).unwrap_or(e.path.clone());
            format!("{rel}{}\n", if e.is_dir { "/" } else { "" })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_param_appears_in_its_schema() {
        let specs = specs();
        assert_eq!(specs.len(), TOOLS.len());
        let eval = specs.iter().find(|s| s.name == "eval").unwrap();
        assert_eq!(eval.input_schema["required"], json!(["form"]));
        assert_eq!(eval.input_schema["properties"]["package"]["type"], "string");
    }

    #[test]
    fn arguments_are_checked_against_the_schema() {
        let eval = TOOLS.iter().find(|t| t.name == "eval").unwrap();
        assert!(Args::parse(eval, json!({})).unwrap_err().contains("missing required argument form"));
        assert!(Args::parse(eval, json!({"form": 1})).unwrap_err().contains("wrong type"));
        assert!(Args::parse(eval, json!({"form": "1", "x": 1})).unwrap_err().contains("unknown argument x"));
        assert!(Args::parse(eval, json!({"form": "1"})).is_ok());
    }

    #[test]
    fn lines_count_from_one() {
        assert_eq!(line_at("a\nb\nc", 0), 1);
        assert_eq!(line_at("a\nb\nc", 2), 2);
        assert_eq!(line_at("a\nb\nc", 4), 3);
    }
}
