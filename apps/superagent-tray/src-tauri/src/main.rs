// Prevents additional console window on Windows in both release and debug builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![windows_subsystem = "windows"]

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

mod connection_logs;
mod muse_file_transfer;
mod remote_service_detection;
mod runtime_control;
mod runtime_detection;
mod tray_settings;
mod tray_lifecycle;
mod lifecycle_console;

/// Reads the installed binary version from the Tauri package metadata.
#[tauri::command]
fn get_tray_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Native window lifecycle is deliberately exposed through an allowlist,
/// not the broad Tauri window permission surface. Webview can control
/// ONLY its own main window, never Core, tunnels or other processes.
#[tauri::command]
fn tray_window_action(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<serde_json::Value, String> {
    if window.label() != "main" {
        return Err("Window operation is restricted to SuperAgent Tray".into());
    }
    match action.as_str() {
        "minimize" => window
            .minimize()
            .map_err(|_| "Cannot minimize Tray window")?,
        "toggle-maximize" => {
            if window
                .is_maximized()
                .map_err(|_| "Cannot inspect window state")?
            {
                window
                    .unmaximize()
                    .map_err(|_| "Cannot restore Tray window")?;
            } else {
                window
                    .maximize()
                    .map_err(|_| "Cannot maximize Tray window")?;
            }
        }
        "start-drag" => {
            if window
                .is_maximized()
                .map_err(|_| "Cannot inspect window state")?
            {
                // Native drag does not move maximized windows. Double-click
                // restore is an explicit separate operation.
                return Err("Restore the maximized window before dragging".into());
            }
            window
                .start_dragging()
                .map_err(|_| "Cannot drag Tray window")?;
        }
        "close" => window.close().map_err(|_| "Cannot close Tray window")?,
        "state" => {}
        _ => return Err("Unsupported Tray window action".into()),
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    Ok(json!({"maximized":maximized,"minimized":minimized}))
}

#[tauri::command]
fn get_tray_settings() -> Result<tray_settings::TraySettings, String> {
    tray_settings::load(&config_dir()?)
}

#[tauri::command]
fn set_tray_settings(
    settings: tray_settings::TraySettings,
) -> Result<tray_settings::TraySettings, String> {
    tray_settings::save(&config_dir()?, &settings)?;
    Ok(settings)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MuseTelegramSettingsInput {
    bot_token: String,
    group_id: String,
    muse_bot_id: String,
    clear_bot_token: bool,
    workspaces: Vec<String>,
    default_workspace: String,
    ws_port: u16,
    ws_path: String,
    ws_mode: String,
    ws_remote_url: String,
    auto_start_mode: String,
}

impl MuseTelegramSettingsInput {
    fn validate(&self) -> Result<(), String> {
        let numeric = |value: &str, allow_negative: bool| {
            let trimmed=value.trim();
            if trimmed.is_empty() { return true; }
            let digits=if allow_negative { trimmed.strip_prefix('-').unwrap_or(trimmed) } else { trimmed };
            !digits.is_empty() && digits.len()<=20 && digits.bytes().all(|b|b.is_ascii_digit())
        };
        let token=self.bot_token.trim();
        if token.len()>256 || token.chars().any(char::is_whitespace) {
            return Err("Telegram bot token is malformed".into());
        }
        if !numeric(&self.group_id,true) {
            return Err("Telegram Group ID must be numeric".into());
        }
        if !numeric(&self.muse_bot_id,false) {
            return Err("Muse Bot ID must be numeric".into());
        }
        if self.workspaces.is_empty() || self.workspaces.len() > 32 ||
            self.workspaces.iter().any(|p| p.len()>500 || !std::path::Path::new(p).is_absolute()) {
            return Err("Muse watched workspaces must contain 1-32 absolute paths".into());
        }
        if !self.workspaces.iter().any(|p| p == &self.default_workspace) {
            return Err("Default workspace must be one of the watched workspaces".into());
        }
        if self.ws_port < 1024 || [7888,7891,7892,9227].contains(&self.ws_port) {
            return Err("Muse WebSocket port is invalid or reserved".into());
        }
        if self.ws_path.is_empty() || self.ws_path.len()>96 || !self.ws_path.starts_with('/') ||
            self.ws_path.contains("//") || self.ws_path.chars().any(|c| !(c.is_ascii_alphanumeric() || "/_-".contains(c))) {
            return Err("Muse WebSocket path is invalid".into());
        }
        if !["server","client"].contains(&self.ws_mode.as_str()) {
            return Err("Muse WebSocket mode is invalid".into());
        }
        if self.ws_mode=="client" &&
            !(self.ws_remote_url.starts_with("ws://") || self.ws_remote_url.starts_with("wss://")) {
            return Err("Muse WebSocket client mode requires ws:// or wss:// remote URL".into());
        }
        if !["off","telegram","websocket"].contains(&self.auto_start_mode.as_str()) {
            return Err("Muse auto-start mode is invalid".into());
        }
        Ok(())
    }
}

#[tauri::command]
async fn get_muse_telegram_settings() -> Result<Value, String> {
    core_request(Method::GET, "/api/desktop/muse-telegram-settings", None).await
}

#[tauri::command]
async fn set_muse_telegram_settings(settings: MuseTelegramSettingsInput) -> Result<Value, String> {
    settings.validate()?;
    core_request(Method::POST, "/api/desktop/muse-telegram-settings", Some(json!({
        "action":"save",
        "settings":{
            "botToken":settings.bot_token.trim(),
            "groupId":settings.group_id.trim(),
            "museBotId":settings.muse_bot_id.trim(),
            "clearBotToken":settings.clear_bot_token,
            "workspaces":settings.workspaces,
            "defaultWorkspace":settings.default_workspace,
            "wsPort":settings.ws_port,
            "wsPath":settings.ws_path,
            "wsMode":settings.ws_mode,
            "wsRemoteUrl":settings.ws_remote_url,
            "autoStartMode":settings.auto_start_mode,
        }
    }))).await
}

#[tauri::command]
async fn test_muse_telegram_settings() -> Result<Value, String> {
    core_request(Method::POST, "/api/desktop/muse-telegram-settings",
        Some(json!({"action":"test"}))).await
}

#[tauri::command]
async fn regenerate_muse_ws_token() -> Result<Value, String> {
    core_request(Method::POST, "/api/desktop/muse-telegram-settings",
        Some(json!({"action":"regenerate-ws-token"}))).await
}

#[tauri::command]
async fn apply_muse_settings() -> Result<Value, String> {
    let registered = server_info()?;
    let pid = registered.pid.ok_or("Selected Core PID is unavailable")?;
    core_request(Method::POST, "/api/desktop/muse-lifecycle",
        Some(json!({"action":"apply-restart","pid":pid}))).await
}

#[tauri::command]
async fn lifecycle_console_request(request: Value) -> Result<Value, String> {
    // Validate once in native code before any Core HTTP request. Core
    // validates independently, authenticates the exact selected owner, and
    // rejects remote ingress. No generic URL or PID controls are exposed.
    let body=lifecycle_console::validate(request)?;
    core_request(Method::POST, "/api/desktop/lifecycle", Some(body))
        .await
        .and_then(|response| response.get("data").cloned()
            .ok_or("Core did not return a lifecycle result".into()))
}

#[tauri::command]
async fn service_action(
    kind: String,
    action: String,
    port: u16,
    pid: u32,
) -> Result<Value, String> {
    // Only native, verified service owners may be controlled. No arbitrary
    // command, PID termination, URL, endpoint or bearer token from the UI.
    if kind == "muse-core" {
        if !["stop", "restart", "apply-restart", "start-telegram", "start-websocket", "start-tunnel"]
            .contains(&action.as_str()) {
            return Err("Invalid Muse lifecycle action".into());
        }
        let registered = server_info()?;
        if registered.port != port || registered.pid != Some(pid) {
            return Err("Choose the registered Core first; Muse lifecycle target mismatch".into());
        }
        let body = match action.as_str() {
            "start-telegram" => json!({"action":"start","mode":"telegram","port":9225,"pid":pid}),
            "start-websocket" => json!({"action":"start","mode":"websocket","port":9225,"pid":pid}),
            "start-tunnel" => json!({"action":"start","mode":"tunnel","port":9225,"pid":pid}),
            _ => json!({ "action": action, "pid": pid }),
        };
        return core_request(
            Method::POST,
            "/api/desktop/muse-lifecycle",
            Some(body),
        )
        .await;
    }
    runtime_control::control(&config_dir()?, &kind, &action, port, pid).await
}

/// Fixed-token scope: never expose Core auth, OpenAI tunnel IDs,
/// Cloudflare credentials or arbitrary access/refresh tokens.
#[tauri::command]
async fn regenerate_token(kind: String, port: u16, pid: u32) -> Result<Value, String> {
    if port < 1024 || pid == 0 {
        return Err("Invalid token rotation target".into());
    }
    match kind.as_str() {
        "mcp" => {
            if !runtime_control::can_regenerate_token(&config_dir()?, "mcp", port, pid).await {
                return Err("MCP owner is not a verified, reloadable OAuth owner; bootstrap regeneration disabled".into());
            }
            core_request(
                Method::POST,
                "/api/desktop/regenerate-token",
                Some(json!({"kind":"mcp","port":port,"pid":pid})),
            )
            .await
        }
        "muse-watch" => runtime_control::regenerate_muse_token(&config_dir()?, port, pid).await,
        "muse-core" => {
            let core = server_info()?;
            if core.port != port || core.pid != Some(pid) {
                return Err("Selected Core Muse owner does not match the requested target".into());
            }
            core_request(
                Method::POST,
                "/api/desktop/regenerate-token",
                Some(json!({"kind":"muse-core","port":port,"pid":pid})),
            )
            .await
        }
        _ => Err("No supported token-rotation contract for this service".into()),
    }
}

fn connection_body(input: Value, core_port: u16) -> Result<Value, String> {
    let object = input
        .as_object()
        .ok_or("Connection payload must be an object")?;
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or("");
    let keys: &[&str] = match kind {
        "mcp-client" => &["kind", "name", "url", "oauth"],
        "mcp-tunnel" => &["kind", "port", "provider", "tunnelId"],
        "core-tunnel" | "muse-tunnel" => &["kind", "port"],
        _ => return Err("Unsupported connection type".into()),
    };
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err("Unexpected connection field; generic commands are forbidden".into());
    }
    if kind == "mcp-client" {
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or("MCP name is required")?;
        if name.is_empty()
            || name.len() > 48
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || !name.as_bytes()[0].is_ascii_alphanumeric()
        {
            return Err("Invalid MCP connection name".into());
        }
        let raw = object
            .get("url")
            .and_then(Value::as_str)
            .ok_or("MCP URL is required")?;
        if raw.len() > 2048 {
            return Err("MCP URL too long".into());
        }
        let url = reqwest::Url::parse(raw).map_err(|_| "Invalid MCP URL")?;
        let localhost = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
        if !((url.scheme() == "https") || (url.scheme() == "http" && localhost))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("MCP URL must be credential-free HTTPS or loopback HTTP".into());
        }
        if !object.get("oauth").is_some_and(Value::is_boolean) {
            return Err("MCP OAuth choice required".into());
        }
    } else {
        let port = object
            .get("port")
            .and_then(Value::as_u64)
            .filter(|n| *n >= 1024 && *n <= 65535)
            .ok_or("Invalid port")? as u16;
        if kind == "core-tunnel" && port != core_port {
            return Err("Only this selected authenticated Core can be exposed".into());
        }
        if kind == "muse-tunnel" && ([7888, 7891, 7892, 9227].contains(&port) || port == core_port)
        {
            return Err("Muse tunnel port is reserved".into());
        }
        if kind == "mcp-tunnel" {
            if [7888, 7891, 7892, core_port].contains(&port) {
                return Err("MCP tunnel port is reserved".into());
            }
            let provider = object.get("provider").and_then(Value::as_str);
            if !matches!(provider, Some("cloudflare" | "openai")) {
                return Err("Unsupported MCP tunnel provider".into());
            }
            let id = object.get("tunnelId").and_then(Value::as_str).unwrap_or("");
            if provider == Some("openai") {
                if !id.starts_with("tunnel_")
                    || id.len() < 15
                    || id.len() > 107
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err("Invalid OpenAI Secure MCP Tunnel ID".into());
                }
            } else if !id.is_empty() {
                return Err("Cloudflare tunnel must not include an OpenAI tunnel ID".into());
            }
        }
    }
    Ok(input)
}

