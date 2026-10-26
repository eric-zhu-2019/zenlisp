use std::path::PathBuf;
use zenlisp_core::session::{Session, SessionConfig};
use zenlisp_core::sexp::Sexp;
use zenlisp_core::swank::{Event, Thread};

pub fn resources() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources")
}

#[tokio::test]
async fn evaluates_in_a_real_sbcl() {
    let s = Session::start(&SessionConfig::new(resources())).await.expect("sbcl starts");
    let v = s.conn.rex(Sexp::parse("(zenlisp:ping)").unwrap(), "CL-USER", Thread::T).await.unwrap();
    assert_eq!(v.plist_get("lisp"), Some(&Sexp::str("SBCL")));

    let v = s
        .conn
        .rex(Sexp::parse(r#"(swank:eval-and-grab-output "(progn (princ :hi) (+ 1 2))")"#).unwrap(), "CL-USER", Thread::T)
        .await
        .unwrap();
    assert_eq!(v, Sexp::list([Sexp::str("HI"), Sexp::str("3")]));
    s.stop().await;
}

#[tokio::test]
async fn errors_enter_the_debugger_and_abort_returns() {
    let s = Session::start(&SessionConfig::new(resources())).await.unwrap();
    let mut events = s.conn.subscribe();
    let conn = s.conn.clone();
    let pending = tokio::spawn(async move {
        conn.rex(Sexp::parse(r#"(swank:eval-and-grab-output "(error \"boom ~a\" 42)")"#).unwrap(), "CL-USER", Thread::T)
            .await
    });
    let dbg = loop {
        if let Event::Debug(d) = events.recv().await.unwrap() {
            break d;
        }
    };
    assert_eq!(dbg.condition, "boom 42");
    assert!(dbg.restarts.iter().any(|r| r.name.contains("ABORT")));
    assert!(!dbg.frames.is_empty());

    s.conn
        .rex(Sexp::parse("(swank:throw-to-toplevel)").unwrap(), "CL-USER", dbg.thread)
        .await
        .ok();
    assert!(pending.await.unwrap().is_err(), "aborted request returns an error");
    s.stop().await;
}

/// Runs when scripts/bundle-sbcl.sh has made a bundle: a Mac with no SBCL installed starts the bundled one.
#[tokio::test]
async fn the_bundled_sbcl_runs_where_none_is_installed() {
    let bundle = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/sbcl");
    if !bundle.join("bin/sbcl").is_file() {
        eprintln!("no bundle at {}; run scripts/bundle-sbcl.sh", bundle.display());
        return;
    }
    // This Mac has an SBCL installed, which the bundle defers to, so point at the bundle directly.
    let mut cfg = SessionConfig::new(resources());
    cfg.sbcl = bundle.join("bin/sbcl");
    cfg.sbcl_home = Some(bundle.join("lib/sbcl"));
    cfg.cache_dir = std::env::temp_dir().join(format!("zenlisp-bundled-cache-{}", std::process::id()));
    let s = Session::start(&cfg).await.expect("the bundled sbcl starts and builds its core");
    let v = s.conn.rex(Sexp::parse(r#"(sb-ext:posix-getenv "SBCL_HOME")"#).unwrap(), "CL-USER", Thread::T).await.unwrap();
    assert!(v.as_str().unwrap().contains("src-tauri/sbcl/lib/sbcl"), "contribs come from the bundle: {v}");
    s.stop().await;
    let _ = std::fs::remove_dir_all(&cfg.cache_dir);
}
