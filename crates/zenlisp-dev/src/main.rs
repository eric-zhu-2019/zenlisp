//! Serves the Workbench over a WebSocket at ws://127.0.0.1:<port>/ws.
//! Frames in: {"id": n, "req": Request}. Frames out: {"id": n, "ok": Response}
//! or {"id": n, "err": "..."} for replies, {"event": AppEvent} for events.

use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use axum::routing::get;
use serde::Deserialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use zenlisp_core::session::SessionConfig;
use zenlisp_core::workbench::{Request, Workbench};

#[derive(Deserialize)]
struct Call {
    id: u64,
    req: Request,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("ZENLISP_DEV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7878);
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let wb = Workbench::new(SessionConfig::new(resources));
    if std::env::var_os("ZENLISP_DEV_MCP").is_some() {
        let addr = zenlisp_core::mcp::start(wb.clone()).await.expect("start MCP server");
        println!("MCP on http://{addr}/mcp");
    }
    let app = Router::new().route("/ws", get(upgrade)).route("/clhs/{*path}", get(hyperspec_file)).with_state(wb);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind dev port");
    println!("zenlisp-dev listening on ws://127.0.0.1:{port}/ws");
    axum::serve(listener, app).await.unwrap();
}

/// The HyperSpec's pages, as the app's clhs: scheme serves them.
async fn hyperspec_file(axum::extract::Path(path): axum::extract::Path<String>) -> Response {
    use axum::response::IntoResponse;
    match zenlisp_core::docs::hyperspec().and_then(|hs| hs.read(&path)) {
        Some((bytes, mime)) => ([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upgrade(ws: WebSocketUpgrade, State(wb): State<Arc<Workbench>>) -> Response {
    ws.on_upgrade(move |socket| client(socket, wb))
}

async fn client(mut socket: WebSocket, wb: Arc<Workbench>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let mut events = wb.subscribe();
    let etx = tx.clone();
    let pump = tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(e) => {
                    if etx.send(json!({ "event": e }).to_string()).is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
    loop {
        tokio::select! {
            out = rx.recv() => {
                let Some(text) = out else { break };
                if socket.send(Message::Text(text.into())).await.is_err() { break; }
            }
            incoming = socket.recv() => {
                let Some(Ok(Message::Text(text))) = incoming else { break };
                let call: Call = match serde_json::from_str(&text) {
                    Ok(c) => c,
                    Err(e) => { let _ = tx.send(json!({ "id": null, "err": e.to_string() }).to_string()); continue; }
                };
                let wb = wb.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let reply = match wb.handle(call.req).await {
                        Ok(r) => json!({ "id": call.id, "ok": r }),
                        Err(e) => json!({ "id": call.id, "err": e }),
                    };
                    let _ = tx.send(reply.to_string());
                });
            }
        }
    }
    pump.abort();
}
