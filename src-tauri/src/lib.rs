use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use zenlisp_core::session::SessionConfig;
use zenlisp_core::workbench::{Request, Response, Workbench};

struct AppState(Arc<Workbench>);

/// An update found by the last check, waiting for the user to install it.
#[derive(Default)]
struct Updates {
    /// False for builds made without an update source.
    enabled: bool,
    pending: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>,
}

/// What a check found, for the UI: "available", "current", "unconfigured" or "error".
#[derive(Clone, serde::Serialize)]
struct UpdateNews {
    kind: &'static str,
    version: String,
    notes: String,
}

/// Looks for a newer release. A check the user asked for always reports back;
/// the check at launch speaks only when there is something to install.
async fn check_for_update(app: tauri::AppHandle, asked: bool) {
    use tauri_plugin_updater::UpdaterExt;
    let updates = app.state::<Updates>();
    let current = app.package_info().version.to_string();
    let news = |kind, version: &str, notes: &str| UpdateNews { kind, version: version.into(), notes: notes.into() };
    if !updates.enabled {
        if asked {
            let _ = app.emit("update", news("unconfigured", &current, ""));
        }
        return;
    }
    let found = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(update)) => {
            eprintln!("zenlisp: update {} available (running {current})", update.version);
            let n = news("available", &update.version, update.body.as_deref().unwrap_or(""));
            *updates.pending.lock().await = Some(update);
            let _ = app.emit("update", n);
        }
        Ok(None) => {
            eprintln!("zenlisp: {current} is the latest release");
            if asked {
                let _ = app.emit("update", news("current", &current, ""));
            }
        }
        Err(e) => {
            eprintln!("zenlisp: update check failed: {e}");
            if asked {
                let _ = app.emit("update", news("error", &current, &e.to_string()));
            }
        }
    }
}

/// Downloads and installs the update the last check found, then restarts into it.
#[tauri::command]
async fn install_update(app: tauri::AppHandle, updates: tauri::State<'_, Updates>) -> Result<(), String> {
    let update = updates.pending.lock().await.take().ok_or("no update is waiting")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let wb = app.state::<AppState>().0.clone();
    wb.stop().await;
    app.restart();
}

/// Quits for real, after the UI has asked about unsaved files.
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
async fn rpc(state: tauri::State<'_, AppState>, req: Request) -> Result<Response, String> {
    state.0.handle(req).await
}

fn resources_dir(app: &tauri::App) -> PathBuf {
    let bundled = app.path().resource_dir().map(|d| d.join("resources"));
    match bundled {
        Ok(d) if d.join("lisp/zenlisp.lisp").is_file() => d,
        _ => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources"),
    }
}

/// The File menu's Open Recent submenu, rebuilt whenever the UI's list of recent projects changes.
struct RecentMenu(Submenu<tauri::Wry>);

