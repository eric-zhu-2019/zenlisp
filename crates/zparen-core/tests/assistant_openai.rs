use axum::Router;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::routing::post;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zparen_core::assistant::{AssistantConfig, AssistantEvent, Provider};
use zparen_core::session::SessionConfig;
use zparen_core::workbench::{AppEvent, Request, Response, Workbench};

#[derive(Default)]
struct Seen {
    openai: Vec<(HeaderMap, Value)>,
    claude: Vec<Value>,
}

fn sse(events: &[Value]) -> String {
    events.iter().map(|e| format!("event: {}\ndata: {}\n\n", e["type"].as_str().unwrap(), e)).collect()
}

async fn responses(State(seen): State<Arc<Mutex<Seen>>>, headers: HeaderMap, body: String) -> String {
    let turn = {
        let mut s = seen.lock().unwrap();
        s.openai.push((headers, serde_json::from_str(&body).unwrap()));
        s.openai.len()
    };
    if turn == 1 {
        let reasoning = json!({"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc-1"});
        let call = json!({"type":"function_call","id":"fc_1","call_id":"call_1","name":"eval","arguments":"{\"form\": \"(+ 1 2)\"}","status":"completed"});
        sse(&[
            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"eval","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\"form\": \"(+ 1 2)\"}"}),
            json!({"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[reasoning, call]}}),
        ])
    } else {
        let message = json!({"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"It is 3.","annotations":[]}]});
        sse(&[
            json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"It is "}),
            json!({"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"3."}),
            json!({"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[message]}}),
        ])
    }
}

async fn messages(State(seen): State<Arc<Mutex<Seen>>>, body: String) -> String {
    seen.lock().unwrap().claude.push(serde_json::from_str(&body).unwrap());
    sse(&[
        json!({"type":"message_start","message":{"id":"msg_c","type":"message","role":"assistant","content":[],"model":"claude-sonnet-5-5"}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Still 3."}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
        json!({"type":"message_stop"}),
    ])
}

async fn turn(wb: &Arc<Workbench>, rx: &mut tokio::sync::broadcast::Receiver<AppEvent>, text: &str) -> String {
    wb.handle(Request::AssistantSend { text: text.into(), context: None }).await.unwrap();
    let mut said = String::new();
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let AppEvent::Assistant { event } = rx.recv().await.unwrap() {
                match event {
                    AssistantEvent::Text { text } => said.push_str(&text),
                    AssistantEvent::ToolFinished { ok, output, .. } => assert!(ok && output.contains('3'), "{output}"),
                    AssistantEvent::Error { message } => panic!("{message}"),
                    AssistantEvent::TurnFinished { stop_reason } => return assert_eq!(stop_reason, "end_turn"),
                    _ => {}
                }
            }
        }
    })
    .await
    .expect("turn finishes");
    said
}

#[tokio::test]
async fn openai_runs_tools_and_claude_continues_the_same_conversation() {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let app = Router::new().route("/v1/responses", post(responses)).route("/v1/messages", post(messages)).with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    // SAFETY: this test binary runs this one test, before any other thread reads the env.
    unsafe {
        std::env::set_var("OPENAI_BASE_URL", format!("http://{addr}/v1"));
        std::env::set_var("OPENAI_API_KEY", "openai-key");
        std::env::set_var("ANTHROPIC_BASE_URL", format!("http://{addr}"));
        std::env::set_var("ANTHROPIC_API_KEY", "claude-key");
    }
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let mut cfg = SessionConfig::new(resources);
    cfg.data_dir = std::env::temp_dir().join(format!("zparen-assistant-openai-{}", std::process::id()));
    let wb = Workbench::new(cfg);
    let mut rx = wb.subscribe();

    let config = AssistantConfig { provider: Provider::OpenAI, claude_model: "claude-sonnet-5-5".into(), openai_model: "gpt-6-luna".into() };
    let Ok(Response::Assistant(status)) = wb.handle(Request::AssistantConfigure { config: config.clone() }).await else { panic!("status") };
    assert_eq!(status.config, config, "the choice is kept");
    assert!(status.openai.configured && status.claude.configured);

    assert_eq!(turn(&wb, &mut rx, "What is (+ 1 2)?").await, "It is 3.");
    {
        let s = seen.lock().unwrap();
        let (headers, first) = &s.openai[0];
        assert_eq!(headers["authorization"], "Bearer openai-key");
        assert_eq!(first["model"], "gpt-6-luna");
        assert_eq!(first["store"], false);
        assert!(first["tools"].as_array().unwrap().iter().any(|t| t["type"] == "function" && t["name"] == "eval"));
        assert_eq!(first["input"], json!([{"role":"user","content":[{"type":"input_text","text":"What is (+ 1 2)?"}]}]));
        let second = s.openai[1].1["input"].as_array().unwrap();
        assert_eq!(second[1]["encrypted_content"], "enc-1", "reasoning goes back as it came");
        assert_eq!(second[2]["call_id"], "call_1");
        assert_eq!(second[3]["type"], "function_call_output");
        assert_eq!(second[3]["call_id"], "call_1");
        assert!(second[3]["output"].as_str().unwrap().contains('3'));
    }

    wb.handle(Request::AssistantConfigure { config: AssistantConfig { provider: Provider::Claude, ..config } }).await.unwrap();
    assert_eq!(turn(&wb, &mut rx, "And now?").await, "Still 3.");
    let s = seen.lock().unwrap();
    let claude = &s.claude[0];
    assert_eq!(claude["model"], "claude-sonnet-5-5");
    let history = claude["messages"].as_array().unwrap();
    assert!(!claude["messages"].to_string().contains("openai_output"), "OpenAI's own items stay out of Claude's request");
    assert_eq!(history[1]["content"], json!([{"type":"tool_use","id":"call_1","name":"eval","input":{"form":"(+ 1 2)"}}]));
    assert_eq!(history[2]["content"][0]["tool_use_id"], "call_1");
    assert_eq!(history[3]["content"], json!([{"type":"text","text":"It is 3."}]));
    assert_eq!(history.len(), 5);
    wb.stop().await;
}
