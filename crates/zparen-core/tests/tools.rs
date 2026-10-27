use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use zparen_core::session::SessionConfig;
use zparen_core::tools;
use zparen_core::workbench::{Request, Response, Workbench};

fn workbench() -> Arc<Workbench> {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    Workbench::new(SessionConfig::new(resources))
}

async fn call(wb: &Arc<Workbench>, name: &str, args: serde_json::Value) -> Result<String, String> {
    let r = tools::call(wb, name, args).await;
    eprintln!("--- {name}\n{}", match &r {
        Ok(t) => format!("ok: {t}"),
        Err(t) => format!("err: {t}"),
    });
    r
}

fn restart_number(text: &str, name: &str) -> i64 {
    text.lines()
        .find_map(|l| {
            let (n, rest) = l.trim().split_once(": [")?;
            rest.starts_with(name).then(|| n.parse().ok()).flatten()
        })
        .unwrap_or_else(|| panic!("no {name} restart in\n{text}"))
}

#[tokio::test]
async fn eval_returns_output_and_values() {
    let wb = workbench();
    let text = call(&wb, "eval", json!({"form": "(progn (princ \"hi\") (values 1 :two))"})).await.unwrap();
    assert_eq!(text, "Output:\nhi\nValues:\n1\n:TWO");
    wb.stop().await;
}

#[tokio::test]
async fn compile_form_reports_notes_with_severity_and_line() {
    let wb = workbench();
    let text = call(&wb, "compile_form", json!({"form": "(defun zz (x)\n  (+ x y))"})).await.unwrap();
    assert!(text.starts_with("Compiled and loaded."), "{text}");
    assert!(text.contains("warning: form line 2: undefined variable: COMMON-LISP-USER::Y"), "{text}");

    let text = call(&wb, "compile_form", json!({"form": "(defun broken (x) (let ((y)) x)"})).await.unwrap_err();
    assert!(text.starts_with("Compilation failed."), "{text}");
    assert!(text.contains("read-error"), "{text}");
    wb.stop().await;
}

#[tokio::test]
async fn errors_open_the_debugger_until_a_restart() {
    let wb = workbench();
    call(&wb, "eval", json!({"form": "(progn (declaim (optimize (debug 3))) (defun half (x) (/ x 0)))"})).await.unwrap();
    assert_eq!(call(&wb, "debugger_state", json!({})).await.unwrap(), "No thread is in the debugger.");

    let err = call(&wb, "eval", json!({"form": "(half 10)"})).await.unwrap_err();
    assert!(err.contains("The image stopped in the debugger."), "{err}");
    assert!(err.contains("DIVISION-BY-ZERO"), "{err}");

    let state = call(&wb, "debugger_state", json!({})).await.unwrap();
    assert!(state.contains("Condition: arithmetic error DIVISION-BY-ZERO"), "{state}");
    assert!(state.contains("(HALF 10)"), "{state}");
    assert!(state.contains("X = 10"), "locals of the HALF frame:\n{state}");

    let abort = restart_number(&state, "*ABORT");
    let done = call(&wb, "invoke_restart", json!({"restart": abort})).await.unwrap();
    assert!(done.contains("The debugger closed."), "{done}");
    assert_eq!(call(&wb, "debugger_state", json!({})).await.unwrap(), "No thread is in the debugger.");
    assert_eq!(call(&wb, "eval", json!({"form": "(+ 1 2)"})).await.unwrap(), "Values:\n3");
    wb.stop().await;
}

#[tokio::test]
async fn failed_lookups_do_not_leave_a_debugger() {
    let wb = workbench();
    let err = call(&wb, "macroexpand", json!({"form": "(no-such-package::m 1)"})).await.unwrap_err();
    assert!(err.contains("NO-SUCH-PACKAGE"), "{err}");
    assert_eq!(call(&wb, "debugger_state", json!({})).await.unwrap(), "No thread is in the debugger.");
    let text = call(&wb, "macroexpand", json!({"form": "(when a b c)"})).await.unwrap();
    assert_eq!(text, "(IF A\n    (PROGN B C))");
    wb.stop().await;
}

#[tokio::test]
async fn project_tools_load_test_and_navigate() {
    let parent = std::env::temp_dir().join(format!("zparen-tools-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&parent);
    std::fs::create_dir_all(&parent).unwrap();
    let wb = workbench();
    let Response::Project { project } = wb
        .handle(Request::NewProject { parent: parent.display().to_string(), name: "hello-zen".into(), deps: Default::default() })
        .await
        .unwrap() else { panic!() };

    let info = call(&wb, "project_info", json!({})).await.unwrap();
    assert!(info.contains("hello-zen/tests"), "{info}");

    let loaded = call(&wb, "load_system", json!({"name": "hello-zen"})).await.unwrap();
    assert!(loaded.starts_with("PASS"), "{loaded}");
    let tested = call(&wb, "run_tests", json!({"name": "hello-zen"})).await.unwrap();
    assert!(tested.starts_with("PASS") && tested.contains("All tests passed."), "{tested}");

    let defs = call(&wb, "find_definitions", json!({"name": "hello-zen:greet"})).await.unwrap();
    assert!(defs.contains(&format!("{}/src/main.lisp:3", project.root)), "{defs}");
    let callers = call(&wb, "who_calls", json!({"name": "hello-zen:greet"})).await.unwrap();
    assert!(callers.contains("MAIN") && callers.contains("src/main.lisp:6"), "{callers}");

    let files = call(&wb, "list_files", json!({})).await.unwrap();
    assert!(files.contains("src/\n") && files.contains("hello-zen.asd\n"), "{files}");
    let src = call(&wb, "read_file", json!({"path": "src/main.lisp", "start_line": 3, "end_line": 4})).await.unwrap();
    assert_eq!(src, "    3  (defun greet (name)\n    4    (format nil \"Hello, ~a!\" name))\n");
    std::fs::write(parent.join("outside.txt"), "secret").unwrap();
    for path in ["../outside.txt", "/etc/hosts"] {
        let outside = call(&wb, "read_file", json!({"path": path})).await.unwrap_err();
        assert!(outside.contains("outside the project root"), "{outside}");
    }

    let tests = PathBuf::from(&project.root).join("tests/main.lisp");
    std::fs::write(
        &tests,
        "(defpackage #:hello-zen/tests (:use #:cl) (:export #:run))\n(in-package #:hello-zen/tests)\n\
         (defun run () (assert (string= (hello-zen:greet \"Lisp\") \"Hi\")))\n",
    )
    .unwrap();
    // ASDF compares whole seconds, and the fasl was written this second.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(2);
    std::fs::File::options().write(true).open(&tests).unwrap().set_modified(later).unwrap();
    let failed = call(&wb, "run_tests", json!({"name": "hello-zen"})).await.unwrap_err();
    assert!(failed.starts_with("FAIL") && failed.contains("The assertion"), "{failed}");
    let abort = restart_number(&failed, "*ABORT");
    call(&wb, "invoke_restart", json!({"restart": abort})).await.unwrap();
    assert_eq!(call(&wb, "debugger_state", json!({})).await.unwrap(), "No thread is in the debugger.");
    wb.stop().await;
}
