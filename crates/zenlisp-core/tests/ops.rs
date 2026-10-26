use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;
use zenlisp_core::ops::{Op, Reply};
use zenlisp_core::session::{Session, SessionConfig};
use zenlisp_core::swank::{Debugger, Event};

async fn start() -> Session {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    Session::start(&SessionConfig::new(resources)).await.expect("sbcl starts")
}

async fn next_debugger(events: &mut Receiver<Event>) -> Debugger {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Event::Debug(d) = events.recv().await.unwrap() {
                return d;
            }
        }
    })
    .await
    .expect("debugger event")
}

fn cl(op: impl FnOnce(String) -> Op) -> Op {
    op("COMMON-LISP-USER".into())
}

#[tokio::test]
async fn repl_eval_streams_output_and_presented_result() {
    let s = start().await;
    let mut events = s.conn.subscribe();
    Op::ReplEval { input: "(progn (princ \"hello\") (list 1 2))".into() }.run(&s.conn).await.unwrap();
    let mut output = String::new();
    let mut result = String::new();
    let mut presented = false;
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
        match e {
            Event::Output { text, target: Some(t) } if t == "repl-result" => result.push_str(&text),
            Event::Output { text, target: None } => output.push_str(&text),
            Event::PresentationStart { .. } => presented = true,
            _ => {}
        }
    }
    assert_eq!(output.trim_end(), "hello");
    assert!(result.starts_with("(1 2)"), "result was {result:?}");
    assert!(presented, "result is a clickable presentation");
    s.stop().await;
}

