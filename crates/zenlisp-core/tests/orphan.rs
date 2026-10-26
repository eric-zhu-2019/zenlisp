use std::path::PathBuf;
use std::time::Duration;
use zenlisp_core::session::{Session, SessionConfig};

#[tokio::test]
async fn sbcl_exits_when_its_parent_goes_away() {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let s = Session::start(&SessionConfig::new(resources)).await.unwrap();
    let pid = s.pid.unwrap();
    s.close_stdin_for_test();
    for _ in 0..50 {
        if s.exited().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("sbcl {pid} still running 5s after its stdin closed");
}