#[tauri::command]
async fn create_connection(payload: Value) -> Result<Value, String> {
    let target = server_info()?;
    let body = connection_body(payload, target.port)?;
    core_request(Method::POST, "/api/desktop/create-connection", Some(body)).await
}

#[tauri::command]
async fn get_delegate_status() -> Result<Value, String> {
    core_request(Method::GET, "/api/desktop/delegate/status", None).await
}

#[tauri::command]
async fn delegate_action(action: String, payload: Option<Value>) -> Result<Value, String> {
    match action.as_str() {
        "renew-code" => {
            core_request(Method::POST, "/api/desktop/delegate/renew-pair-code", None).await
        }
        "disconnect" => {
            let body = payload.ok_or_else(|| "Missing payload for disconnect action".to_string())?;
            core_request(Method::POST, "/api/desktop/delegate/disconnect", Some(body)).await
        }
        "start" => {
            core_request(
                Method::POST,
                "/api/desktop/delegate/lifecycle",
                Some(json!({"action": "start"})),
            )
            .await
        }
        "stop" => {
            core_request(
                Method::POST,
                "/api/desktop/delegate/lifecycle",
                Some(json!({"action": "stop"})),
            )
            .await
        }
        _ => Err("Unsupported delegate action".into()),
    }
}

#[tauri::command]
async fn get_terminal_tasks(
    running_only: Option<bool>,
    search: Option<String>,
) -> Result<Value, String> {
    let mut path = "/api/desktop/terminal/tasks?".to_string();
    if let Some(ro) = running_only {
        path.push_str(&format!("runningOnly={}&", ro));
    }
    if let Some(s) = search {
        if !s.is_empty() {
            let clean: String = s
                .chars()
                .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
                .collect();
            path.push_str(&format!("search={}&", clean));
        }
    }
    core_request(
        Method::GET,
        path.trim_end_matches('&').trim_end_matches('?'),
        None,
    )
    .await
}

