// Prevents additional console window on Windows in both release and debug builds.
#![windows_subsystem = "windows"]

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

mod connection_logs;
mod muse_file_transfer;
mod lan_file_save;
mod lan_folder_save;
mod remote_service_detection;
mod runtime_control;
mod runtime_detection;
mod core_startup;
mod tray_settings;
mod desktop_input_trust;
mod desktop_live_android_control;
mod desktop_access_registry;
mod named_tunnel_settings;
mod named_tunnel_connector;
mod named_tunnel_clipboard;
mod named_tunnel_health;
mod named_tunnel_orchestrator;
mod tray_lifecycle;
mod shutdown_manager;
mod lifecycle_console;
mod release_updates;
mod tray_notification_center;
mod tray_navigation_receipt;
mod tray_os_action;

#[cfg(test)]
#[path = "../../../../tests/tray_core_startup.rs"]
mod core_startup_tests;

/// Samples only independently verified local process owners reported by Core.
#[tauri::command]
async fn get_overview_owner_metrics() -> Result<Value, String> {
    use sysinfo::{Pid, System};
    // Inventory is deliberately cheaper than dashboard: resource sampling
    // must not invoke the safe-lifecycle supervisor for every refresh.
    let initial = lifecycle_console_request(json!({"action":"inventory"})).await?;
    let services = initial.get("services").and_then(Value::as_array)
        .ok_or("OVERVIEW_OWNER_INVENTORY_UNAVAILABLE")?;
    let owners: Vec<(String, u32)> = services.iter().filter_map(|item| {
        if item.get("ownershipVerified") != Some(&Value::Bool(true)) ||
            !matches!(item.get("state").and_then(Value::as_str), Some("active" | "embedded")) {
            return None;
        }
        let pid = item.get("ownerPid")?.as_u64()?;
        if !(1..=u32::MAX as u64).contains(&pid) { return None; }
        Some((item.get("service")?.as_str()?.to_string(), pid as u32))
    }).take(16).collect();

    let mut system = System::new();
    system.refresh_processes();
    let started: HashMap<u32, u64> = owners.iter().filter_map(|(_, pid)| {
        system.process(Pid::from_u32(*pid))
            .map(|process| (*pid, process.start_time()))
    }).collect();
    tokio::time::sleep(Duration::from_millis(300)).await;
    system.refresh_processes();

    // No cached/previous owner evidence can authorize displaying OS metrics.
    let confirmed = lifecycle_console_request(json!({"action":"inventory"})).await?;
    let current = confirmed.get("services").and_then(Value::as_array)
        .ok_or("OVERVIEW_OWNER_RECHECK_UNAVAILABLE")?;
    let still_owned = |service: &str, pid: u32| current.iter().any(|item|
        item.get("service").and_then(Value::as_str) == Some(service) &&
        item.get("ownerPid").and_then(Value::as_u64) == Some(pid as u64) &&
        item.get("ownershipVerified") == Some(&Value::Bool(true)) &&
        matches!(item.get("state").and_then(Value::as_str), Some("active" | "embedded"))
    );
    let mcp_telemetry = owners.iter().find(|(service, pid)|
        service == "mcp" && still_owned(service, *pid))
        .and_then(|(_, pid)| current.iter().find(|item|
            item.get("service").and_then(Value::as_str) == Some("mcp") &&
            item.get("ownerPid").and_then(Value::as_u64) == Some(*pid as u64)))
        .and_then(|item| item.get("details")?.get("memoryTelemetry"))
        .map(|memory| json!({
            "rssBytes": memory.get("rssBytes").and_then(Value::as_u64),
            "heapUsedBytes": memory.get("heapUsedBytes").and_then(Value::as_u64),
            "trend": {"suspicious": memory.get("trend").and_then(|t| t.get("suspicious"))
                .and_then(Value::as_bool)}
        }));

    let mut seen_pids = HashSet::new();
    let processes: Vec<Value> = owners.into_iter().filter_map(|(service, pid)| {
        if !still_owned(&service, pid) { return None; }
        let process = system.process(Pid::from_u32(pid))?;
        if started.get(&pid).copied() != Some(process.start_time()) ||
            !seen_pids.insert(pid) {
            return None;
        }
        Some(json!({"service": service, "cpuPct": process.cpu_usage(),
            "rssBytes": process.memory()}))
    }).collect();

    Ok(json!({"observedAt": SystemTime::now()
        .duration_since(UNIX_EPOCH).map_or(0, |x| x.as_millis() as u64),
        "processes": processes, "mcpTelemetry": mcp_telemetry}))
}

#[tauri::command]
fn get_tray_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Build number is stamped at compile time, not guessed from the running Core.
#[tauri::command]
fn get_tray_build_number() -> &'static str {
    env!("SUPERAGENT_TRAY_BUILD_NUMBER")
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
        "reload" => {
            let _ = window.eval("window.location.reload()");
        }
        "state" => {}
        _ => return Err("Unsupported Tray window action".into()),
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    Ok(json!({"maximized":maximized,"minimized":minimized}))
}

/// Allowlisted external URL launcher for community support and release verification.
/// Never permits arbitrary schemas, loopback navigation, or unapproved domains.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    const ALLOWED_PREFIXES: &[&str] = &[
        "https://ko-fi.com/rudycity",
        "https://github.com/RudyCity/superagent",
    ];
    if !ALLOWED_PREFIXES.iter().any(|prefix| url.starts_with(prefix)) {
        return Err("URL not allowlisted".into());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("Failed to launch browser: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to launch browser: {e}"))?;
    }
    Ok(())
}

// A system with many pending approvals must not emit an OS toast storm.
// The inbox remains complete; only pop-up delivery is rate-limited.
static OS_ALERT_BUDGET: std::sync::Mutex<(u64, u8)> = std::sync::Mutex::new((0, 0));
fn os_alert_budget_available() -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_secs());
    let Ok(mut budget) = OS_ALERT_BUDGET.lock() else { return false; };
    if now.saturating_sub(budget.0) >= 60 {
        *budget = (now, 0);
    }
    if budget.1 >= 3 { return false; }
    budget.1 += 1;
    true
}

/// All native producers use one redacted, durable event path. Never use
/// untrusted Core strings as OS notification titles or bodies.
fn record_operational_incident(
    app: &tauri::AppHandle, source: &str, severity: &str,
    id: &str, title: &str, body: &str,
) -> Result<bool, String> {
    let dir = config_dir()?;
    let created = tray_notification_center::publish(&dir, source, severity, id, title, body)?;
    if created {
        let _ = app.emit("tray-notifications-changed", ());
        if tray_notification_center::should_notify_os(&dir, source, severity)? &&
            os_alert_budget_available() {
            // The OS surface is intentionally generic; detailed text stays in
            // the private, authenticated native Tray inbox.
            let ticket=tray_os_action::issue(&dir,id).ok();
            let mut builder=app.notification().builder()
                .title("SuperAgent needs attention")
                .body("A system event requires review. Open the Tray Notification Center.");
            if let Some(id)=ticket {builder=builder.id(id);}
            if let Err(error)=builder.show(){
                if let Some(id)=ticket {tray_os_action::cancel(id);}
                eprintln!("[tray] Critical desktop alert unavailable: {error}");
            }
        }
    }
    Ok(created)
}

/// A paired-device observation may label an incident with only an ID supplied
/// by the authenticated Core device inventory; never a WebView/display label.
fn record_verified_device_incident(
    app: &tauri::AppHandle, device_id: &str, id: &str,
    title: &str, body: &str,
) -> Result<(), String> {
    let dir = config_dir()?;
    let created = tray_notification_center::publish_for_device(
        &dir, "lan-devices", "warning", id, title, body, device_id,
    )?;
    if created {
        let _ = app.emit("tray-notifications-changed", ());
        if tray_notification_center::should_notify_os(&dir, "lan-devices", "warning")? &&
            os_alert_budget_available() {
            let ticket = tray_os_action::issue(&dir, id).ok();
            let mut builder = app.notification().builder()
                .title("SuperAgent LAN device needs attention")
                .body("A previously paired LAN device disconnected. Review LAN Devices.");
            if let Some(ticket_id) = ticket { builder = builder.id(ticket_id); }
            if let Err(error) = builder.show() {
                if let Some(ticket_id) = ticket { tray_os_action::cancel(ticket_id); }
                eprintln!("[tray] LAN device notification unavailable: {error}");
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn tray_notification_center_preferences(
    window: tauri::WebviewWindow,
    preferences: tray_notification_center::NotificationPreferences,
) -> Result<Value, String> {
    if window.label() != "main" || !window.is_visible().unwrap_or(false) ||
        !window.is_focused().unwrap_or(false) {
        return Err("Focus the native Tray to manage notification preferences".into());
    }
    tray_notification_center::save_preferences(&config_dir()?, preferences)
}

/// The WebView can read and acknowledge, but may not insert arbitrary content.
#[tauri::command]
fn tray_notification_center_action(
    window: tauri::WebviewWindow,
    action: String,
    id: Option<String>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Notification Center is limited to the native Tray window".into());
    }
    if action != "list" && (!window.is_visible().unwrap_or(false) ||
        !window.is_focused().unwrap_or(false)) {
        return Err("Focus the native Tray to change notifications".into());
    }
    tray_notification_center::perform(&config_dir()?, &action, id.as_deref())
}

/// Take a one-time OS toast activation verified and queued by the native
/// notification plugin. Never accepts an arbitrary URL, tab, or incident ID.
#[tauri::command]
fn tray_notification_center_take_os_activation(
    window: tauri::WebviewWindow,
) -> Result<Value,String> {
    if window.label()!="main" || !window.is_visible().unwrap_or(false) ||
       !window.is_focused().unwrap_or(false) {
        return Err("OS_NOTIFICATION_TRAY_FOREGROUND_REQUIRED".into());
    }
    Ok(tray_os_action::take(&config_dir()?))
}

/// A navigation ticket is valid only for an existing, active native incident.
/// It carries no approval action, arbitrary URL, screenshot or file access.
#[tauri::command]
fn tray_notification_center_begin_navigation(
    window: tauri::WebviewWindow, incident_id: String,
) -> Result<Value,String> {
    if window.label()!="main" || !window.is_visible().unwrap_or(false) ||
       !window.is_focused().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        return Err("NAVIGATION_TRAY_FOREGROUND_REQUIRED".into());
    }
    tray_navigation_receipt::issue(&config_dir()?,&incident_id)
}

/// Return a single-use receipt only after comparing current native item,
/// allowed route, and (for pending approvals) fresh authenticated Core inventory.
/// The WebView's claimed row focus is never itself an approval credential.
#[tauri::command]
async fn tray_notification_center_ack_navigation(
    window: tauri::WebviewWindow, incident_id:String, nonce:String,
    route:String, target_found:bool,
) -> Result<Value,String> {
    if window.label()!="main" || !window.is_visible().unwrap_or(false) ||
       !window.is_focused().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
        return Err("NAVIGATION_TRAY_FOREGROUND_REQUIRED".into());
    }
    let dir=config_dir()?;
    let Some(ticket)=tray_navigation_receipt::consume(
        &dir,&incident_id,&nonce,&route,target_found)? else {
        return Ok(tray_navigation_receipt::receipt(
            &incident_id,None,"NOT_DELIVERED"));
    };
    if let Some((request_id,tab))=&ticket.pending {
        let payload=match core_request(Method::GET,"/api/desktop/access/requests",None).await {
            Ok(body)=>body,
            Err(_)=>return Ok(tray_navigation_receipt::receipt(
                &incident_id,Some(ticket.route),"BACKEND_UNAVAILABLE")),
        };
        let valid=payload.get("success")==Some(&Value::Bool(true)) &&
            payload.get("requests").and_then(Value::as_array).is_some_and(|requests|
                requests.iter().any(|req|
                    req.get("requestId").and_then(Value::as_str)==Some(request_id.as_str()) &&
                    req.get("status").and_then(Value::as_str)==Some("pending") &&
                    (*tab=="legacy" || *tab=="mcp")));
        if !valid { return Ok(tray_navigation_receipt::receipt(
            &incident_id,Some(ticket.route),"TARGET_EXPIRED")); }
    }
    // Core inventory may have awaited a reload or user focus change. Recheck
    // foreground and the exact ledger revision before persisting the read ACK.
    if !window.is_visible().unwrap_or(false) || !window.is_focused().unwrap_or(false) ||
       window.is_minimized().unwrap_or(true) {
        return Ok(tray_navigation_receipt::receipt(&incident_id,Some(ticket.route),"NOT_DELIVERED"));
    }
    if !tray_navigation_receipt::complete(&dir,&ticket)? {
        return Ok(tray_navigation_receipt::receipt(&incident_id,Some(ticket.route),"TARGET_EXPIRED"));
    }
    Ok(tray_navigation_receipt::receipt(&incident_id,Some(ticket.route),"DELIVERED"))
}

/// Foreground refresh of the exact same authenticated security projection used
/// by the native background poll. Never approves a capability or trusts MCP
/// request arguments from WebView. A failed Core read retains local inbox
/// history and reports an explicit unavailable sync state.
#[tauri::command]
async fn tray_notification_center_refresh_security(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Security notifications are limited to the native Tray window".into());
    }
    let synchronized = poll_pending_security_requests(&app).await;
    if let Err(error) = &synchronized {
        eprintln!("[tray] Security approval refresh unavailable: {error}");
    }
    let mut snapshot = tray_notification_center::perform(&config_dir()?, "list", None)?;
    if let Some(object) = snapshot.as_object_mut() {
        object.insert("securitySync".into(),
            json!(if synchronized.is_ok() { "ok" } else { "unavailable" }));
    }
    Ok(snapshot)
}

/// Record a generic, redacted UI issue; never persist raw IPC error bodies,
/// commands, credentials, project paths or other potentially private content.
#[tauri::command]
fn tray_notification_center_ui_alert(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    scope: String,
    kind: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Notification reports are limited to the native Tray window".into());
    }
    let allowed = ["security", "runtime", "delegate", "desktop-live", "terminal",
        "lan-devices", "muse-files", "jobs", "updates", "settings", "shutdown",
        "overview", "logs"];
    if !allowed.contains(&scope.as_str()) ||
        !["warning", "error"].contains(&kind.as_str()) {
        return Err("Unsupported notification category".into());
    }
    let severity = if kind == "error" { "critical" } else { "warning" };
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_secs() / 60);
    let id = format!("tray-ui:{scope}:{kind}:{timestamp}");
    let title = format!("{} needs attention", scope.replace('-', " "));
    record_operational_incident(
        &app, &scope, severity, &id, &title,
        "An operation reported an issue. Open its Tray page to review current status.",
    )?;
    Ok(())
}

