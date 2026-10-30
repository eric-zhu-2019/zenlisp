use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;
use zparen_core::ops::{Op, Reply};
use zparen_core::session::{Session, SessionConfig};
use zparen_core::swank::{Debugger, Event};

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
    cl(|package| Op::ReplEval { input: "(progn (princ \"hello\") (list 1 2))".into(), package }).run(&s.conn).await.unwrap();
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

    let Reply::Definitions { items } = cl(|package| Op::FindDefinitions { name: "zparen:ping".into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(items[0].location.as_ref().unwrap().file.as_ref().unwrap().ends_with("zparen.lisp"));

    let Reply::Inspector(page) = cl(|package| Op::Inspect { form: "(list 1 2)".into(), package }).run(c).await.unwrap() else { panic!() };
    assert!(page.title.contains("CONS"), "{}", page.title);
    assert!(page.parts.iter().any(|p| matches!(p, zparen_core::ops::InspectorPart::Value { text, .. } if text == "2")));

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
    let dir = std::env::temp_dir().join(format!("zparen-bp-{}", std::process::id()));
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
    let set = format!("(zparen::set-breakpoints {path:?} '(({from} {to} \"(let\")))");
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

    let clear = format!("(zparen::set-breakpoints {path:?} nil)");
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
    let dir = std::env::temp_dir().join(format!("zparen-tests-{}", std::process::id()));
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
    let setup = zparen_core::project::quicklisp_setup().expect("Quicklisp is installed");
    let register = format!("(progn (load {:?}) (push #p\"{}/\" asdf:*central-registry*) t)", setup.display().to_string(), dir.display());
    cl(|package| Op::Eval { form: register, package }).run(c).await.unwrap();

    let Reply::Tests(run) = (Op::RunTests { system: "tt".into() }).run(c).await.unwrap() else { panic!() };
    assert_eq!((run.passed, run.failed), (1, 2), "{run:#?}");
    assert_eq!(run.frameworks, ["fiveam", "parachute"]);
    let suite = &run.tests[0];
    assert_eq!((suite.name.as_str(), suite.kind), ("TT", zparen_core::ops::TestKind::Suite));
    let wrong = suite.children.iter().find(|t| t.name == "WRONG").unwrap();
    assert_eq!(wrong.id.as_deref(), Some("TT/FIVE::WRONG"), "a test can be named to run it again");
    assert_eq!(wrong.children[0].name, "(= 5 (+ 2 2))", "checks print in the test's package");
    assert_eq!(wrong.children[0].message.as_deref(), Some("two and two make 4"));
    let outer = run.tests.iter().find(|t| t.name == "OUTER").expect("parachute's outer test is a root");
    assert_eq!(outer.children[0].name, "INNER", "nested parachute tests nest: {outer:#?}");
    assert_eq!(run.tests.iter().filter(|t| t.name == "INNER").count(), 0, "a nested test shows once");

    let again = vec![zparen_core::ops::TestRef { framework: "fiveam".into(), id: "TT/FIVE::WRONG".into() }];
    let Reply::Tests(rerun) = (Op::RerunTests { tests: again }).run(c).await.unwrap() else { panic!() };
    assert_eq!((rerun.passed, rerun.failed), (0, 1), "{rerun:#?}");
    s.stop().await;
}

#[tokio::test]
async fn extra_repls_evaluate_in_their_own_thread() {
    use zparen_core::swank::ChannelMessage;
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
    let Reply::Compiled { notes, .. } = cl(|package| Op::CheckText { text: text.into(), package, file: None }).run(c).await.unwrap() else { panic!() };
    let warning = notes.iter().find(|n| n.message.contains("UNDEFINED-ZZ")).expect("the undefined variable is reported");
    // SBCL places a note at the form it was compiling, here the call holding the variable.
    assert_eq!(warning.location.as_ref().and_then(|l| l.offset), Some(text.find("(+ (ck-helper").unwrap() as i64), "{notes:?}");
    assert!(!notes.iter().any(|n| n.message.contains("CK-HELPER")), "a function the file defines is known: {notes:?}");
    let Reply::Evaluated { value, .. } = cl(|package| Op::Eval { form: "(fboundp 'ck-user)".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(value, "NIL", "checking does not load the code");

    let unloaded = "(in-package #:ck-not-loaded)\n\n(defun f (x) (+ x missing-yy))\n";
    let Reply::Compiled { notes, .. } = cl(|package| Op::CheckText { text: unloaded.into(), package, file: None }).run(c).await.unwrap() else { panic!() };
    assert!(notes.iter().any(|n| n.message.contains("MISSING-YY")), "a file whose package is not loaded is still checked: {notes:?}");
    let Reply::Evaluated { value, .. } = cl(|package| Op::Eval { form: "(find-package \"CK-NOT-LOADED\")".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(value, "NIL", "the stand-in package is gone again");
    s.stop().await;
}

#[tokio::test]
async fn checking_a_loaded_file_does_not_report_it_redefining_itself() {
    let s = start().await;
    let c = &s.conn;
    let dir = std::env::temp_dir().join(format!("zparen-redefine-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // Coalton's types expand to definitions like this one, made while compiling.
    let text = "(eval-when (:compile-toplevel :load-toplevel :execute)\n  (defun rd-helper () 1))\n\n(defun rd-user () (rd-missing))\n";
    let file = dir.join("loaded.lisp");
    std::fs::write(&file, text).unwrap();
    Op::CompileFile { path: file.to_string_lossy().into(), load: true }.run(c).await.unwrap();
    let check = |file: &std::path::Path| cl(|package| Op::CheckText { text: text.into(), package, file: Some(file.to_string_lossy().into()) });

    let Reply::Compiled { notes, .. } = check(&file).run(c).await.unwrap() else { panic!() };
    assert!(!notes.iter().any(|n| n.severity == "redefinition"), "{notes:?}");
    assert!(notes.iter().any(|n| n.message.contains("RD-MISSING")), "other notes stay: {notes:?}");

    let Reply::Compiled { notes, .. } = check(&dir.join("other.lisp")).run(c).await.unwrap() else { panic!() };
    assert!(notes.iter().any(|n| n.severity == "redefinition" && n.message.contains("RD-HELPER")), "another file's redefinition is still reported: {notes:?}");
    s.stop().await;
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn names_being_typed_are_packages_or_systems_where_the_code_says_so() {
    let s = start().await;
    // `^` marks the cursor; the text before it is what the editor sends.
    let cases = [
        ("(defpackage #:app\n  (:use #:cl #:alexan^))", Some("package")),
        ("(defpackage #:app\n  (:local-nicknames (#:a #:alexan^)))", Some("package")),
        ("(defpackage #:app\n  (:import-from #:split^))", Some("package")),
        ("(defpackage #:app\n  (:local-nicknames (#:a^ #:alexandria)))", None),
        ("(defpackage #:app\n  (:import-from #:alexandria #:fla^))", None),
        ("(defpackage #:app\n  (:export #:ma^))", None),
        ("(in-package :my-^", Some("package")),
        ("(in-package \"MY-^\")", Some("package")),
        ("(defsystem \"app\"\n  :depends-on (\"cl-pp^\"))", Some("system")),
        ("(defsystem \"app\"\n  :depends-on (:alex^))", Some("system")),
        ("(ql:quickload :split^)", Some("system")),
        ("(ql:quickload '(:alexandria :spl^))", Some("system")),
        ("(list :key^)", None),
        ("(alexandria:fla^", None),
        ("(defun f () (mapc^", None),
        ("(f #\\( \"a;b(\" ; (x\n #| ( |# (in-package #:fo^", Some("package")),
    ];
    for (src, want) in cases {
        let text = src[..src.find('^').unwrap()].to_string();
        let got = match (Op::DesignatorAt { text }).run(&s.conn).await.unwrap() {
            Reply::Text { text } => Some(text),
            Reply::None => None,
            other => panic!("{other:?}"),
        };
        assert_eq!(got.as_deref(), want, "{src}");
    }
    s.stop().await;
}

#[tokio::test]
async fn plugins_add_commands_settings_checks_and_repl_hooks() {
    let data = std::env::temp_dir().join(format!("zparen-plugins-{}", std::process::id()));
    // Plugins start in the data folder, where they once lived, and move to the config folder.
    let plugins = data.join("plugins");
    let config = data.join("config");
    std::fs::create_dir_all(&plugins).unwrap();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/plugins");
    for f in ["demo.lisp", "broken.lisp"] {
        std::fs::copy(fixtures.join(f), plugins.join(f)).unwrap();
    }
    let mut cfg = SessionConfig::new(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources"));
    cfg.data_dir = data.clone();
    cfg.config_dir = config.clone();
    let s = Session::start(&cfg).await.expect("sbcl starts");
    let c = &s.conn;
    let json = |r: Reply| match r {
        Reply::Text { text } => serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|e| panic!("{e}: {text}")),
        other => panic!("{other:?}"),
    };

    let m = json(Op::PluginManifest.run(c).await.unwrap());
    assert_eq!(m["directory"], format!("{}/", config.join("plugins").display()), "plugins load from the config folder");
    assert!(config.join("plugins/demo.lisp").exists() && !plugins.exists(), "and the old folder moved there");
    let broken = m["plugins"].as_array().unwrap().iter().find(|p| p["name"] == "broken").unwrap();
    assert!(broken["error"].as_str().unwrap().contains("boom"), "a plugin that fails says why: {m}");
    assert_eq!(m["commands"][0]["id"], "demo/wrap-form", "the other plugins still load");
    assert_eq!(m["commands"][0]["key"], "Mod-Alt-t");
    assert_eq!(m["settings"][0]["value"], "time");
    assert!(m["hooks"].as_array().unwrap().contains(&"repl-input".into()));

    let text = "(defun f () 1)\n(foo)";
    let run = || cl(|package| Op::RunPluginCommand { id: "demo/wrap-form".into(), file: None, text: text.into(), cursor: 17, selection_from: 17, selection_to: 17, package });
    let r = json(run().run(c).await.unwrap());
    assert_eq!(r["effects"][0], serde_json::json!({ "type": "replace", "from": 15, "to": 20, "text": "(time (foo))" }));

    json(Op::SetPluginSetting { id: "DEMO::WRAP-WITH".into(), value: "progn".into() }.run(c).await.unwrap());
    json(Op::ReloadPlugins.run(c).await.unwrap());
    let r = json(run().run(c).await.unwrap());
    assert_eq!(r["effects"][0]["text"], "(progn (foo))", "a setting keeps its value across a reload");

    let Reply::Compiled { notes, .. } = cl(|package| Op::CheckText { text: "(defun g () (eval 1))".into(), package, file: None }).run(c).await.unwrap() else { panic!() };
    assert!(notes.iter().any(|n| n.message == "EVAL here [no-eval]"), "{notes:?}");

    let file = data.join("compiled.lisp");
    std::fs::write(&file, "(defun compiled-by-test () 1)\n").unwrap();
    Op::CompileFile { path: file.to_string_lossy().into(), load: true }.run(c).await.unwrap();
    let Reply::Evaluated { value, .. } = cl(|package| Op::Eval { form: "demo::*compiled*".into(), package }).run(c).await.unwrap() else { panic!() };
    assert_eq!(value, "((\"compiled.lisp\" T))", "a compile runs its hook once, and checks run none");

    let mut events = c.subscribe();
    cl(|package| Op::ReplEval { input: ",hello".into(), package }).run(c).await.unwrap();
    let mut output = String::new();
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
        if let Event::Output { text, .. } = e {
            output.push_str(&text);
        }
    }
    assert!(output.contains("hello from a plugin"), "a REPL hook handles its own input: {output:?}");
    s.stop().await;
    let _ = std::fs::remove_dir_all(&data);
}

#[tokio::test]
async fn coal_files_compile_with_coalton() {
    let s = start().await;
    let c = &s.conn;
    let run = |op: Op| async move { tokio::time::timeout(Duration::from_secs(10), op.run(c)).await.expect("answers").unwrap() };
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/coalton-stand-in.lisp");
    run(cl(|package| Op::Eval { form: format!("(load {:?})", fixture.display().to_string()), package })).await;
    let dir = std::env::temp_dir().join(format!("zparen-coal-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = |name: &str| dir.join(name).to_string_lossy().into_owned();

    std::fs::write(dir.join("good.coal"), "(package zen-coal)\n\n(define answer 42)\n").unwrap();
    let Reply::Compiled { success, notes, .. } = run(Op::CompileFile { path: path("good.coal"), load: true }).await else { panic!() };
    assert!(success && notes.is_empty(), "{notes:?}");
    let Reply::Evaluated { value, .. } = run(cl(|package| Op::Eval { form: "(symbol-value (find-symbol \"ANSWER\" \"ZEN-COAL\"))".into(), package })).await else {
        panic!()
    };
    assert_eq!(value, "42", "the file loaded");

    let bad = "(package zen-coal-bad)\n\n(define v (bad 1))\n";
    std::fs::write(dir.join("bad.coal"), bad).unwrap();
    let Reply::Compiled { success, notes, .. } = run(Op::CompileFile { path: path("bad.coal"), load: true }).await else { panic!() };
    assert!(!success, "{notes:?}");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].message.starts_with("error: Ambiguous predicate"), "{}", notes[0].message);
    assert_eq!(notes[0].location.as_ref().and_then(|l| l.offset), Some(bad.find("(bad").unwrap() as i64), "on the expression Coalton blames");

    let Reply::Compiled { success, notes, .. } = run(cl(|package| Op::CheckText { text: bad.into(), package, file: Some(path("bad.coal")) })).await else { panic!() };
    assert!(!success, "{notes:?}");
    let offsets: Vec<_> = notes.iter().filter(|n| n.severity == "error").map(|n| n.location.as_ref().and_then(|l| l.offset)).collect();
    assert_eq!(offsets, [Some(bad.find("(bad").unwrap() as i64)], "the check reads the text as .coal: {notes:?}");
    let _ = std::fs::remove_dir_all(&dir);
    s.stop().await;
}

#[tokio::test]
async fn coalton_forms_run_inside_coalton_and_hovers_show_coalton_types() {
    let s = start().await;
    let c = &s.conn;
    let run = |op: Op| async move { tokio::time::timeout(Duration::from_secs(10), op.run(c)).await.expect("answers").unwrap() };
    let eval = |form: &str| {
        let op = cl(|package| Op::Eval { form: form.into(), package });
        async move {
            match run(op).await {
                Reply::Evaluated { value, .. } => value,
                other => panic!("{other:?}"),
            }
        }
    };
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/coalton-stand-in.lisp");
    eval(&format!("(load {:?})", fixture.display().to_string())).await;

    assert_eq!(eval("(coalton:define x 1)").await, ":TOPLEVEL");
    assert_eq!(eval("cl-user::*compiled*").await, "((COALTON:DEFINE X 1))");
    assert_eq!(eval("(coalton:match y)").await, "(:EXPRESSION (COALTON:MATCH Y))");
    assert_eq!(eval("(list 'coalton:define)").await, "(COALTON:DEFINE)", "Lisp forms run as written");

    run(cl(|package| Op::ReplEval { input: "(coalton:define z 2)".into(), package })).await;
    assert_eq!(eval("cl-user::*compiled*").await, "((COALTON:DEFINE Z 2))");

    // A form Coalton rejects in the REPL prints Coalton's message there, and the debugger stays closed.
    let mut events = c.subscribe();
    run(cl(|package| Op::ReplEval { input: "(coalton:coalton-toplevel (coalton:define v (bad 1)))".into(), package })).await;
    let mut output = String::new();
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
        match e {
            Event::Output { text, target: None } => output.push_str(&text),
            Event::Debug(d) => panic!("the debugger opened: {d:?}"),
            _ => {}
        }
    }
    assert!(output.starts_with("; error: Ambiguous predicate\n;   --> <macroexpansion>"), "{output:?}");
    // While ASDF works, as a quickload typed in the REPL does, the debugger offers ASDF's restarts as before.
    let mut events = c.subscribe();
    let input = "(let ((asdf/session:*asdf-session* t)) (eval '(coalton:coalton-toplevel (coalton:define v (bad 1)))))";
    let conn = c.clone();
    let pending = tokio::spawn(async move { cl(|package| Op::ReplEval { input: input.into(), package }).run(&conn).await });
    let d = next_debugger(&mut events).await;
    assert!(d.condition.contains("Ambiguous predicate"), "{}", d.condition);
    let _ = Op::DebuggerAbort { thread: d.thread }.run(c).await;
    let _ = pending.await;

    // A Lisp call to a Coalton function that takes an instance argument prints how to call it, and the debugger stays closed.
    let mut events = c.subscribe();
    run(cl(|package| Op::ReplEval { input: "(scale 10)".into(), package })).await;
    let mut output = String::new();
    while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
        match e {
            Event::Output { text, target: None } => output.push_str(&text),
            Event::Debug(d) => panic!("the debugger opened: {d:?}"),
            _ => {}
        }
    }
    assert!(
        output.contains("; scale is a Coalton function of type ∀ :A. NUM :A ⇒ :A → :A.\n; Call it as (coalton (scale 10)).\n"),
        "{output:?}"
    );
    // Other wrong calls open the debugger without the hint, including one inside the arguments to a Coalton function.
    for input in ["(add2 1 2)", "(scale (add2 1 2))"] {
        let mut events = c.subscribe();
        let conn = c.clone();
        let pending = tokio::spawn(async move { cl(|package| Op::ReplEval { input: input.into(), package }).run(&conn).await });
        let mut output = String::new();
        let d = loop {
            match tokio::time::timeout(Duration::from_secs(10), events.recv()).await.expect("the debugger opens").unwrap() {
                Event::Output { text, target: None } => output.push_str(&text),
                Event::Debug(d) => break d,
                _ => {}
            }
        };
        assert!(d.condition.contains("invalid number of arguments"), "{}", d.condition);
        assert!(!output.contains("Coalton function"), "{output:?}");
        let _ = Op::DebuggerAbort { thread: d.thread }.run(c).await;
        let _ = pending.await;
    }

    let Reply::Compiled { success, notes, .. } = run(cl(|package| Op::CompileForm {
        form: "(coalton:define w 3)".into(),
        buffer: "scratch".into(),
        file: None,
        offset: 0,
        package,
    }))
    .await
    else {
        panic!()
    };
    assert!(success && notes.is_empty(), "{notes:?}");
    assert_eq!(eval("cl-user::*compiled*").await, "((COALTON:DEFINE W 3))");

    // Coalton's own errors are notes on the expression it blames, and the form never reaches the debugger.
    let form = "(coalton:coalton-toplevel\n  (coalton:define w (bad 1)))";
    let Reply::Compiled { success, notes, .. } = run(cl(|package| Op::CompileForm {
        form: form.into(),
        buffer: "scratch".into(),
        file: None,
        offset: 100,
        package,
    }))
    .await
    else {
        panic!()
    };
    assert!(!success, "{notes:?}");
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].severity, "error");
    assert!(notes[0].message.starts_with("error: Ambiguous predicate"), "Coalton's words, not the compiler's: {}", notes[0].message);
    assert_eq!(notes[0].location.as_ref().and_then(|l| l.offset), Some(100 + form.find("(bad").unwrap() as i64));
    let text = format!("(in-package :cl-user)\n\n{form}\n");
    let Reply::Compiled { notes, .. } = run(cl(|package| Op::CheckText { text: text.clone(), package, file: None })).await else { panic!() };
    let offsets: Vec<_> = notes.iter().filter(|n| n.severity == "error").map(|n| n.location.as_ref().and_then(|l| l.offset)).collect();
    assert_eq!(offsets, [Some(text.find("(bad").unwrap() as i64)], "{notes:?}");
    let source = "/projects/typed/src/main.lisp";
    let Reply::Compiled { notes, .. } = run(cl(|package| Op::CheckText { text: text.clone(), package, file: Some(source.into()) })).await else { panic!() };
    let error = notes.iter().find(|n| n.severity == "error").expect("an error note");
    assert!(error.message.contains(source) && !error.message.contains("zparen-check"), "the message names the file being checked: {}", error.message);

    let Reply::Text { text } = run(cl(|package| Op::Describe { symbol: "add2".into(), package })).await else { panic!() };
    assert!(text.contains("Coalton type: (INTEGER → INTEGER)") && !text.contains("Not documented"), "{text}");
    let Reply::Text { text } = run(cl(|package| Op::Describe { symbol: "car".into(), package })).await else { panic!() };
    assert!(!text.contains("Coalton type"), "{text}");

    // Coalton's help notes become edits the editor can make, at the text they rewrite.
    let form = "(coalton:coalton-toplevel\n  (coalton:define v (unused y)))";
    let Reply::Compiled { notes, .. } = run(cl(|package| Op::CompileForm {
        form: form.into(),
        buffer: "scratch".into(),
        file: None,
        offset: 100,
        package,
    }))
    .await
    else {
        panic!()
    };
    let fixes: Vec<_> = notes.iter().flat_map(|n| n.fixes.clone()).collect();
    assert_eq!(
        fixes,
        [zparen_core::ops::Fix {
            label: "prefix the variable with '_' to declare it unused".into(),
            offset: 100 + form.find("y)").unwrap() as i64,
            old: "y".into(),
            text: "_y".into(),
        }],
        "{notes:?}"
    );

    // Hover and K describe a Coalton type or class: its kind or superclasses, docstring, and constructors or methods.
    let Reply::Text { text } = run(cl(|package| Op::Describe { symbol: "box".into(), package })).await else { panic!() };
    assert!(
        text.contains("Coalton type BOX :: * → *\n\nA box holding one value.\n\nConstructors:\n  BOX-OF :: ∀ :A. :A → BOX :A") && !text.contains("Not documented"),
        "{text}"
    );
    let Reply::Text { text } = run(cl(|package| Op::Describe { symbol: "coalton:shape".into(), package })).await else { panic!() };
    assert!(text.contains("Coalton class SHAPE :A\n\nThings with an area.\n\nMethods:\n  AREA :: ∀ :A. SHAPE :A ⇒ :A → DOUBLE-FLOAT"), "{text}");

    // The symbol search lists Coalton classes and types, which have no meaning in Lisp.
    let Reply::Symbols { items } = run(Op::Apropos { query: "shape".into(), package: None }).await else { panic!() };
    let shape = items.iter().find(|i| i.name == "COALTON:SHAPE").unwrap_or_else(|| panic!("{items:?}"));
    assert_eq!((shape.kinds.as_slice(), shape.doc.as_deref()), (["coalton-class".to_string()].as_slice(), Some("Things with an area.")));

    // Coalton's manual has a page for each operator and an entry for each type, class and function of its library,
    // which is in its package's part of the reference.
    for (name, parts) in [
        ("coalton:define", &["(\"https://coalton-lang.github.io/manual/operators/define/\")"][..]),
        (
            "coalton:shape",
            &[
                "(\"https://coalton-lang.github.io/reference/#coalton-shape-class\"",
                "\"coalton\"",
                "\"https://coalton-lang.github.io/reference/#coalton-package\")",
            ][..],
        ),
        ("add2", &["NIL"][..]),
    ] {
        let value = eval(&format!("(zparen::coalton-manual-page-named {name:?})")).await;
        assert!(parts.iter().all(|p| value.contains(p)), "{name}: {value}");
    }

    // (help NAME) in the REPL prints the same, or what Lisp knows of NAME; (help) says how to use it.
    let repl_output = |input: &'static str| {
        let conn = c.clone();
        async move {
            let mut events = conn.subscribe();
            let repl = conn.clone();
            let pending = tokio::spawn(async move { cl(|package| Op::ReplEval { input: input.into(), package }).run(&repl).await });
            let mut output = String::new();
            while let Ok(Ok(e)) = tokio::time::timeout(Duration::from_millis(500), events.recv()).await {
                match e {
                    Event::Output { text, .. } => output.push_str(&text),
                    Event::Debug(d) => panic!("the debugger opened: {d:?}"),
                    _ => {}
                }
            }
            pending.await.unwrap().unwrap();
            output
        }
    };
    let output = repl_output("(help box)").await;
    assert!(output.starts_with("; Coalton type BOX :: * → *\n; \n; A box holding one value."), "{output:?}");
    let output = repl_output("(help 'add2)").await;
    assert!(output.starts_with("; ADD2 :: (INTEGER → INTEGER)"), "{output:?}");
    let output = repl_output("(help car)").await;
    assert!(output.contains("; COMMON-LISP:CAR\n;   [symbol]"), "{output:?}");
    let output = repl_output("(help)").await;
    assert!(output.starts_with("; (help NAME) shows what NAME is"), "{output:?}");
    // A HELP function of the user's own still runs.
    eval("(defun cl-user::help (x) (list :mine x))").await;
    let output = repl_output("(help 1)").await;
    assert!(output.contains("(:MINE 1)"), "{output:?}");
    eval("(fmakunbound 'cl-user::help)").await;
    s.stop().await;
}
