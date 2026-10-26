use crate::sexp::Sexp;
use crate::swank::{Connection, Frame, RexError, Thread, parse_frame};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "op", rename_all = "camelCase")]
#[ts(export)]
pub enum Op {
    /// Evaluates REPL input in the REPL thread. Output and results arrive as events.
    #[serde(rename_all = "camelCase")]
    ReplEval { input: String },
    /// Evaluates a form and returns its printed output and values.
    #[serde(rename_all = "camelCase")]
    Eval { form: String, package: String },
    #[serde(rename_all = "camelCase")]
    CompileForm { form: String, package: String, buffer: String, file: Option<String>, offset: i64 },
    #[serde(rename_all = "camelCase")]
    CompileFile { path: String, load: bool },
    #[serde(rename_all = "camelCase")]
    LoadFile { path: String },
    #[serde(rename_all = "camelCase")]
    Complete { prefix: String, package: String },
    #[serde(rename_all = "camelCase")]
    Autodoc { form: Vec<AutodocArg>, package: String },
    #[serde(rename_all = "camelCase")]
    Describe { symbol: String, package: String },
    #[serde(rename_all = "camelCase")]
    FindDefinitions { name: String, package: String },
    #[serde(rename_all = "camelCase")]
    Apropos { query: String, package: Option<String> },
    #[serde(rename_all = "camelCase")]
    Xref { kind: XrefKind, name: String, package: String },
    #[serde(rename_all = "camelCase")]
    Macroexpand { form: String, package: String, all: bool },
    ListPackages,
    #[serde(rename_all = "camelCase")]
    SetPackage { name: String },
    Interrupt,
    ListThreads,

    #[serde(rename_all = "camelCase")]
    Inspect { form: String, package: String },
    #[serde(rename_all = "camelCase")]
    InspectPresentation { id: i64 },
    #[serde(rename_all = "camelCase")]
    InspectPart { index: i64 },
    #[serde(rename_all = "camelCase")]
    InspectorAction { index: i64 },
    InspectorBack,
    InspectorForward,
    InspectorRefresh,

    #[serde(rename_all = "camelCase")]
    InvokeRestart { thread: Thread, level: i64, index: i64 },
    #[serde(rename_all = "camelCase")]
    Backtrace { thread: Thread, start: i64, end: i64 },
    #[serde(rename_all = "camelCase")]
    FrameLocals { thread: Thread, frame: i64 },
    #[serde(rename_all = "camelCase")]
    FrameSource { thread: Thread, frame: i64 },
    #[serde(rename_all = "camelCase")]
    EvalInFrame { thread: Thread, frame: i64, form: String, package: String },
    #[serde(rename_all = "camelCase")]
    InspectFrameVar { thread: Thread, frame: i64, var: i64 },
    #[serde(rename_all = "camelCase")]
    RestartFrame { thread: Thread, frame: i64 },
    #[serde(rename_all = "camelCase")]
    ReturnFromFrame { thread: Thread, frame: i64, form: String },
    #[serde(rename_all = "camelCase")]
    Step { thread: Thread, frame: i64, how: StepKind },
    #[serde(rename_all = "camelCase")]
    DebuggerAbort { thread: Thread },
    #[serde(rename_all = "camelCase")]
    DebuggerContinue { thread: Thread },
    #[serde(rename_all = "camelCase")]
    InspectCondition { thread: Thread },

    /// Starts or stops recording calls to a function for the trace panel.
    #[serde(rename_all = "camelCase")]
    ToggleTrace { name: String, package: String },
    TraceReport,
    ClearTraces,
    UntraceAll,
    /// Inspects an argument (`value` false) or a returned value of a recorded call.
    #[serde(rename_all = "camelCase")]
    InspectTracePart { id: i64, part: i64, value: bool },
    /// Evaluates a form under the statistical profiler.
    #[serde(rename_all = "camelCase")]
    ProfileForm { form: String, package: String },
    /// Profiles every thread until `ProfileStop`, for code that runs on its own.
    ProfileStart,
    ProfileStop,
    #[serde(rename_all = "camelCase")]
    Disassemble { name: String, package: String },
    /// Expands a macro form one step, marking the macro forms in the expansion.
    #[serde(rename_all = "camelCase")]
    Macrostep { form: String, package: String },

    /// Runs a system's tests (its ASDF test-op) and reports the tests it ran.
    #[serde(rename_all = "camelCase")]
    RunTests { system: String },
    /// Runs the named tests again, as `TestNode::id` and `framework` give them.
    #[serde(rename_all = "camelCase")]
    RerunTests { tests: Vec<TestRef> },