/// macOS's standard menus, with project items at the top of File and ZenLisp's
/// own Help items in front of the system's search field.
fn menu(app: &tauri::AppHandle) -> tauri::Result<(Menu<tauri::Wry>, Submenu<tauri::Wry>)> {
    let menu = Menu::default(app)?;
    let recent = Submenu::with_id(app, "open-recent", "Open Recent", true)?;
    let file = match menu.items()?.into_iter().find_map(|i| i.as_submenu().cloned().filter(|s| s.text().is_ok_and(|t| t == "File"))) {
        Some(f) => f,
        None => {
            let f = Submenu::new(app, "File", true)?;
            menu.insert(&f, 1)?;
            f
        }
    };
    let project_items: [&dyn tauri::menu::IsMenuItem<tauri::Wry>; 5] = [
        &MenuItem::with_id(app, "new-project", "New Project…", true, Some("CmdOrCtrl+Shift+N"))?,
        &MenuItem::with_id(app, "open-project", "Open Project…", true, Some("CmdOrCtrl+O"))?,
        &recent,
        &MenuItem::with_id(app, "close-project", "Close Project", true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
    ];
    for (i, item) in project_items.into_iter().enumerate() {
        file.insert(item, i)?;
    }
    // The app menu comes first; Settings goes after About, as in every Mac app.
    if let Some(app_menu) = menu.items()?.into_iter().next().and_then(|i| i.as_submenu().cloned()) {
        let updates = MenuItem::with_id(app, "check-updates", "Check for Updates…", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
        app_menu.insert(&updates, 1)?;
        app_menu.insert(&PredefinedMenuItem::separator(app)?, 2)?;
        app_menu.insert(&settings, 3)?;
    }
    let help_items = [
        MenuItem::with_id(app, "help-shortcuts", "Keyboard Shortcuts", true, Some("CmdOrCtrl+Shift+/"))?,
        MenuItem::with_id(app, "help-docs", "Lisp Documentation", true, None::<&str>)?,
        MenuItem::with_id(app, "help-tour", "Getting Started", true, None::<&str>)?,
    ];
    let report = MenuItem::with_id(app, "help-report", "Copy Diagnostics for a Report", true, None::<&str>)?;
    let help = match menu.items()?.into_iter().find_map(|i| i.as_submenu().cloned().filter(|s| s.text().is_ok_and(|t| t == "Help"))) {
        Some(h) => h,
        None => {
            let h = Submenu::new(app, "Help", true)?;
            menu.append(&h)?;
            h
        }
    };
    for item in &help_items {
        help.append(item)?;
    }
    help.append(&PredefinedMenuItem::separator(app)?)?;
    help.append(&report)?;
    Ok((menu, recent))
}

/// Fills Open Recent with the UI's recent projects, newest first.
#[tauri::command]
fn set_recent_projects(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    let state = app.state::<RecentMenu>();
    let recent = &state.0;
    let fill = || -> tauri::Result<()> {
        for item in recent.items()? {
            recent.remove(&item)?;
        }
        if paths.is_empty() {
            recent.append(&MenuItem::new(&app, "No Recent Projects", false, None::<&str>)?)?;
            return Ok(());
        }
        let home = std::env::var("HOME").unwrap_or_default();
        for path in &paths {
            let shown = if !home.is_empty() && path.starts_with(&home) { format!("~{}", &path[home.len()..]) } else { path.clone() };
            recent.append(&MenuItem::with_id(&app, format!("recent:{path}"), shown, true, None::<&str>)?)?;
        }
        recent.append(&PredefinedMenuItem::separator(&app)?)?;
        recent.append(&MenuItem::with_id(&app, "recent-clear", "Clear Menu", true, None::<&str>)?)?;
        Ok(())
    };
    fill().map_err(|e| e.to_string())
}

fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // SAFETY: no other thread exists yet. Without it, ocicl, qlot and Homebrew's SBCL are not found.
    unsafe { zenlisp_core::project::use_tool_path() };
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // The HyperSpec's pages, served unmodified from the local copy.
        .register_uri_scheme_protocol("clhs", |_ctx, request| {
            let path = percent_decode(request.uri().path());
            match zenlisp_core::docs::hyperspec().and_then(|hs| hs.read(&path)) {
                Some((bytes, mime)) => tauri::http::Response::builder().header("Content-Type", mime).body(bytes).unwrap(),
                None => tauri::http::Response::builder().status(404).body(Vec::new()).unwrap(),
            }
        })
        .setup(|app| {
            // A Mac without SBCL uses the one the app carries, if it was built with one.
            let bundled = app.path().resource_dir().map(|d| d.join("sbcl")).unwrap_or_default();
            let wb = Workbench::new(SessionConfig::new(resources_dir(app)).with_bundled_sbcl(&bundled));
            let mut events = wb.subscribe();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.recv().await {
                        Ok(e) => {
                            let _ = handle.emit("app-event", e);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });
            let mcp_wb = wb.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = zenlisp_core::mcp::start(mcp_wb).await {
                    eprintln!("ZenLisp MCP server did not start: {e}");
                }
            });
            app.manage(AppState(wb));
            // Release builds name an update source and its key; others have none and skip updates.
            let enabled = app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).is_some_and(|k| !k.is_empty());
            if enabled {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    check_for_update(handle, false).await;
                });
            }
            app.manage(Updates { enabled, ..Default::default() });
            let (bar, recent) = menu(app.handle())?;
            app.set_menu(bar)?;
            app.manage(RecentMenu(recent));
            app.on_menu_event(|app, event| {
                if event.id().0 == "check-updates" {
                    tauri::async_runtime::spawn(check_for_update(app.clone(), true));
                    return;
                }
                let _ = app.emit("menu", event.id().0.as_str());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, quit, install_update, set_recent_projects])
        .build(tauri::generate_context!())
        .expect("error while building ZenLisp")
        .run(|app, event| {
            // ⌘Q asks the UI first; `quit` exits with an explicit code, which passes through.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = &event {
                api.prevent_exit();
                let _ = app.emit("quit-requested", ());
                return;
            }
            if let tauri::RunEvent::Exit = event {
                let wb = app.state::<AppState>().0.clone();
                tauri::async_runtime::block_on(wb.stop());
            }
        });
}
