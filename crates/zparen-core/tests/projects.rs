use std::path::PathBuf;
use std::time::Duration;
use zparen_core::session::SessionConfig;
use zparen_core::workbench::{AppEvent, Request, Response, Workbench};

fn workbench() -> std::sync::Arc<Workbench> {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    Workbench::new(SessionConfig::new(resources))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("zparen-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn finish(rx: &mut tokio::sync::broadcast::Receiver<AppEvent>, task: &str) -> (bool, String) {
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            match rx.recv().await.unwrap() {
                AppEvent::TaskOutput { task: t, text } if t == task => out.push_str(&text),
                AppEvent::Lisp { event: zparen_core::swank::Event::Output { text, .. } } => out.push_str(&text),
                AppEvent::TaskFinished { task: t, ok, message } if t == task => {
                    out.push_str(&message);
                    return ok;
                }
                _ => {}
            }
        }
    })
    .await
    .map(|ok| (ok, out.clone()))
    .unwrap_or_else(|_| panic!("{task} did not finish. Output so far:\n{out}"))
}

#[tokio::test]
async fn new_project_loads_tests_and_builds() {
    let wb = workbench();
    let mut rx = wb.subscribe();
    let parent = tmp("new");
    let Response::Project { project } = wb
        .handle(Request::NewProject { parent: parent.display().to_string(), name: "hello-zen".into(), deps: Default::default() })
        .await
        .unwrap() else { panic!() };
    assert_eq!(project.name, "hello-zen");

    let Response::Systems { systems } = wb.handle(Request::ProjectSystems).await.unwrap() else { panic!() };
    let names: Vec<_> = systems.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, ["hello-zen", "hello-zen/tests"]);

    wb.handle(Request::LoadSystem { name: "hello-zen".into() }).await.unwrap();
    let (ok, out) = finish(&mut rx, "load hello-zen").await;
    assert!(ok, "{out}");

    wb.handle(Request::TestSystem { name: "hello-zen".into() }).await.unwrap();
    let (ok, out) = finish(&mut rx, "test hello-zen").await;
    assert!(ok && out.contains("All tests passed."), "{out}");

    wb.handle(Request::Build { system: "hello-zen".into() }).await.unwrap();
    let (ok, out) = finish(&mut rx, "build hello-zen").await;
    assert!(ok, "{out}");
    let exe = PathBuf::from(&project.root).join("bin/hello-zen");
    let run = std::process::Command::new(&exe).output().expect("built binary runs");
    assert_eq!(String::from_utf8_lossy(&run.stdout), "Hello, world!\n");
    wb.stop().await;
}

#[tokio::test]
async fn vendored_dependencies_load_without_quicklisp() {
    let root = tmp("vendor");
    std::fs::create_dir_all(root.join("vendor/tiny-dep")).unwrap();
    std::fs::write(root.join("vendor/tiny-dep/tiny-dep.asd"), "(defsystem \"tiny-dep\" :components ((:file \"tiny\")))").unwrap();
    std::fs::write(root.join("vendor/tiny-dep/tiny.lisp"), "(defpackage :tiny (:use :cl) (:export :answer)) (in-package :tiny) (defun answer () 42)").unwrap();
    std::fs::write(root.join("app.asd"), "(defsystem \"app\" :depends-on (\"tiny-dep\") :components ((:file \"app\")))").unwrap();
    std::fs::write(root.join("app.lisp"), "(defpackage :app (:use :cl)) (in-package :app) (defun run () (tiny:answer))").unwrap();

    let wb = workbench();
    let mut rx = wb.subscribe();
    let Response::Project { project } = wb.handle(Request::OpenProject { root: root.display().to_string() }).await.unwrap() else { panic!() };
    assert!(project.managers.iter().any(|m| matches!(m, zparen_core::project::DepManager::Vendor { .. })));
    wb.handle(Request::LoadSystem { name: "app".into() }).await.unwrap();
    let (ok, out) = finish(&mut rx, "load app").await;
    assert!(ok, "{out}");
    let Response::Lisp { reply } = wb
        .handle(Request::Lisp { op: zparen_core::ops::Op::Eval { form: "(app::run)".into(), package: "CL-USER".into() } })
        .await
        .unwrap() else { panic!() };
    assert!(matches!(reply, zparen_core::ops::Reply::Evaluated { ref value, .. } if value == "42"), "{reply:?}");
    wb.stop().await;
}