#[tokio::test]
async fn editor_services() {
    let s = start().await;
    let c = &s.conn;

    let Reply::Completions { items } = cl(|package| Op::Complete { prefix: "mvb".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(items[0].label, "multiple-value-bind");

    let Reply::Compiled { success, notes, .. } = cl(|package| Op::CompileForm {
        form: "(defun zz (x) (+ x y))".into(),
        package,
        buffer: "scratch.lisp".into(),
        file: None,
        offset: 100,
    })
    .run(c)
    .await
    .unwrap() else { panic!() };
    assert!(success);
    assert_eq!(notes[0].severity, "warning");
    assert_eq!(notes[0].location.as_ref().unwrap().offset, Some(100 + 14), "note points at (+ x y) in the buffer");

    let Reply::Definitions { items } = cl(|package| Op::FindDefinitions { name: "zenlisp:ping".into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(items[0].location.as_ref().unwrap().file.as_ref().unwrap().ends_with("zenlisp.lisp"));

    let Reply::Inspector(page) = cl(|package| Op::Inspect { form: "(list 1 2)".into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(page.title.contains("CONS"), "{}", page.title);
    assert!(page.parts.iter().any(|p| matches!(p, zenlisp_core::ops::InspectorPart::Value { text, .. } if text == "2")));

    let Reply::Names { items } = Op::ListPackages.run(c).await.unwrap() else { panic!() };
    assert!(items.iter().any(|n| n == "COMMON-LISP-USER"));
    s.stop().await;
}

#[tokio::test]
async fn live_repair_by_restarting_a_frame() {
    let s = start().await;
    let c = &s.conn;
    let mut events = c.subscribe();
    cl(|package| Op::Eval { form: "(progn (declaim (optimize (debug 3))) (defun half (x) (/ x 0)))".into(), package })
        .run(c)
        .await
        .unwrap();

    let conn = c.clone();
    let waiting = tokio::spawn(async move { cl(|package| Op::Eval { form: "(half 10)".into(), package }).run(&conn).await });
    let dbg = next_debugger(&mut events).await;
    assert!(dbg.condition.contains("DIVISION-BY-ZERO"), "{}", dbg.condition);
    let frame = dbg.frames.iter().find(|f| f.description.starts_with("(HALF")).expect("HALF frame");
    assert!(frame.restartable);

    let Reply::Locals { items } = Op::FrameLocals { thread: dbg.thread, frame: frame.index }.run(c).await.unwrap() else { panic!() };
    assert_eq!(items[0].value, "10");
    let Reply::Text { text } = cl(|package| Op::EvalInFrame { thread: dbg.thread, frame: frame.index, form: "(* x 3)".into(), package })
        .run(c)
        .await
        .unwrap() else { panic!() };
    assert!(text.starts_with("=> 30 "), "{text}");

    cl(|package| Op::Eval { form: "(defun half (x) (/ x 2))".into(), package }).run(c).await.unwrap();
    let _ = Op::RestartFrame { thread: dbg.thread, frame: frame.index }.run(c).await;
    let Reply::Evaluated { value, .. } = waiting.await.unwrap().unwrap() else { panic!() };
    assert_eq!(value, "5");
    s.stop().await;
}

#[tokio::test]
async fn compiled_files_load_and_stop_at_breakpoints() {
    let s = start().await;
    let mut events = s.conn.subscribe();
    let dir = std::env::temp_dir().join(format!("zenlisp-bp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("bp.lisp");
    let text = "(defun bp-helper (y) (list y y))\n(defun bp-target (x)\n  (let ((a (bp-helper x)))\n    (length (append a (bp-helper (1+ x))))))\n";
    std::fs::write(&file, text).unwrap();
    let path = file.to_string_lossy().to_string();
    let eval = |form: &str| cl(|package| Op::Eval { form: form.into(), package });

    Op::CompileFile { path: path.clone(), load: true }.run(&s.conn).await.unwrap();
    let value = |r| match r {
        Reply::Evaluated { value, .. } => value,
        other => panic!("{other:?}"),
    };
    assert_eq!(value(eval("(bp-target 3)").run(&s.conn).await.unwrap()), "4", "compile-file loads what it compiled");

    let from = text.find("(let").unwrap();
    let to = text.rfind("))))").unwrap() + 3;
    let set = format!("(zenlisp::set-breakpoints {path:?} '(({from} {to} \"(let\")))");
    assert_eq!(value(eval(&set).run(&s.conn).await.unwrap()), format!("({from})"), "the range binds to a call site");

    let conn = s.conn.clone();
    let call = tokio::spawn(async move { cl(|package| Op::Eval { form: "(bp-target 3)".into(), package }).run(&conn).await });
    let d = next_debugger(&mut events).await;
    assert!(d.stepping, "a breakpoint stops at a form, as a step does");
    assert!(d.condition.contains("Breakpoint at (let"), "{}", d.condition);
    assert!(d.frames[0].description.contains("BP-TARGET"), "frame 0 is the function that hit it: {}", d.frames[0].description);
    let index = d.restarts.iter().position(|r| r.name == "CONTINUE").expect("a continue restart") as i64;
    let _ = Op::InvokeRestart { thread: d.thread, level: d.level, index }.run(&s.conn).await;
    assert_eq!(value(call.await.unwrap().unwrap()), "4", "continuing finishes the call");

    let clear = format!("(zenlisp::set-breakpoints {path:?} nil)");
    assert_eq!(value(eval(&clear).run(&s.conn).await.unwrap()), "NIL");
    assert_eq!(value(eval("(bp-target 3)").run(&s.conn).await.unwrap()), "4", "cleared breakpoints no longer stop");
    s.stop().await;
}

#[tokio::test]
async fn trace_profile_disassemble_and_macrostep() {
    let s = start().await;
    let c = &s.conn;
    let eval = |form: &str| cl(|package| Op::Eval { form: form.into(), package });
    eval("(defun tr-fib (n) (if (< n 2) n (+ (tr-fib (- n 1)) (tr-fib (- n 2)))))").run(c).await.unwrap();

    cl(|package| Op::ToggleTrace { name: "tr-fib".into(), package }).run(c).await.unwrap();
    eval("(tr-fib 2)").run(c).await.unwrap();
    let Reply::Traces { specs, entries, .. } = Op::TraceReport.run(c).await.unwrap() else { panic!() };
    assert_eq!(specs, ["COMMON-LISP-USER::TR-FIB"], "names read back from any package");
    assert_eq!(entries.len(), 3, "{entries:?}");
    assert_eq!((entries[0].args.as_slice(), entries[0].values.as_slice(), entries[0].parent), (&["2".to_string()][..], &["1".to_string()][..], None));
    assert_eq!(entries[1].parent, Some(entries[0].id), "the recursive calls nest under the first");
    let Reply::Inspector(page) = (Op::InspectTracePart { id: entries[0].id, part: 0, value: false }).run(c).await.unwrap() else { panic!() };
    assert!(page.title.contains('2'), "{}", page.title);

    let Reply::Text { text } = cl(|package| Op::Disassemble { name: "tr-fib".into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(text.contains("disassembly for TR-FIB"), "the traced function itself, not its wrapper: {}", &text[..80.min(text.len())]);

    Op::UntraceAll.run(c).await.unwrap();
    Op::ClearTraces.run(c).await.unwrap();
    let Reply::Traces { specs, entries, .. } = Op::TraceReport.run(c).await.unwrap() else { panic!() };
    assert!(specs.is_empty() && entries.is_empty());

    let Reply::Profile(p) = cl(|package| Op::ProfileForm { form: "(tr-fib 33)".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(p.value.as_deref(), Some("3524578"));
    assert!(p.samples > 10, "{p:?}");
    let top = &p.rows[0];
    // A sample can land in the call around the form, so nearly every one, not all.
    assert!(top.name == "TR-FIB" && top.total * 10 >= p.samples * 9, "the profiled function is on nearly every sample: {} of {}: {:?}", top.total, p.samples, p.rows);
    assert!(!p.rows.iter().any(|r| r.name.contains("SWANK") || r.name.contains("EVAL") || r.name.contains("COMPILE")), "the IDE's frames are left out: {:?}", p.rows);

    let Reply::Expansion { text, macros } = cl(|package| Op::Macrostep { form: "(when x (incf x))".into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(text.starts_with("(IF X"), "{text}");
    assert_eq!(macros[0].name, "INCF");
    assert!(text[macros[0].start..].starts_with("(INCF X)"));
    let r = cl(|package| Op::Macrostep { form: "(list 1)".into(), package }).run(c).await.unwrap();
    assert_eq!(r, Reply::Text { text: "Not a macro form".into() });
    s.stop().await;
}

/// Needs FiveAM and Parachute installed through Quicklisp.
#[tokio::test]
async fn test_runs_report_fiveam_and_parachute_results_as_a_tree() {
    let s = start().await;
    let c = &s.conn;
    let dir = std::env::temp_dir().join(format!("zenlisp-tests-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("tt.asd"),
        r#"(defsystem "tt" :in-order-to ((test-op (test-op "tt/five" "tt/para"))))
(defsystem "tt/five" :depends-on ("fiveam") :components ((:file "five"))
  :perform (test-op (o c) (symbol-call :fiveam :run! (find-symbol "TT" "TT/FIVE"))))
(defsystem "tt/para" :depends-on ("parachute") :components ((:file "para"))
  :perform (test-op (o c) (symbol-call :parachute :test :tt/para)))
"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("five.lisp"),
        "(defpackage #:tt/five (:use #:cl #:fiveam))\n(in-package #:tt/five)\n(def-suite tt)\n(in-suite tt)\n\
         (test adds (is (= 3 (+ 1 2))))\n(test wrong (is (= 5 (+ 2 2)) \"two and two make ~a\" (+ 2 2)))\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("para.lisp"),
        "(defpackage #:tt/para (:use #:cl #:parachute))\n(in-package #:tt/para)\n\
         (define-test outer)\n(define-test inner :parent outer (is = 1 2))\n",
    )
    .unwrap();
    let setup = zenlisp_core::project::quicklisp_setup().expect("Quicklisp is installed");
    let register = format!("(progn (load {:?}) (push #p\"{}/\" asdf:*central-registry*) t)", setup.display().to_string(), dir.display());
    cl(|package| Op::Eval { form: register, package }).run(c).await.unwrap();

    let Reply::Tests(run) = (Op::RunTests { system: "tt".into() }).run(c).await.unwrap() else { panic!() };
    assert_eq!((run.passed, run.failed), (1, 2), "{run:#?}");
    assert_eq!(run.frameworks, ["fiveam", "parachute"]);
    let suite = &run.tests[0];
    assert_eq!((suite.name.as_str(), suite.kind), ("TT", zenlisp_core::ops::TestKind::Suite));
    let wrong = suite.children.iter().find(|t| t.name == "WRONG").unwrap();
    assert_eq!(wrong.id.as_deref(), Some("TT/FIVE::WRONG"), "a test can be named to run it again");
    assert_eq!(wrong.children[0].name, "(= 5 (+ 2 2))", "checks print in the test's package");
    assert_eq!(wrong.children[0].message.as_deref(), Some("two and two make 4"));
    let outer = run.tests.iter().find(|t| t.name == "OUTER").expect("parachute's outer test is a root");
    assert_eq!(outer.children[0].name, "INNER", "nested parachute tests nest: {outer:#?}");
    assert_eq!(run.tests.iter().filter(|t| t.name == "INNER").count(), 0, "a nested test shows once");

    let again = vec![zenlisp_core::ops::TestRef { framework: "fiveam".into(), id: "TT/FIVE::WRONG".into() }];
    let Reply::Tests(rerun) = (Op::RerunTests { tests: again }).run(c).await.unwrap() else { panic!() };
    assert_eq!((rerun.passed, rerun.failed), (0, 1), "{rerun:#?}");
    s.stop().await;
}

#[tokio::test]
async fn extra_repls_evaluate_in_their_own_thread() {
    use zenlisp_core::swank::ChannelMessage;
    let s = start().await;
    let c = &s.conn;
    let mut events = c.subscribe();
    let Reply::Repl { channel, thread, package } = (Op::CreateRepl { remote: 7 }).run(c).await.unwrap() else { panic!() };
    assert_eq!(package, "COMMON-LISP-USER");
    assert_ne!(thread, 0, "the REPL's thread id is known before it is reported");
    // The messages for remote channel 7, up to and including the first that `stop` accepts.
    async fn until(events: &mut Receiver<Event>, stop: impl Fn(&ChannelMessage) -> bool) -> Vec<ChannelMessage> {
        let mut seen = Vec::new();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Event::Channel { channel: 7, message } = events.recv().await.unwrap() {
                    let done = stop(&message);
                    seen.push(message);
                    if done {
                        return;
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no awaited message for channel 7; saw {seen:?}"));
        seen
    }
    let prompt = |m: &ChannelMessage| matches!(m, ChannelMessage::Prompt { .. });

    (Op::ReplSend { channel, text: "(progn (setq *zz* (+ 1 2)) *zz*)".into() }).run(c).await.unwrap();
    assert!(until(&mut events, prompt).await.contains(&ChannelMessage::WriteResult { text: "3\n".into() }));

    (Op::ReplSend { channel, text: "(read-line)".into() }).run(c).await.unwrap();
    until(&mut events, |m| *m == ChannelMessage::ReadMode { reading: true }).await;
    (Op::ReplSend { channel, text: "hello\n".into() }).run(c).await.unwrap();
    let answered = until(&mut events, prompt).await;
    assert!(answered.contains(&ChannelMessage::WriteResult { text: "\"hello\"\nNIL\n".into() }), "read-line returns the line it was sent: {answered:?}");

    let listed = |r: Reply| match r {
        Reply::Threads { items } => items.iter().any(|t| t.id == thread),
        other => panic!("{other:?}"),
    };
    let all = Op::ListThreads.run(c).await.unwrap();
    assert!(listed(all.clone()), "the REPL has a thread of its own: {thread} in {all:?}");
    (Op::EndThread { thread }).run(c).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!listed(Op::ListThreads.run(c).await.unwrap()), "closing the REPL ends its thread");
    s.stop().await;
}

#[tokio::test]
async fn checking_text_reports_notes_without_defining_anything() {
    let s = start().await;
    let c = &s.conn;
    let text = "(defun ck-helper (x) (* x 2))\n\n(defun ck-user (y)\n  (+ (ck-helper y) undefined-zz))\n";
    let Reply::Compiled { notes, .. } = cl(|package| Op::CheckText { text: text.into(), package }).run(c).await.unwrap() else { panic!() };
    let warning = notes.iter().find(|n| n.message.contains("UNDEFINED-ZZ")).expect("the undefined variable is reported");
    // SBCL places a note at the form it was compiling, here the call holding the variable.
    assert_eq!(warning.location.as_ref().and_then(|l| l.offset), Some(text.find("(+ (ck-helper").unwrap() as i64), "{notes:?}");
    assert!(!notes.iter().any(|n| n.message.contains("CK-HELPER")), "a function the file defines is known: {notes:?}");
    let Reply::Evaluated { value, .. } = cl(|package| Op::Eval { form: "(fboundp 'ck-user)".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(value, "NIL", "checking does not load the code");

    let unloaded = "(in-package #:ck-not-loaded)\n\n(defun f (x) (+ x missing-yy))\n";
    let Reply::Compiled { notes, .. } = cl(|package| Op::CheckText { text: unloaded.into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(notes.iter().any(|n| n.message.contains("MISSING-YY")), "a file whose package is not loaded is still checked: {notes:?}");
    let Reply::Evaluated { value, .. } = cl(|package| Op::Eval { form: "(find-package \"CK-NOT-LOADED\")".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(value, "NIL", "the stand-in package is gone again");
    s.stop().await;
}