#[tauri::command]
async fn kill_terminal_task(task_id: String) -> Result<Value, String> {
    core_request(
        Method::POST,
        "/api/desktop/terminal/kill",
        Some(json!({ "taskId": task_id })),
    )
    .await
}

#[tauri::command]
async fn launch_terminal_task(
    command: Option<String>,
    preset_name: Option<String>,
) -> Result<Value, String> {
    core_request(
        Method::POST,
        "/api/desktop/terminal/launch",
        Some(json!({
            "command": command,
            "presetName": preset_name
        })),
    )
    .await
}

#[tauri::command]
async fn get_terminal_logs(task_id: String) -> Result<Value, String> {
    let clean: String = task_id
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let path = format!("/api/desktop/terminal/logs?taskId={}", clean);
    core_request(Method::GET, &path, None).await
}

#[tauri::command]
async fn get_terminal_presets() -> Result<Value, String> {
    core_request(Method::GET, "/api/desktop/terminal/presets", None).await
}

#[tauri::command]
async fn prune_terminal_tasks() -> Result<Value, String> {
    core_request(Method::POST, "/api/desktop/terminal/prune", None).await
}


#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn find_superagent_executable() -> Result<(PathBuf, Vec<String>), String> {
    if let Some(exe) = std::env::var_os("SUPERAGENT_EXECUTABLE") {
        let p = PathBuf::from(exe);
        if p.exists() {
            return Ok((p, vec![]));
        }
    }
    // Check adjacent binary (bundled installer placing superagent alongside superagent-tray)
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let sibling_name = if cfg!(windows) { "superagent.exe" } else { "superagent" };
            let sibling_sa = exe_dir.join(sibling_name);
            if sibling_sa.exists() {
                return Ok((sibling_sa, vec![]));
            }
        }
    }
    if let Some(home) = dirs::home_dir() {
        let bun_sa = home.join(".bun").join("bin").join("superagent.exe");
        if bun_sa.exists() {
            return Ok((bun_sa, vec![]));
        }
        let local_sa = home.join(".superagent-r").join("bin").join("superagent.exe");
        if local_sa.exists() {
            return Ok((local_sa, vec![]));
        }
        let bun_exe = home.join(".bun").join("bin").join("bun.exe");
        if bun_exe.exists() {
            let cwd = std::env::current_dir().unwrap_or_default();
            let dist_cli = cwd.join("dist").join("cli.js");
            if dist_cli.exists() {
                return Ok((bun_exe, vec![dist_cli.to_string_lossy().to_string()]));
            }
        }
    }
    Ok((PathBuf::from("superagent"), vec![]))
}

