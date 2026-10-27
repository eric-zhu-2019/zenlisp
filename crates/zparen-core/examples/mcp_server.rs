//! Serves the MCP tools without the app, for trying them from an agent.
//! cargo run -p zparen-core --example mcp_server -- [port] [project-root]
use zparen_core::mcp;
use zparen_core::session::SessionConfig;
use zparen_core::workbench::{Request, Workbench};

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let port = args.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let wb = Workbench::new(SessionConfig::new(resources));
    if let Some(root) = args.next() {
        wb.handle(Request::OpenProject { root }).await.expect("project opens");
    }
    let token = mcp::load_or_create_token(&std::env::temp_dir().join("zparen-mcp-example")).expect("token");
    let addr = mcp::serve(wb, port, token.clone()).await.expect("listens");
    println!("{}", mcp::claude_config_line(addr.port(), &token));
    std::future::pending::<()>().await;
}