fn record_core_notification(app: &tauri::AppHandle, severity: &str, title: &str, body: &str) {
    let id = format!("core:{}:{}", severity, SystemTime::now()
        .duration_since(UNIX_EPOCH).map_or(0, |t| t.as_nanos()));
    if record_operational_incident(app, "core", severity, &id, title, body).is_err() {
        eprintln!("[tray] Core incident persistence unavailable");
    }
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

#[tauri::command]
fn get_named_tunnel_settings() -> Result<named_tunnel_settings::NamedTunnelView, String> {
    Ok(named_tunnel_settings::load(&config_dir()?)?.inspect())
}

#[tauri::command]
fn set_named_tunnel_settings(
    settings: named_tunnel_settings::NamedTunnelSettings,
) -> Result<named_tunnel_settings::NamedTunnelView, String> {
    named_tunnel_connector::save_settings_guarded(&config_dir()?,&settings)
}

#[tauri::command]
fn get_named_tunnel_connector_status() -> Result<named_tunnel_connector::ConnectorStatus, String> {
    let dir=config_dir()?;
    let s=named_tunnel_settings::load(&dir)?;
    Ok(named_tunnel_connector::status(&dir,&s))
}

#[tauri::command]
fn plan_named_tunnel_connector() -> Result<named_tunnel_connector::ConnectorActionResult,String> {
    let dir=config_dir()?;
    let s=named_tunnel_settings::load(&dir)?;
    named_tunnel_connector::plan(&dir,&s)
}

#[tauri::command]
async fn named_tunnel_connector_action(
    app:tauri::AppHandle,
    window:tauri::WebviewWindow,
    action:String,expected_tunnel_id:String,reviewed:bool,
) -> Result<named_tunnel_connector::ConnectorActionResult,String> {
    if window.label()!="main"||!window.is_visible().unwrap_or(false)||
        window.is_minimized().unwrap_or(true) {
        return Err("Named Tunnel lifecycle requires the visible native Tray window".into());
    }
    if !reviewed||!matches!(action.as_str(),"start"|"stop"){
        return Err("Explicit lifecycle review is required".into());
    }
    let dir=config_dir()?;
    let s=named_tunnel_settings::load(&dir)?;
    if expected_tunnel_id!=s.tunnel_id{
        return Err("Cloudflare tunnel ID changed during review".into());
    }
    if action=="start"{
        let planned=named_tunnel_connector::plan(&dir,&s)?;
        if planned.status.running {return Err("Named connector is already active".into());}
        let health=named_tunnel_health::inspect(&dir,&s).await?;
        if health.anchor_status!="verified_local" {
            return Err("Start a verified independent Named Tunnel Anchor first".into());
        }
    } else if !named_tunnel_connector::status(&dir,&s).owned {
        return Err("Refusing to stop an unverified connector process".into());
    } else if std::fs::symlink_metadata(
        dir.join(format!("mcp-tunnel-anchor-{}.json",s.anchor_port))
    ).is_ok() {
        // Refuse abrupt interruption while an Anchor may still proxy MCP
        // requests. Owner/Anchor drain is an independent reviewed operation.
        return Err("Drain and close the independent Named Tunnel Anchor before stopping its connector".into());
    }
    let prompt=format!(
        "{} ONLY the independently owned Cloudflare Named Tunnel connector?\n\nHostname: {}\nTunnel ID: {}\n\nThis does NOT change or stop the active Gemini Quick Tunnel. The action is not an OAuth cutover.",
        if action=="start"{"Start"}else{"Stop"},s.hostname,s.tunnel_id,
    );
    let native=app.clone();
    let accepted=tauri::async_runtime::spawn_blocking(move||{
        use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
        native.dialog().message(prompt).buttons(
            MessageDialogButtons::OkCancelCustom(
                "Confirm connector action".into(),"Cancel".into(),
            )
        ).blocking_show()
    }).await.map_err(|_|"Native connector approval failed")?;
    if !accepted{return Err("Connector action was not approved".into());}
    let dir_clone=dir.clone();
    tauri::async_runtime::spawn_blocking(move||
        named_tunnel_connector::action(&dir_clone,&s,&action,&expected_tunnel_id,true)
    ).await.map_err(|_|"Connector process control failed")?
}

#[tauri::command]
async fn get_named_tunnel_health() -> Result<named_tunnel_health::NamedTunnelHealth,String> {
    let dir=config_dir()?;
    let s=named_tunnel_settings::load(&dir)?;
    named_tunnel_health::inspect(&dir,&s).await
}

#[tauri::command]
async fn get_named_tunnel_manager_status(
) -> Result<named_tunnel_orchestrator::NamedTunnelManagerStatus, String> {
    let dir = config_dir()?;
    let settings = named_tunnel_settings::load(&dir)?;
    Ok(named_tunnel_orchestrator::status(&dir, &settings).await)
}

#[tauri::command]
async fn plan_named_tunnel_stack(
) -> Result<named_tunnel_orchestrator::NamedTunnelStackPlan, String> {
    let dir = config_dir()?;
    let settings = named_tunnel_settings::load(&dir)?;
    Ok(named_tunnel_orchestrator::plan(&dir, &settings).await)
}

#[tauri::command]
async fn named_tunnel_stack_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    expected_tunnel_id: String,
    reviewed: bool,
) -> Result<named_tunnel_orchestrator::NamedTunnelStackActionResult, String> {
    if window.label() != "main" || !window.is_visible().unwrap_or(false) ||
        window.is_minimized().unwrap_or(true) || !window.is_focused().unwrap_or(false) {
        return Err("Named stack action requires a visible, focused native Tray window".into());
    }
    if !reviewed || !matches!(action.as_str(),
        "start-anchor" | "start-owner" | "stop-owner" | "stop-anchor") {
        return Err("Named stack requires explicit review of an allowed action".into());
    }
    let dir = config_dir()?;
    let settings = named_tunnel_settings::load(&dir)?;
    if expected_tunnel_id != settings.tunnel_id {
        return Err("Cloudflare Tunnel UUID changed during review".into());
    }
    let prompt = format!(
        "Review Named Tunnel stack action: {action}\n\nHost: {}\nTunnel UUID: {}\nAnchor: 127.0.0.1:{}\nPrivate owner: 127.0.0.1:{}\n\nNo Quick Tunnel or live Gemini MCP owner is affected. This is not OAuth cutover.",
        settings.hostname, settings.tunnel_id, settings.anchor_port, settings.owner_port
    );
    let dialog_app = app.clone();
    let approved = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        dialog_app.dialog().message(prompt).buttons(
            MessageDialogButtons::OkCancelCustom(
                "Approve isolated action".into(), "Cancel".into()
            )
        ).blocking_show()
    }).await.map_err(|_| "Native stack approval dialog failed")?;
    if !approved { return Err("Named Tunnel action canceled by operator".into()); }
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) ||
        !window.is_focused().unwrap_or(false) {
        return Err("Native Tray lost focus before the reviewed operation".into());
    }
    let latest = named_tunnel_settings::load(&dir)?;
    if latest != settings {
        return Err("Named Tunnel settings changed while native approval was open".into());
    }
    named_tunnel_orchestrator::action(
        &dir, &settings, &action, &expected_tunnel_id, true
    ).await
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
    let target_kind = match kind.as_str() {
        "mcp-tunnel" => "mcp",
        "muse-tunnel" => "muse-watch",
        other => other,
    };
    match target_kind {
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

/// The WebView may only invoke fixed LAN Client operations through the selected,
/// authenticated loopback Core. It never receives Core bearer or pair/session tokens.
/// Fetch the independently paired Android identity from the authenticated Core.
/// Never trust WebView-selected labels, fingerprints or a cached viewer frame.
async fn desktop_live_android_device(device_id: &str) -> Result<(String, String), String> {
    let inventory = core_request(Method::POST, "/api/desktop/lan-support",
        Some(json!({"action":"list"}))).await?;
    let list = inventory.get("devices").and_then(Value::as_array)
        .ok_or("ANDROID_CONTROLLER_INVENTORY_UNAVAILABLE")?;
    let matched: Vec<&Value> = list.iter().filter(|entry|
        entry.get("id").and_then(Value::as_str) == Some(device_id) &&
        entry.get("platform").and_then(Value::as_str) == Some("android") &&
        entry.get("paired").and_then(Value::as_bool) == Some(true) &&
        entry.get("connected").and_then(Value::as_bool) == Some(true)
    ).collect();
    if matched.len() != 1 { return Err("ANDROID_CONTROLLER_SESSION_NOT_VERIFIED".into()); }
    let fingerprint = matched[0].get("fingerprint").and_then(Value::as_str)
        .ok_or("ANDROID_CONTROLLER_FINGERPRINT_REQUIRED")?;
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("ANDROID_CONTROLLER_FINGERPRINT_INVALID".into());
    }
    let label = matched[0].get("label").and_then(Value::as_str).unwrap_or("Android device")
        .chars().filter(|c| !c.is_control()).take(80).collect::<String>();
    Ok((label, fingerprint.to_ascii_lowercase()))
}