async fn launch_server_process(port: u16) -> Result<u32, String> {
    let probe_url = format!("http://127.0.0.1:{}/api/status", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;

    if let Ok(resp) = client.get(&probe_url).send().await {
        if resp.status().is_success() {
            return Ok(0);
        }
    }

    let (exe, extra_args) = find_superagent_executable()?;
    let mut cmd = Command::new(&exe);
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.arg("--server")
       .arg(port.to_string())
       .arg("--client-mode")
       .arg("tline")
       .stdin(std::process::Stdio::null())
       .stdout(std::process::Stdio::null())
       .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("Failed to spawn SuperAgent server: {}", e))?;
    let pid = child.id();

    for _ in 0..14 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(resp) = client.get(&probe_url).send().await {
            if resp.status().is_success() {
                return Ok(pid);
            }
        }
    }
    Ok(pid)
}

#[tauri::command]
async fn start_core_server(port: Option<u16>) -> Result<Value, String> {
    let target = port.unwrap_or(7888);
    let pid = launch_server_process(target).await?;
    let already_running = pid == 0;
    Ok(json!({
        "success": true,
        "port": target,
        "pid": pid,
        "alreadyRunning": already_running,
        "message": if already_running {
            "SuperAgent Core server is already running".to_string()
        } else {
            format!("SuperAgent Core server started on port {}", target)
        }
    }))
}

#[tauri::command]
async fn stop_core_server(port: Option<u16>) -> Result<Value, String> {
    let target = port.unwrap_or(7888);
    let dir = config_dir()?;
    let info_path = dir.join("server-info.json");
    if !info_path.exists() {
        return Err("No active server-info.json found to stop".into());
    }
    let content = std::fs::read_to_string(&info_path).map_err(|e| e.to_string())?;
    let val: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let pid = val["pid"].as_u64().ok_or_else(|| "Missing PID in server-info.json".to_string())? as u32;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = Command::new("taskkill")
            .args(&["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Failed to terminate Core process".into());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").arg(pid.to_string()).status();
    }
    Ok(json!({ "success": true, "port": target, "pid": pid, "message": "Core server stopped" }))
}

#[tauri::command]
fn get_connection_logs(
    query: connection_logs::ConnectionLogsQuery,
) -> Result<connection_logs::ConnectionLogsResponse, String> {
    let dir = config_dir()?;
    Ok(connection_logs::query_connection_logs(&dir, query))
}

#[derive(Default, Deserialize, Serialize)]
struct SeenReminders {
    ids: Vec<String>,
}

fn config_dir() -> Result<PathBuf, String> {
    if let Some(override_dir) = std::env::var_os("SUPERAGENT_CONFIG_DIR") {
        let dir = PathBuf::from(override_dir);
        if !dir.is_absolute() {
            return Err("SUPERAGENT_CONFIG_DIR must be an absolute directory".into());
        }
        return Ok(dir);
    }
    dirs::home_dir()
        .map(|home| home.join(".superagent-r"))
        .ok_or_else(|| "Cannot resolve home directory".into())
}