    /// Starts another REPL in a thread of its own. `remote` is the client's
    /// channel id, which tags the REPL's messages.
    #[serde(rename_all = "camelCase")]
    CreateRepl { remote: i64 },
    /// Sends an extra REPL a line: input to evaluate, or text it is reading.
    #[serde(rename_all = "camelCase")]
    ReplSend { channel: i64, text: String },
    #[serde(rename_all = "camelCase")]
    InterruptThread { thread: Thread },
    /// Ends a thread, such as a closed REPL's.
    #[serde(rename_all = "camelCase")]
    EndThread { thread: i64 },
    /// Compiles a buffer's text without loading it, for its compiler notes as it is typed.
    #[serde(rename_all = "camelCase")]
    CheckText { text: String, package: String },
    /// Systems that could be dependencies: Quicklisp's, then ones ASDF knows.
    #[serde(rename_all = "camelCase")]
    FindSystems { query: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TestRef {
    pub framework: String,
    pub id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StepKind {
    Into,
    Over,
    Out,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum XrefKind {
    Calls,
    Callers,
    References,
    Binds,
    Sets,
    Macroexpands,
    Specializes,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum AutodocArg {
    Token(String),
    Nested(Vec<AutodocArg>),
    Cursor(CursorMarker),
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export)]
pub struct CursorMarker {
    pub cursor: bool,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Reply {
    None,
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    Evaluated { output: String, value: String },
    #[serde(rename_all = "camelCase")]
    Compiled { success: bool, notes: Vec<Note>, seconds: f64 },
    #[serde(rename_all = "camelCase")]
    Completions { items: Vec<Completion> },
    #[serde(rename_all = "camelCase")]
    Arglist { text: String, active: Option<Span> },
    #[serde(rename_all = "camelCase")]
    Definitions { items: Vec<Definition> },
    #[serde(rename_all = "camelCase")]
    Symbols { items: Vec<SymbolInfo> },
    #[serde(rename_all = "camelCase")]
    Names { items: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Threads { items: Vec<ThreadInfo> },
    Inspector(InspectorPage),
    #[serde(rename_all = "camelCase")]
    Frames { items: Vec<Frame> },
    #[serde(rename_all = "camelCase")]
    Locals { items: Vec<Local> },
    #[serde(rename_all = "camelCase")]
    Location { location: Option<SourceLocation> },
    #[serde(rename_all = "camelCase")]
    Traces { specs: Vec<String>, total: i64, entries: Vec<TraceEntry> },
    Profile(Profile),
    /// A macrostep expansion. A form that is not a macro form gets `Text` with the reason.
    #[serde(rename_all = "camelCase")]
    Expansion { text: String, macros: Vec<MacroSpot> },
    Tests(TestRun),
    #[serde(rename_all = "camelCase")]
    Repl { channel: i64, thread: i64, package: String },
    #[serde(rename_all = "camelCase")]
    Systems { items: Vec<AvailableSystem> },
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AvailableSystem {
    pub name: String,
    /// "quicklisp" for a dist's system, "local" for one ASDF finds on disk.
    pub source: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TestRun {
    /// Tests that hold no other tests, by outcome.
    pub passed: i64,
    pub failed: i64,
    pub skipped: i64,
    pub seconds: f64,
    /// The test frameworks the run used, such as "fiveam"; none for tests outside FiveAM, Parachute and Rove.
    pub frameworks: Vec<String>,
    pub tests: Vec<TestNode>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TestNode {
    /// The test's name as Lisp reads it back, for running it again; none for checks and unnamed groups.
    pub id: Option<String>,
    pub framework: String,
    pub name: String,
    pub kind: TestKind,
    pub status: TestStatus,
    /// Why a check failed or was skipped.
    pub message: Option<String>,
    pub children: Vec<TestNode>,
}

#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TestKind {
    Suite,
    Test,
    Check,
}

#[derive(Debug, Clone, Copy, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TestStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TraceEntry {
    pub id: i64,
    pub parent: Option<i64>,
    pub name: String,
    pub args: Vec<String>,
    pub values: Vec<String>,
    /// False while the call is still running, or when it exited non-locally.
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Profile {
    pub samples: i64,
    /// Wall-clock time and printed values, when a single form was profiled.
    pub seconds: Option<f64>,
    pub value: Option<String>,
    /// Functions by the samples they were on the stack for, most first.
    pub rows: Vec<ProfileRow>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileRow {
    pub name: String,
    /// Samples taken while this function itself was running.
    pub own: i64,
    /// Samples with this function anywhere on the stack.
    pub total: i64,
    pub callers: Vec<ProfileCall>,
    pub callees: Vec<ProfileCall>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileCall {
    pub name: String,
    pub samples: i64,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MacroSpot {
    pub name: String,
    /// Zero-based offset of the form's opening parenthesis in the expansion.
    pub start: usize,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[ts(export)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Note {
    pub message: String,
    pub severity: String,
    pub location: Option<SourceLocation>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceLocation {
    pub file: Option<String>,
    pub buffer: Option<String>,
    /// Zero-based character offset into the file or buffer.
    pub offset: Option<i64>,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Completion {
    pub label: String,
    pub score: f64,
    /// Swank's classification string, such as "-f---m--" for a macro.
    pub flags: String,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Definition {
    pub label: String,
    pub location: Option<SourceLocation>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SymbolInfo {
    pub name: String,
    pub kinds: Vec<String>,
    pub doc: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ThreadInfo {
    pub id: i64,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InspectorPage {
    pub title: String,
    pub parts: Vec<InspectorPart>,
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum InspectorPart {
    Text { text: String },
    Value { text: String, index: i64 },
    Action { text: String, index: i64 },
}

#[derive(Debug, Clone, Serialize, TS, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Local {
    pub name: String,
    pub id: i64,
    pub value: String,
}

fn rpc(name: &str, args: impl IntoIterator<Item = Sexp>) -> Sexp {
    let mut v = vec![Sexp::sym(name)];
    v.extend(args);
    Sexp::List(v)
}

fn s(x: &str) -> Sexp {
    Sexp::str(x)
}

fn quote(x: Sexp) -> Sexp {
    Sexp::list([Sexp::sym("quote"), x])
}

fn autodoc_sexp(arg: &AutodocArg) -> Sexp {
    match arg {
        AutodocArg::Token(t) => Sexp::str(t),
        AutodocArg::Nested(v) => Sexp::List(v.iter().map(autodoc_sexp).collect()),
        AutodocArg::Cursor(_) => Sexp::sym("swank::%cursor-marker%"),
    }
}

impl Op {
    pub fn swank_call(&self) -> (Sexp, Thread) {
        use Op::*;
        let t = Thread::T;
        match self {
            ReplEval { input } => (rpc("swank-repl:listener-eval", [s(input)]), Thread::Repl),
            Eval { form, .. } => (rpc("swank:eval-and-grab-output", [s(form)]), t),
            CompileForm { form, buffer, file, offset, .. } => (
                rpc(
                    "swank:compile-string-for-emacs",
                    [
                        s(form),
                        s(buffer),
                        quote(Sexp::list([
                            Sexp::list([Sexp::kw("position"), Sexp::Int(offset + 1)]),
                        ])),
                        file.as_deref().map(s).unwrap_or(Sexp::Nil),
                        Sexp::Nil,
                    ],
                ),
                t,
            ),
            CompileFile { path, load } => (rpc("swank:compile-file-for-emacs", [s(path), Sexp::bool(*load)]), t),
            LoadFile { path } => (rpc("swank:load-file", [s(path)]), t),
            Complete { prefix, package } => (
                rpc("swank:fuzzy-completions", [s(prefix), s(package), Sexp::kw("limit"), Sexp::Int(80)]),
                t,
            ),
            Autodoc { form, .. } => (
                rpc(
                    "swank:autodoc",
                    [
                        quote(Sexp::List(form.iter().map(autodoc_sexp).collect())),
                        Sexp::kw("print-right-margin"),
                        Sexp::Int(100),
                    ],
                ),
                t,
            ),
            Describe { symbol, .. } => (rpc("swank:documentation-symbol", [s(symbol)]), t),
            FindDefinitions { name, .. } => (rpc("swank:find-definitions-for-emacs", [s(name)]), t),
            Apropos { query, package } => (
                rpc(
                    "swank:apropos-list-for-emacs",
                    [s(query), Sexp::t(), Sexp::Nil, package.as_deref().map(s).unwrap_or(Sexp::Nil)],
                ),
                t,
            ),
            Xref { kind, name, .. } => {
                let k = match kind {
                    XrefKind::Calls => "calls",
                    XrefKind::Callers => "callers",
                    XrefKind::References => "references",
                    XrefKind::Binds => "binds",
                    XrefKind::Sets => "sets",
                    XrefKind::Macroexpands => "macroexpands",
                    XrefKind::Specializes => "specializes",
                };
                // sb-introspect walks the heap, and code just loaded can sit in an
                // allocation region it skips until a collection closes it.
                (Sexp::list([Sexp::sym("cl:progn"), Sexp::list([Sexp::sym("sb-ext:gc")]), rpc("swank:xref", [Sexp::kw(k), s(name)])]), t)
            }
            Macroexpand { form, all, .. } => {
                let f = if *all { "swank:swank-macroexpand-all" } else { "swank:swank-macroexpand-1" };
                (rpc(f, [s(form)]), t)
            }
            ListPackages => (rpc("swank:list-all-package-names", [Sexp::t()]), t),
            SetPackage { name } => (rpc("swank:set-package", [s(name)]), Thread::Repl),
            Interrupt => (Sexp::Nil, Thread::Repl),
            ListThreads => (rpc("swank:list-threads", []), t),

            Inspect { form, .. } => (rpc("swank:init-inspector", [s(form)]), t),
            InspectPresentation { id } => (rpc("swank:inspect-presentation", [Sexp::Int(*id), Sexp::t()]), t),
            InspectPart { index } => (rpc("swank:inspect-nth-part", [Sexp::Int(*index)]), t),
            InspectorAction { index } => (rpc("swank:inspector-call-nth-action", [Sexp::Int(*index)]), t),
            InspectorBack => (rpc("swank:inspector-pop", []), t),
            InspectorForward => (rpc("swank:inspector-next", []), t),
            InspectorRefresh => (rpc("swank:inspector-reinspect", []), t),

            InvokeRestart { thread, level, index } => (
                rpc("swank:invoke-nth-restart-for-emacs", [Sexp::Int(*level), Sexp::Int(*index)]),
                *thread,
            ),
            Backtrace { thread, start, end } => (rpc("swank:backtrace", [Sexp::Int(*start), Sexp::Int(*end)]), *thread),
            FrameLocals { thread, frame } => (rpc("swank:frame-locals-and-catch-tags", [Sexp::Int(*frame)]), *thread),
            FrameSource { thread, frame } => (rpc("swank:frame-source-location", [Sexp::Int(*frame)]), *thread),
            EvalInFrame { thread, frame, form, package } => (
                rpc("swank:eval-string-in-frame", [s(form), Sexp::Int(*frame), s(package)]),
                *thread,
            ),
            InspectFrameVar { thread, frame, var } => (
                rpc("swank:inspect-frame-var", [Sexp::Int(*frame), Sexp::Int(*var)]),
                *thread,
            ),
            RestartFrame { thread, frame } => (rpc("swank:restart-frame", [Sexp::Int(*frame)]), *thread),
            ReturnFromFrame { thread, frame, form } => (
                rpc("swank:sldb-return-from-frame", [Sexp::Int(*frame), s(form)]),
                *thread,
            ),
            Step { thread, frame, how } => {
                let f = match how {
                    StepKind::Into => "swank:sldb-step",
                    StepKind::Over => "swank:sldb-next",
                    StepKind::Out => "swank:sldb-out",
                };
                (rpc(f, [Sexp::Int(*frame)]), *thread)
            }
            DebuggerAbort { thread } => (rpc("swank:sldb-abort", []), *thread),
            DebuggerContinue { thread } => (rpc("swank:sldb-continue", []), *thread),
            InspectCondition { thread } => (rpc("swank:inspect-current-condition", []), *thread),

            ToggleTrace { name, .. } => (rpc("zenlisp::toggle-trace", [s(name)]), t),
            TraceReport => (rpc("zenlisp::trace-report", []), t),
            ClearTraces => (rpc("swank-trace-dialog:clear-trace-tree", []), t),
            UntraceAll => (rpc("swank-trace-dialog:dialog-untrace-all", []), t),
            InspectTracePart { id, part, value } => (
                rpc(
                    "swank-trace-dialog:inspect-trace-part",
                    [Sexp::Int(*id), Sexp::Int(*part), Sexp::kw(if *value { "retval" } else { "arg" })],
                ),
                t,
            ),
            ProfileForm { form, .. } => (rpc("zenlisp::profile-form", [s(form)]), t),
            ProfileStart => (rpc("zenlisp::start-profiling", []), t),
            ProfileStop => (rpc("zenlisp::stop-profiling", []), t),
            Disassemble { name, .. } => (rpc("zenlisp::disassemble-name", [s(name)]), t),
            Macrostep { form, .. } => (rpc("swank-macrostep:macrostep-expand-1", [s(form), Sexp::Nil, Sexp::Nil]), t),
            RunTests { system } => (rpc("zenlisp:run-system-tests", [s(system)]), t),
            CreateRepl { remote } => (rpc("zenlisp::create-repl", [Sexp::Int(*remote)]), t),
            ReplSend { .. } | InterruptThread { .. } => (Sexp::Nil, t),
            EndThread { thread } => (rpc("zenlisp::end-thread", [Sexp::Int(*thread)]), t),
            FindSystems { query } => (rpc("zenlisp::find-systems", [s(query)]), t),
            CheckText { text, .. } => (rpc("zenlisp::check-text", [s(text)]), t),
            RerunTests { tests } => (
                rpc(
                    "zenlisp:rerun-tests",
                    [quote(Sexp::List(tests.iter().map(|r| Sexp::list([s(&r.framework), s(&r.id)])).collect()))],
                ),
                t,
            ),
        }
    }

    pub fn package(&self) -> &str {
        use Op::*;
        match self {
            Eval { package, .. }
            | CompileForm { package, .. }
            | Complete { package, .. }
            | Autodoc { package, .. }
            | Describe { package, .. }
            | FindDefinitions { package, .. }
            | Xref { package, .. }
            | Macroexpand { package, .. }
            | Inspect { package, .. }
            | EvalInFrame { package, .. }
            | ToggleTrace { package, .. }
            | ProfileForm { package, .. }
            | Disassemble { package, .. }
            | CheckText { package, .. }
            | Macrostep { package, .. } => package,
            _ => "COMMON-LISP-USER",
        }
    }

    pub fn parse_reply(&self, v: Sexp) -> Reply {
        use Op::*;
        match self {
            Eval { .. } => Reply::Evaluated {
                output: str_at(&v, 0),
                value: str_at(&v, 1),
            },
            CompileForm { .. } | CompileFile { .. } | CheckText { .. } => parse_compilation(&v),
            Complete { .. } => Reply::Completions {
                items: v
                    .items()
                    .first()
                    .map(Sexp::items)
                    .unwrap_or_default()
                    .iter()
                    .map(|c| Completion {
                        label: str_at(c, 0),
                        score: str_at(c, 1).parse().unwrap_or(0.0),
                        flags: str_at(c, 3),
                    })
                    .collect(),
            },
            Autodoc { .. } => parse_arglist(&str_at(&v, 0)),
            FindDefinitions { .. } => Reply::Definitions {
                items: v
                    .items()
                    .iter()
                    .map(|d| Definition { label: str_at(d, 0), location: d.items().get(1).and_then(parse_location) })
                    .collect(),
            },
            Xref { .. } => Reply::Definitions {
                items: v
                    .items()
                    .iter()
                    .map(|d| Definition { label: str_at(d, 0), location: d.items().get(1).and_then(parse_location) })
                    .collect(),
            },
            Apropos { .. } => Reply::Symbols {
                items: v
                    .items()
                    .iter()
                    .map(|p| {
                        let entries = p.items();
                        let mut kinds = Vec::new();
                        let mut doc = None;
                        for pair in entries.chunks(2).skip(1) {
                            if let [Sexp::Kw(k), val] = pair {
                                kinds.push(k.clone());
                                if doc.is_none() {
                                    doc = val.as_str().map(String::from);
                                }
                            }
                        }
                        SymbolInfo { name: p.plist_get("designator").and_then(Sexp::as_str).unwrap_or_default().into(), kinds, doc }
                    })
                    .collect(),
            },
            ListPackages => Reply::Names {
                items: {
                    let mut names: Vec<String> = v.items().iter().filter_map(|n| n.as_str().map(String::from)).collect();
                    names.sort();
                    names
                },
            },
            ListThreads => Reply::Threads {
                items: v
                    .items()
                    .iter()
                    .skip(1)
                    .map(|row| ThreadInfo {
                        id: row.items().first().and_then(Sexp::as_int).unwrap_or_default(),
                        name: str_at(row, 1),
                        status: str_at(row, 2),
                    })
                    .collect(),
            },
            Inspect { .. }
            | InspectPresentation { .. }
            | InspectPart { .. }
            | InspectorAction { .. }
            | InspectorBack
            | InspectorForward
            | InspectorRefresh
            | InspectFrameVar { .. }
            | InspectTracePart { .. }
            | InspectCondition { .. } => match parse_inspector(&v) {
                Some(page) => Reply::Inspector(page),
                None => Reply::None,
            },
            Backtrace { .. } => Reply::Frames { items: v.items().iter().map(parse_frame).collect() },
            FrameLocals { .. } => Reply::Locals {
                items: v
                    .items()
                    .first()
                    .map(Sexp::items)
                    .unwrap_or_default()
                    .iter()
                    .map(|l| Local {
                        name: l.plist_get("name").and_then(Sexp::as_str).unwrap_or_default().into(),
                        id: l.plist_get("id").and_then(Sexp::as_int).unwrap_or_default(),
                        value: l.plist_get("value").and_then(Sexp::as_str).unwrap_or_default().into(),
                    })
                    .collect(),
            },
            FrameSource { .. } => Reply::Location { location: parse_location(&v) },
            TraceReport => parse_traces(&v),
            ProfileForm { .. } | ProfileStop => Reply::Profile(parse_profile(&v)),
            Macrostep { .. } => parse_macrostep(&v),
            RunTests { .. } | RerunTests { .. } => Reply::Tests(parse_test_run(&v)),
            FindSystems { .. } => Reply::Systems {
                items: v
                    .items()
                    .iter()
                    .map(|r| AvailableSystem {
                        name: str_at(r, 0),
                        source: str_at(r, 1),
                        installed: r.items().get(2).is_some_and(|i| !i.is_nil()),
                    })
                    .collect(),
            },
            CreateRepl { .. } => {
                let items = v.items();
                Reply::Repl {
                    channel: items.first().and_then(Sexp::as_int).unwrap_or_default(),
                    thread: items.get(1).and_then(Sexp::as_int).unwrap_or_default(),
                    package: str_at(&v, 2),
                }
            }
            _ => match v {
                Sexp::Str(text) => Reply::Text { text },
                Sexp::Nil => Reply::None,
                other => Reply::Text { text: other.to_string() },
            },
        }
    }

    pub async fn run(&self, conn: &Connection) -> Result<Reply, RexError> {
        match self {
            Op::Interrupt => {
                conn.interrupt(Thread::Repl).await.map_err(|_| RexError::Disconnected)?;
                return Ok(Reply::None);
            }
            Op::InterruptThread { thread } => {
                conn.interrupt(*thread).await.map_err(|_| RexError::Disconnected)?;
                return Ok(Reply::None);
            }
            Op::ReplSend { channel, text } => {
                let msg = Sexp::list([Sexp::kw("emacs-channel-send"), Sexp::Int(*channel), Sexp::list([Sexp::kw("process"), s(text)])]);
                conn.send(&msg).await.map_err(|_| RexError::Disconnected)?;
                return Ok(Reply::None);
            }
            _ => {}
        }
        let (form, thread) = self.swank_call();
        let v = conn.rex(form, self.package(), thread).await?;
        // Swank compiles but leaves loading the fasl to the client, as SLIME does.
        if let Op::CompileFile { load: true, .. } = self {
            let items = v.items();
            let (loadp, fasl) = (items.get(4), items.get(5).and_then(Sexp::as_str));
            if let (Some(loadp), Some(fasl), true) = (loadp, fasl, items.get(2).is_some_and(|s| !s.is_nil())) {
                if !loadp.is_nil() {
                    conn.rex(rpc("swank:load-file", [s(fasl)]), self.package(), thread).await?;
                }
            }
        }
        Ok(self.parse_reply(v))
    }
}

fn str_at(v: &Sexp, i: usize) -> String {
    v.items().get(i).and_then(Sexp::as_str).unwrap_or_default().to_string()
}

/// Turns Swank's `(:location (:file f) (:position p) (:snippet s))`,
/// with 1-based positions, into a zero-based `SourceLocation`.
pub fn parse_location(v: &Sexp) -> Option<SourceLocation> {
    let parts = v.items();
    if !parts.first()?.is_kw("location") {
        return None;
    }
    let mut loc = SourceLocation { file: None, buffer: None, offset: None, snippet: None };
    for p in &parts[1..] {
        let items = p.items();
        let Some(Sexp::Kw(k)) = items.first() else { continue };
        match k.as_str() {
            "file" => loc.file = items.get(1).and_then(Sexp::as_str).map(String::from),
            "buffer" => loc.buffer = items.get(1).and_then(Sexp::as_str).map(String::from),
            "buffer-and-file" => {
                loc.buffer = items.get(1).and_then(Sexp::as_str).map(String::from);
                loc.file = items.get(2).and_then(Sexp::as_str).map(String::from);
            }
            "position" => loc.offset = items.get(1).and_then(Sexp::as_int).map(|p| p - 1),
            "offset" => {
                let start = items.get(1).and_then(Sexp::as_int).unwrap_or(1);
                let delta = items.get(2).and_then(Sexp::as_int).unwrap_or(0);
                loc.offset = Some(start - 1 + delta);
            }
            "snippet" => loc.snippet = items.get(1).and_then(Sexp::as_str).map(String::from),
            _ => {}
        }
    }
    Some(loc)
}

fn parse_compilation(v: &Sexp) -> Reply {
    let items = v.items();
    let notes = items
        .get(1)
        .map(Sexp::items)
        .unwrap_or_default()
        .iter()
        .map(|n| Note {
            message: n.plist_get("message").and_then(Sexp::as_str).unwrap_or_default().into(),
            severity: match n.plist_get("severity") {
                Some(Sexp::Kw(k)) => k.clone(),
                _ => "note".into(),
            },
            location: n.plist_get("location").and_then(parse_location),
        })
        .collect();
    Reply::Compiled {
        success: items.get(2).is_some_and(|s| !s.is_nil()),
        notes,
        seconds: match items.get(3) {
            Some(Sexp::Num(n)) => n.parse().unwrap_or(0.0),
            Some(Sexp::Int(i)) => *i as f64,
            _ => 0.0,
        },
    }
}

fn strings(v: Option<&Sexp>) -> Vec<String> {
    v.map(Sexp::items).unwrap_or_default().iter().filter_map(|x| x.as_str().map(String::from)).collect()
}

fn float(v: Option<&Sexp>) -> Option<f64> {
    match v? {
        Sexp::Num(n) => n.parse().ok(),
        Sexp::Int(i) => Some(*i as f64),
        _ => None,
    }
}

/// `(SPECS TOTAL ((ID PARENT NAME ARGS VALUES DONE) ...))` from `zenlisp::trace-report`.
fn parse_traces(v: &Sexp) -> Reply {
    let items = v.items();
    Reply::Traces {
        specs: strings(items.first()),
        total: items.get(1).and_then(Sexp::as_int).unwrap_or_default(),
        entries: items
            .get(2)
            .map(Sexp::items)
            .unwrap_or_default()
            .iter()
            .map(|e| {
                let f = e.items();
                TraceEntry {
                    id: f.first().and_then(Sexp::as_int).unwrap_or_default(),
                    parent: f.get(1).and_then(Sexp::as_int),
                    name: str_at(e, 2),
                    args: strings(f.get(3)),
                    values: strings(f.get(4)),
                    done: f.get(5).is_some_and(|d| !d.is_nil()),
                }
            })
            .collect(),
    }
}

fn parse_calls(v: Option<&Sexp>) -> Vec<ProfileCall> {
    v.map(Sexp::items)
        .unwrap_or_default()
        .iter()
        .map(|c| ProfileCall { name: str_at(c, 0), samples: c.items().get(1).and_then(Sexp::as_int).unwrap_or_default() })
        .collect()
}

fn parse_profile(v: &Sexp) -> Profile {
    Profile {
        samples: v.plist_get("samples").and_then(Sexp::as_int).unwrap_or_default(),
        seconds: float(v.plist_get("seconds")),
        value: v.plist_get("value").and_then(Sexp::as_str).map(String::from),
        rows: v
            .plist_get("rows")
            .map(Sexp::items)
            .unwrap_or_default()
            .iter()
            .map(|r| ProfileRow {
                name: r.plist_get("name").and_then(Sexp::as_str).unwrap_or_default().into(),
                own: r.plist_get("self").and_then(Sexp::as_int).unwrap_or_default(),
                total: r.plist_get("total").and_then(Sexp::as_int).unwrap_or_default(),
                callers: parse_calls(r.plist_get("callers")),
                callees: parse_calls(r.plist_get("callees")),
            })
            .collect(),
    }
}

fn parse_test_node(v: &Sexp) -> TestNode {
    let text = |k| v.plist_get(k).and_then(Sexp::as_str).map(String::from);
    TestNode {
        id: text("id"),
        framework: text("framework").unwrap_or_default(),
        name: text("name").unwrap_or_default(),
        kind: match v.plist_get("kind") {
            Some(k) if k.is_kw("suite") => TestKind::Suite,
            Some(k) if k.is_kw("check") => TestKind::Check,
            _ => TestKind::Test,
        },
        status: match v.plist_get("status") {
            Some(k) if k.is_kw("failed") => TestStatus::Failed,
            Some(k) if k.is_kw("skipped") => TestStatus::Skipped,
            _ => TestStatus::Passed,
        },
        message: text("message"),
        children: v.plist_get("children").map(Sexp::items).unwrap_or_default().iter().map(parse_test_node).collect(),
    }
}

fn parse_test_run(v: &Sexp) -> TestRun {
    let int = |k| v.plist_get(k).and_then(Sexp::as_int).unwrap_or_default();
    TestRun {
        passed: int("passed"),
        failed: int("failed"),
        skipped: int("skipped"),
        seconds: float(v.plist_get("seconds")).unwrap_or_default(),
        frameworks: strings(v.plist_get("frameworks")),
        tests: v.plist_get("tests").map(Sexp::items).unwrap_or_default().iter().map(parse_test_node).collect(),
    }
}

/// `(:ok TEXT ((NAME TYPE START) ...))` or `(:error MESSAGE)` from swank-macrostep.
fn parse_macrostep(v: &Sexp) -> Reply {
    let items = v.items();
    if !items.first().is_some_and(|k| k.is_kw("ok")) {
        return Reply::Text { text: str_at(v, 1) };
    }
    Reply::Expansion {
        text: str_at(v, 1),
        macros: items
            .get(2)
            .map(Sexp::items)
            .unwrap_or_default()
            .iter()
            .filter_map(|m| Some(MacroSpot { name: str_at(m, 0), start: m.items().get(2)?.as_int()? as usize }))
            .collect(),
    }
}

/// Swank marks the argument under the cursor as `===> arg <===`.
pub fn parse_arglist(raw: &str) -> Reply {
    const OPEN: &str = "===> ";
    const CLOSE: &str = " <===";
    let (Some(a), Some(b)) = (raw.find(OPEN), raw.find(CLOSE)) else {
        return Reply::Arglist { text: raw.into(), active: None };
    };
    if b < a {
        return Reply::Arglist { text: raw.into(), active: None };
    }
    let text = format!("{}{}{}", &raw[..a], &raw[a + OPEN.len()..b], &raw[b + CLOSE.len()..]);
    let start = raw[..a].chars().count();
    let end = start + raw[a + OPEN.len()..b].chars().count();
    Reply::Arglist { text, active: Some(Span { start, end }) }
}

fn parse_inspector(v: &Sexp) -> Option<InspectorPage> {
    let title = v.plist_get("title")?.as_str()?.to_string();
    let content = v.plist_get("content")?.items().first()?.items();
    let parts = content
        .iter()
        .map(|p| match p {
            Sexp::Str(text) => InspectorPart::Text { text: text.clone() },
            Sexp::List(items) if items[0].is_kw("value") => InspectorPart::Value {
                text: items.get(1).and_then(Sexp::as_str).unwrap_or_default().into(),
                index: items.get(2).and_then(Sexp::as_int).unwrap_or_default(),
            },
            Sexp::List(items) if items[0].is_kw("action") => InspectorPart::Action {
                text: items.get(1).and_then(Sexp::as_str).unwrap_or_default().into(),
                index: items.get(2).and_then(Sexp::as_int).unwrap_or_default(),
            },
            other => InspectorPart::Text { text: other.to_string() },
        })
        .collect();
    Some(InspectorPage { title, parts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arglist_marks_active_argument() {
        let Reply::Arglist { text, active } = parse_arglist("(mapcar ===> function <=== list &rest more-lists)") else {
            panic!()
        };
        assert_eq!(text, "(mapcar function list &rest more-lists)");
        let span = active.unwrap();
        assert_eq!(&text[span.start..span.end], "function");
    }

    #[test]
    fn compilation_notes_have_zero_based_offsets() {
        let v = Sexp::parse(
            r#"(:compilation-result ((:message "undefined variable: Y" :severity :warning
                 :location (:location (:buffer "zz.lisp") (:offset 1 14) nil) :references nil)) t 0.003 nil nil)"#,
        )
        .unwrap();
        let Reply::Compiled { success, notes, .. } = parse_compilation(&v) else { panic!() };
        assert!(success);
        assert_eq!(notes[0].severity, "warning");
        assert_eq!(notes[0].location.as_ref().unwrap().offset, Some(14));
    }

    #[test]
    fn buffer_compiled_definitions_name_their_file() {
        let v = Sexp::parse(r#"(:location (:buffer-and-file "/p/main.lisp" "/p/main.lisp") (:offset 26 0) (:snippet "(defun greet"))"#).unwrap();
        let loc = parse_location(&v).unwrap();
        assert_eq!(loc.file.as_deref(), Some("/p/main.lisp"));
        assert_eq!(loc.offset, Some(25));
    }

    #[test]
    fn macrostep_marks_inner_macros() {
        let v = Sexp::parse(r#"(:ok "(IF X\n    (INCF X))" (("INCF" :macro 10)))"#).unwrap();
        let Reply::Expansion { text, macros } = parse_macrostep(&v) else { panic!() };
        assert_eq!(&text[macros[0].start..], "(INCF X))");
        assert_eq!(parse_macrostep(&Sexp::parse(r#"(:error "Not a macro form")"#).unwrap()), Reply::Text { text: "Not a macro form".into() });
    }

    #[test]
    fn inspector_parts() {
        let v = Sexp::parse(r##"(:title "#<HASH-TABLE>" :id 0 :content (("Count" ": " (:value "0" 1) "\n" (:action "[clear]" 2)) 20 0 500))"##)
            .unwrap();
        let page = parse_inspector(&v).unwrap();
        assert_eq!(page.title, "#<HASH-TABLE>");
        assert_eq!(page.parts[2], InspectorPart::Value { text: "0".into(), index: 1 });
        assert_eq!(page.parts[4], InspectorPart::Action { text: "[clear]".into(), index: 2 });
    }
}