/// The WebView may initiate a native request but cannot approve its own input.
#[tauri::command]
async fn lan_support_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    const ALL: &[&str] = &["discover", "list", "pair", "pair_complete", "pair_cancel", "tunnel_invite", "apk_download_qr", "qr_heartbeat", "tunnel_list", "tunnel_pair_request", "tunnel_revoke", "open", "exec", "terminal_start", "terminal_read", "terminal_input", "terminal_key", "terminal_resize", "terminal_stop", "terminal_fleet_open", "terminal_fleet_close", "terminal_fleet_start", "terminal_fleet_read", "terminal_fleet_input", "terminal_fleet_key", "terminal_fleet_resize", "terminal_fleet_stop", "close", "revoke", "screen", "input", "schema", "element", "control_request", "control_status", "control_revoke", "file_offer", "file_put", "file_get", "file_status", "file_finish", "file_abort", "file_v2_offer", "file_v2_put", "file_v2_status", "file_v2_finish", "file_v2_abort",
        "file_relay_start", "file_relay_status", "file_relay_cancel",
        "file_receive_v2_start", "file_receive_v2_status", "file_receive_v2_cancel"];
    if !ALL.contains(&action.as_str()) { return Err("Unsupported LAN action".into()); }
    if window.label() != "main" { return Err("LAN control requires the installed main Tray".into()); }
    let data = payload.unwrap_or_else(|| json!({}));
    let obj = data.as_object().ok_or("Invalid LAN payload")?;
    let allowed: &[&str] = match action.as_str() {
        "discover" => &["segment", "targetIp"],
        "list" => &[],
        "pair" => &["host", "port", "code", "fingerprint", "controller", "segment"],
        "pair_complete" => &["requestId", "code", "verified"],
        "pair_cancel" => &["requestId"],
        "tunnel_invite" | "apk_download_qr" | "tunnel_list" => &[],
        "qr_heartbeat" => &["kind", "id"],
        "tunnel_pair_request" => &["tunnelId", "fingerprint", "controller"],
        "tunnel_revoke" => &["tunnelId"],
        "exec" | "terminal_start" => &["deviceId", "command"],
        "terminal_fleet_open" | "terminal_fleet_close" | "terminal_fleet_start" | "terminal_fleet_read" | "terminal_fleet_input" | "terminal_fleet_key" | "terminal_fleet_resize" | "terminal_fleet_stop" => &["targets"],
        "terminal_read" => &["deviceId", "jobId", "cursor"],
        "terminal_input" => &["deviceId", "jobId", "text", "appendNewline"],
        "terminal_key" => &["deviceId", "jobId", "key"],
        "terminal_resize" => &["deviceId", "jobId", "cols", "rows"],
        "terminal_stop" => &["deviceId", "jobId"],
        "input" => &["deviceId", "kind", "x", "y", "endX", "endY", "durationMs", "text"],
        "control_request" | "control_status" | "control_revoke" => &["deviceId","kind"],
        "file_offer" => &["deviceId", "direction", "name", "size", "sha256"],
        "file_put" => &["deviceId", "transferId", "seq", "data"],
        "file_get" => &["deviceId", "transferId", "seq"],
        "file_status" => &["deviceId", "transferId"],
        "file_finish" | "file_abort" => &["deviceId", "transferId"],
        "file_v2_offer" => &["deviceId", "direction", "name", "size", "sha256"],
        "file_v2_put" => &["deviceId", "transferId", "seq", "data"],
        "file_v2_status" | "file_v2_finish" | "file_v2_abort" => &["deviceId", "transferId"],
        "file_relay_start" => &["sourceId", "destinationId", "protocol"],
        "file_relay_status" | "file_relay_cancel" => &["jobId"],
        "file_receive_v2_start" => &["deviceId"],
        "file_receive_v2_status" | "file_receive_v2_cancel" => &["jobId"],
        "schema" => &["deviceId", "knownRevision"],
        "element" => &["deviceId", "elementId", "revision", "kind"],
        _ => &["deviceId"],
    };
    if obj.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unexpected LAN argument".into());
    }
    if action == "discover" {
        let segment = data["segment"].as_str().ok_or("Network segment is required")?;
        if segment.len() < 3 || segment.len() > 32 || segment.trim() != segment
            || !segment.bytes().next().unwrap_or(b'-').is_ascii_alphanumeric()
            || !segment.bytes().all(|b| b.is_ascii_alphanumeric() || b" _.-".contains(&b)) {
            return Err("Invalid network segment name".into());
        }
        if let Some(ip) = data.get("targetIp") {
            ip.as_str().ok_or("Invalid direct IPv4 target")?
                .parse::<std::net::Ipv4Addr>().map_err(|_| "Invalid direct IPv4 target")?;
        }
    }
    if action == "pair" {
        let host = data["host"].as_str().ok_or("Target IPv4 required")?;
        let code = data["code"].as_str().ok_or("Pair code required")?;
        let fingerprint = data["fingerprint"].as_str().ok_or("Fingerprint required")?;
        if host.len() > 15 || !host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            || code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit())
            || fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid LAN pairing details".into());
        }
        if let Some(port) = data.get("port") {
            let port = port.as_u64().ok_or("Invalid LAN port")?;
            if !(1024..=65534).contains(&port) { return Err("Invalid LAN port".into()); }
        }
        if let Some(label) = data.get("controller") {
            let label = label.as_str().ok_or("Invalid controller label")?;
            if label.len() > 60 || !label.chars().all(|c| c.is_ascii_alphanumeric() || " _.-".contains(c)) {
                return Err("Invalid controller label".into());
            }
        }
        if let Some(segment) = data.get("segment") {
            let segment = segment.as_str().ok_or("Invalid network segment")?;
            if segment.len() < 3 || segment.len() > 32 || segment.trim() != segment
                || !segment.bytes().next().unwrap_or(b'-').is_ascii_alphanumeric()
                || !segment.bytes().all(|b| b.is_ascii_alphanumeric() || b" _.-".contains(&b)) {
                return Err("Invalid network segment".into());
            }
        }

    } else if action == "pair_complete" {
        let request_id = data["requestId"].as_str().ok_or("Pair request ID required")?;
        let code = data["code"].as_str().ok_or("Pair code required")?;
        if request_id.len() != 36 || !request_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || code.len() != 8 || !code.bytes().all(|b| b.is_ascii_digit())
            || data.get("verified").and_then(Value::as_bool) != Some(true) {
            return Err("Invalid local pairing completion".into());
        }
    } else if action == "pair_cancel" {
        let request_id = data["requestId"].as_str().ok_or("Pair request ID required")?;
        if request_id.len() != 36 || !request_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid pair request ID".into());
        }
    } else if action == "qr_heartbeat" {
        let kind = data["kind"].as_str().ok_or("QR heartbeat kind required")?;
        let id = data["id"].as_str().ok_or("QR heartbeat ID required")?;
        if kind != "connect" && kind != "apk" { return Err("Invalid QR heartbeat kind".into()); }
        let valid_connect = kind == "connect" && id.len() == 36
            && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
        let valid_apk = kind == "apk" && id.len() == 64
            && id.bytes().all(|b| b.is_ascii_hexdigit());
        if !valid_connect && !valid_apk { return Err("Invalid QR heartbeat ID".into()); }
    } else if action == "tunnel_pair_request" {
        let tunnel_id = data["tunnelId"].as_str().ok_or("Tunnel device ID required")?;
        let fingerprint = data["fingerprint"].as_str().ok_or("Fingerprint required")?;
        if tunnel_id.len() != 36 || !tunnel_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
            || fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid tunnel pairing details".into());
        }
        if let Some(label) = data.get("controller") {
            let label = label.as_str().ok_or("Invalid controller label")?;
            if label.len() > 60 || !label.chars().all(|c| c.is_ascii_alphanumeric() || " _.-".contains(c)) {
                return Err("Invalid controller label".into());
            }
        }
    } else if action == "tunnel_revoke" {
        let tunnel_id = data["tunnelId"].as_str().ok_or("Tunnel device ID required")?;
        if tunnel_id.len() != 36 || !tunnel_id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid tunnel device ID".into());
        }
    } else if !["discover", "list", "tunnel_invite", "apk_download_qr", "tunnel_list",
        "file_relay_start", "file_relay_status", "file_relay_cancel",
        "file_receive_v2_start", "file_receive_v2_status", "file_receive_v2_cancel",
        "terminal_fleet_open", "terminal_fleet_close", "terminal_fleet_start", "terminal_fleet_read", "terminal_fleet_input", "terminal_fleet_key", "terminal_fleet_resize", "terminal_fleet_stop"].contains(&action.as_str()) {
        let id = data["deviceId"].as_str().ok_or("Device ID required")?;
        if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid device ID".into());
        }
    }
    if action == "exec" {
        let command = data["command"].as_str().ok_or("Remote command required")?;
        if command.trim().is_empty() || command.len() > 2000 {
            return Err("Remote command length must be 1–2000".into());
        }
    }
    if action == "terminal_start" {
        let command = data["command"].as_str().ok_or("Terminal command required")?;
        if command.trim().is_empty() || command.chars().count() > 2000 ||
            command.chars().any(|c| c.is_control() && c != '\n' && c != '\r') {
            return Err("Invalid terminal command".into());
        }
    }
    if matches!(action.as_str(), "terminal_read" | "terminal_input" | "terminal_stop") {
        let job = data["jobId"].as_str().ok_or("Terminal task ID required")?;
        if job.len() != 36 || !job.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
            return Err("Invalid terminal task ID".into());
        }
        if action == "terminal_read" && data.get("cursor").is_some() &&
            data["cursor"].as_u64().is_none() {
            return Err("Invalid terminal cursor".into());
        }
        if action == "terminal_input" {
            let text = data["text"].as_str().ok_or("Terminal input required")?;
            if text.is_empty() || text.chars().count() > 1024 ||
               text.chars().any(|c| c.is_control() && c != '\n' && c != '\t') ||
               data.get("appendNewline").is_some_and(|v| !v.is_boolean()) {
                return Err("Invalid terminal input".into());
            }
        }
    }
    if action.starts_with("terminal_fleet_") {
        let targets = data["targets"].as_array().ok_or("Terminal fleet targets required")?;
        if !(2..=8).contains(&targets.len()) {
            return Err("Fleet requires 2–8 distinct device targets".into());
        }
        let mut ids = std::collections::HashSet::new();
        for target in targets {
            let fields = target.as_object().ok_or("Invalid terminal fleet target")?;
            let valid: &[&str] = match action.as_str() {
                "terminal_fleet_open" | "terminal_fleet_close" => &["deviceId"],
                "terminal_fleet_start" => &["deviceId", "command"],
                "terminal_fleet_read" => &["deviceId", "jobId", "cursor"],
                "terminal_fleet_input" => &["deviceId", "jobId", "text", "appendNewline"],
                "terminal_fleet_key" => &["deviceId", "jobId", "key"],
                "terminal_fleet_resize" => &["deviceId", "jobId", "cols", "rows"],
                "terminal_fleet_stop" => &["deviceId", "jobId"],
                _ => return Err("Unknown terminal fleet action".into()),
            };
            if fields.keys().any(|key| !valid.contains(&key.as_str())) {
                return Err("Unexpected terminal fleet field".into());
            }
            let device = target["deviceId"].as_str().ok_or("Target deviceId required")?;
            if device.len() != 36 || !device.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') ||
                !ids.insert(device.to_owned()) {
                return Err("Invalid or repeated target deviceId".into());
            }
            if matches!(action.as_str(), "terminal_fleet_open" | "terminal_fleet_close") {
                // Only an opaque paired device handle; target owner approvals live in Core.
            } else if action == "terminal_fleet_start" {
                let command = target["command"].as_str().ok_or("Target command required")?;
                if command.trim().is_empty() || command.chars().count() > 2000 ||
                    command.chars().any(|value| value.is_control()) {
                    return Err("Invalid target command".into());
                }
            } else {
                let job = target["jobId"].as_str().ok_or("Target terminal jobId required")?;
                if job.len() != 36 || !job.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
                    return Err("Invalid target terminal jobId".into());
                }
                if action == "terminal_fleet_read" && target.get("cursor").is_some() &&
                    target["cursor"].as_u64().is_none() {
                    return Err("Invalid target cursor".into());
                }
                if action == "terminal_fleet_key" {
                    let key = target["key"].as_str().ok_or("Terminal key required")?;
                    if !matches!(key, "Enter" | "Backspace" | "Tab" | "Escape" |
                        "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" |
                        "Home" | "End" | "Delete" | "PageUp" | "PageDown" | "CtrlC") {
                        return Err("Unsupported fleet terminal key".into());
                    }
                }
                if action == "terminal_fleet_resize" {
                    let cols = target["cols"].as_u64().ok_or("Terminal cols required")?;
                    let rows = target["rows"].as_u64().ok_or("Terminal rows required")?;
                    if !(20..=300).contains(&cols) || !(5..=120).contains(&rows) {
                        return Err("Invalid fleet terminal dimensions".into());
                    }
                }
                if action == "terminal_fleet_input" {
                    let input = target["text"].as_str().ok_or("Target terminal input required")?;
                    if input.is_empty() || input.chars().count() > 1024 ||
                        input.chars().any(|value| value.is_control()) ||
                        target.get("appendNewline").is_some_and(|value| !value.is_boolean()) {
                        return Err("Invalid target terminal input".into());
                    }
                }
            }
        }
    }
    if action.starts_with("file_") {
        if action.starts_with("file_receive_v2_") {
            let id = if action == "file_receive_v2_start" {
                data["deviceId"].as_str().ok_or("Owner-selected V2 source device ID required")?
            } else {
                data["jobId"].as_str().ok_or("V2 receive job ID required")?
            };
            if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
                return Err("Invalid V2 receive handle".into());
            }
        } else if action.starts_with("file_relay_") {
            let valid_uuid = |v: &str| v.len() == 36 &&
                v.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
            if action == "file_relay_start" {
                let src = data["sourceId"].as_str().ok_or("Source device required")?;
                let dst = data["destinationId"].as_str().ok_or("Destination device required")?;
                if !valid_uuid(src) || !valid_uuid(dst) || src == dst {
                    return Err("Choose two different approved device IDs".into());
                }
                if let Some(v) = data.get("protocol") {
                    if v.as_str() != Some("v1") && v.as_str() != Some("v2") {
                        return Err("Invalid relay protocol".into());
                    }
                }
            } else {
                let id = data["jobId"].as_str().ok_or("Relay job ID required")?;
                if !valid_uuid(id) { return Err("Invalid relay job ID".into()); }
            }
        } else if action == "file_v2_offer" {
            if data["direction"].as_str() != Some("upload") {
                return Err("V2 currently supports receiving files on Windows only".into());
            }
            let name = data["name"].as_str().ok_or("V2 file name required")?;
            if name.is_empty() || name.len() > 96 || name.starts_with('.')
                || name.ends_with('.') || name.ends_with(' ') || name.ends_with(".safolder")
                || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b" _.-()".contains(&b)) {
                return Err("Unsafe V2 file name".into());
            }
            let size = data["size"].as_u64().ok_or("V2 file size required")?;
            let sha256 = data["sha256"].as_str().ok_or("V2 SHA-256 required")?;
            if !(1..=256 * 1024 * 1024).contains(&size) || sha256.len() != 64
                || !sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
                return Err("Invalid V2 file metadata".into());
            }
        } else if action.starts_with("file_v2_") {
            let id = data["transferId"].as_str().ok_or("V2 transfer ID required")?;
            if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
                return Err("Invalid V2 transfer handle".into());
            }
            if action == "file_v2_put" {
                let seq = data["seq"].as_u64().ok_or("V2 sequence required")?;
                if seq > 16384 { return Err("V2 sequence exceeds file bound".into()); }
                let data64 = data["data"].as_str().ok_or("V2 base64 chunk required")?;
                if data64.is_empty() || data64.len() > 21848 ||
                    !data64.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) {
                    return Err("Invalid V2 base64 chunk".into());
                }
            }
        } else if action == "file_offer" {
            let direction = data["direction"].as_str().ok_or("File direction required")?;
            if direction != "upload" && direction != "download" {
                return Err("Invalid file direction".into());
            }
            if direction == "download" &&
                ["name","size","sha256"].iter().any(|key| data.get(*key).is_some()) {
                return Err("Remote file is selected at the target only".into());
            }
            if direction == "upload" {
                let name = data["name"].as_str().ok_or("File name required")?;
                let ok = !name.is_empty() && name.len() <= 96 && !name.starts_with('.')
                    && !name.ends_with('.') && !name.ends_with(' ')
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b" _.-()".contains(&b));
                if !ok { return Err("Unsafe file name".into()); }
                let size = data["size"].as_u64().ok_or("File size required")?;
                let hash = data["sha256"].as_str().ok_or("File hash required")?;
                if !(1..=4 * 1024 * 1024).contains(&size) || hash.len()!=64
                    || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Invalid file size or digest".into());
                }
            }
        } else {
            let id = data["transferId"].as_str().ok_or("Transfer ID required")?;
            if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
                return Err("Invalid transfer handle".into());
            }
            if action == "file_put" || action == "file_get" {
                let seq = data["seq"].as_u64().ok_or("File sequence required")?;
                if seq > 1024 { return Err("Too many file chunks".into()); }
            }
            if action == "file_put" {
                let b64 = data["data"].as_str().ok_or("File data required")?;
                if b64.is_empty() || b64.len() > 5464 ||
                    !b64.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) {
                    return Err("Invalid base64 file chunk".into());
                }
            }
        }
    }
    if action == "schema" {
        if let Some(revision) = data.get("knownRevision") {
            let value = revision.as_u64().ok_or("Schema revision must be nonnegative integer")?;
            if value > 1_000_000_000 { return Err("Schema revision outside bounds".into()); }
        }
    }
    if action == "element" {
        let rev = data["revision"].as_u64().ok_or("UI revision must be an integer")?;
        if rev == 0 || rev > 1_000_000_000 { return Err("UI revision out of bounds".into()); }
        if data["kind"].as_str() != Some("click") {
            return Err("Unsupported UI element action".into());
        }
        let id = data["elementId"].as_str().ok_or("UI element path required")?;
        let parts: Vec<&str> = id.split('.').collect();
        if id.len() > 48 || parts.is_empty() || parts.len() > 13 || parts[0] != "0"
            || parts[1..].iter().any(|part| part.is_empty() || part.len() > 2
                || !part.bytes().all(|b| b.is_ascii_digit())) {
            return Err("Invalid semantic UI element ID".into());
        }
    }
    if action == "input" {
        let kind = data["kind"].as_str().ok_or("Input kind required")?;
        let fields: &[&str] = match kind {
            "tap" => &["x", "y"],
            "swipe" => &["x", "y", "endX", "endY", "durationMs"],
            "back" | "home" | "recents" => &[],
            "text" => &["text"],
            _ => return Err("Unsupported Android input".into()),
        };
        if obj.keys().any(|k| k != "deviceId" && k != "kind" && !fields.contains(&k.as_str())) {
            return Err("Unexpected Android input field".into());
        }
        for coord in if kind == "tap" { vec!["x", "y"] }
                     else if kind == "swipe" { vec!["x", "y", "endX", "endY"] }
                     else { vec![] } {
            let value = data[coord].as_f64().ok_or("Invalid input coordinate")?;
            if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                return Err("Input coordinate out of bounds".into());
            }
        }
        if kind == "swipe" {
            let ms = data["durationMs"].as_u64().ok_or("Invalid swipe duration")?;
            if !(100..=1500).contains(&ms) { return Err("Swipe duration invalid".into()); }
        }
        if kind == "text" {
            let text = data["text"].as_str().ok_or("Input text required")?;
            if text.is_empty() || text.chars().count() > 160 || text.chars().any(|c| c as u32 == 10 || c as u32 == 13) {
                return Err("Text input invalid".into());
            }
        }
    }
    // The native controller permission does not exist in WebView state,
    // local storage, Core preview tokens or MCP project access grants.
    if matches!(action.as_str(), "control_revoke" | "control_status" | "control_request") {
        let kind = data["kind"].as_str().ok_or("Controller kind required")?;
        if !matches!(kind, "mouse" | "keyboard") {
            return Err("ANDROID_CONTROLLER_INVALID_SCOPE".into());
        }
    }
    if action == "control_revoke" {
        let id = data["deviceId"].as_str().ok_or("Device ID required")?;
        let kind = data["kind"].as_str().ok_or("Controller kind required")?;
        // Always destroy the native bearer, but never claim Core-wide
        // revocation unless the separately authorized Core confirms it.
        let outcome: Result<(), String> = async {
            let (_, fp) = desktop_live_android_device(id).await?;
            let token = desktop_live_android_control::credential(id,&fp,kind,true)
                .map_err(|_| "ANDROID_CONTROLLER_CORE_REVOKE_UNVERIFIED".to_string())?;
            let result = core_request(Method::POST,"/api/desktop/lan-controller/revoke",
                Some(json!({"deviceId":id,"controllerToken":token,"kind":kind}))).await?;
            if result.get("success").and_then(Value::as_bool) != Some(true) ||
               result.get("approved").and_then(Value::as_bool) != Some(false) {
                return Err("ANDROID_CONTROLLER_CORE_REVOKE_UNVERIFIED".into());
            }
            Ok(())
        }.await;
        desktop_live_android_control::revoke_kind(id,kind);
        outcome?;
        return Ok(json!({"success":true,"approved":false,"kind":kind}));
    }
    if matches!(action.as_str(), "input" | "element" | "control_request" | "control_status") &&
       (!window.is_visible().unwrap_or(false) ||
        window.is_minimized().unwrap_or(true)) {
        desktop_live_android_control::revoke();
        return Err("ANDROID_CONTROLLER_VISIBLE_TRAY_REQUIRED".into());
    }
    if action == "control_status" {
        let id = data["deviceId"].as_str().ok_or("Device ID required")?;
        let kind = data["kind"].as_str().ok_or("Controller kind required")?;
        let result = async {
            let (_, fp) = desktop_live_android_device(id).await?;
            let token = desktop_live_android_control::credential(id,&fp,kind,true)?;
            let response = core_request(Method::POST,"/api/desktop/lan-controller/status",
                Some(json!({"deviceId":id,"controllerToken":token,"kind":kind}))).await?;
            if response.get("approved").and_then(Value::as_bool) != Some(true) {
                return Err("ANDROID_CONTROLLER_CORE_GRANT_REVOKED".into());
            }
            let seconds = response.get("secondsRemaining").and_then(Value::as_u64)
                .ok_or("ANDROID_CONTROLLER_CORE_STATUS_INVALID")?;
            if seconds < 1 || seconds > desktop_live_android_control::MAX_CONTROL_SECONDS {
                return Err("ANDROID_CONTROLLER_CORE_STATUS_EXPIRED".into());
            }
            Ok::<u64,String>(seconds)
        }.await;
        return Ok(match result {
            Ok(seconds) => json!({"success":true,"approved":true,"secondsRemaining":seconds}),
            Err(_) => { desktop_live_android_control::revoke_kind(id,kind);
                json!({"success":true,"approved":false,"secondsRemaining":0}) },
        });
    }
    if action == "control_request" {
        let id = data["deviceId"].as_str().ok_or("Device ID required")?;
        let kind = data["kind"].as_str().ok_or("Controller kind required")?;
        if DESKTOP_LIVE_APPROVAL_OPEN.compare_exchange(
            false, true, std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        ).is_err() {
            return Err("Another native Desktop Live approval is pending".into());
        }
        let _guard = DesktopLiveApprovalGuard;
        let (label, fingerprint) = desktop_live_android_device(id).await?;
        let challenge = core_request(Method::POST,"/api/desktop/lan-controller/challenge",
            Some(json!({"deviceId":id,"kind":kind}))).await?;
        let nonce = challenge.get("nonce").and_then(Value::as_str)
            .ok_or("ANDROID_CONTROLLER_CHALLENGE_UNAVAILABLE")?;
        if challenge.get("deviceId").and_then(Value::as_str) != Some(id) ||
           challenge.get("fingerprint").and_then(Value::as_str) != Some(fingerprint.as_str()) ||
           challenge.get("kind").and_then(Value::as_str) != Some(kind) {
            return Err("ANDROID_CONTROLLER_CHALLENGE_IDENTITY_MISMATCH".into());
        }
        let prompt = format!(concat!(
            "ALLOW ANDROID {} INPUT?\n\n",
            "Device: {}\nFingerprint: {}…\n\n",
            "Viewer permission does NOT authorize mouse, touch or keyboard.\n",
            "Allow this installed Tray to request input on ONLY this device ",
            "for up to two minutes?\n\n",
            "The Android owner must independently approve Accessibility input. ",
            "The phone may deny any command. No Core token is shown to the browser."
        ), kind.to_ascii_uppercase(),label, &fingerprint[..12]);
        let native = app.clone();
        let approved = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            native.dialog().message(prompt).buttons(
                MessageDialogButtons::OkCancelCustom(
                    "Allow input".to_string(), "Deny".to_string(),
                ),
            ).blocking_show()
        }).await.map_err(|_| "ANDROID_CONTROLLER_NATIVE_DIALOG_FAILED")?;
        if !approved {
            desktop_live_android_control::revoke_kind(id,kind);
            return Ok(json!({"success":true,"approved":false}));
        }
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
            desktop_live_android_control::revoke_kind(id,kind);
            return Err("ANDROID_CONTROLLER_TRAY_HIDDEN_DURING_APPROVAL".into());
        }
        let (_, after) = desktop_live_android_device(id).await?;
        if after != fingerprint {
            desktop_live_android_control::revoke_kind(id,kind);
            return Err("ANDROID_CONTROLLER_DEVICE_CHANGED_DURING_APPROVAL".into());
        }
        let mac = desktop_live_android_controller_proof(nonce,id,&fingerprint,kind)?;
        let result = core_request(Method::POST,"/api/desktop/lan-controller/approve",
            Some(json!({"deviceId":id,"fingerprint":fingerprint,
                "nonce":nonce,"mac":mac,"kind":kind}))).await?;
        if result.get("kind").and_then(Value::as_str) != Some(kind) {
            return Err("ANDROID_CONTROLLER_SCOPE_RESPONSE_INVALID".into());
        }
        let controller_token = result.get("controllerToken").and_then(Value::as_str)
            .ok_or("ANDROID_CONTROLLER_CORE_GRANT_MISSING")?;
        let expires = result.get("expiresAt").and_then(Value::as_u64)
            .ok_or("ANDROID_CONTROLLER_CORE_GRANT_INVALID")?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| "ANDROID_CONTROLLER_HOST_CLOCK_INVALID")?.as_millis() as u64;
        if expires <= now || expires > now + 120_500 ||
           controller_token.len()!=64 ||
           !controller_token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
            return Err("ANDROID_CONTROLLER_CORE_GRANT_INVALID".into());
        }
        desktop_live_android_control::approve(id, &fingerprint, kind, controller_token)?;
        return Ok(json!({"success":true,"approved":true,
            "secondsRemaining": desktop_live_android_control::MAX_CONTROL_SECONDS,"kind":kind}));
    }
    let mut controller_token: Option<String> = None;
    if matches!(action.as_str(), "input" | "element") {
        let id = data["deviceId"].as_str().ok_or("Device ID required")?;
        let (_, fingerprint) = desktop_live_android_device(id).await?;
        let kind = if action == "element" ||
            matches!(data["kind"].as_str(), Some("tap" | "swipe")) {
            "mouse"
        } else { "keyboard" };
        controller_token = Some(desktop_live_android_control::credential(id, &fingerprint,kind,true)?);
    }
    if matches!(action.as_str(), "open" | "close" | "revoke" | "pair") {
        if let Some(id) = data.get("deviceId").and_then(Value::as_str) {
            desktop_live_android_control::revoke_device(id);
        } else {
            desktop_live_android_control::revoke();
        }
    }
    let mut body = Map::new();
    body.insert("action".into(), Value::String(action.clone()));
    body.extend(obj.iter().map(|(key, value)| (key.clone(), value.clone())));
    if let Some(token) = controller_token {
        body.insert("controllerToken".into(),Value::String(token));
    }
    let response = core_request(Method::POST, "/api/desktop/lan-support",
        Some(Value::Object(body))).await;
    if matches!(action.as_str(), "input" | "element") &&
       (!window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true)) {
        desktop_live_android_control::revoke();
        return Err("ANDROID_CONTROLLER_ACTION_UNVERIFIED_AFTER_TRAY_HIDDEN".into());
    }
    response
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
        "orchestrator-status" => {
            core_request(Method::GET, "/api/desktop/delegate/orchestrator", None).await
        }
        "cdp-live" => {
            let data = payload.unwrap_or_else(|| json!({}));
            let obj = data.as_object().ok_or("Invalid CDP live cursor")?;
            if obj.keys().any(|key| key != "cursor") { return Err("Unexpected CDP live field".into()); }
            let cursor = obj.get("cursor").and_then(Value::as_str);
            if obj.get("cursor").is_some() && cursor.is_none() { return Err("Invalid CDP cursor".into()); }
            let path = match cursor {
                Some(value) if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) =>
                    format!("/api/desktop/cdp/live?cursor={value}"),
                None => "/api/desktop/cdp/live".into(),
                _ => return Err("Invalid CDP cursor".into()),
            };
            core_request(Method::GET, &path, None).await
        }
        "cdp-preview" => {
            let data = payload.ok_or("Missing preview consent")?;
            let obj = data.as_object().ok_or("Invalid CDP preview request")?;
            if obj.len() != 5 || obj.keys().any(|k| !["port","targetId","expectedRevision","consent","previewId"].contains(&k.as_str())) {
                return Err("Unexpected preview request field".into());
            }
            let port = obj.get("port").and_then(Value::as_u64).ok_or("Preview port required")?;
            let revision = obj.get("expectedRevision").and_then(Value::as_u64).ok_or("Preview revision required")?;
            let target = obj.get("targetId").and_then(Value::as_str).ok_or("Preview target required")?;
            let consent = obj.get("consent").and_then(Value::as_bool);
            let preview_id = obj.get("previewId").and_then(Value::as_str).ok_or("Preview consent ID required")?;
            let preview_bytes = preview_id.as_bytes();
            if preview_bytes.len() != 36 || preview_bytes.iter().enumerate().any(|(index, byte)| {
                if [8,13,18,23].contains(&index) { *byte != b'-' }
                else if index == 14 { !(b'1'..=b'8').contains(byte) }
                else if index == 19 { !matches!(*byte, b'8'|b'9'|b'a'|b'b') }
                else { !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase() }
            }) { return Err("Invalid preview consent ID".into()); }
            if !(1024..=65535).contains(&port) || revision > 1_000_000_000 ||
                consent != Some(true) || target.is_empty() || target.len() > 128 ||
                !target.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                return Err("Preview requires explicit consent for an exact registered target".into());
            }
            core_request(Method::POST, "/api/desktop/cdp/preview", Some(data)).await
        }
        "cdp-approval" => {
            let data = payload.ok_or("Missing replay approval request")?;
            let obj = data.as_object().ok_or("Invalid replay approval body")?;
            if obj.len() != 2 || obj.keys().any(|k| !["approvalId","decision"].contains(&k.as_str())) {
                return Err("Unexpected replay approval field".into());
            }
            let id = obj.get("approvalId").and_then(Value::as_str).ok_or("Approval ID required")?;
            let decision = obj.get("decision").and_then(Value::as_str).ok_or("Approval decision required")?;
            if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') ||
                !matches!(decision, "approve" | "deny") {
                return Err("Invalid replay approval request".into());
            }
            core_request(Method::POST, "/api/desktop/cdp/approval", Some(data)).await
        }
        "cdp-control" => {
            let data = payload.ok_or("Missing CDP control target")?;
            let obj = data.as_object().ok_or("Invalid CDP control body")?;
            if obj.keys().any(|k| !["port","targetId","mode","expectedRevision"].contains(&k.as_str())) ||
                obj.len() != 4 { return Err("Unexpected CDP control field".into()); }
            let port = obj.get("port").and_then(Value::as_u64).ok_or("CDP port required")?;
            let rev = obj.get("expectedRevision").and_then(Value::as_u64).ok_or("CDP revision required")?;
            let target = obj.get("targetId").and_then(Value::as_str).ok_or("CDP target ID required")?;
            let mode = obj.get("mode").and_then(Value::as_str).ok_or("CDP mode required")?;
            if !(1024..=65535).contains(&port) || rev > 1_000_000_000 ||
                target.is_empty() || target.len() > 128 ||
                !target.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') ||
                !matches!(mode, "human" | "agent") { return Err("Invalid CDP control target".into()); }
            core_request(Method::POST, "/api/desktop/cdp/control", Some(data)).await
        }
        "orchestrator" => {
            let data = payload.ok_or("Missing multi-tab command")?;
            let obj = data.as_object().ok_or("Invalid multi-tab payload")?;
            let command = obj.get("action").and_then(Value::as_str).ok_or("Action required")?;
            let allowed: &[&str] = match command {
                "new-tab" => &["clientId"],
                "claim" | "release" => &["clientId", "tabId", "workerId"],
                "enqueue" => &["requestId", "clientId", "tabId", "workerId", "message", "title", "priority", "chatId", "maxRuntimeMs"],
                "parallel" => &["requestId", "clientId", "tabIds", "goal"],
                "cancel" | "reconcile" | "stop-generation" => &["taskId"],
                "forward" => &["sourceTaskId", "requestId", "clientId", "tabId", "workerId", "priority"],
                "aggregate" => &["taskIds"],
                "set-concurrency" => &["maxConcurrent"],
                _ => return Err("Unsupported multi-tab command".into()),
            };
            if obj.keys().any(|key| key != "action" && !allowed.contains(&key.as_str())) {
                return Err("Unexpected multi-tab command field".into());
            }
            let serialized = serde_json::to_vec(&data).map_err(|_| "Invalid multi-tab payload")?;
            if serialized.len() > 25_000 { return Err("Multi-tab payload too large".into()); }
            core_request(Method::POST, "/api/desktop/delegate/orchestrator", Some(data)).await
        }
        _ => Err("Unsupported delegate action".into()),
    }
}

