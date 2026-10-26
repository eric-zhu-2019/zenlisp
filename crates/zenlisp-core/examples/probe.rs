//! Sends each argument as a Swank RPC form and prints the reply.
//! cargo run -p zenlisp-core --example probe -- '(swank:operator-arglist "mapcar" "CL-USER")'
use zenlisp_core::session::{Session, SessionConfig};
use zenlisp_core::sexp::Sexp;
use zenlisp_core::swank::Thread;

#[tokio::main]
async fn main() {
    let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let s = Session::start(&SessionConfig::new(resources)).await.expect("sbcl starts");
    let mut events = s.conn.subscribe();
    tokio::spawn(async move {
        while let Ok(e) = events.recv().await {
            eprintln!("   event: {e:?}");
        }
    });
    for form in std::env::args().skip(1) {
        let r = s.conn.rex(Sexp::parse(&form).expect("form parses"), "CL-USER", Thread::T).await;
        match r {
            Ok(v) => println!("== {form}\n{v}\n"),
            Err(e) => println!("== {form}\nERR {e}\n"),
        }
    }
    s.stop().await;
}
