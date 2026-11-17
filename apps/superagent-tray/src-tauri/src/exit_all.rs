//! Explicit native "Exit App" for the selected SuperAgent stack.
//! This is not process-name/PID cleanup: every remote stop uses an authenticated
//! owner contract, and a partial/ambiguous outcome keeps the Tray available.
use super::{config_dir, core_request, lifecycle_console_request, remote_service_detection,
    runtime_control, runtime_detection, server_info, tray_lifecycle};
use reqwest::Method;
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

static EXITING: AtomicBool = AtomicBool::new(false);

const STOP_ORDER: &[&str] = &["guardian", "daemon", "channel_host", "transport", "vision"];
const PLAN_FIELDS: &[&str] = &[
    "port", "operationId", "expectedOwnerPid", "expectedInstanceId",
    "expectedSupervisorPid", "expectedWorkerPid", "expectedRunning",
    "noActiveJobs", "noPublicIngress", "noCoreShutdown", "corePort",
    "channelMode", "wsPort",
];

fn live(state: &str) -> bool {
    matches!(state, "online" | "observed" | "idle" | "unverified" |
        "active" | "degraded")
}

fn stop_request_from_plan(service: &str, plan: &Value) -> Result<Value, String> {
    if !STOP_ORDER.contains(&service) {
        return Err("EXIT_UNSUPPORTED_SERVICE".into());
    }
    if plan.get("allowed") == Some(&Value::Bool(false)) {
        return Err(format!("EXIT_STOP_NOT_SUPPORTED_{service}"));
    }
    let operation_id = plan.get("operationId").and_then(Value::as_str)
        .filter(|value| value.len() >= 8)
        .ok_or_else(|| format!("EXIT_NO_VERIFIED_PLAN_{service}"))?;
    let mut request = Map::new();
    request.insert("action".into(), json!("stop"));
    request.insert("service".into(), json!(service));
    request.insert("confirm".into(), json!(true));
    request.insert("operationId".into(), json!(operation_id));
    for key in PLAN_FIELDS {
        if let Some(value) = plan.get(*key) {
            request.insert((*key).into(), value.clone());
        }
    }
    Ok(Value::Object(request))
}

fn check_observed_owners(services: &[remote_service_detection::RemoteService])
    -> Result<Vec<(u16, u32)>, String>
{
    let mut mcp = Vec::new();
    for service in services {
        if !live(service.state) { continue; }
        match service.kind {
            "cloudflare" => return Err(
                "EXIT_TUNNEL_ACTIVE: stop the owned Cloudflare tunnel from its guarded controls first".into()),
            "core-supervisor" => return Err(
                "EXIT_SUPERVISOR_ACTIVE: Core supervisor has no verified full-stop contract".into()),
            "muse-watch" => return Err(
                "EXIT_MUSE_OWNER_ACTIVE: stopping its watcher does not terminate the independent owner".into()),
            "mcp" => {
                if !service.can_stop {
                    return Err("EXIT_MCP_BUSY_OR_UNVERIFIED: close MCP sessions before Exit App".into());
                }
                let (Some(port), Some(pid)) = (service.port, service.pid) else {
                    return Err("EXIT_MCP_IDENTITY_MISSING".into());
                };
                mcp.push((port, pid));
            }
            _ => {}
        }
    }
    Ok(mcp)
}

fn selected_core_verified(runtime: &Value) -> Result<bool, String> {
    let cores = runtime.get("cores").and_then(Value::as_array)
        .ok_or("EXIT_RUNTIME_INVENTORY_UNAVAILABLE")?;
    if cores.iter().any(|core| core["state"] == "online" && core["selected"] != true) {
        return Err("EXIT_OTHER_CORE_ACTIVE: refuse to ignore another running Core".into());
    }
    if let Some(selected) = cores.iter().find(|core| core["selected"] == true) {
        if selected["state"] == "online" && selected["pidVerified"] == true {
            return Ok(true);
        }
        if selected["state"] == "offline" {
            return Ok(false);
        }
        return Err("EXIT_CORE_OWNER_UNVERIFIED".into());
    }
    Ok(false)
}

async fn prepare_managed_stops() -> Result<Vec<Value>, String> {
    let inventory = lifecycle_console_request(json!({"action":"inventory"})).await?;
    let states = inventory.get("services").and_then(Value::as_array)
        .ok_or("EXIT_SERVICE_INVENTORY_UNAVAILABLE")?;
    for service in states {
        let name = service["service"].as_str().unwrap_or("");
        if matches!(name, "rest_tunnel" | "muse_tunnel") && live(service["state"].as_str().unwrap_or("")) {
            return Err("EXIT_PUBLIC_TUNNEL_ACTIVE: stop it with its owner-specific approval first".into());
        }
        if name == "core" && service["state"] == "active" {
            return Err("EXIT_SUPERVISOR_ACTIVE: verified supervisor shutdown is not supported".into());
        }
    }
    let mut requests = Vec::new();
    for name in STOP_ORDER {
        let Some(service) = states.iter().find(|item| item["service"] == *name) else {
            return Err(format!("EXIT_MISSING_STATUS_{name}"));
        };
        let state = service["state"].as_str().unwrap_or("unknown");
        if state == "inactive" || (name == &"daemon" && state == "embedded") {
            continue;
        }
        if !matches!(state, "active" | "degraded") ||
            service["ownershipVerified"] != true ||
            !service["actions"].as_array()
                .is_some_and(|actions| actions.iter().any(|action| action == "stop")) {
            return Err(format!("EXIT_UNVERIFIED_OR_BUSY_{name}"));
        }
        let port = service["port"].as_u64()
            .filter(|port| (1024..=65535).contains(port))
            .ok_or_else(|| format!("EXIT_PORT_MISSING_{name}"))?;
        let plan = lifecycle_console_request(json!({
            "action":"plan", "service":name, "targetAction":"stop", "port":port
        })).await?;
        requests.push(stop_request_from_plan(name, &plan)?);
    }
    Ok(requests)
}