/// Domain-separated signature for a Core-issued Android controller challenge.
/// The key stays in host-only native memory. The WebView never sees a MAC or
/// controller token and cannot turn a screenshot approval into input authority.
fn desktop_live_android_controller_proof(nonce: &str, id: &str, fp: &str, kind: &str) -> Result<String, String> {
    if !matches!(kind, "mouse" | "keyboard") || nonce.len() != 48 || !nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) ||
       fp.len() != 64 || !fp.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) ||
       id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("ANDROID_CONTROLLER_CHALLENGE_INVALID".into());
    }
    let file = config_dir()?.join(".desktop-live-native-approval.key");
    let metadata = std::fs::symlink_metadata(&file)
        .map_err(|_| "ANDROID_CONTROLLER_NATIVE_KEY_UNAVAILABLE")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() ||
       !(64..=80).contains(&metadata.len()) {
        return Err("ANDROID_CONTROLLER_NATIVE_KEY_INVALID".into());
    }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("ANDROID_CONTROLLER_NATIVE_KEY_PERMISSIONS".into());
        }
    }
    let value = std::fs::read_to_string(&file)
        .map_err(|_| "ANDROID_CONTROLLER_NATIVE_KEY_UNREADABLE")?;
    let hex = value.trim();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("ANDROID_CONTROLLER_NATIVE_KEY_INVALID".into());
    }
    let key: Vec<u8> = (0..32).map(|i|
        u8::from_str_radix(&hex[2*i..2*i+2], 16))
        .collect::<Result<_,_>>().map_err(|_| "ANDROID_CONTROLLER_NATIVE_KEY_INVALID")?;
    let message = format!("superagent-desktop-live-android-controller-v2:{}:{}:{}:{}",nonce,id,fp,kind);
    Ok(desktop_live_hmac(&key, message.as_bytes()))
}

fn desktop_live_hmac(key: &[u8], message: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut outer_pad = [0x5cu8; 64];
    let mut inner_pad = [0x36u8; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    format!("{:x}", outer.finalize())
}

fn desktop_live_native_approval_proof(nonce: &str, approved: &Value) -> Result<Value, String> {
    desktop_native_approval_proof(nonce, approved, false)
}
fn desktop_recording_native_approval_proof(nonce: &str, approved: &Value) -> Result<Value, String> {
    desktop_native_approval_proof(nonce, approved, true)
}
fn desktop_native_approval_proof(
    nonce: &str, approved: &Value, recording: bool,
) -> Result<Value, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    if nonce.len() != 48 || !nonce.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("Invalid native approval challenge".into());
    }
    let key_path = config_dir()?.join(".desktop-live-native-approval.key");
    let metadata = std::fs::symlink_metadata(&key_path)
        .map_err(|_| "Native approval key is unavailable")?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() ||
       !(64..=80).contains(&metadata.len()) {
        return Err("Native approval key file is not secure".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Native approval key permissions are too broad".into());
        }
    }
    let text = std::fs::read_to_string(&key_path)
        .map_err(|_| "Native approval key is unreadable")?;
    let hex_key = text.trim();
    if hex_key.len() != 64 || !hex_key.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err("Native approval key is invalid".into());
    }
    let key = (0..32).map(|i| u8::from_str_radix(&hex_key[2*i..2*i+2], 16))
        .collect::<Result<Vec<_>, _>>().map_err(|_| "Native approval key is invalid")?;
    let pid = approved.get("pid").and_then(Value::as_u64).filter(|n| *n > 0)
        .ok_or("Native approval PID is invalid")?;
    let value = |key: &str| -> Result<String, String> {
        let text = approved.get(key).and_then(Value::as_str)
            .filter(|text| !text.is_empty()).ok_or("Missing approved window identity")?;
        Ok(URL_SAFE_NO_PAD.encode(text.as_bytes()))
    };
    let bounds = approved.get("expectedBounds").and_then(Value::as_object)
        .ok_or("Missing approved native window geometry")?;
    let number = |field: &str| -> Result<i64, String> {
        bounds.get(field).and_then(Value::as_i64)
            .ok_or("Invalid native window geometry".into())
    };
    let purpose=if recording {"desktop-live-native-recording-v1"}
        else {"desktop-live-native-approval-v1"};
    let base = format!("{}:{}:{}:{}:{}:{}:{}:{}:{}:{}",
        purpose, nonce, pid, value("nativeId")?, value("expectedTitle")?,
        value("expectedApplication")?, number("x")?, number("y")?,
        number("width")?, number("height")?);
    let message=if recording {
        use sha2::{Digest,Sha256};
        let token=approved.get("previewToken").and_then(Value::as_str)
            .filter(|t|t.len()==64 && t.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
            .ok_or("Recording capability missing")?;
        let directory=approved.get("projectDirectory").and_then(Value::as_str)
            .filter(|p|p.len()<=1024 && std::path::Path::new(p).is_absolute())
            .ok_or("Recording project path missing")?;
        let preset=approved.get("videoPreset").and_then(Value::as_str)
            .filter(|p|["compact","standard","detail"].contains(p))
            .ok_or("Recording preset is invalid")?;
        let digest=Sha256::digest(token.as_bytes());
        let token_hash=digest.iter().map(|b|format!("{:02x}",b)).collect::<String>();
        format!("{}:{}:{}:{}",base,token_hash,URL_SAFE_NO_PAD.encode(directory.as_bytes()),preset)
    } else {base};
    let mac = desktop_live_hmac(&key, message.as_bytes());
    Ok(json!({"nonce": nonce, "mac": mac}))
}

static DESKTOP_LIVE_APPROVAL_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

struct DesktopLiveApprovalGuard;
impl Drop for DesktopLiveApprovalGuard {
    fn drop(&mut self) {
        DESKTOP_LIVE_APPROVAL_OPEN.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}


#[tauri::command]
async fn recordings_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "main" || !window.is_visible().unwrap_or(false) ||
       window.is_minimized().unwrap_or(true) {
        return Err("Recording Manager requires the visible native Tray".into());
    }
    if action == "pick-project" {
        use tauri_plugin_dialog::DialogExt;
        let dialog_app = app.clone();
        let dialog_window = window.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            dialog_app.dialog().file().set_parent(&dialog_window).blocking_pick_folder()
        }).await.map_err(|_| "Native project picker failed")?;
        let Some(selected) = selected else { return Ok(json!({"cancelled":true})); };
        let folder = selected.into_path().map_err(|_| "A local folder is required")?;
        let meta = fs::symlink_metadata(&folder).map_err(|_| "Project folder unavailable")?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("Choose a real project directory".into());
        }
        let canonical = fs::canonicalize(&folder).map_err(|_| "Project folder unavailable")?;
        if canonical.parent().is_none() { return Err("Filesystem root is not a project".into()); }
        return Ok(json!({"projectDirectory":canonical.to_string_lossy()}));
    }
    if action=="start-native" {
        let data=payload.ok_or("Exact preview and recording project required")?;
        let args=data.as_object().ok_or("Invalid native recording request")?;
        if args.len()!=3 || args.keys().any(|k|
            !["previewToken","projectDirectory","videoPreset"].contains(&k.as_str())) {
            return Err("Unexpected native recording parameters".into());
        }
        let preview_token=args.get("previewToken").and_then(Value::as_str)
            .filter(|v|v.len()==64 && v.bytes().all(|c|c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
            .ok_or("A valid approved preview is required")?.to_string();
        let project=args.get("projectDirectory").and_then(Value::as_str)
            .filter(|p|p.len()>2 && p.len()<=1024 && std::path::Path::new(p).is_absolute())
            .ok_or("Choose an existing absolute project folder")?;
        let project=fs::canonicalize(project)
            .map_err(|_| "Selected recording project is unavailable")?;
        let attributes=fs::symlink_metadata(&project)
            .map_err(|_| "Selected recording project is unavailable")?;
        if !attributes.is_dir() || attributes.file_type().is_symlink() {
            return Err("Recording requires a real local project folder".into());
        }
        let project=project.to_string_lossy().to_string();
        let preset=args.get("videoPreset").and_then(Value::as_str)
            .filter(|p|["compact","standard","detail"].contains(p))
            .ok_or("Invalid recording quality preset")?.to_string();
        if DESKTOP_LIVE_APPROVAL_OPEN.compare_exchange(false,true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst).is_err() {
            return Err("Another native approval is pending".into());
        }
        let _guard=DesktopLiveApprovalGuard;
        let response=core_request(Method::POST,"/api/desktop/cdp/recordings",
            Some(json!({"action":"native-preview","previewToken":preview_token}))).await?;
        let pinned=response.get("window").and_then(Value::as_object)
            .ok_or("Approved preview was not found")?;
        let pid=pinned.get("pid").and_then(Value::as_u64)
            .filter(|pid|*pid>0 && *pid<=u32::MAX as u64)
            .ok_or("Preview PID invalid")?;
        let native_id=pinned.get("nativeId").and_then(Value::as_str)
            .filter(|id|!id.is_empty() && id.len()<=256)
            .ok_or("Preview window ID invalid")?.to_string();
        let title=pinned.get("title").and_then(Value::as_str)
            .filter(|title|!title.is_empty()).ok_or("Preview title invalid")?.to_string();
        let application=pinned.get("application").and_then(Value::as_str)
            .filter(|app|!app.is_empty()).ok_or("Preview application invalid")?.to_string();
        let bounds=pinned.get("bounds").and_then(Value::as_object)
            .filter(|bounds|bounds.len()==4)
            .ok_or("Preview bounds invalid")?.clone();
        let clean=|s:&str|s.chars().filter(|c|!c.is_control()).take(95).collect::<String>();
        let prompt=format!(
            "RECORD PRIVATE APPLICATION WINDOW\n\n\
             Application: {}\nWindow: {}\nProcess: {}\n\
             Project: {}\nQuality: {}\n\n\
             The video can contain passwords, messages and private information. \
             Only this already-approved window will be recorded; no audio or input control. \
             Recording stops if its 5-minute preview permission expires or this window changes. \
             The MP4 is kept locally in the chosen project. Start recording?",
            clean(&application),clean(&title),pid,clean(&project),preset
        );
        let dialog_app=app.clone();
        let approved=tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
            dialog_app.dialog().message(prompt).title("Approve window recording")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Start recording".to_string(),"Cancel".to_string()))
                .blocking_show()
        }).await.map_err(|_| "Native recording approval dialog failed")?;
        if !approved {return Err("Native recording permission denied".into());}
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
            return Err("Tray was hidden during recording approval".into());
        }
        let challenge=core_request(Method::POST,"/api/desktop/cdp/recordings",
            Some(json!({"action":"native-challenge"}))).await?;
        let nonce=challenge.get("nonce").and_then(Value::as_str)
            .ok_or("Native recording challenge unavailable")?;
        let mut request=json!({
            "action":"start-native","projectDirectory":project,
            "previewToken":preview_token,"pid":pid,"nativeId":native_id,
            "expectedTitle":title,"expectedApplication":application,
            "expectedBounds":bounds,"videoPreset":preset,"consent":true
        });
        let proof=desktop_recording_native_approval_proof(nonce,&request)?;
        request["approvalProof"]=proof;
        let result=core_request(Method::POST,"/api/desktop/cdp/recordings",Some(request)).await?;
        let id=result.get("recordingId").and_then(Value::as_str)
            .ok_or("Recorder did not confirm recording identity")?;
        if result.get("status").and_then(Value::as_str)!=Some("recording") {
            return Err("Recorder did not verify an active recording".into());
        }
        return Ok(json!({"success":true,"recordingId":id,
            "status":"recording","projectDirectory":project,"videoPreset":preset}));
    }
    if !matches!(action.as_str(),"list" | "stop" | "open-video" | "open-folder" | "export-zip" | "delete") {
        return Err("Unsupported recording operation".into());
    }
    let data=payload.ok_or("Project selection required")?;
    let map=data.as_object().ok_or("Invalid recording manager payload")?;
    if map.keys().any(|key| key!="projectDirectory" && key!="recordingId") {
        return Err("Unexpected recording manager field".into());
    }
    let project=map.get("projectDirectory").and_then(Value::as_str)
        .filter(|p| !p.is_empty() && p.len()<=1024 && std::path::Path::new(p).is_absolute())
        .ok_or("Choose an absolute project folder")?;
    let id=map.get("recordingId").and_then(Value::as_str);
    if action=="list" && id.is_some() { return Err("Unexpected recording ID".into()); }
    if action!="list" {
        let bytes=id.ok_or("Exact recording ID required")?.as_bytes();
        if bytes.len()!=36 || !bytes.iter().enumerate().all(|(i,b)|{
            if [8,13,18,23].contains(&i) {*b==b'-'} else {b.is_ascii_hexdigit()}
        }) { return Err("Invalid recording UUID".into()); }
    }
    if action=="delete" {
        use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
        let dialog_app=app.clone();
        let approved=tauri::async_runtime::spawn_blocking(move || {
            // MessageDialogBuilder does not expose set_parent on Linux/macOS.
            // The IPC caller was already checked as the visible main Tray.
            dialog_app.dialog().message("Permanently delete this recording, video and logs?")
                .title("Delete recording")
                .buttons(MessageDialogButtons::OkCancel).blocking_show()
        }).await.map_err(|_| "Native deletion approval failed")?;
        if !approved { return Err("Recording deletion cancelled".into()); }
    }
    let core_action=match action.as_str() {
        "open-video"=>"video", "open-folder"=>"folder",other=>other,
    };
    let mut body=json!({"action":core_action,"projectDirectory":project});
    if let Some(id)=id { body["recordingId"]=json!(id); }
    if action=="delete" {body["confirmDelete"]=json!(true);}
    let response=core_request(Method::POST,"/api/desktop/cdp/recordings",Some(body)).await?;
    if action=="export-zip" {
        let file=response.get("path").and_then(Value::as_str)
            .ok_or("Core did not return a verified ZIP path")?;
        let selected=fs::canonicalize(file).map_err(|_| "ZIP export unavailable")?;
        let expected=fs::canonicalize(
            PathBuf::from(project).join(".superagent").join("recordings")
                .join("cdp").join(id.unwrap())
        ).map_err(|_| "Recording directory unavailable")?;
        if selected!=expected.join("recording.zip") {
            return Err("Native ZIP path verification failed".into());
        }
        #[cfg(target_os="windows")]
        let mut opener=Command::new("explorer.exe");
        #[cfg(target_os="macos")]
        let mut opener=Command::new("open");
        #[cfg(all(not(target_os="windows"),not(target_os="macos")))]
        let mut opener=Command::new("xdg-open");
        opener.arg(&expected).spawn().map_err(|_| "Cannot open local archive folder")?;
        return Ok(json!({"success":true,"exported":true,
            "bytes":response.get("bytes"),"entries":response.get("entries"),
            "sha256":response.get("sha256"),"folderOpened":true}));
    }
    if action=="open-video" || action=="open-folder" {
        let file=response.get("path").and_then(Value::as_str)
            .ok_or("Core did not verify an archive file")?;
        let selected=fs::canonicalize(file).map_err(|_| "Archive target is unavailable")?;
        let expected=fs::canonicalize(
            PathBuf::from(project).join(".superagent").join("recordings")
                .join("cdp").join(id.unwrap())
        ).map_err(|_| "Recording folder is unavailable")?;
        let permitted=if action=="open-video" {selected==expected.join("video.mp4")}
            else {selected==expected};
        if !permitted {return Err("Native archive path verification failed".into());}
        #[cfg(target_os="windows")]
        let mut opener=if action=="open-video" {
            let mut command=Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        } else { Command::new("explorer.exe") };
        #[cfg(target_os="macos")]
        let mut opener=Command::new("open");
        #[cfg(all(not(target_os="windows"),not(target_os="macos")))]
        let mut opener=Command::new("xdg-open");
        opener.arg(&selected).spawn().map_err(|_| "Could not launch the local viewer")?;
        return Ok(json!({"success":true,"launchRequested":true}));
    }
    Ok(response)
}