async fn eval(wb: &std::sync::Arc<Workbench>, form: &str) -> String {
    let Response::Lisp { reply } = wb
        .handle(Request::Lisp { op: zparen_core::ops::Op::Eval { form: form.into(), package: "CL-USER".into() } })
        .await
        .unwrap() else { panic!() };
    match reply {
        zparen_core::ops::Reply::Evaluated { value, .. } => value,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn quicklisp_dependencies_load() {
    let root = tmp("ql");
    std::fs::write(root.join("ql-app.asd"), "(defsystem \"ql-app\" :depends-on (\"alexandria\") :components ((:file \"app\")))").unwrap();
    std::fs::write(root.join("app.lisp"), "(defpackage :ql-app (:use :cl)) (in-package :ql-app) (defun run () (alexandria:flatten '((1) (2 (3)))))").unwrap();
    let wb = workbench();
    let mut rx = wb.subscribe();
    wb.handle(Request::OpenProject { root: root.display().to_string() }).await.unwrap();
    wb.handle(Request::LoadSystem { name: "ql-app".into() }).await.unwrap();
    let (ok, out) = finish(&mut rx, "load ql-app").await;
    assert!(ok, "{out}");
    assert_eq!(eval(&wb, "(ql-app::run)").await, "(1 2 3)");
    wb.stop().await;
}

#[tokio::test]
#[ignore = "downloads from ghcr.io; run with --include-ignored"]
async fn ocicl_installs_and_loads_dependencies() {
    let root = tmp("ocicl");
    std::fs::write(root.join("oc-app.asd"), "(defsystem \"oc-app\" :depends-on (\"cl-ppcre\") :components ((:file \"app\")))").unwrap();
    std::fs::write(root.join("app.lisp"), "(defpackage :oc-app (:use :cl)) (in-package :oc-app) (defun run () (cl-ppcre:regex-replace \"l+\" \"hello\" \"L\"))").unwrap();
    std::fs::write(
        root.join("ocicl.csv"),
        "cl-ppcre, ghcr.io/ocicl/cl-ppcre@sha256:bf073924cf4fd5957a4fd961a95d446ed0e53fa32a5002cbd2d52182874f45e5, cl-ppcre-20250606-a2ea581/cl-ppcre.asd\n",
    )
    .unwrap();
    let wb = workbench();
    let mut rx = wb.subscribe();
    let Response::Project { project } = wb.handle(Request::OpenProject { root: root.display().to_string() }).await.unwrap() else { panic!() };
    assert!(project.managers.iter().any(|m| matches!(m, zparen_core::project::DepManager::Ocicl { .. })));
    wb.handle(Request::InstallDeps).await.unwrap();
    let (ok, out) = finish(&mut rx, "install dependencies").await;
    assert!(ok, "{out}");
    wb.handle(Request::RestartSession).await.unwrap();
    wb.handle(Request::LoadSystem { name: "oc-app".into() }).await.unwrap();
    let (ok, out) = finish(&mut rx, "load oc-app").await;
    assert!(ok, "{out}");
    assert!(eval(&wb, "(oc-app::run)").await.starts_with("\"heLo\""));
    wb.stop().await;
}

async fn status_until(wb: &Workbench, mut done: impl FnMut(&zparen_core::workbench::SessionState) -> bool) -> zparen_core::workbench::SessionState {
    for _ in 0..200 {
        let s = wb.status().await.session;
        if done(&s) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the session never reached the expected state: {:?}", wb.status().await.session)
}

#[tokio::test]
async fn a_dying_lisp_says_why_and_a_saved_image_starts_with_the_project_loaded() {
    use zparen_core::ops::{Op, Reply};
    use zparen_core::workbench::SessionState;
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let mut cfg = SessionConfig::new(resources);
    cfg.data_dir = tmp("image-data");
    let wb = Workbench::new(cfg);
    let mut rx = wb.subscribe();
    let parent = tmp("image");
    wb.handle(Request::NewProject { parent: parent.display().to_string(), name: "imaged-zen".into(), deps: Default::default() }).await.unwrap();
    status_until(&wb, |s| matches!(s, SessionState::Ready { image: false, .. })).await;

    let exit = Op::Eval { form: r#"(progn (format sb-sys:*stderr* "about to go~%") (finish-output sb-sys:*stderr*) (sb-ext:exit :code 3 :abort t))"#.into(), package: "CL-USER".into() };
    let _ = wb.handle(Request::Lisp { op: exit }).await;
    let SessionState::Exited { message } = status_until(&wb, |s| matches!(s, SessionState::Exited { .. })).await else { unreachable!() };
    assert!(message.starts_with("Lisp exited with code 3."), "{message}");
    assert!(message.contains("about to go"), "the report has SBCL's last output: {message}");

    wb.handle(Request::SaveImage { systems: vec!["imaged-zen".into()] }).await.unwrap();
    let (ok, out) = finish(&mut rx, "save startup image").await;
    assert!(ok, "{out}");
    let Response::Image { image: Some(info) } = wb.handle(Request::Image).await.unwrap() else { panic!("no image after saving") };
    assert!(info.megabytes > 10, "{info:?}");

    wb.handle(Request::RestartSession).await.unwrap();
    status_until(&wb, |s| matches!(s, SessionState::Ready { image: true, .. })).await;
    let probe = Op::Eval { form: r#"(and (asdf:component-loaded-p "imaged-zen") (fboundp (find-symbol "GREET" "IMAGED-ZEN")) t)"#.into(), package: "CL-USER".into() };
    let Response::Lisp { reply: Reply::Evaluated { value, .. } } = wb.handle(Request::Lisp { op: probe }).await.unwrap() else { panic!() };
    assert_eq!(value, "T", "the project is loaded before anything is evaluated");

    wb.handle(Request::DeleteImage).await.unwrap();
    wb.handle(Request::RestartSession).await.unwrap();
    status_until(&wb, |s| matches!(s, SessionState::Ready { image: false, .. })).await;
    wb.stop().await;
}
