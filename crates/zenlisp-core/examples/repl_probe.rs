use std::time::Duration;
use zenlisp_core::ops::Op;
use zenlisp_core::session::{Session, SessionConfig};

#[tokio::main]
async fn main() {
    let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let s = tokio::time::timeout(Duration::from_secs(20), Session::start(&SessionConfig::new(resources))).await;
    let s = match s { Ok(Ok(s)) => s, other => { println!("start: {:?}", other.map(|r| r.err())); return } };
    println!("started");
    let mut events = s.conn.subscribe();
    tokio::spawn(async move { while let Ok(e) = events.recv().await { println!("  event {e:?}"); } });
    let pkg = || "COMMON-LISP-USER".to_string();
    let ops = vec![
        Op::Complete { prefix: "mvb".into(), package: pkg() },
        Op::CompileForm { form: "(defun zz (x) (+ x y))".into(), package: pkg(), buffer: "scratch.lisp".into(), file: None, offset: 100 },
        Op::FindDefinitions { name: "zenlisp:ping".into(), package: pkg() },
        Op::Inspect { form: "(list 1 2)".into(), package: pkg() },
        Op::ListPackages,
    ];
    for op in ops {
        let r = tokio::time::timeout(Duration::from_secs(5), op.run(&s.conn)).await;
        println!("{op:?}\n  => {}", format!("{r:?}").chars().take(300).collect::<String>());
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.stop().await;
    std::process::exit(0);
}