fn server_info() -> Result<runtime_detection::RuntimeCredentials, String> {
    // Supports multiple registered Core servers, selected by the operator,
    // without ever sending credentials to the WebView.
    runtime_detection::server_info(&config_dir()?)
}

#[tauri::command]
async fn detect_runtime() -> Result<runtime_detection::RuntimeSnapshot, String> {
    runtime_detection::detect_runtime(&config_dir()?).await
}

#[tauri::command]
async fn select_runtime_core(port: u16) -> Result<Value, String> {
    runtime_detection::select_core(&config_dir()?, port).await?;
    Ok(json!({ "success": true, "port": port }))
}

async fn core_request(method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    // path comes from the fixed match below, never from the webview.
    let info = server_info()?;
    let url = format!("http://127.0.0.1:{}{}", info.port, path);
    let request_timeout = if path == "/api/desktop/regenerate-token" {
        // Local clipboard helper may require a short PowerShell invocation.
        Duration::from_secs(15)
    } else if path == "/api/desktop/create-connection" {
        // A managed MCP owner may take 60s for tunnel provisioning.
        // Never retry ambiguous create requests on timeout.
        Duration::from_secs(100)
    } else if path == "/api/desktop/lifecycle" {
        // Read-only navigation must not freeze the UI while the selected Core
        // is offline. Mutating commands retain the operation ID after timeout;
        // never automatically replay an ambiguous upgrade or restart.
        match body.as_ref().and_then(|b|b.get("action")).and_then(Value::as_str) {
            Some("dashboard"|"health"|"doctor"|"watchdog") => Duration::from_secs(24),
            Some("profile"|"logs"|"status"|"inventory") => Duration::from_secs(10),
            Some("plan") => Duration::from_secs(18),
            _ => Duration::from_secs(120),
        }
    } else if path == "/api/desktop/muse-lifecycle" {
        // Restart can re-establish the original Telegram/WS transport.
        Duration::from_secs(35)
    } else if path == "/api/desktop/muse-telegram-settings" {
        // Test may need a bounded Telegram Bot API round-trip.
        Duration::from_secs(20)
    } else if path == "/api/daemon/jobs/run" {
        // Manual agent jobs can legitimately run for the Core's 5-minute
        // default limit. Returning a 4s timeout would invite duplicate runs.
        Duration::from_secs(330)
    } else {
        Duration::from_secs(4)
    };
    let client = reqwest::Client::builder()
        .timeout(request_timeout)
        // Never route the local Core bearer credential through system proxies.
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "HTTP client could not initialize".to_string())?;
    let mut request = client.request(method, url).bearer_auth(info.auth_token);
    if let Some(payload) = body {
        request = request.json(&payload);
    }
    let response = request.send().await.map_err(|_| {
        "SuperAgent Core is unreachable at the configured loopback port".to_string()
    })?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "SuperAgent Core returned invalid JSON".to_string())?;
    if !status.is_success() || value.get("success") == Some(&Value::Bool(false)) {
        let msg = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Daemon operation was not applied (the job may be running)");
        return Err(format!(
            "Core HTTP {}: {}",
            status.as_u16(),
            msg.chars().take(320).collect::<String>()
        ));
    }
    Ok(value)
}

fn limited_body(action: &str, payload: Option<Value>) -> Result<Value, String> {
    let source = payload.unwrap_or_else(|| json!({}));
    let object = source.as_object().ok_or("Expected object payload")?;
    let keys: &[&str] = match action {
        "create" => &[
            "name",
            "cronExpression",
            "prompt",
            "kind",
            "workspace",
            "enabled",
            "maxRuns",
            "notifyGateway",
        ],
        "update" => &[
            "id",
            "name",
            "cronExpression",
            "prompt",
            "workspace",
            "enabled",
            "maxRuns",
            "notifyGateway",
        ],
        "delete" | "run" => &["id"],
        _ => &[],
    };
    let mut filtered = Map::new();
    for (k, v) in object {
        if !keys.contains(&k.as_str()) {
            return Err(format!("Unsupported {} field: {}", action, k));
        }
        filtered.insert(k.clone(), v.clone());
    }
    if action == "create" {
        let kind = filtered
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("reminder");
        if kind != "reminder" && kind != "agent" {
            return Err("Only reminder or agent tasks can be created in desktop".into());
        }
        filtered.insert("kind".into(), json!(kind));
        // Desktop never forwards privileged tool grants, YOLO settings, or retries.
    }
    if matches!(action, "update" | "delete" | "run")
        && filtered
            .get("id")
            .and_then(Value::as_str)
            .map_or(true, str::is_empty)
    {
        return Err("Job ID is required".into());
    }
    Ok(Value::Object(filtered))
}

