use crate::tools;
use crate::workbench::Workbench;
use axum::extract::Request;
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, RoleServer, ServerHandler};
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;

const INSTRUCTIONS: &str = "ZenLisp is a Common Lisp IDE. These tools work in the user's running SBCL image, \
which the user sees and edits at the same time. Start with project_info. Prefer compile_form for definitions and \
eval for experiments. When a tool reports the debugger, inspect it with debugger_state and leave it with invoke_restart.";

#[derive(Clone)]
struct Server {
    wb: Arc<Workbench>,
}

impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("zenlisp", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(tools::specs().into_iter().map(to_tool).collect()))
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        tools::specs().into_iter().find(|s| s.name == name).map(to_tool)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if !tools::specs().iter().any(|s| s.name == request.name) {
            return Err(ErrorData::invalid_params(format!("unknown tool {}", request.name), None));
        }
        let args = request.arguments.map(serde_json::Value::Object).unwrap_or_default();
        let result = match tools::call(&self.wb, &request.name, args).await {
            Ok(text) => CallToolResult::success(vec![ContentBlock::text(text)]),
            Err(text) => CallToolResult::error(vec![ContentBlock::text(text)]),
        };
        Ok(result.into())
    }
}

fn to_tool(spec: tools::ToolSpec) -> Tool {
    let schema = match spec.input_schema {
        serde_json::Value::Object(m) => m,
        _ => Default::default(),
    };
    Tool::new(spec.name, spec.description, Arc::new(schema))
}

/// Serves MCP at `http://127.0.0.1:<port>/mcp` until the process exits.
/// Port 0 picks a free port; the returned address has the real one.
pub async fn serve(wb: Arc<Workbench>, port: u16, token: String) -> io::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await?;
    let addr = listener.local_addr()?;
    let config = StreamableHttpServerConfig::default().with_legacy_session_mode(false).with_json_response(true);
    let service: StreamableHttpService<Server, LocalSessionManager> =
        StreamableHttpService::new(move || Ok(Server { wb: wb.clone() }), Default::default(), config);
    let token: Arc<str> = token.into();
    let app = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn(move |req: Request, next: Next| {
            let token = token.clone();
            async move {
                match reject(req.headers(), &token) {
                    Some(r) => r,
                    None => next.run(req).await,
                }
            }
        }));
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(addr)
}

fn reject(headers: &HeaderMap, token: &str) -> Option<Response> {
    if let Some(origin) = headers.get(header::ORIGIN)
        && !origin.to_str().is_ok_and(is_local_origin)
    {
        return Some((StatusCode::FORBIDDEN, "Forbidden: Origin is not localhost").into_response());
    }
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !constant_time_eq(given.as_bytes(), token.as_bytes()) {
        return Some((StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")], "Unauthorized").into_response());
    }
    None
}

fn is_local_origin(origin: &str) -> bool {
    let Some(rest) = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://")) else {
        return false;
    };
    let host = match rest.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => rest.split(':').next().unwrap_or_default(),
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The token in `dir/mcp-token`, created on first use and readable only by
/// the user. It stays the same across launches so a registered client keeps
/// working.
pub fn load_or_create_token(dir: &Path) -> io::Result<String> {
    let path = dir.join("mcp-token");
    if let Ok(t) = std::fs::read_to_string(&path) {
        let t = t.trim();
        if t.len() >= 32 {
            return Ok(t.to_string());
        }
    }
    let mut bytes = [0u8; 32];
    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, &token)?;
    std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(token)
}

pub fn claude_config_line(port: u16, token: &str) -> String {
    format!("claude mcp add --transport http zenlisp http://127.0.0.1:{port}/mcp --header \"Authorization: Bearer {token}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_origins_pass() {
        for ok in ["http://localhost:1420", "http://127.0.0.1", "https://localhost", "http://[::1]:3000"] {
            assert!(is_local_origin(ok), "{ok}");
        }
        for bad in ["http://evil.com", "http://localhost.evil.com", "null", "file://", "http://127.0.0.1.nip.io"] {
            assert!(!is_local_origin(bad), "{bad}");
        }
    }

    #[test]
    fn token_persists() {
        let dir = std::env::temp_dir().join(format!("zenlisp-token-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = load_or_create_token(&dir).unwrap();
        assert_eq!(a.len(), 64);
        assert_eq!(load_or_create_token(&dir).unwrap(), a);
    }
}

pub const DEFAULT_PORT: u16 = 7337;

/// Starts the MCP server for `wb` and records how to reach it. Falls back to
/// a free port when the default one is taken, such as by a second ZenLisp.
pub async fn start(wb: Arc<Workbench>) -> io::Result<SocketAddr> {
    let token = load_or_create_token(wb.data_dir())?;
    let addr = match serve(wb.clone(), DEFAULT_PORT, token.clone()).await {
        Ok(a) => a,
        Err(_) => serve(wb.clone(), 0, token.clone()).await?,
    };
    wb.set_mcp(crate::workbench::McpInfo {
        url: format!("http://127.0.0.1:{}/mcp", addr.port()),
        claude_command: claude_config_line(addr.port(), &token),
    });
    Ok(addr)
}
