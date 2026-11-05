//! Native-only file selection and fixed-shape Core bridge for Muse transfers.
//! No raw paths, credentials, file bytes, or arbitrary HTTP targets enter the WebView.
use reqwest::Method;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone)]
struct Selected {
    ticket: String,
    path: PathBuf,
    bytes: u64,
}

#[derive(Default)]
pub struct MuseFileSelection(Mutex<Option<Selected>>);

fn selected_file(path: PathBuf) -> Result<(PathBuf, u64, String), String> {
    let meta = std::fs::symlink_metadata(&path)
        .map_err(|_| "Selected file cannot be inspected")?;
    if !meta.file_type().is_file() || meta.file_type().is_symlink() ||
        meta.len() > 8 * 1024 * 1024
    {
        return Err("Select a regular file at most 8 MiB (no symlinks)".into());
    }
    let canonical = path.canonicalize().map_err(|_| "Cannot resolve selected file")?;
    let name = canonical.file_name().and_then(|x| x.to_str())
        .filter(|s| !s.is_empty() && s.len() <= 180)
        .ok_or("Invalid selected filename")?;
    let lower = name.to_ascii_lowercase();
    if lower == ".env" || lower.starts_with(".env.") ||
        ["id_rsa", "id_ed25519", "credentials.json", "model-config.json"].contains(&lower.as_str())
    {
        return Err("Sensitive configuration files cannot be transferred".into());
    }
    Ok((canonical.clone(), meta.len(), name.to_owned()))
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        Err("Muse transfer controls require the SuperAgent Tray window".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn muse_file_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    selection: State<'_, MuseFileSelection>,
) -> Result<Option<Value>, String> {
    main_window(&window)?;
    let file = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file()
            .add_filter("CSV, JSON, Documents and Archives", &["csv", "json", "txt", "md", "pdf", "xlsx", "zip"])
            .add_filter("All Files", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "Native file dialog failed")?;
    let Some(file) = file else { return Ok(None) };
    let (path, bytes, name) = selected_file(
        file.into_path().map_err(|_| "Only local files can be selected")?
    )?;
    let epoch = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock unavailable")?.as_nanos();
    let ticket = format!("selected-{epoch:032x}-{:x}", std::process::id());
    *selection.0.lock().map_err(|_| "File selection unavailable")? =
        Some(Selected { ticket: ticket.clone(), path, bytes });
    Ok(Some(json!({ "ticket": ticket, "name": name, "size": bytes })))
}

#[tauri::command]
pub async fn muse_file_start(
    window: tauri::WebviewWindow,
    selection: State<'_, MuseFileSelection>,
    ticket: String,
    kind: String,
) -> Result<Value, String> {
    main_window(&window)?;
    if kind != "muse-websocket" && kind != "telegram" {
        return Err("Unsupported Muse transfer channel".into());
    }
    let chosen = {
        let mut slot = selection.0.lock().map_err(|_| "File selection unavailable")?;
        if slot.as_ref().map(|s| s.ticket.as_str()) != Some(ticket.as_str()) {
            return Err("Select a new file from the native file picker".into());
        }
        slot.take().ok_or("File ticket already consumed")?
    };
    let (canonical, size, _) = selected_file(chosen.path.clone())?;
    if canonical != chosen.path || size != chosen.bytes {
        return Err("File changed after it was selected; select it again".into());
    }
    super::core_request(
        Method::POST, "/api/desktop/muse-files/start",
        Some(json!({ "filePath": chosen.path.to_string_lossy(), "kind": kind })),
    ).await
}

#[tauri::command]
pub async fn muse_file_control(
    window: tauri::WebviewWindow,
    action: String,
    id: Option<String>,
    settings: Option<Value>,
) -> Result<Value, String> {
    main_window(&window)?;
    match action.as_str() {
        "status" if id.is_none() && settings.is_none() =>
            super::core_request(Method::GET, "/api/desktop/muse-files/status", None).await,
        "settings" if id.is_none() =>
            super::core_request(Method::POST, "/api/desktop/muse-files/settings",
                Some(json!({ "settings": settings.ok_or("Missing settings")? }))).await,
        "pause" | "resume" | "cancel" if settings.is_none() => {
            let job_id = id.ok_or("Transfer ID is required")?;
            if !valid_uuid(&job_id) { return Err("Invalid transfer ID".into()); }
            let endpoint = match action.as_str() {
                "pause" => "/api/desktop/muse-files/pause",
                "resume" => "/api/desktop/muse-files/resume",
                _ => "/api/desktop/muse-files/cancel",
            };
            super::core_request(Method::POST, endpoint, Some(json!({ "id": job_id }))).await
        }
        _ => Err("Unsupported Muse file transfer control".into()),
    }
}

fn valid_uuid(s: &str) -> bool {
    s.len() == 36 && s.bytes().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) { c == b'-' }
        else { c.is_ascii_hexdigit() }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_id_and_file_picker_guards() {
        assert!(valid_uuid("bcc52c5a-1835-4c4e-a786-0e870def0aa5"));
        assert!(!valid_uuid("../foo"));
        assert!(!valid_uuid("a".repeat(36).as_str()));
        let dir = std::env::temp_dir().join(format!(
            "muse-file-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let invalid = dir.join(".env");
        std::fs::write(&invalid, "PRIVATE").unwrap();
        assert!(selected_file(invalid).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