#[tauri::command]
async fn desktop_live_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    // Native approval cannot be bypassed by changing a JavaScript consent flag.
    // All IPC actions originate in the actual installed main Tray window.
    if window.label() != "main" {
        return Err("Desktop Live is restricted to the main native Tray".into());
    }
    if !matches!(action.as_str(), "stop" | "remote-stop") &&
       (!window.is_visible().unwrap_or(false) ||
        window.is_minimized().unwrap_or(true)) {
        return Err("Desktop Live is not available from a hidden Tray window".into());
    }
    // Native Tray to authenticated local Core only. Never proxy arbitrary routes,
    // accept model-selected commands, or expose Core bearer to the WebView.
    match action.as_str() {
        // These requests carry no viewer credentials, private key material,
        // socket configuration, or local preview bearer into WebView JavaScript.
        "inventory" => {
            if payload.is_some() { return Err("Unexpected inventory payload".into()); }
            core_request(Method::GET, "/api/desktop/live/manage", None).await
        }
        "stop-handle" => {
            let data = payload.ok_or("Missing exact session handle")?;
            let body = data.as_object().ok_or("Invalid stop request")?;
            if body.len() < 1 || body.len() > 3 ||
               body.keys().any(|key| !["id","expectedRevision","confirmProfile"].contains(&key.as_str())) {
                return Err("Unexpected stop field".into());
            }
            let id = body.get("id").and_then(Value::as_str).ok_or("Exact session handle required")?;
            if id.len() > 210 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:.".contains(&b)) ||
               !["native:", "managed:", "delegate:", "profile:", "lan:"].iter().any(|prefix| id.starts_with(prefix)) {
                return Err("Invalid exact session handle".into());
            }
            if let Some(revision) = body.get("expectedRevision") {
                if revision.as_u64().is_none() { return Err("Invalid CDP revision".into()); }
            }
            if let Some(confirm) = body.get("confirmProfile") {
                if !confirm.is_boolean() { return Err("Invalid profile confirmation".into()); }
            }
            core_request(Method::POST, "/api/desktop/live/manage/stop", Some(data)).await
        }
        "password-status" => {
            if payload.is_some() { return Err("Unexpected password status payload".into()); }
            core_request(Method::GET, "/api/desktop/tray-password/status", None).await
        }
        "password-set" => {
            let data = payload.ok_or("Missing password update")?;
            let body = data.as_object().ok_or("Invalid password payload")?;
            if body.is_empty() || body.len() > 2 ||
               body.keys().any(|key| !["newPassword","currentPassword"].contains(&key.as_str())) {
                return Err("Unexpected password field".into());
            }
            let password = body.get("newPassword").and_then(Value::as_str).ok_or("New password required")?;
            if !(12..=128).contains(&password.len()) || password.bytes().any(|b| b.is_ascii_control()) {
                return Err("New password must have 12-128 printable characters".into());
            }
            if let Some(prior) = body.get("currentPassword") {
                if !prior.is_string() { return Err("Invalid current password".into()); }
            }
            core_request(Method::POST, "/api/desktop/tray-password/set", Some(data)).await
        }
        "gateway-status" => {
            if payload.is_some() { return Err("Unexpected remote gateway status payload".into()); }
            core_request(Method::GET, "/api/desktop/tray-remote/status", None).await
        }
        "gateway-start" => {
            let data = payload.ok_or("Missing remote Tray origin settings")?;
            let body = data.as_object().ok_or("Invalid remote Tray origin request")?;
            if body.len()!=2 || body.keys().any(|k| !["publicOrigin","originPort"].contains(&k.as_str())) {
                return Err("Unexpected remote Tray origin fields".into());
            }
            let origin = body.get("publicOrigin").and_then(Value::as_str)
                .ok_or("Public HTTPS origin required")?;
            let url = reqwest::Url::parse(origin).map_err(|_| "Invalid remote origin")?;
            if url.scheme()!="https" || url.origin().ascii_serialization()!=origin ||
               url.username()!="" || url.password().is_some() ||
               url.path()!="/" || url.query().is_some() || url.fragment().is_some() ||
               url.port().is_some() || url.host_str().map(|h| h.contains('.'))!=Some(true) ||
               origin.len()>254 {
                return Err("Dedicated HTTPS hostname required".into());
            }
            let port=body.get("originPort").and_then(Value::as_u64).ok_or("Origin port required")?;
            if !(1024..=65535).contains(&port) ||
                [7888,9227,6759,6789,9877,17341,19320,19321].contains(&port) {
                return Err("Use a dedicated unprotected remote Tray origin port".into());
            }
            core_request(Method::POST, "/api/desktop/tray-remote/start", Some(data)).await
        }
        "gateway-start-quick" => {
            let data = payload.ok_or("Missing Quick Tunnel origin port")?;
            let body = data.as_object().ok_or("Invalid Quick Tunnel request")?;
            if body.len()!=1 || body.keys().any(|k| k!="originPort") {
                return Err("Quick Tunnel accepts only the dedicated origin port".into());
            }
            let port=body.get("originPort").and_then(Value::as_u64)
                .ok_or("Origin port required")?;
            if !(1024..=65535).contains(&port) ||
                [7888,9227,6759,6789,9877,17341,19320,19321].contains(&port) {
                return Err("Quick Tunnel requires a dedicated unprotected port".into());
            }
            // Never accept a hostname, shell command, executable path or MCP tunnel PID.
            core_request(Method::POST, "/api/desktop/tray-remote/start-quick", Some(data)).await
        }
        "gateway-stop" => {
            if payload.is_some() { return Err("Unexpected remote gateway stop payload".into()); }
            core_request(Method::POST, "/api/desktop/tray-remote/stop", Some(json!({}))).await
        }
        "controller-review" => {
            if payload.is_some() {
                return Err("Controller review accepts no viewer or browser payload".into());
            }
            if DESKTOP_LIVE_APPROVAL_OPEN.compare_exchange(
                false, true, std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ).is_err() {
                return Err("Another native Desktop Live review is pending".into());
            }
            let _approval_guard = DesktopLiveApprovalGuard;
            // The dialog explains the separate authorization boundary. It is
            // NOT itself a controller approval and never grants input.
            let native = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                use tauri_plugin_dialog::DialogExt;
                native.dialog().message(concat!(
                    "DESKTOP LIVE — REMOTE CONTROLLER\n\n",
                    "Watching a window does not authorize mouse or keyboard input.\n",
                    "Native remote control is not configured for this installed Tray.\n",
                    "A separate authenticated viewer identity, attended native input ",
                    "approval, and a verified semantic input adapter are required.\n\n",
                    "No control token will be issued. ",
                    "Use Take Over for physical control at the host, or the separately ",
                    "approved LAN Devices workflow for Android input."
                )).blocking_show();
            }).await.map_err(|_| "Native controller review could not complete")?;
            Ok(json!({
                "success": true,
                "state": "NOT_CONFIGURED",
                "approved": false,
                "inputEnabled": false,
            }))
        }
        "remote-status" => {
            if payload.is_some() { return Err("Unexpected remote readiness payload".into()); }
            core_request(Method::GET, "/api/desktop/live/remote/status", None).await
        }
        "remote-stop" => {
            if payload.is_some() { return Err("Unexpected remote stop payload".into()); }
            core_request(Method::POST, "/api/desktop/live/remote/stop", Some(json!({}))).await
        }
        "remote-review" => {
            if payload.is_some() { return Err("Remote review does not accept a browser-selected identity".into()); }
            if DESKTOP_LIVE_APPROVAL_OPEN.compare_exchange(
                false, true, std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ).is_err() {
                return Err("Another native Desktop Live dialog is pending".into());
            }
            let _approval_guard = DesktopLiveApprovalGuard;
            let status = core_request(Method::GET, "/api/desktop/live/remote/status", None).await?;
            // No separate mTLS host listener/certificate provisioning exists in
            // this build. Never convert a browser boolean into remote permission.
            if status.get("state").and_then(Value::as_str) != Some("NOT_CONFIGURED") ||
               status.get("approvalAvailable").and_then(Value::as_bool) != Some(false) ||
               status.get("viewerCertificateSha256") != Some(&Value::Null) {
                return Err("Unverifiable private viewer readiness — access denied".into());
            }
            let prompt = concat!(
                "PRIVATE REMOTE VIEWER — NOT CONFIGURED\n\n",
                "No independently verified mTLS 1.3 private listener, pinned viewer ",
                "certificate fingerprint, or secure viewer credential handoff exists.\n\n",
                "Local window-preview approval NEVER grants remote viewing. ",
                "Remote mouse and keyboard input would require a separate native approval. ",
                "No remote session will be opened."
            );
            let native = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                use tauri_plugin_dialog::DialogExt;
                native.dialog().message(prompt).blocking_show();
            }).await.map_err(|_| "Native private-viewer review could not complete")?;
            Ok(json!({"success":true,"state":"NOT_CONFIGURED","approved":false}))
        }
        "windows" => {
            if payload.is_some() { return Err("Unexpected discovery payload".into()); }
            core_request(Method::GET, "/api/desktop/live/windows", None).await
        }
        "start" => {
            let data = payload.ok_or("Missing explicit window consent")?;
            let obj = data.as_object().ok_or("Invalid window selection")?;
            if obj.len() != 3 || obj.keys().any(|key|
                !["pid", "nativeId", "consent"].contains(&key.as_str())) {
                return Err("Unexpected window selection fields".into());
            }
            let pid = obj.get("pid").and_then(Value::as_u64).ok_or("Window PID required")?;
            let native_id = obj.get("nativeId").and_then(Value::as_str).ok_or("Native window ID required")?;
            if pid == 0 || pid > u32::MAX as u64 || native_id.is_empty() || native_id.len() > 256 ||
                native_id.chars().any(char::is_control) || obj.get("consent").and_then(Value::as_bool) != Some(true) {
                return Err("Preview requires explicit consent for a verified native window".into());
            }
            if DESKTOP_LIVE_APPROVAL_OPEN.compare_exchange(
                false, true, std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ).is_err() {
                return Err("Another native Desktop Live approval is pending".into());
            }
            let _approval_guard = DesktopLiveApprovalGuard;
            // Source metadata comes from the authenticated Core's fresh OS
            // discovery, not untrusted window names supplied by the WebView.
            let inventory = core_request(Method::GET, "/api/desktop/live/windows", None).await?;
            let windows = inventory.get("windows").and_then(Value::as_array)
                .ok_or("Native window inventory could not be verified")?;
            let matches: Vec<_> = windows.iter().filter(|item|
                item.get("pid").and_then(Value::as_u64) == Some(pid) &&
                item.get("nativeId").and_then(Value::as_str) == Some(native_id)
            ).collect();
            if matches.len() != 1 { return Err("Selected native window is no longer available".into()); }
            let target = matches[0];
            let sanitized = |field: &str| target.get(field).and_then(Value::as_str)
                .unwrap_or("Unknown").chars().filter(|ch| !ch.is_control())
                .take(110).collect::<String>();
            let prompt = format!(
                "Allow a PRIVATE, READ-ONLY preview of this exact application window?\n\n\
                 Application: {}\nTitle: {}\nProcess: {}\n\n\
                 The screenshot may contain private information. Only the local Tray will display it. \
                 No mouse or keyboard access is granted. The session expires after five minutes.",
                sanitized("application"), sanitized("title"), pid,
            );
            let native = app.clone();
            let approved = tauri::async_runtime::spawn_blocking(move || {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                native.dialog().message(prompt).buttons(
                    MessageDialogButtons::OkCancelCustom(
                        "Allow preview".to_string(), "Deny".to_string(),
                    )
                ).blocking_show()
            }).await.map_err(|_| "Native Desktop Live approval did not complete")?;
            if !approved {
                return Err("Native Desktop Live permission was denied".into());
            }
            if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
                return Err("Tray was hidden before approval completed".into());
            }
            // Pin the exact name, application and bounds that appeared in the
            // OS approval. The Core refuses if navigation, resize or reuse
            // changed that window while the native dialog was visible.
            let mut approved_payload = data;
            let approved_obj = approved_payload.as_object_mut()
                .ok_or("Approved native window payload unavailable")?;
            for (key, native_key) in [
                ("expectedTitle", "title"),
                ("expectedApplication", "application"),
                ("expectedBounds", "bounds"),
            ] {
                let native_value = target.get(native_key).ok_or("Native approval target missing")?;
                approved_obj.insert(key.to_string(), native_value.clone());
            }
            // A bearer credential and JavaScript consent flag alone cannot
            // forge native approval. The Core tracks a one-use, 30s challenge.
            let challenge = core_request(Method::POST, "/api/desktop/live/challenge",
                Some(json!({}))).await?;
            let nonce = challenge.get("nonce").and_then(Value::as_str)
                .ok_or("Native approval challenge is unavailable")?;
            let proof = desktop_live_native_approval_proof(nonce, &approved_payload)?;
            approved_payload.as_object_mut().ok_or("Invalid approved window payload")?
                .insert("approvalProof".to_string(), proof);
            core_request(Method::POST, "/api/desktop/live/start", Some(approved_payload)).await
        }
        "frame" | "stop" => {
            let data = payload.ok_or("Missing preview capability")?;
            let obj = data.as_object().ok_or("Invalid preview capability")?;
            let allowed: &[&str] = if action == "frame" {
                &["token", "codec", "knownHash", "maxWidth", "quality"]
            } else { &["token"] };
            if obj.is_empty() || obj.len() > allowed.len() ||
                obj.keys().any(|key| !allowed.contains(&key.as_str())) ||
                !obj.contains_key("token") {
                return Err("Unexpected preview capability field".into());
            }
            let token = obj.get("token").and_then(Value::as_str).ok_or("Preview capability required")?;
            if token.len() != 64 || !token.bytes().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()) {
                return Err("Invalid preview capability".into());
            }
            if action == "frame" {
                let jpeg = match obj.get("codec") {
                    None => false,
                    Some(Value::String(name)) if name == "png" => false,
                    Some(Value::String(name)) if name == "jpeg" => true,
                    _ => return Err("Unsupported native preview codec".into()),
                };
                if let Some(hash) = obj.get("knownHash") {
                    let hash = hash.as_str().ok_or("Invalid preview hash")?;
                    if hash.len() != 64 || !hash.bytes().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()) {
                        return Err("Invalid preview hash".into());
                    }
                }
                if obj.contains_key("maxWidth") || obj.contains_key("quality") {
                    if !jpeg { return Err("JPEG settings require the JPEG codec".into()); }
                }
                if let Some(width) = obj.get("maxWidth") {
                    let n = width.as_u64().ok_or("Invalid preview width")?;
                    if !(320..=1920).contains(&n) { return Err("Invalid preview width".into()); }
                }
                if let Some(quality) = obj.get("quality") {
                    let n = quality.as_u64().ok_or("Invalid preview quality")?;
                    if !(40..=85).contains(&n) { return Err("Invalid preview quality".into()); }
                }
            }
            let path = if action == "frame" { "/api/desktop/live/frame" }
                       else { "/api/desktop/live/stop" };
            core_request(Method::POST, path, Some(data)).await
        }
        _ => Err("Unsupported desktop live action".into()),
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
async fn control_terminal_task(task_id: String, action: String) -> Result<Value, String> {
    if !matches!(action.as_str(), "start" | "pause" | "resume") {
        return Err("Invalid terminal control action".into());
    }
    if !task_id.starts_with("term-bg-") || task_id.len() != 15 ||
        !task_id[8..].chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return Err("Invalid Tray terminal task ID".into());
    }
    core_request(
        Method::POST,
        "/api/desktop/terminal/control",
        Some(json!({ "taskId": task_id, "action": action })),
    )
    .await
}