#[tauri::command]
async fn daemon_action(action: String, payload: Option<Value>) -> Result<Value, String> {
    match action.as_str() {
        "status" => core_request(Method::GET, "/api/daemon/status", None).await,
        "list" => core_request(Method::GET, "/api/daemon/jobs", None).await,
        "runs" => core_request(Method::GET, "/api/daemon/runs?limit=100", None).await,
        "start" => core_request(Method::POST, "/api/daemon/start", Some(json!({}))).await,
        "stop" => core_request(Method::POST, "/api/daemon/stop", Some(json!({}))).await,
        "create" => {
            core_request(
                Method::POST,
                "/api/daemon/jobs",
                Some(limited_body("create", payload)?),
            )
            .await
        }
        "update" => {
            core_request(
                Method::PATCH,
                "/api/daemon/jobs",
                Some(limited_body("update", payload)?),
            )
            .await
        }
        "delete" => {
            core_request(
                Method::DELETE,
                "/api/daemon/jobs",
                Some(limited_body("delete", payload)?),
            )
            .await
        }
        "run" => {
            core_request(
                Method::POST,
                "/api/daemon/jobs/run",
                Some(limited_body("run", payload)?),
            )
            .await
        }
        _ => Err("Unknown desktop daemon action".into()),
    }
}

fn seen_file() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("desktop-notified-runs.json"))
}

