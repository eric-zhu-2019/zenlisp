use axum::Router;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zparen_core::assistant::AssistantEvent;
use zparen_core::session::SessionConfig;
use zparen_core::workbench::{AppEvent, Request, Workbench};

#[derive(Default)]
struct Seen {
    bodies: Vec<Value>,
    headers: Vec<HeaderMap>,
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e)).collect()
}

async fn messages(State(seen): State<Arc<Mutex<Seen>>>, headers: HeaderMap, body: String) -> String {
    let body: Value = serde_json::from_str(&body).unwrap();
    let turn = {
        let mut s = seen.lock().unwrap();
        s.bodies.push(body);
        s.headers.push(headers);
        s.bodies.len()
    };
    let start = json!({"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5"}});
    if turn == 1 {
        sse(&[
            start,
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Evaluate it."}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"eval","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"form\": \"(+ 1"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" 2)\"}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}),
            json!({"type":"message_stop"}),
        ])
    } else {
        sse(&[
            start,
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It is "}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"3."}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}),
            json!({"type":"message_stop"}),
        ])
    }
}

#[tokio::test]
async fn tool_loop_runs_lisp_and_echoes_history() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let app = Router::new().route("/v1/messages", post(messages)).with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // SAFETY: this test binary runs this one test, before any other thread reads the env.
    unsafe {
        std::env::set_var("ANTHROPIC_BASE_URL", format!("http://{addr}"));
        std::env::set_var("ANTHROPIC_API_KEY", "test-key");
    }
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let mut cfg = SessionConfig::new(resources);
    cfg.data_dir = std::env::temp_dir().join(format!("zparen-assistant-{}", std::process::id()));
    let wb = Workbench::new(cfg);
    let mut rx = wb.subscribe();

    wb.handle(Request::AssistantSend { text: "What is (+ 1 2)?".into(), context: None }).await.unwrap();
    let mut text = String::new();
    let mut tool_output = String::new();
    let finished = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let AppEvent::Assistant { event } = rx.recv().await.unwrap() {
                match event {
                    AssistantEvent::Text { text: t } => text.push_str(&t),
                    AssistantEvent::ToolFinished { ok, output, .. } => {
                        assert!(ok, "{output}");
                        tool_output = output;
                    }
                    AssistantEvent::Error { message } => panic!("{message}"),
                    AssistantEvent::TurnFinished { stop_reason } => return stop_reason,
                    _ => {}
                }
            }
        }
    })
    .await
    .expect("turn finishes");
    assert_eq!(finished, "end_turn");
    assert_eq!(text, "It is 3.");
    assert!(tool_output.contains('3'), "{tool_output}");

    let s = seen.lock().unwrap();
    let first = &s.bodies[0];
    assert_eq!(first["model"], "claude-opus-5-5");
    assert_eq!(first["thinking"]["type"], "adaptive");
    assert_eq!(first["fallbacks"], "default");
    assert!(first.get("temperature").is_none());
    assert!(first["tools"].as_array().unwrap().iter().all(|t| t["eager_input_streaming"] == true));
    let h = &s.headers[0];
    assert_eq!(h["anthropic-version"], "2026-10-21");
    assert_eq!(h["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert_eq!(h["x-api-key"], "test-key");

    let second = s.bodies[1]["messages"].as_array().unwrap();
    assert_eq!(second.len(), 3, "user, assistant, tool results");
    assert_eq!(second[1]["content"][0], json!({"type":"thinking","thinking":"Evaluate it.","signature":"sig-1"}));
    assert_eq!(second[1]["content"][1]["input"], json!({"form": "(+ 1 2)"}));
    let result = &second[2]["content"][0];
    assert_eq!(result["tool_use_id"], "toolu_1");
    assert_eq!(result["is_error"], false);
    wb.stop().await;
}