#[tauri::command]
async fn external_terminal_task_action(
    task_id: String,
    action: String,
    command: Option<String>,
    cwd: Option<String>,
    operation_id: Option<String>,
) -> Result<Value, String> {
    if !matches!(action.as_str(), "configure" | "plan-stop" | "stop" | "start") ||
        !task_id.starts_with("external-win-") ||
        task_id.len() > 23 || !task_id[13..].chars().all(|c| c.is_ascii_digit()) ||
        task_id[13..].is_empty() {
        return Err("Invalid external process action".into());
    }
    if command.as_ref().is_some_and(|s| s.len() > 2048) ||
        cwd.as_ref().is_some_and(|s| s.len() > 600) ||
        operation_id.as_ref().is_some_and(|s| s.len() > 64) {
        return Err("External process action payload is too large".into());
    }
    core_request(
        Method::POST,
        "/api/desktop/terminal/external",
        Some(json!({
            "taskId": task_id, "action": action, "command": command,
            "cwd": cwd, "operationId": operation_id
        })),
    ).await
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
            // Prefer running bundled bun directly with standalone cli.js to avoid extra wrapper processes
            let adjacent_bun = exe_dir.join(if cfg!(windows) { "bun.exe" } else { "bun" });
            let standalone_cli = exe_dir.join("standalone").join("dist").join("cli.js");
            if adjacent_bun.exists() && standalone_cli.exists() {
                return Ok((adjacent_bun, vec![standalone_cli.to_string_lossy().to_string()]));
            }
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
    let dir = config_dir()?;
    if core_startup::preflight(&dir, port).await? { return Ok(0); }

    let (exe, extra_args) = find_superagent_executable()?;
    let mut cmd = Command::new(&exe);
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.arg("core")
       .arg("boot")
       .arg("--port")
       .arg(port.to_string())
       .arg("--client-mode")
       .arg("tline");

    if let Ok(cwd) = std::env::current_dir() {
        let is_tray_bin = cwd.to_string_lossy().contains("tray-releases");
        if !is_tray_bin {
            cmd.current_dir(cwd);
        } else if let Some(home) = dirs::home_dir() {
            cmd.current_dir(home);
        }
    } else if let Some(home) = dirs::home_dir() {
        cmd.current_dir(home);
    }

    let log_file = config_dir().ok().map(|d| d.join("superagent-server.log"));
    if let Some(ref path) = log_file {
        if let Ok(out_f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            if let Ok(err_f) = out_f.try_clone() {
                cmd.stdout(std::process::Stdio::from(out_f));
                cmd.stderr(std::process::Stdio::from(err_f));
            } else {
                cmd.stdout(std::process::Stdio::from(out_f));
                cmd.stderr(std::process::Stdio::null());
            }
        } else {
            cmd.stdout(std::process::Stdio::null());
            cmd.stderr(std::process::Stdio::null());
        }
    } else {
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
    }
    cmd.stdin(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn SuperAgent server: {}", e))?;
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Ok(owner_pid) = core_startup::verified_owner(&dir, port).await {
            if core_startup::launched_owner(owner_pid, pid).await? { return Ok(owner_pid); }
            if child.try_wait().map_err(|_| "Core bootstrap process status unavailable")?
                .is_some_and(|status| status.success()) { return Ok(0); }
        }
        if child.try_wait().map_err(|_| "Core bootstrap process status unavailable")?.is_some() {
            return Err(format!("Core bootstrap exited before authenticated readiness on port {}. Inspect the local Core log; recovery evidence was preserved.", port));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err(format!(
        "Core startup on port {} did not reach authenticated readiness within 30s. Outcome is uncertain; inspect Runtime Detection before retrying. No process was stopped or recovery evidence removed.", port
    ))
}

async fn stop_core_server_inner(target: u16) -> Result<Value, String> {
    Err(format!("Core Stop on port {} requires an explicit verified drain/manual shutdown. Use generation-preserving Restart for maintenance. No process was stopped or recovery evidence removed.", target))
}

#[tauri::command]
async fn start_core_server(app: tauri::AppHandle, port: Option<u16>) -> Result<Value, String> {
    let target = port.unwrap_or(7888);
    match launch_server_process(target).await {
        Ok(pid) => {
            let already_running = pid == 0;
            let message = if already_running {
                "SuperAgent Core server is already running".to_string()
            } else {
                format!("SuperAgent Core server started on port {}", target)
            };
            record_core_notification(&app, "info", "Core started", "The selected Core server was started or is already active.");
            Ok(json!({
                "success": true,
                "port": target,
                "pid": pid,
                "alreadyRunning": already_running,
                "message": message
            }))
        }
        Err(e) => {
            record_core_notification(&app, "critical", "Core start failed", "Core could not start. Review Runtime Detection.");
            Err(e)
        }
    }
}

#[tauri::command]
async fn stop_core_server(app: tauri::AppHandle, port: Option<u16>) -> Result<Value, String> {
    let target = port.unwrap_or(7888);
    match stop_core_server_inner(target).await {
        Ok(val) => {
            let msg = val.get("message").and_then(Value::as_str).unwrap_or("Core server stopped");
            // Do not copy untrusted Core HTTP text into a desktop banner.
            let _ = msg;
            record_core_notification(&app, "warning", "Core stopped", "The selected Core server was stopped.");
            Ok(val)
        }
        Err(e) => {
            record_core_notification(&app, "critical", "Core stop failed", "Core shutdown did not complete. Inspect the verified owner state.");
            Err(e)
        }
    }
}

#[tauri::command]
async fn restart_core_server(app: tauri::AppHandle, port: Option<u16>) -> Result<Value, String> {
    let target = port.unwrap_or(7888);
    let dir = config_dir()?;
    let result = async {
        let pid = core_startup::verified_owner(&dir, target).await?;
        runtime_control::control(&dir, "core-supervisor", "restart", target, pid).await
    }.await;
    match result {
        Ok(value) => {
            record_core_notification(&app, "info", "Core restarted", "The selected Core server was restarted.");
            Ok(value)
        }
        Err(e) => {
            record_core_notification(&app, "critical", "Core restart failed", "Core restart failed. Inspect Runtime Detection.");
            Err(e)
        }
    }
}

#[tauri::command]
async fn get_core_version() -> Result<Value, String> {
    match core_request(Method::GET, "/api/status", None).await {
        Ok(val) => {
            let version = val.get("version").and_then(Value::as_str).unwrap_or("unknown");
            Ok(json!({
                "online": true,
                "version": version,
                "port": val.get("port"),
                "raw": val
            }))
        }
        Err(e) => {
            Ok(json!({
                "online": false,
                "version": null,
                "error": e
            }))
        }
    }
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

#[tauri::command]
fn get_yolo_mode() -> Result<String, String> {
    let dir = config_dir()?;
    let path = dir.join("yolo-mode.json");
    if !path.exists() {
        return Ok("off".to_string());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let mode = parsed.get("mode").and_then(|m| m.as_str()).unwrap_or("off");
    if mode == "full" || mode == "scoped" {
        Ok(mode.to_string())
    } else {
        Ok("off".to_string())
    }
}

#[tauri::command]
fn set_yolo_mode(mode: String) -> Result<String, String> {
    if mode != "off" && mode != "scoped" && mode != "full" {
        return Err("Invalid YOLO mode. Allowed: off, scoped, full".into());
    }
    let dir = config_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let state = json!({
        "mode": mode,
        "updatedAt": now,
        "source": "superagent-tray"
    });
    let path = dir.join("yolo-mode.json");
    fs::write(&path, serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(mode)
}

/// Native operator-only Managed CDP launch, status and exact-owner stop.
#[tauri::command]
async fn managed_chrome_action(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "main" || !window.is_visible().unwrap_or(false) ||
        window.is_minimized().unwrap_or(true) {
        return Err("MANAGED_CDP_NATIVE_TRAY_REQUIRED".into());
    }
    let input = payload.unwrap_or_else(|| json!({}));
    let object = input.as_object().ok_or("MANAGED_CDP_INVALID_REQUEST")?;
    let allowed: &[&str] = match action.as_str() {
        "status" => &["port"],
        "launch" => &["port", "mode", "url"],
        "stop" => &["port", "expectedPid", "recordId"],
        _ => return Err("MANAGED_CDP_UNKNOWN_ACTION".into()),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("MANAGED_CDP_UNEXPECTED_FIELD".into());
    }
    let port = match object.get("port") {
        None => 9222,
        Some(value) => value.as_u64().ok_or("MANAGED_CDP_INVALID_PORT")?,
    };
    if !(1024..=65535).contains(&port) {
        return Err("MANAGED_CDP_INVALID_PORT".into());
    }
    let mut body = json!({"action":action,"port":port});
    if action == "launch" {
        let mode = object.get("mode").and_then(Value::as_str).unwrap_or("headed");
        if !["auto","headed","headless"].contains(&mode) {
            return Err("MANAGED_CDP_INVALID_MODE".into());
        }
        let url = object.get("url").and_then(Value::as_str).unwrap_or("about:blank");
        if url.len() > 2048 || url.chars().any(|c| c.is_control()) {
            return Err("MANAGED_CDP_INVALID_URL".into());
        }
        if url != "about:blank" {
            let parsed = reqwest::Url::parse(url).map_err(|_| "MANAGED_CDP_INVALID_URL")?;
            if !["http","https"].contains(&parsed.scheme()) ||
                !parsed.username().is_empty() || parsed.password().is_some() {
                return Err("MANAGED_CDP_INVALID_URL".into());
            }
        }
        body["mode"] = json!(mode);
        body["url"] = json!(url);
    } else if action == "stop" {
        let pid = object.get("expectedPid").and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .ok_or("MANAGED_CDP_STOP_IDENTITY_REQUIRED")?;
        let record_id = object.get("recordId").and_then(Value::as_str)
            .filter(|id| (6..=180).contains(&id.len()) &&
                id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b)))
            .ok_or("MANAGED_CDP_STOP_IDENTITY_REQUIRED")?;
        body["expectedPid"] = json!(pid);
        body["recordId"] = json!(record_id);
    }
    if action != "status" {
        if !window.is_focused().unwrap_or(false) {
            return Err("MANAGED_CDP_FOCUSED_TRAY_REQUIRED".into());
        }
        let description = if action == "launch" {
            format!("Launch isolated Chrome CDP on 127.0.0.1:{port}?\n\nMode: {}\nURL: {}\n\nYour personal Chrome windows will not be touched.",
                body["mode"].as_str().unwrap_or("headed"), body["url"].as_str().unwrap_or("about:blank"))
        } else {
            format!("Stop only SuperAgent-owned Chrome CDP on port {port}?\n\nVerified PID: {}\n\nOther Chrome windows will not be touched.",
                body["expectedPid"])
        };
        let dialog_app = app.clone();
        let approved = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            dialog_app.dialog().message(description).buttons(
                MessageDialogButtons::OkCancelCustom(
                    "Approve action".into(), "Cancel".into()
                )
            ).blocking_show()
        }).await.map_err(|_| "MANAGED_CDP_NATIVE_DIALOG_FAILED")?;
        if !approved { return Err("MANAGED_CDP_OPERATOR_CANCELLED".into()); }
        if !window.is_visible().unwrap_or(false) ||
            window.is_minimized().unwrap_or(true) ||
            !window.is_focused().unwrap_or(false) {
            return Err("MANAGED_CDP_TRAY_FOCUS_LOST".into());
        }
        body["confirm"] = json!(true);
    }
    core_request(Method::POST, "/api/desktop/chrome-runtime", Some(body)).await
}

/// Only passive notification inventory GETs receive the longer read deadline.
fn notification_read_timeout(path: &str) -> Option<Duration> {
    match path {
        "/api/desktop/access/requests" |
        "/api/daemon/jobs" |
        "/api/daemon/runs?limit=100" => Some(Duration::from_secs(12)),
        _ => None,
    }
}

/// Limits repeated diagnostics without hiding transitions or changing polling.
/// Failed inventories must never resolve existing Security incidents.
#[derive(Default)]
struct ProjectionLogState {
    last_error: Option<String>,
    last_reported_at: Option<Instant>,
}

impl ProjectionLogState {
    fn should_report(&mut self, error: Option<&str>, now: Instant) -> bool {
        match error {
            Some(error) => {
                let changed = self.last_error.as_deref() != Some(error);
                let due = self.last_reported_at
                    .is_none_or(|last| now.duration_since(last) >= Duration::from_secs(300));
                self.last_error = Some(error.to_owned());
                if changed || due {
                    self.last_reported_at = Some(now);
                    true
                } else {
                    false
                }
            }
            None => {
                let recovered = self.last_error.take().is_some();
                self.last_reported_at = None;
                recovered
            }
        }
    }

    fn report<T>(&mut self, label: &str, result: &Result<T, String>) {
        let error = result.as_ref().err().map(String::as_str);
        if self.should_report(error, Instant::now()) {
            if let Some(error) = error {
                eprintln!("[tray] {label} unavailable: {error}");
            } else {
                eprintln!("[tray] {label} recovered");
            }
        }
    }
}

async fn core_request(method: Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    // path comes from the fixed match below, never from the webview.
    let info = server_info()?;
    let url = format!("http://127.0.0.1:{}{}", info.port, path);
    let projection_read = method == Method::GET && notification_read_timeout(path).is_some();
    let core_port = info.port;
    let request_timeout = if path.starts_with("/api/desktop/cdp/live") {
        Duration::from_secs(14)
    } else if path == "/api/desktop/cdp/recordings" {
        // Recording start requires OS-verified capture and FFmpeg readiness;
        // finalize waits for the encoder; ZIP may copy 175 MB of local data.
        // Never retry these operations after an ambiguous timeout.
        match body.as_ref().and_then(|b|b.get("action")).and_then(Value::as_str) {
            Some("start-native") => Duration::from_secs(42),
            Some("stop") => Duration::from_secs(28),
            Some("export-zip") => Duration::from_secs(95),
            _ => Duration::from_secs(12),
        }
    } else if path == "/api/desktop/live/frame" {
        // Platform-native window discovery/capture may require several
        // bounded OS subprocesses. A timeout is never automatically retried.
        Duration::from_secs(36)
    } else if path == "/api/desktop/live/windows" || path == "/api/desktop/live/start" {
        Duration::from_secs(22)
    } else if path == "/api/desktop/regenerate-token" {
        // Local clipboard helper may require a short PowerShell invocation.
        Duration::from_secs(15)
    } else if path == "/api/desktop/chrome-runtime" {
        // Chrome launch waits up to 15 seconds for DevTools readiness.
        // A timed-out mutation must be checked via status, never replayed.
        if body.as_ref().and_then(|b| b.get("action")).and_then(Value::as_str) == Some("launch") {
            Duration::from_secs(30)
        } else if body.as_ref().and_then(|b| b.get("action")).and_then(Value::as_str) == Some("stop") {
            Duration::from_secs(18)
        } else {
            Duration::from_secs(6)
        }
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
    } else if path == "/api/desktop/lan-support" {
        // Pairing / session approval is a physical action at the target console.
        // Avoid replaying ambiguous requests when the owner is slow to approve.
        match body.as_ref().and_then(|b| b.get("action")).and_then(Value::as_str) {
            Some("pair" | "open" | "file_offer" | "terminal_start" | "terminal_input" | "terminal_fleet_open" | "terminal_fleet_start" | "terminal_fleet_input" | "terminal_fleet_key") => Duration::from_secs(125),
            // HTTPS quick tunnel provisioning may take 30s, followed by public readiness checks.
            // A slow QR operation must not be mistaken for an unreachable Core.
            Some("tunnel_invite" | "apk_download_qr") => Duration::from_secs(75),
            Some("file_put" | "file_get" | "file_finish" | "file_abort") => Duration::from_secs(18),
            Some("terminal_read" | "terminal_stop" | "terminal_fleet_read" | "terminal_fleet_resize" | "terminal_fleet_stop" | "terminal_fleet_close") => Duration::from_secs(15),
            Some("exec") if body.as_ref().and_then(|b| b.get("command"))
                .and_then(Value::as_str).is_some_and(|command|
                    command.starts_with("android.action.")) => Duration::from_secs(120),
            Some("exec") => Duration::from_secs(50),
            Some("screen" | "input" | "schema" | "element") => Duration::from_secs(12),
            Some("discover") => Duration::from_secs(8),
            _ => Duration::from_secs(15),
        }
    } else if path == "/api/desktop/terminal/external" {
        // External stop requires CIM birth verification and a second guarded
        // PowerShell operation. Never retry a timeout automatically.
        Duration::from_secs(30)
    } else if path == "/api/desktop/terminal/control" {
        // Windows suspends/resumes a verified owned process tree through a
        // bounded PowerShell/CIM probe; 4 seconds can report a false timeout.
        // Never automatically retry a timed-out non-idempotent lifecycle call.
        Duration::from_secs(25)
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
    } else if method == Method::GET && notification_read_timeout(path).is_some() {
        notification_read_timeout(path).unwrap_or(Duration::from_secs(4))
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
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            if projection_read {
                format!("Core notification inventory GET {path} on loopback port {core_port} timed out after {}s; previous notification state is preserved", request_timeout.as_secs())
            } else {
                "SuperAgent Core request timed out. The operation may have completed; check its status before retrying.".to_string()
            }
        } else if error.is_connect() {
            "SuperAgent Core is unreachable at the configured loopback port".to_string()
        } else {
            "SuperAgent Core request failed before receiving a response".to_string()
        }
    })?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| "SuperAgent Core returned invalid JSON".to_string())?;
    if !status.is_success() || value.get("success") == Some(&Value::Bool(false)) {
        let msg = (if path == "/api/desktop/access/projects/mutate" {
            value.get("code").or_else(|| value.get("error"))
        } else {
            value.get("error")
        })
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

// Separate local proof for project metadata mutation. The Core bearer is
// insufficient: each operation is bound to a one-use 30s nonce and a key
// never exposed to WebView JavaScript. Same-user malware remains outside
// this key-file boundary until platform-native IPC attestation is available.
async fn signed_project_operator_mutation(payload: Value) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    let challenge = core_request(Method::GET, "/api/desktop/access/projects/challenge", None).await?;
    let nonce = challenge.get("nonce").and_then(Value::as_str)
        .ok_or("Project operator challenge unavailable")?;
    if nonce.len() != 48 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid operator challenge".into());
    }
    let file = config_dir()?.join(".mcp-project-operator.key");
    let metadata = fs::symlink_metadata(&file).map_err(|_| "Operator proof key unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() < 64 || metadata.len() > 80 {
        return Err("Operator proof key invalid".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Operator proof key permissions invalid".into());
        }
    }
    let raw_key = fs::read_to_string(&file).map_err(|_| "Operator proof key unreadable")?;
    let raw_key = raw_key.trim();
    if raw_key.len() != 64 || !raw_key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Operator proof key malformed".into());
    }
    let mut key = [0u8; 32];
    for (index, cell) in key.iter_mut().enumerate() {
        *cell = u8::from_str_radix(&raw_key[index * 2..index * 2 + 2], 16)
            .map_err(|_| "Operator proof key invalid hex")?;
    }
    let payload_text = serde_json::to_string(&payload).map_err(|_| "Invalid project payload")?;
    if payload_text.len() > 7500 { return Err("Project payload too large".into()); }
    let message = format!("superagent-project-operator-v1:{}:{}", nonce, payload_text);
    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for (i, byte) in key.iter().enumerate() {
        inner_pad[i] ^= byte;
        outer_pad[i] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message.as_bytes());
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    let mac: String = outer.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    core_request(Method::POST, "/api/desktop/access/projects/mutate",
        Some(json!({"payloadText": payload_text, "proof": {"nonce": nonce, "mac": mac}}))).await
}