fn read_seen(file: &PathBuf) -> SeenReminders {
    fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_seen(file: &PathBuf, seen: &SeenReminders) -> Result<(), String> {
    let parent = file.parent().ok_or("Missing reminder state directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = file.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec(seen).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(temp, file).map_err(|e| e.to_string())?;
    Ok(())
}

/// Native polling continues with the window hidden, and dedupes notifications
/// after restart. Core owns the cron schedule and the durable run ledger.
async fn poll_reminders(
    app: &tauri::AppHandle,
    notifications_enabled: bool,
) -> Result<usize, String> {
    let jobs = core_request(Method::GET, "/api/daemon/jobs", None).await?;
    let runs = core_request(Method::GET, "/api/daemon/runs?limit=100", None).await?;
    let reminder_jobs: HashMap<String, (String, String)> = jobs["jobs"]
        .as_array()
        .ok_or("Missing daemon jobs")?
        .iter()
        .filter(|job| job["kind"] == "reminder")
        .filter_map(|job| {
            Some((
                job["id"].as_str()?.to_owned(),
                (
                    job["name"].as_str()?.to_owned(),
                    job["prompt"].as_str()?.to_owned(),
                ),
            ))
        })
        .collect();
    if reminder_jobs.is_empty() {
        return Ok(0);
    }

    let file = seen_file()?;
    let mut state = read_seen(&file);
    let mut known: HashSet<String> = state.ids.iter().cloned().collect();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let mut eligible: Vec<&Value> = runs["runs"]
        .as_array()
        .ok_or("Missing daemon runs")?
        .iter()
        .filter(|run| run["status"] == "success")
        .filter(|run| {
            let completed = run["completedAt"].as_u64().unwrap_or(0);
            completed <= now_ms && now_ms.saturating_sub(completed) <= 2 * 60 * 60 * 1000
        })
        .collect();
    eligible.sort_by_key(|run| run["completedAt"].as_u64().unwrap_or(0));

    let mut delivered = 0;
    for run in eligible {
        let Some(id) = run["runId"].as_str() else {
            continue;
        };
        let Some(job_id) = run["jobId"].as_str() else {
            continue;
        };
        let Some((name, message)) = reminder_jobs.get(job_id) else {
            continue;
        };
        if known.contains(id) {
            continue;
        }
        // Native notification on Windows requires an installed app.
        // Failed deliveries are not marked as seen; a later poll can retry.
        if notifications_enabled {
            app.notification()
                .builder()
                .title(name)
                .body(message)
                .show()
                .map_err(|e| format!("OS notification delivery failed: {}", e))?;
            delivered += 1;
        }
        known.insert(id.to_owned());
        state.ids.push(id.to_owned());
        if state.ids.len() > 500 {
            let keep_from = state.ids.len() - 500;
            state.ids.drain(0..keep_from);
        }
        // Persist immediately so a crash does not generate a notification storm.
        write_seen(&file, &state)?;
    }
    Ok(delivered)
}

fn show_main(app: &tauri::AppHandle, new_reminder: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        if new_reminder {
            let _ = app.emit("desktop-create-reminder", ());
        }
    }
}

fn is_background_launch() -> bool {
    std::env::args_os().any(|arg| arg == "--background")
}

fn main() {
    #[cfg(debug_assertions)]
    if std::env::args_os().any(|arg| arg == "--lifecycle-smoke") {
        tray_lifecycle::run_headless_smoke(&config_dir().expect("Invalid test profile"))
            .expect("Tray lifecycle smoke host refused to start");
        return;
    }

    // Read-only preferences diagnostic. Never starts a GUI or changes Core,
    // other processes, scheduler jobs, or the OS login startup registry.
    if std::env::args_os().any(|arg| arg == "--diagnose-settings") {
        match config_dir().and_then(|dir| tray_settings::load(&dir)) {
            Ok(settings) => println!(
                "{}",
                serde_json::to_string_pretty(&settings).unwrap_or_else(|_| "{}".into())
            ),
            Err(error) => eprintln!("SuperAgent Tray settings invalid: {error}"),
        }
        return;
    }
    // Read-only diagnostic mode: same credential-free registry inventory as
    // the UI, useful when checking a live installation without GUI automation.
    // Never emits bearer values, public tunnel URLs, bot data or task content.
    if std::env::args_os().any(|arg| arg == "--diagnose-services") {
        match config_dir() {
            Ok(dir) => {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("Diagnostic runtime could not initialize");
                let services = runtime.block_on(remote_service_detection::scan(&dir));
                println!(
                    "{}",
                    serde_json::to_string_pretty(&services).unwrap_or_else(|_| "[]".into())
                );
            }
            Err(error) => eprintln!("SuperAgent Tray diagnostics unavailable: {}", error),
        }
        return;
    }
    tauri::Builder::default()
        // The plugin is first: concurrent SuperAgent CLI/API launches must
        // never create multiple tray owners or reminder notification pollers.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A background autostart is a no-op when Tray is already active.
            // A user opening the exe explicitly focuses the existing window.
            if !args.iter().any(|arg| arg == "--background") {
                show_main(app, false);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(muse_file_transfer::MuseFileSelection::default())
        .setup(|app| {
            tray_lifecycle::install(app.handle().clone(), &config_dir()?)?;
            // Windows native chrome must never appear above our custom
            // HTML titlebar, even if the host preserves caption style bits
            // for resize/snap compatibility. Enforce decorations=false
            // at runtime as well as in tauri.conf.json.
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
                window.set_resizable(true)?;
                // Auto-launch runs quietly in the notification area; manual
                // starts still open the main window by default.
                if is_background_launch() {
                    window.hide()?;
                }
            }
            let status_item = MenuItem::with_id(app, "status_info", "⚡ SuperAgent Tray · Active", false, None::<&str>)?;
            let version_item = MenuItem::with_id(
                app, "version_info",
                format!("Version {}", app.package_info().version), false, None::<&str>
            )?;
            let sep0 = PredefinedMenuItem::separator(app)?;
            let open = MenuItem::with_id(app, "open", "📊 Open Dashboard", true, None::<&str>)?;
            let start_server = MenuItem::with_id(app, "start_server", "🟢 Start Core Server (:7888)", true, None::<&str>)?;
            let runtime =
                MenuItem::with_id(app, "runtime", "🔍 Runtime Detection", true, None::<&str>)?;
            let conn_logs =
                MenuItem::with_id(app, "connection_logs", "📜 Connection Logs", true, None::<&str>)?;
            let delegate =
                MenuItem::with_id(app, "delegate", "🌐 Chrome Delegate", true, None::<&str>)?;
            let terminal =
                MenuItem::with_id(app, "terminal", "💻 Terminal Processes", true, None::<&str>)?;
            let muse_files =
                MenuItem::with_id(app, "muse_files", "📁 Muse File Transfer", true, None::<&str>)?;
            let add = MenuItem::with_id(app, "add", "➕ New Reminder", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let settings = MenuItem::with_id(app, "settings", "⚙️ Tray Settings", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit SuperAgent Tray", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &status_item,
                &version_item,
                &sep0,
                &open,
                &start_server,
                &runtime,
                &conn_logs,
                &delegate,
                &terminal,
                &muse_files,
                &add,
                &sep1,
                &settings,
                &sep2,
                &quit,
            ])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .expect("App icon not generated")
                        .clone(),
                )
                .tooltip("SuperAgent Tray · Runtime & Reminders")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app, false),
                    "start_server" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = launch_server_process(7888).await;
                            show_main(&handle, false);
                            let _ = handle.emit("desktop-server-started", 7888);
                        });
                    }
                    "add" => show_main(app, true),
                    "runtime" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-runtime", ());
                    }
                    "connection_logs" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-logs", ());
                    }
                    "delegate" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-delegate", ());
                    }
                    "terminal" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-terminal", ());
                    }
                    "muse_files" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-muse-files", ());
                    }
                    "settings" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle(), false);
                    }
                })
                .build(app)?;

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    // No auto-start: SuperAgent Core and daemon scheduling
                    // remain user-owned. This loop only displays completed runs.
                    let preferences = config_dir()
                        .ok()
                        .map(|dir| tray_settings::load_or_default(&dir))
                        .unwrap_or_default();
                    // When notifications are switched off, acknowledge
                    // completed reminders without emitting toasts so they
                    // cannot flood the user when re-enabled later.
                    let _ = poll_reminders(&handle, preferences.notifications_enabled).await;
                    tokio::time::sleep(Duration::from_secs(preferences.notification_poll_seconds))
                        .await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = config_dir()
                    .ok()
                    .map(|dir| tray_settings::load_or_default(&dir).close_to_tray)
                    .unwrap_or(true);
                api.prevent_close();
                if close_to_tray {
                    let _ = window.hide();
                } else {
                    // Explicit setting: closing window quits this utility.
                    // It never stops Core, tunnels or user agents.
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon_action,
            detect_runtime,
            select_runtime_core,
            service_action,
            lifecycle_console_request,
            create_connection,
            regenerate_token,
            get_tray_settings,
            get_tray_version,
            set_tray_settings,
            get_muse_telegram_settings,
            set_muse_telegram_settings,
            test_muse_telegram_settings,
            regenerate_muse_ws_token,
            apply_muse_settings,
            tray_window_action,
            start_core_server,
            stop_core_server,
            get_connection_logs,
            get_delegate_status,
            delegate_action,
            get_terminal_tasks,
            kill_terminal_task,
            launch_terminal_task,
            get_terminal_logs,
            get_terminal_presets,
            prune_terminal_tasks,
            muse_file_transfer::muse_file_pick,
            muse_file_transfer::muse_file_start,
            muse_file_transfer::muse_file_control
        ])
        .build(tauri::generate_context!())
        .expect("SuperAgent Tray could not build")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                tray_lifecycle::cleanup();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_connection_strictly_limits_fields_provider_and_selected_core() {
        assert!(connection_body(
            json!({
              "kind":"mcp-client","name":"docs","url":"https://example.org/mcp","oauth":true
            }),
            7888
        )
        .is_ok());
        assert!(connection_body(
            json!({
              "kind":"mcp-tunnel","port":9227,"provider":"cloudflare"
            }),
            7888
        )
        .is_ok());
        assert!(connection_body(
            json!({
              "kind":"mcp-tunnel","port":9300,"provider":"openai",
              "tunnelId":"tunnel_0123456789abcdef"
            }),
            7888
        )
        .is_ok());
        assert!(connection_body(
            json!({
              "kind":"core-tunnel","port":7888
            }),
            7888
        )
        .is_ok());
        assert!(connection_body(
            json!({
              "kind":"muse-tunnel","port":9225
            }),
            7888
        )
        .is_ok());
        let unsafe_inputs = [
            json!({"kind":"mcp-client","name":"x","url":"https://usr:secret@example.org/mcp","oauth":true}),
            json!({"kind":"mcp-client","name":"x","url":"http://192.168.1.3:8000/mcp","oauth":true}),
            json!({"kind":"mcp-client","name":"x","url":"https://example.org/?key=secret","oauth":true}),
            json!({"kind":"mcp-client","name":"x","url":"https://example.org/mcp","oauth":true,"command":"cmd.exe"}),
            json!({"kind":"mcp-tunnel","port":9227,"provider":"cloudflare","allowDangerous":true}),
            json!({"kind":"mcp-tunnel","port":9227,"provider":"cloudflare","tunnelId":"tunnel_0123456789abcdef"}),
            json!({"kind":"mcp-tunnel","port":9227,"provider":"openai","tunnelId":"invalid"}),
            json!({"kind":"mcp-tunnel","port":9227,"provider":"unknown"}),
            json!({"kind":"core-tunnel","port":8000}),
            json!({"kind":"muse-tunnel","port":7888}),
            json!({"kind":"muse-tunnel","port":9225,"workspace":"C:\\secrets"}),
            json!({"kind":"muse-tunnel","port":9225,"shell":"powershell"}),
            json!({"kind":"execute","command":"taskkill"}),
        ];
        for payload in unsafe_inputs {
            assert!(connection_body(payload, 7888).is_err());
        }
    }

    #[test]
    fn desktop_commands_only_allow_declared_fields_and_kinds() {
        let created = limited_body(
            "create",
            Some(json!({
                "name": "Water break", "prompt": "Drink water",
                "cronExpression": "0 10 * * *"
            })),
        )
        .unwrap();
        assert_eq!(created["kind"], "reminder");
        assert!(limited_body(
            "create",
            Some(json!({
                "kind": "system-memory-retention-sweep", "name": "Unsafe"
            }))
        )
        .is_err());
        assert!(limited_body(
            "create",
            Some(json!({
                "kind": "agent", "allowedTools": ["run_command"]
            }))
        )
        .is_err());
        assert!(limited_body(
            "update",
            Some(json!({
                "id": "job-1", "kind": "agent"
            }))
        )
        .is_err());
        assert!(limited_body(
            "update",
            Some(json!({
                "id": "job-1", "maxRuns": null, "enabled": false
            }))
        )
        .is_ok());
    }

    #[test]
    fn mutating_actions_require_job_identity() {
        assert!(limited_body("delete", Some(json!({}))).is_err());
        assert!(limited_body("run", Some(json!({"id": ""}))).is_err());
        assert!(limited_body("update", Some(json!({"id": "job-1", "prompt": "New"}))).is_ok());
    }

    #[test]
    fn seen_reminder_state_roundtrips_without_duplicate_ids() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "superagent-tray-test-{}-{}",
            std::process::id(),
            unique
        ));
        let path = dir.join("state.json");
        assert!(read_seen(&path).ids.is_empty());
        let saved = SeenReminders {
            ids: vec!["run-1".into(), "run-2".into()],
        };
        write_seen(&path, &saved).unwrap();
        assert_eq!(read_seen(&path).ids, saved.ids);
        fs::remove_dir_all(&dir).unwrap();
    }
}
