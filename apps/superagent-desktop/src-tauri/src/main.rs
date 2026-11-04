use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

mod runtime_detection;

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
    let request_timeout = if path == "/api/daemon/jobs/run" {
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
async fn poll_reminders(app: &tauri::AppHandle) -> Result<usize, String> {
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
        app.notification()
            .builder()
            .title(name)
            .body(message)
            .show()
            .map_err(|e| format!("OS notification delivery failed: {}", e))?;
        known.insert(id.to_owned());
        state.ids.push(id.to_owned());
        if state.ids.len() > 500 {
            let keep_from = state.ids.len() - 500;
            state.ids.drain(0..keep_from);
        }
        // Persist immediately so a crash does not generate a notification storm.
        write_seen(&file, &state)?;
        delivered += 1;
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open Cron Manager", true, None::<&str>)?;
            let add = MenuItem::with_id(app, "add", "New Reminder", true, None::<&str>)?;
            let runtime =
                MenuItem::with_id(app, "runtime", "Runtime Detection", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Quit SuperAgent Desktop", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &add, &runtime, &quit])?;
            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .expect("App icon not generated")
                        .clone(),
                )
                .tooltip("SuperAgent · Runtime & Reminders")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app, false),
                    "add" => show_main(app, true),
                    "runtime" => {
                        show_main(app, false);
                        let _ = app.emit("desktop-open-runtime", ());
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
                    let _ = poll_reminders(&handle).await;
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon_action,
            detect_runtime,
            select_runtime_core
        ])
        .run(tauri::generate_context!())
        .expect("SuperAgent Desktop could not start");
}

#[cfg(test)]
mod tests {
    use super::*;

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