// Fixed-shape native bridge for the MCP Security Approval Manager.
// Only the installed, focused Tray window can issue grants or revoke access;
// the Core bearer token stays in Rust, never in WebView JavaScript.
#[tauri::command]
async fn mcp_project_access_action(
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("MCP project access is available only in the native main Tray window".into());
    }
    let mutating = matches!(action.as_str(), "approve" | "deny" | "revoke" | "direct_grant" | "register_project" | "update_project" | "remove_project");
    if mutating
        && (!window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(true)
            || !window.is_focused().unwrap_or(false))
    {
        return Err("Bring the native SuperAgent Tray to the foreground to approve project access".into());
    }

    let data = payload.unwrap_or_else(|| json!({}));
    if !data.is_object() {
        return Err("Invalid MCP project access payload".into());
    }
    let text_field = |name: &str, max: usize| -> Result<String, String> {
        let value = data.get(name).and_then(Value::as_str)
            .ok_or_else(|| format!("Missing {}", name))?;
        if value.is_empty() || value.len() > max || value.trim() != value
            || value.chars().any(|c| c.is_control()) {
            return Err(format!("Invalid {}", name));
        }
        Ok(value.to_string())
    };
    let checked_capabilities = || -> Result<Vec<String>, String> {
        let caps = data.get("capabilities").and_then(Value::as_array)
            .ok_or_else(|| "Capabilities must be an array".to_string())?;
        if caps.is_empty() || caps.len() > 7 {
            return Err("Invalid capabilities".into());
        }
        let mut values: Vec<String> = Vec::new();
        for cap in caps {
            let value = cap.as_str().ok_or_else(|| "Invalid capability".to_string())?;
            if !["read", "write", "execute", "git", "worktree", "planning", "chain"]
                .contains(&value) || values.iter().any(|existing| existing.as_str() == value) {
                return Err("Invalid or duplicate capability".into());
            }
            values.push(value.to_string());
        }
        Ok(values)
    };
    let project_mutation = || -> Result<Value, String> {
        let allowed: &[&str] = match action.as_str() {
            "register_project" => &["id", "name", "type", "root", "target", "description"],
            "update_project" => &["projectId", "expectedUpdatedAt", "name", "root", "target", "description", "enabled"],
            "remove_project" => &["projectId", "expectedUpdatedAt"],
            _ => return Err("Unsupported project action".into()),
        };
        if data.as_object().ok_or("Invalid project fields")?.keys()
            .any(|key| !allowed.contains(&key.as_str())) {
            return Err("Unsupported project registration field".into());
        }
        let mut result = serde_json::Map::new();
        let op = match action.as_str() {
            "register_project" => "register",
            "update_project" => "update",
            _ => "remove",
        };
        result.insert("action".into(), json!(op));
        if action != "register_project" {
            let id = text_field("projectId", 63)?;
            if !id.bytes().enumerate().all(|(i, b)|
                b.is_ascii_lowercase() || b.is_ascii_digit() || (b == b'-' && i > 0)) {
                return Err("Invalid project ID".into());
            }
            let updated = data.get("expectedUpdatedAt").and_then(Value::as_u64)
                .ok_or("Project revision required")?;
            if updated == 0 { return Err("Invalid project revision".into()); }
            result.insert("projectId".into(), json!(id));
            result.insert("expectedUpdatedAt".into(), json!(updated));
            if action == "remove_project" { return Ok(Value::Object(result)); }
        }
        let name = if action == "register_project" || data.get("name").is_some() {
            Some(text_field("name", 120)?)
        } else { None };
        if let Some(name) = name { result.insert("name".into(), json!(name)); }
        if let Some(desc) = data.get("description") {
            let desc = desc.as_str().ok_or("Invalid description")?;
            if desc.len() > 500 || desc.chars().any(|c| c.is_control()) {
                return Err("Invalid description".into());
            }
            result.insert("description".into(), json!(desc));
        }
        if action == "update_project" {
            if let Some(enabled) = data.get("enabled") {
                result.insert("enabled".into(),
                    json!(enabled.as_bool().ok_or("Invalid enabled flag")?));
            }
            if let Some(root) = data.get("root") {
                let root = root.as_str().ok_or("Invalid project root")?;
                if root.is_empty() || root.len() > 4096 ||
                   !PathBuf::from(root).is_absolute() || !PathBuf::from(root).is_dir() {
                    return Err("Choose an existing absolute project folder".into());
                }
                result.insert("root".into(), json!(root));
            }
            if let Some(target) = data.get("target") {
                let target = target.as_str().ok_or("Invalid project target")?;
                if target.is_empty() || target.len() > 2048 ||
                    !(target.starts_with("ssh://") || target.starts_with("chain:")) ||
                    target.contains('?') || target.contains('#') {
                    return Err("Invalid project target".into());
                }
                result.insert("target".into(), json!(target));
            }
            return Ok(Value::Object(result));
        }
        let project_type = text_field("type", 5)?;
        if !["local", "ssh", "chain"].contains(&project_type.as_str()) {
            return Err("Project type must be local, ssh or chain".into());
        }
        result.insert("type".into(), json!(project_type));
        if data.get("id").is_some() {
            let id = text_field("id", 63)?;
            if !id.bytes().enumerate().all(|(i,b)|
                b.is_ascii_lowercase() || b.is_ascii_digit() || (b == b'-' && i > 0)) {
                return Err("Invalid project ID".into());
            }
            result.insert("id".into(), json!(id));
        }
        if project_type == "local" {
            if data.get("target").is_some() { return Err("Unexpected project target".into()); }
            let root = text_field("root", 4096)?;
            if !PathBuf::from(&root).is_absolute() || !PathBuf::from(&root).is_dir() {
                return Err("Choose an existing absolute project folder".into());
            }
            result.insert("root".into(), json!(root));
        } else {
            if data.get("root").is_some() { return Err("Unexpected local root".into()); }
            let target = text_field("target", 2048)?;
            if (project_type == "ssh" && (!target.starts_with("ssh://") ||
                    target.contains('?') || target.contains('#'))) ||
                (project_type == "chain" && (!target.starts_with("chain:") ||
                    !target["chain:".len()..].bytes().all(|b| b.is_ascii_lowercase() ||
                    b.is_ascii_digit() || b == b'-'))) {
                return Err("Invalid SSH or chain target".into());
            }
            result.insert("target".into(), json!(target));
        }
        Ok(Value::Object(result))
    };
    if mutating {
        // JavaScript can request an approval, but only this native dialog can
        // accept it. The dialog reads the current Core record, not any
        // caller-provided display label, and never exposes the Core token.
        let clean = |value: &str| -> String {
            value.chars().filter(|c| !c.is_control()).take(140).collect()
        };
        let prompt = if matches!(action.as_str(), "register_project" | "update_project" | "remove_project") {
            let input = project_mutation()?;
            let verb = match action.as_str() {
                "register_project" => "REGISTER",
                "update_project" => "UPDATE",
                _ => "REMOVE",
            };
            let (name, id, target) = if action == "register_project" {
                (clean(input.get("name").and_then(Value::as_str).unwrap_or("")),
                 clean(input.get("id").and_then(Value::as_str).unwrap_or("(auto from name)")),
                 clean(input.get("root").or_else(|| input.get("target"))
                     .and_then(Value::as_str).unwrap_or("")))
            } else {
                let inventory = core_request(Method::GET,
                    "/api/desktop/access/projects/inventory", None).await?;
                let id = input.get("projectId").and_then(Value::as_str).ok_or("Missing project ID")?;
                let projects = inventory.get("projects").and_then(Value::as_array)
                    .ok_or("Unable to verify project inventory")?;
                let current = projects.iter().find(|p|
                    p.get("projectId").and_then(Value::as_str) == Some(id))
                    .ok_or("Project no longer registered")?;
                if current.get("updatedAt").and_then(Value::as_u64) !=
                    input.get("expectedUpdatedAt").and_then(Value::as_u64) {
                    return Err("Project changed. Reload the inventory before editing".into());
                }
                (clean(current.get("name").and_then(Value::as_str).unwrap_or("")),
                 clean(id),
                 clean(current.get("target").and_then(Value::as_str).unwrap_or("")))
            };
            format!("{} PROJECT?\\n\\nName: {}\\nID: {}\\nCurrent target: {}\\nNew data: {}\\n\\nChanging a target, disabling or removing revokes existing MCP grants. Registration never grants access. Review the exact action.",
                verb, name, id, target,
                clean(&serde_json::to_string(&input).unwrap_or_default()))
        } else if action == "direct_grant" {
            let identity_handle = text_field("identityHandle", 96)?;
            let project_id = text_field("projectId", 63)?;
            if project_id == "mcp-connection" {
                return Err("Koneksi MCP hanya untuk autentikasi OAuth; izin operasi harus diberikan pada proyek terdaftar".into());
            }
            let caps = checked_capabilities()?;
            let inventory = core_request(Method::GET, "/api/desktop/access/identities", None).await?;
            let identities = inventory.get("identities").and_then(Value::as_array)
                .ok_or("Unable to verify the selected MCP identity")?;
            let identity = identities.iter().find(|entry|
                entry.get("identityHandle").and_then(Value::as_str) == Some(identity_handle.as_str())
            ).ok_or("Selected MCP identity is no longer verified")?;
            let subject = clean(identity.get("subject").and_then(Value::as_str).unwrap_or("Unknown agent"));
            let registry = core_request(Method::GET, "/api/desktop/access/projects", None).await?;
            let projects = registry.get("projects").and_then(Value::as_array)
                .ok_or("Unable to verify registered project targets")?;
            let project = projects.iter().find(|entry|
                entry.get("projectId").and_then(Value::as_str) == Some(project_id.as_str())
            ).ok_or("Project is not an enabled registered target")?;
            let target = format!("{} ({})", clean(project.get("name").and_then(Value::as_str).unwrap_or(&project_id)),
                clean(project.get("target").and_then(Value::as_str).unwrap_or("")));
            format!("APPROVE MCP ACCESS?\n\nAgent: {}\nIdentity: {}\nTarget: {}\nCapabilities: {}\n\nExecute/Git may run commands with OS-user privileges. This is independent from Chat Agent YOLO. Permissions remain active until revoked.",
                subject, identity_handle, target, caps.join(", "))
        } else {
            let request_id = text_field("requestId", 96)?;
            let inventory = core_request(Method::GET, "/api/desktop/access/requests", None).await?;
            let requests = inventory.get("requests").and_then(Value::as_array)
                .ok_or("Unable to verify the MCP access request")?;
            let request = requests.iter().find(|entry|
                entry.get("requestId").and_then(Value::as_str) == Some(request_id.as_str())
            ).ok_or("MCP access request no longer exists")?;
            let current_status = request.get("status").and_then(Value::as_str).unwrap_or("");
            if (action == "approve" || action == "deny") && current_status != "pending" {
                return Err("Access request is no longer pending".into());
            }
            if action == "approve" && request.get("projectId").and_then(Value::as_str) == Some("mcp-connection") {
                return Err("Permintaan Execute koneksi lama tidak dapat disetujui; gunakan Akses Proyek".into());
            }
            if action == "revoke" && current_status != "approved" {
                return Err("Only an approved access request may be revoked".into());
            }
            let selected = if action == "approve" && data.get("capabilities").is_some() {
                checked_capabilities()?
            } else {
                request.get("capabilities").and_then(Value::as_array)
                    .ok_or("Access request capabilities are unavailable")?
                    .iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>()
            };
            let verb = match action.as_str() {
                "approve" => "APPROVE",
                "deny" => "DENY",
                "revoke" => "REVOKE",
                _ => return Err("Unsupported native MCP approval action".into()),
            };
            format!("{} MCP ACCESS?\n\nAgent: {}\nTarget: {}\nPath: {}\nCapabilities: {}\nReason: {}\nRequest: {}\n\nReview this exact scope before confirming.",
                verb,
                clean(request.get("subject").and_then(Value::as_str).unwrap_or("Unknown")),
                clean(request.get("projectName").and_then(Value::as_str).unwrap_or("Unknown")),
                clean(request.get("projectPath").and_then(Value::as_str).unwrap_or("")),
                selected.join(", "),
                clean(request.get("reason").and_then(Value::as_str).unwrap_or("Not provided")),
                request_id)
        };
        if !window.is_focused().unwrap_or(false) || !window.is_visible().unwrap_or(false) {
            return Err("Native Tray lost focus while resolving the MCP access request".into());
        }
        let dialog_app = window.app_handle().clone();
        let approved = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            dialog_app.dialog().message(prompt).buttons(
                MessageDialogButtons::OkCancelCustom(
                    "Confirm MCP action".into(), "Cancel".into(),
                )
            ).blocking_show()
        }).await.map_err(|_| "Native MCP approval dialog failed")?;
        if !approved {
            return Err("MCP access operation was not approved in the native Tray dialog".into());
        }
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) {
            return Err("Tray was hidden before MCP approval completed".into());
        }
    }
    match action.as_str() {
        "requests" => core_request(Method::GET, "/api/desktop/access/requests", None).await,
        "identities" => core_request(Method::GET, "/api/desktop/access/identities", None).await,
        "connected_clients" => {
            if !data.as_object().is_some_and(|value| value.is_empty()) {
                return Err("Connected MCP client inventory accepts no query fields".into());
            }
            core_request(Method::GET, "/api/desktop/access/connected-clients", None).await
        },
        "tools" => {
            let fields = data.as_object().ok_or("Invalid tool inventory query")?;
            if fields.keys().any(|key| key != "identityHandle" && key != "projectId") {
                return Err("Unexpected tool inventory query field".into());
            }
            let mut query: Vec<String> = Vec::new();
            if let Some(value) = fields.get("identityHandle") {
                let handle = value.as_str().ok_or("Invalid MCP identity handle")?;
                if handle.len() != 20 || !handle.starts_with("idh_") ||
                    !handle[4..].bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("Invalid MCP identity handle".into());
                }
                query.push(format!("identityHandle={}", handle));
            }
            if let Some(value) = fields.get("projectId") {
                let project = value.as_str().ok_or("Invalid MCP project selection")?;
                if project.is_empty() || project.len() > 63 ||
                    !project.bytes().enumerate().all(|(i,b)|
                        b.is_ascii_lowercase() || b.is_ascii_digit() || (b == b'-' && i > 0)) {
                    return Err("Invalid MCP project selection".into());
                }
                query.push(format!("projectId={}", project));
            }
            let endpoint = if query.is_empty() {
                "/api/desktop/access/tools".to_string()
            } else {
                format!("/api/desktop/access/tools?{}", query.join("&"))
            };
            core_request(Method::GET, &endpoint, None).await
        },
        "projects" => core_request(Method::GET, "/api/desktop/access/projects", None).await,
        "project_inventory" => core_request(Method::GET,
            "/api/desktop/access/projects/inventory", None).await,
        "register_project" | "update_project" | "remove_project" =>
            signed_project_operator_mutation(project_mutation()?).await,
        "approve" => {
            let request_id = text_field("requestId", 96)?;
            let body = if data.get("capabilities").is_some() {
                json!({"requestId": request_id, "capabilities": checked_capabilities()?})
            } else {
                json!({"requestId": request_id})
            };
            core_request(Method::POST, "/api/desktop/access/requests/approve", Some(body)).await
        }
        "deny" => {
            let request_id = text_field("requestId", 96)?;
            core_request(Method::POST, "/api/desktop/access/requests/deny",
                Some(json!({"requestId": request_id, "reason": "Denied by native operator"}))).await
        }
        "revoke" => {
            let request_id = text_field("requestId", 96)?;
            core_request(Method::POST, "/api/desktop/access/requests/revoke",
                Some(json!({"requestId": request_id}))).await
        }
        "direct_grant" => {
            let identity_handle = text_field("identityHandle", 96)?;
            let project_id = text_field("projectId", 63)?;
            core_request(Method::POST, "/api/desktop/access/direct-grant", Some(json!({
                "identityHandle": identity_handle,
                "projectId": project_id,
                "capabilities": checked_capabilities()?
            }))).await
        }
        _ => Err("Unknown or unauthorized MCP project access action".into()),
    }
}

#[tauri::command]
async fn daemon_action(action: String, payload: Option<Value>) -> Result<Value, String> {
    match action.as_str() {
        "status" => core_request(Method::GET, "/api/daemon/status", None).await,
        "core_status" => core_request(Method::GET, "/api/status", None).await,
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

/// Native-only operator controls for outbound MCP worker schedules.
/// The bearer token is never forwarded to the webview.
#[tauri::command]
async fn external_lifecycle_action(
    window: tauri::WebviewWindow,
    action: String,
    payload: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("External lifecycle is available only in the main Tray window".into());
    }
    let mutating = !matches!(action.as_str(), "list" | "status" | "workers" | "targets");
    if !matches!(
        action.as_str(),
        "list" | "status" | "workers" | "targets" | "create" | "run.now" | "pause" | "resume" | "cancel" | "review.retry" | "worker.bind" | "worker.unbind" | "worker.revoke"
    ) {
        return Err("Unsupported external lifecycle action".into());
    }
    if mutating && (!window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || !window.is_focused().unwrap_or(false))
    {
        return Err("Bring SuperAgent Tray to the foreground to manage external workflow jobs".into());
    }
    let source = payload.unwrap_or_else(|| json!({}));
    let obj = source.as_object().ok_or("Expected lifecycle request object")?;
    let workspace = obj.get("workspace").and_then(Value::as_str).ok_or("Select a workspace")?;
    if workspace.is_empty() || workspace.len() > 4096 || workspace.contains('\0') {
        return Err("Invalid workspace".into());
    }
    let args = obj.get("args").cloned().unwrap_or_else(|| json!({}));
    let fields = args.as_object().ok_or("Invalid lifecycle arguments")?;
    let allowed: &[&str] = match action.as_str() {
        "create" => &["name", "cronExpression", "prompt", "steps", "maxRuns", "enabled", "idempotencyKey"],
        "run.now" => &["workflowId", "idempotencyKey"],
        "pause" | "resume" | "cancel" => &["workflowId"],
        "review.retry" => &["runId", "stepId"],
        "worker.bind" => &["workerId", "clientId", "tabId"],
        "worker.unbind" | "worker.revoke" => &["workerId"],
        "list" => &["limit"],
        _ => &[],
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unsupported lifecycle argument".into());
    }
    if serde_json::to_string(&args).map_err(|e| e.to_string())?.len() > 70_000 {
        return Err("Lifecycle request too large".into());
    }
    core_request(Method::POST, "/api/lifecycle/action", Some(json!({
        "workspace": workspace, "action": action, "args": args,
    }))).await
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
    // Reuse the existing authenticated daemon poll to surface recent execution
    // failures even when no reminder jobs exist. Never copy task prompts,
    // workspace paths, output, error strings or notification delivery secrets.
    if let Some(entries) = runs.get("runs").and_then(Value::as_array) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_or(0, |t| t.as_millis() as u64);
        for run in entries.iter().take(100) {
            let Some(id) = run.get("runId").and_then(Value::as_str) else { continue };
            let completed = run.get("completedAt").and_then(Value::as_u64).unwrap_or(0);
            if completed == 0 || completed > now ||
                now.saturating_sub(completed) > 15 * 60 * 1000 {
                continue;
            }
            let status = run.get("status").and_then(Value::as_str).unwrap_or("");
            let failed_execution = matches!(status, "error" | "timed_out" | "interrupted");
            let failed_delivery = run.get("notificationStatus").and_then(Value::as_str) == Some("failed");
            if !failed_execution && !failed_delivery { continue; }
            let (severity, title, body) = if failed_execution {
                ("critical", "Scheduled run needs attention",
                    "A scheduled execution did not complete successfully. Review Execution History.")
            } else {
                ("warning", "Scheduled notification delivery failed",
                    "A scheduled run could not deliver its notification. Review Execution History.")
            };
            record_operational_incident(
                app, "jobs", severity, &format!("daemon-run:{id}:{title}"),
                title, body,
            )?;
        }
    }
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
        // Commit the private inbox before OS delivery or the legacy "seen"
        // cursor. A persistence error leaves this run eligible for retry.
        let incident_id=format!("reminder:{id}");
        record_operational_incident(
            app, "reminder", "info", &incident_id,
            "Reminder completed",
            "A scheduled reminder completed. Review its execution in History.",
        )?;
        // A delivered reminder has a private, bounded OS click ticket. It
        // opens the matching History run, never a caller-supplied URL or shell.
        // Failed OS delivery keeps the run eligible for retry.
        if notifications_enabled {
            let ticket=tray_os_action::issue(&config_dir()?,&incident_id).ok();
            let mut builder=app.notification().builder().title(name).body(message);
            if let Some(id)=ticket{builder=builder.id(id);}
            if let Err(e)=builder.show(){
                if let Some(id)=ticket{tray_os_action::cancel(id);}
                return Err(format!("OS notification delivery failed: {e}"));
            }
            delivered += 1;
        }
        known.insert(id.to_owned());
        state.ids.push(id.to_owned());
        if state.ids.len() > 500 {
            let keep_from = state.ids.len() - 500;
            state.ids.drain(0..keep_from);
        }
        write_seen(&file, &state)?;
    }
    Ok(delivered)
}

/// Passive, authenticated security projection. Never approves/revokes a
/// capability; absence is trusted only after a complete successful inventory.
async fn poll_pending_security_requests(app: &tauri::AppHandle) -> Result<(), String> {
    let payload = core_request(Method::GET, "/api/desktop/access/requests", None).await?;
    if payload.get("success") != Some(&Value::Bool(true)) {
        return Err("Security request inventory unavailable".into());
    }
    let requests = payload.get("requests").and_then(Value::as_array)
        .ok_or("Security inventory malformed")?;
    let mut active = HashSet::new();
    for request in requests.iter().take(300) {
        let Some(id) = request.get("requestId").and_then(Value::as_str) else { continue; };
        if id.is_empty() || id.len() > 150 || id.chars().any(char::is_control) { continue; }
        // Identity and lifecycle are from authenticated Core inventory, not the
        // notification body or a WebView-supplied approval result.
        // Operation access requests ALWAYS belong to Akses Proyek.
        // Historical virtual mcp-connection requests are denial-only there.
        let tab = "mcp";
        let key = format!("mcp-pending:{tab}:{id}");
        let status = request.get("status").and_then(Value::as_str).unwrap_or("");
        if status != "pending" {
            let changed = if status == "expired" {
                tray_notification_center::expire_verified(&config_dir()?, &key)?
            } else if ["approved", "denied", "cancelled", "rejected", "revoked"].contains(&status) {
                tray_notification_center::resolve(&config_dir()?, &key)?
            } else { false };
            if changed { let _ = app.emit("tray-notifications-changed", ()); }
            continue;
        }
        active.insert(key.clone());
        // Informational only. The label was bound to a verified OAuth token
        // after owner consent; it is NEVER an approval or client identity.
        let approved_name = request.get("ownerConnectionName")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.chars().count() <= 64 &&
                !value.chars().any(char::is_control));
        let details = match approved_name {
            Some(name) => format!("{name} requested MCP permission. Review Security Approval."),
            None => "An MCP connection requested access. Review Security Approval.".to_owned(),
        };
        record_operational_incident(
            app, "security", "critical", &key,
            "Security approval pending",
            &details,
        )?;
    }
    // The API is unpaginated; avoid false resolves if a future revision
    // returns a partial/bounded projection.
    if requests.len() <= 300 {
        let resolved = tray_notification_center::resolve_missing(
            &config_dir()?, "mcp-pending:", &active,
        )?;
        if resolved > 0 { let _ = app.emit("tray-notifications-changed", ()); }
    }
    Ok(())
}

#[derive(Default)]
struct HealthObservation {
    core_seen: bool,
    service_seen: bool,
    mcp_active: bool,
    mcp_clients: u64,
    tunnel_active: bool,
    muse_connected: bool,
    telegram_active: bool,
    channel_host_count: u64,
}

fn monitor_transition(
    app: &tauri::AppHandle, source: &str, key: &str,
    title: &str, body: &str, was_running: bool, running: bool,
) -> Result<(), String> {
    if was_running && !running {
        record_operational_incident(app, source, "warning", key, title, body)?;
    } else if running {
        if tray_notification_center::resolve(&config_dir()?, key)? {
            let _ = app.emit("tray-notifications-changed", ());
        }
    }
    Ok(())
}