async fn stop_owned_stack() -> Result<(), String> {
    let dir = config_dir()?;
    let snapshot = serde_json::to_value(runtime_detection::detect_runtime(&dir).await?)
        .map_err(|_| "EXIT_RUNTIME_SNAPSHOT_INVALID")?;
    let core_online = selected_core_verified(&snapshot)?;
    let remote = remote_service_detection::scan(&dir).await;
    let mcp_targets = check_observed_owners(&remote)?;
    let stops = if core_online {
        prepare_managed_stops().await?
    } else {
        Vec::new()
    };

    // Preflight finishes before the first side effect. No PID-only kill,
    // taskkill /T /F, name-based process enumeration, or credential export.
    for request in stops {
        lifecycle_console_request(request).await?;
    }
    for (port, pid) in mcp_targets {
        runtime_control::control(&dir, "mcp", "stop", port, pid).await?;
    }
    if core_online {
        // Only the selected, authenticated Core endpoint is asked to exit.
        // A supervisor is rejected above, since it would restart its worker.
        let registered = server_info()?;
        if snapshot["cores"].as_array().is_none_or(|cores| !cores.iter().any(|core| {
            core["selected"] == true && core["port"] == registered.port &&
                core["pid"] == registered.pid.unwrap_or(0)
        })) {
            return Err("EXIT_CORE_CHANGED_SINCE_PREFLIGHT".into());
        }
        core_request(Method::POST, "/api/shutdown", Some(json!({}))).await?;
        tokio::time::sleep(Duration::from_millis(800)).await;
        let after = serde_json::to_value(runtime_detection::detect_runtime(&dir).await?)
            .map_err(|_| "EXIT_CORE_POSTCHECK_UNAVAILABLE")?;
        if after["cores"].as_array().is_some_and(|cores| cores.iter().any(|core|
            core["selected"] == true && core["state"] == "online")) {
            return Err("EXIT_CORE_STILL_RUNNING: Tray stays open for review".into());
        }
    }
    let remaining = remote_service_detection::scan(&dir).await;
    if remaining.iter().any(|service| live(service.state) &&
        matches!(service.kind, "mcp" | "core-supervisor" | "muse-watch" | "cloudflare")) {
        return Err("EXIT_OWNER_STILL_RUNNING: inspect Runtime Detection before retry".into());
    }
    Ok(())
}

struct ExitGuard;
impl Drop for ExitGuard {
    fn drop(&mut self) { EXITING.store(false, Ordering::SeqCst); }
}

pub fn request(app: AppHandle) {
    if EXITING.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(async move {
        let _guard = ExitGuard;
        let dialog_app = app.clone();
        let confirmed = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            dialog_app.dialog().message(
                "Exit SuperAgent and stop managed services?\n\n\
                This disconnects local agents, MCP sessions and tunnel clients. \
                Only verified owners will be stopped. If any owner is busy, \
                unverified or has no safe stop protocol, the Tray will remain open.\n\n\
                Use 'Quit Tray Only' to leave services running."
            ).buttons(MessageDialogButtons::OkCancelCustom(
                "Stop services & exit".into(), "Cancel".into()
            )).blocking_show()
        }).await;
        if !matches!(confirmed, Ok(true)) { return; }
        match stop_owned_stack().await {
            Ok(()) => {
                tray_lifecycle::cleanup();
                app.exit(0);
            }
            Err(error) => {
                eprintln!("[tray] Scoped Exit App did not complete: {error}");
                super::show_main(&app, false);
                let safe = if error.starts_with("EXIT_") {
                    error.chars().take(150).collect::<String>()
                } else {
                    "Verified lifecycle stop was rejected. Inspect Runtime Detection.".into()
                };
                let _ = app.notification().builder()
                    .title("SuperAgent remains running")
                    .body(&safe).show();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_plan_needs_bounded_service_and_operation_id() {
        assert!(stop_request_from_plan("core", &json!({"operationId":"valid-op-id"})).is_err());
        assert!(stop_request_from_plan("vision", &json!({})).is_err());
        assert!(stop_request_from_plan("vision", &json!({
            "operationId":"valid-op-id", "allowed":false
        })).is_err());
        let req = stop_request_from_plan("vision", &json!({
            "operationId":"verified-uuid", "port":8095,
            "expectedOwnerPid":34, "expectedInstanceId":"owned",
            "noPublicIngress":true, "url":"https://unexpected.invalid",
            "token":"secret"
        })).unwrap();
        assert_eq!(req["service"], "vision");
        assert_eq!(req["action"], "stop");
        assert_eq!(req["confirm"], true);
        assert!(req.get("url").is_none());
        assert!(req.get("token").is_none());
    }
    #[test]
    fn selected_core_requires_kernel_verified_online_owner() {
        assert_eq!(selected_core_verified(&json!({"cores":[]})).unwrap(), false);
        assert_eq!(selected_core_verified(&json!({"cores":[{
            "selected":true,"state":"online","pidVerified":true
        }]})).unwrap(), true);
        assert!(selected_core_verified(&json!({"cores":[{
            "selected":true,"state":"online","pidVerified":false
        }]})).is_err());
    }
}
