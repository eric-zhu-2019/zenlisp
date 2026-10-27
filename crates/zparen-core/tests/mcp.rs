use serde_json::{Value, json};
use std::path::PathBuf;
use zparen_core::mcp;
use zparen_core::session::SessionConfig;
use zparen_core::workbench::Workbench;

const TOKEN: &str = "test-token-0123456789abcdef0123456789abcdef";

struct Client {
    http: reqwest::Client,
    url: String,
}

impl Client {
    async fn post(&self, body: Value, headers: &[(&str, &str)]) -> (u16, String) {
        let mut req = self
            .http
            .post(&self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .body(body.to_string());
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = req.send().await.unwrap();
        (res.status().as_u16(), res.text().await.unwrap())
    }

    async fn legacy_rpc(&self, body: Value) -> Value {
        let auth = format!("Bearer {TOKEN}");
        let (status, text) =
            self.post(body, &[("Authorization", &auth), ("MCP-Protocol-Version", "2025-11-25")]).await;
        assert_eq!(status, 200, "{text}");
        let v: Value = serde_json::from_str(&text).unwrap_or_else(|_| panic!("not JSON: {text}"));
        v.get("result").cloned().unwrap_or_else(|| panic!("no result: {v}"))
    }
}

#[tokio::test]
async fn claude_code_flow_over_http() {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let wb = Workbench::new(SessionConfig::new(resources));
    let addr = mcp::serve(wb.clone(), 0, TOKEN.into()).await.unwrap();
    assert!(addr.ip().is_loopback());
    let c = Client { http: reqwest::Client::new(), url: format!("http://{addr}/mcp") };

    let init = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}});
    let (status, _) = c.post(init.clone(), &[]).await;
    assert_eq!(status, 401, "no token");
    let (status, _) = c.post(init.clone(), &[("Authorization", "Bearer wrong")]).await;
    assert_eq!(status, 401, "wrong token");
    let auth = format!("Bearer {TOKEN}");
    let (status, _) = c.post(init.clone(), &[("Authorization", &auth), ("Origin", "http://evil.example")]).await;
    assert_eq!(status, 403, "foreign Origin");

    let (status, _) = c.post(init.clone(), &[("Authorization", &auth), ("Origin", "http://localhost:1420")]).await;
    assert_eq!(status, 200, "localhost Origin");
    let result = c.legacy_rpc(init).await;
    assert_eq!(result["serverInfo"]["name"], "zparen");
    assert_eq!(result["protocolVersion"], "2025-11-25");
    assert!(result["capabilities"]["tools"].is_object());
    let (status, _) = c
        .post(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), &[("Authorization", &auth)])
        .await;
    assert_eq!(status, 202);

    let tools = c.legacy_rpc(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})).await;
    let names: Vec<&str> = tools["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"eval") && names.contains(&"invoke_restart") && names.contains(&"edit_file") && names.len() == 16, "{names:?}");
    let eval = tools["tools"].as_array().unwrap().iter().find(|t| t["name"] == "eval").unwrap();
    assert_eq!(eval["inputSchema"]["required"], json!(["form"]));

    let called = c
        .legacy_rpc(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "eval", "arguments": {"form": "(* 6 7)"}}}))
        .await;
    assert_eq!(called["isError"], false, "{called}");
    assert_eq!(called["content"][0]["text"], "Values:\n42");

    let failed = c
        .legacy_rpc(json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "eval", "arguments": {}}}))
        .await;
    assert_eq!(failed["isError"], true, "{failed}");
    wb.stop().await;
}

/// The 2026-07-28 revision drops `initialize`; each request carries its
/// version in `_meta` and mirrors it in headers.
#[tokio::test]
async fn stateless_2026_request() {
    let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources");
    let wb = Workbench::new(SessionConfig::new(resources));
    let addr = mcp::serve(wb.clone(), 0, TOKEN.into()).await.unwrap();
    let c = Client { http: reqwest::Client::new(), url: format!("http://{addr}/mcp") };
    let auth = format!("Bearer {TOKEN}");
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "eval", "arguments": {"form": "(+ 1 2)"},
        "_meta": {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "1"},
            "io.modelcontextprotocol/clientCapabilities": {}}}});
    let headers = [
        ("Authorization", auth.as_str()),
        ("MCP-Protocol-Version", "2026-07-28"),
        ("Mcp-Method", "tools/call"),
        ("Mcp-Name", "eval"),
    ];
    let (status, text) = c.post(body, &headers).await;
    assert_eq!(status, 200, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["result"]["content"][0]["text"], "Values:\n3", "{v}");
    wb.stop().await;
}

#[test]
fn config_line_is_ready_to_paste() {
    assert_eq!(
        mcp::claude_config_line(7777, "abc"),
        "claude mcp add --transport http zparen http://127.0.0.1:7777/mcp --header \"Authorization: Bearer abc\""
    );
}