/// Read-only per-process health observations. Unknown is NOT equivalent to
/// stopped: network errors and unavailable owners never auto-resolve incidents.
/// Observe transitions for individually verified paired LAN devices. A failed,
/// incomplete or malformed Core inventory never invents a disconnection.
async fn poll_lan_device_health(
    app: &tauri::AppHandle, previous: &mut HashMap<String, bool>,
) -> Result<(), String> {
    let data = core_request(Method::POST, "/api/desktop/lan-support",
        Some(json!({"action":"list"}))).await?;
    let devices = data.get("devices").and_then(Value::as_array)
        .ok_or("LAN device inventory unavailable")?;
    if devices.len() > 300 { return Err("LAN device inventory incomplete".into()); }
    let mut current = HashMap::new();
    for device in devices {
        if device.get("paired").and_then(Value::as_bool) != Some(true) { continue; }
        let Some(id) = device.get("id").and_then(Value::as_str) else {
            return Err("LAN device identity unavailable".into());
        };
        let Some(connected) = device.get("connected").and_then(Value::as_bool) else {
            return Err("LAN device connection state unavailable".into());
        };
        if id.is_empty() || id.len() > 64 ||
            !id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) ||
            current.insert(id.to_owned(), connected).is_some() {
            return Err("LAN device inventory identity invalid".into());
        }
    }
    // First successful inventory is a baseline, not an outage.
    for (id, connected) in &current {
        let key = format!("lan:device:{id}:disconnected");
        match previous.get(id) {
            Some(&true) if !*connected => record_verified_device_incident(
                app, id, &key, "Paired LAN device disconnected",
                "A previously connected, paired device is now reported disconnected by Core.",
            )?,
            Some(&false) if *connected => {
                if tray_notification_center::resolve(&config_dir()?, &key)? {
                    let _ = app.emit("tray-notifications-changed", ());
                }
            },
            _ => {},
        }
    }
    *previous = current;
    Ok(())
}

async fn poll_operational_health(
    app: &tauri::AppHandle, previous: &mut HealthObservation,
) -> Result<(), String> {
    let services = match core_request(Method::GET, "/api/desktop/runtime-services", None).await {
        Ok(value) if value.get("success") == Some(&Value::Bool(true)) => value,
        _ => {
            if previous.core_seen {
                record_operational_incident(
                    app, "core", "critical", "health:core",
                    "Core health unavailable",
                    "The selected Core health endpoint is unavailable. Inspect Runtime Detection.",
                )?;
            }
            return Ok(());
        }
    };
    if tray_notification_center::resolve(&config_dir()?, "health:core")? {
        let _ = app.emit("tray-notifications-changed", ());
    }
    previous.core_seen = true;
    let mcp = &services["mcp"];
    let tunnel = &services["tunnel"];
    let muse = &services["muse"];
    let telegram = &services["telegram"];
    // An older Core, truncated projection or unknown field must NEVER look
    // like an observed disconnect. Preserve the last verified snapshot.
    let (Some(mcp_active), Some(mcp_clients), Some(tunnel_active),
        Some(muse_owner), Some(muse_ready), Some(telegram_active), Some(hosts)) = (
        mcp["active"].as_bool(), mcp["connectedClientCount"].as_u64(),
        tunnel["active"].as_bool(), muse["ownerPresent"].as_bool(),
        muse["connected"].as_bool(), telegram["active"].as_bool(),
        services["channelHosts"]["verifiedCount"].as_u64(),
    ) else { return Ok(()); };
    let muse_connected = muse_owner && muse_ready;
    if previous.service_seen {
        monitor_transition(app, "mcp", "health:mcp-owner",
            "MCP service disconnected", "A previously active MCP service is no longer reported by Core.",
            previous.mcp_active, mcp_active)?;
        monitor_transition(app, "mcp", "health:mcp-clients",
            "MCP client connections lost", "A previously connected MCP client is no longer observed by Core.",
            previous.mcp_clients > 0, mcp_clients > 0)?;
        monitor_transition(app, "tunnel", "health:tunnel",
            "Tunnel disconnected", "A previously active Core-owned tunnel is no longer observed.",
            previous.tunnel_active, tunnel_active)?;
        monitor_transition(app, "runtime", "health:muse",
            "Muse connection lost", "The previously connected Muse watcher is no longer connected.",
            previous.muse_connected, muse_connected)?;
        monitor_transition(app, "runtime", "health:telegram",
            "Telegram service stopped", "A previously active Telegram service is no longer observed.",
            previous.telegram_active, telegram_active)?;
        monitor_transition(app, "runtime", "health:channel-hosts",
            "Channel host connection lost", "Previously verified channel hosts are no longer observed.",
            previous.channel_host_count > 0, hosts > 0)?;
    }
    previous.service_seen = true;
    previous.mcp_active = mcp_active;
    previous.mcp_clients = mcp_clients;
    previous.tunnel_active = tunnel_active;
    previous.muse_connected = muse_connected;
    previous.telegram_active = telegram_active;
    previous.channel_host_count = hosts;

    if let Ok(delegate) = core_request(Method::GET, "/api/desktop/delegate/status", None).await {
        if delegate.get("success") == Some(&Value::Bool(true)) {
            let (Some(running), Some(desired)) = (
                delegate["running"].as_bool(), delegate["desiredEnabled"].as_bool(),
            ) else { return Ok(()); };
            if desired && !running {
                record_operational_incident(
                    app, "delegate", "warning", "health:delegate-listener",
                    "Delegate listener unavailable",
                    "The enabled Delegate listener is not running. Review Delegate status.",
                )?;
            } else if tray_notification_center::resolve(&config_dir()?, "health:delegate-listener")? {
                let _ = app.emit("tray-notifications-changed", ());
            }
        }
    }
    Ok(())
}

fn show_main(app: &tauri::AppHandle, new_reminder: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
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
    #[cfg(windows)]
    {
        // Prevent GPU driver injection crashes (e.g. NVIDIA NvMemMapStoragex.dll access violation)
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu --disable-gpu-compositing");
    }

    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {}\nLocation: {:?}\n", info, info.location());
        if let Some(home) = dirs::home_dir() {
            let log_file = home.join(".superagent-r").join("tray-panic.log");
            let _ = std::fs::write(log_file, &msg);
        }
    }));
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
            // OS toast click is a native event, not a caller-supplied URL or
            // HTML title. An ID maps to one published, unexpired incident.
            // An Action Center click outside the OS provider's delivery window
            // may not be reported; the persisted inbox remains authoritative.
            let activation_app=app.handle().clone();
            let _=app.notification().on_action(move |event| {
                if event.action_id()!="tap"{return}
                let Some(notification)=event.notification() else{return};
                let Ok(dir)=config_dir() else{return};
                if !tray_os_action::activate(&dir,notification.id()){return}
                if let Some(window)=activation_app.get_webview_window("main"){
                    let _=window.show();
                    let _=window.unminimize();
                    let _=window.set_focus();
                }
                let _=activation_app.emit("tray-notification-os-activate",());
            });
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
                } else {
                    let _ = window.maximize();
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
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
            let restart_server = MenuItem::with_id(app, "restart_server", "🔄 Restart Core Server (:7888)", true, None::<&str>)?;
            let stop_server = MenuItem::with_id(app, "stop_server", "🛑 Stop Core Server (:7888)", true, None::<&str>)?;
            let notifications = MenuItem::with_id(app, "notifications", "🔔 Notifications", true, None::<&str>)?;
            let runtime =
                MenuItem::with_id(app, "runtime", "🔍 Runtime Detection", true, None::<&str>)?;
            let conn_logs =
                MenuItem::with_id(app, "connection_logs", "📜 Connection Logs", true, None::<&str>)?;
            let delegate =
                MenuItem::with_id(app, "delegate", "🌐 Chrome Delegate", true, None::<&str>)?;
            let security =
                MenuItem::with_id(app, "security", "🛡️ Security Approval", true, None::<&str>)?;
            let terminal =
                MenuItem::with_id(app, "terminal", "💻 Terminal Processes", true, None::<&str>)?;
            let muse_files =
                MenuItem::with_id(app, "muse_files", "📁 Muse File Transfer", true, None::<&str>)?;
            let lan_devices =
                MenuItem::with_id(app, "lan_devices", "🖧 LAN Devices", true, None::<&str>)?;
            let add = MenuItem::with_id(app, "add", "➕ New Reminder", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let updates = MenuItem::with_id(app, "updates", "⬇ Check for Updates", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "⚙️ Tray Settings", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let exit_superagent = MenuItem::with_id(app, "exit_superagent", "⏻ Shutdown Manager · Exit App", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Tray Only · Keep Services Running", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &status_item,
                &version_item,
                &sep0,
                &open,
                &notifications,
                &start_server,
                &restart_server,
                &stop_server,
                &runtime,
                &conn_logs,
                &delegate,
                &security,
                &terminal,
                &muse_files,
                &lan_devices,
                &add,
                &sep1,
                &updates,
                &settings,
                &sep2,
                &exit_superagent,
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
                            match launch_server_process(7888).await {
                                Ok(_pid) => {
                                    show_main(&handle, false);
                                    record_core_notification(&handle, "info", "Core started", "Core is active.");
                                    let _ = handle.emit("desktop-server-started", 7888);
                                }
                                Err(e) => {
                                    eprintln!("[tray] Failed to start Core server: {}", e);
                                    show_main(&handle, false);
                                    record_core_notification(&handle, "critical", "Core start failed", "Core could not start. Open Runtime Detection.");
                                    let _ = handle.emit("desktop-server-start-failed", e);
                                }
                            }
                        });
                    }
                    "restart_server" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = stop_core_server_inner(7888).await;
                            tokio::time::sleep(Duration::from_millis(600)).await;
                            match launch_server_process(7888).await {
                                Ok(_pid) => {
                                    show_main(&handle, false);
                                    record_core_notification(&handle, "info", "Core restarted", "Core was restarted from the notification area.");
                                    let _ = handle.emit("desktop-server-started", 7888);
                                }
                                Err(e) => {
                                    eprintln!("[tray] Failed to restart Core server: {}", e);
                                    show_main(&handle, false);
                                    record_core_notification(&handle, "critical", "Core restart failed", "Core restart failed. Inspect Runtime Detection.");
                                    let _ = handle.emit("desktop-server-start-failed", e);
                                }
                            }
                        });
                    }
                    "stop_server" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            match stop_core_server_inner(7888).await {
                                Ok(_) => {
                                    show_main(&handle, false);
                                    record_core_notification(&handle, "warning", "Core stopped", "Core was stopped from the notification area.");
                                    let _ = handle.emit("desktop-server-stopped", 7888);
                                }
                                Err(e) => {
                                    eprintln!("[tray] Failed to stop Core server: {}", e);
                                    show_main(&handle, false);
                                    record_core_notification(&handle, "critical", "Core stop failed", "Core could not be stopped. Inspect the verified owner.");
                                    let _ = handle.emit("desktop-server-stop-failed", e);
                                }
                            }
                        });
                    }
                    "add" => show_main(app, true),
                    "notifications" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-notifications", ());
                    }
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
                    "security" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-security", ());
                    }
                    "terminal" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-terminal", ());
                    }
                    "muse_files" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-muse-files", ());
                    }
                    "lan_devices" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-lan-devices", ());
                    }
                    "updates" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-updates", ());
                    }
                    "settings" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-settings", ());
                    }
                    "exit_superagent" => shutdown_manager::open(app),
                    "quit" => {
                        if shutdown_manager::is_running() {
                            shutdown_manager::open(app);
                            return;
                        }
                        tray_lifecycle::cleanup();
                        std::process::exit(0);
                    }
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
                let mut observation = HealthObservation::default();
                let mut security_log = ProjectionLogState::default();
                let mut reminder_log = ProjectionLogState::default();
                let mut health_log = ProjectionLogState::default();
                let mut lan_log = ProjectionLogState::default();
                let mut lan_previous = HashMap::<String, bool>::new();
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
                    // Security approvals must not wait behind slow daemon,
                    // reminder, or health probes. All three projections read
                    // trusted Core state independently, and never grant access.
                    let (security, reminders, health, lan) = tokio::join!(
                        poll_pending_security_requests(&handle),
                        poll_reminders(&handle, preferences.notifications_enabled),
                        poll_operational_health(&handle, &mut observation),
                        poll_lan_device_health(&handle, &mut lan_previous),
                    );
                    security_log.report("Security notification projection", &security);
                    reminder_log.report("Reminder notification projection", &reminders);
                    health_log.report("Operational notification projection", &health);
                    lan_log.report("Paired LAN device notification projection", &lan);
                    // A digest is claimed in durable native storage before
                    // delivery, so restarts or overlapping UI refreshes cannot
                    // send the same daily summary twice. This never grants
                    // access or includes private incident payloads.
                    if preferences.notifications_enabled {
                        if let Ok(dir) = config_dir() {
                            match tray_notification_center::take_daily_digest(&dir) {
                                Ok(Some((actions, information))) => {
                                    let body = format!(
                                        "{actions} action-required and {information} informational events in the last 24 hours. Open SuperAgent Tray for details."
                                    );
                                    if let Err(error) = handle.notification().builder()
                                        .title("SuperAgent daily digest")
                                        .body(&body).show() {
                                        eprintln!("[tray] Daily digest OS delivery failed: {error}");
                                    }
                                    let _ = handle.emit("tray-notifications-changed", ());
                                },
                                Ok(None) => {},
                                Err(error) => eprintln!("[tray] Daily digest unavailable: {error}"),
                            }
                        }
                    }
                    tokio::time::sleep(Duration::from_secs(preferences.notification_poll_seconds))
                        .await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if shutdown_manager::is_running() {
                    // Closing the window cannot abort a partially completed
                    // verified shutdown. Keep the owner and progress alive.
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
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
                    tray_lifecycle::cleanup();
                    std::process::exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            mcp_project_access_action,
            daemon_action,
            external_lifecycle_action,
            detect_runtime,
            select_runtime_core,
            get_yolo_mode,
            set_yolo_mode,
            service_action,
            lifecycle_console_request,
            shutdown_manager::shutdown_manager_action,
            create_connection,
            regenerate_token,
            get_tray_settings,
            tray_notification_center_action,
            tray_notification_center_begin_navigation,
            tray_notification_center_ack_navigation,
            tray_notification_center_take_os_activation,
            tray_notification_center_refresh_security,
            tray_notification_center_ui_alert,
            tray_notification_center_preferences,
            desktop_input_trust::get_desktop_input_policy,
            desktop_input_trust::list_desktop_input_windows,
            desktop_input_trust::set_desktop_input_mode,
            desktop_input_trust::trust_desktop_input_window,
            desktop_input_trust::revoke_desktop_input_window,
            desktop_input_trust::revoke_all_desktop_input_windows,
            desktop_access_registry::get_permanent_access_registry,
            desktop_access_registry::list_installed_desktop_apps,
            desktop_access_registry::pick_permanent_access_executable,
            desktop_access_registry::pick_permanent_access_path,
            desktop_access_registry::register_permanent_access_rule,
            desktop_access_registry::revoke_permanent_access_rule,
            desktop_access_registry::get_permanent_access_audit_log,
            desktop_access_registry::clear_permanent_access_audit_log,
            get_named_tunnel_settings,
            set_named_tunnel_settings,
            get_named_tunnel_connector_status,
            get_named_tunnel_health,
            get_named_tunnel_manager_status,
            plan_named_tunnel_stack,
            named_tunnel_stack_action,
            plan_named_tunnel_connector,
            named_tunnel_connector_action,
            named_tunnel_connector::pick_named_tunnel_token,
            named_tunnel_clipboard::import_named_tunnel_clipboard,
            get_tray_version,
            get_overview_owner_metrics,
            get_tray_build_number,
            release_updates::check_release_updates,
            release_updates::download_release_update,
            release_updates::download_release_component,
            set_tray_settings,
            get_muse_telegram_settings,
            set_muse_telegram_settings,
            test_muse_telegram_settings,
            regenerate_muse_ws_token,
            apply_muse_settings,
            tray_window_action,
            open_external_url,
            start_core_server,
            stop_core_server,
            restart_core_server,
            get_core_version,
            get_connection_logs,
            get_delegate_status,
            delegate_action,
            recordings_action,
            desktop_live_action,
            managed_chrome_action,
            lan_support_action,
            get_terminal_tasks,
            kill_terminal_task,
            control_terminal_task,
            external_terminal_task_action,
            launch_terminal_task,
            get_terminal_logs,
            get_terminal_presets,
            prune_terminal_tasks,
            muse_file_transfer::muse_file_pick,
            muse_file_transfer::muse_file_start,
            muse_file_transfer::muse_file_control,
            lan_file_save::lan_file_save,
            lan_folder_save::lan_folder_save
        ])
        .build(tauri::generate_context!())
        .expect("SuperAgent Tray could not build")
        .run(|_app, event| {
            match event {
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    if code.is_some() {
                        tray_lifecycle::cleanup();
                    } else {
                        // All windows closed / hidden - keep app alive in notification area
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    tray_lifecycle::cleanup();
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_read_timeout_is_limited_to_passive_inventory() {
        for path in [
            "/api/desktop/access/requests",
            "/api/daemon/jobs",
            "/api/daemon/runs?limit=100",
        ] {
            assert_eq!(notification_read_timeout(path), Some(Duration::from_secs(12)));
        }
        assert_eq!(notification_read_timeout("/api/desktop/access/requests/approve"), None);
        assert_eq!(notification_read_timeout("/api/daemon/jobs/run"), None);
        assert_eq!(notification_read_timeout("/api/status"), None);
    }

    #[test]
    fn projection_log_tracks_failure_recovery_and_periodic_retry() {
        let mut state = ProjectionLogState::default();
        let start = Instant::now();
        assert!(!state.should_report(None, start));
        assert!(state.should_report(Some("timeout"), start));
        assert!(!state.should_report(Some("timeout"), start + Duration::from_secs(30)));
        assert!(state.should_report(Some("unreachable"), start + Duration::from_secs(31)));
        assert!(!state.should_report(Some("unreachable"), start + Duration::from_secs(90)));
        assert!(state.should_report(Some("unreachable"), start + Duration::from_secs(332)));
        assert!(state.should_report(None, start + Duration::from_secs(333)));
        assert!(!state.should_report(None, start + Duration::from_secs(334)));
        assert!(state.should_report(Some("timeout"), start + Duration::from_secs(335)));
    }

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
    fn native_approval_hmac_matches_core_utf8_window_vector() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let nonce = "0123456789abcdef".repeat(3);
        let message = format!("desktop-live-native-approval-v1:{}:{}:{}:{}:{}:{}:{}:{}:{}",
            nonce, 4851, URL_SAFE_NO_PAD.encode("cg:12345"),
            URL_SAFE_NO_PAD.encode("Editor — Hello"),
            URL_SAFE_NO_PAD.encode("Sample.app"),
            -220, 80, 1200, 800);
        let mac = desktop_live_hmac(&[0x11; 32], message.as_bytes());
        assert_eq!(mac, "a881eb0505eeef0f0994aab5b0839302259604cd7f1b757c5534be3efade3e51");
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
