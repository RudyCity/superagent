#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const EVENT_PREFIX: &str = "@@SUPERAGENT_LAN_GUI@@";
const MAX_PIXELS: usize = 1280 * 720;

#[derive(Default)]
struct Receiver(Mutex<Option<Child>>);

fn client_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().resource_dir().map_err(|e| e.to_string())?
        .join("binaries").join("superagent-lan-client.exe");
    if !path.is_file() {
        return Err("Bundled LAN receiver executable is missing. Reinstall the application.".into());
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || metadata.len() < 100_000 || metadata.len() > 160_000_000 {
        return Err("Bundled LAN receiver executable failed validation.".into());
    }
    Ok(path)
}
fn valid_segment(value: &str) -> bool {
    (3..=32).contains(&value.len()) &&
        value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn terminate_owned(child: &mut Child) {
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = writeln!(stdin, "{}", json!({ "type": "stop" }));
        let _ = stdin.flush();
    }
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() { return; }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    // Kill only this exact Child handle spawned by this Tauri process.
    let _ = child.kill();
    let _ = child.wait();
}
#[tauri::command]
fn start_client(app: AppHandle, state: State<'_, Receiver>, segment: String) -> Result<(), String> {
    if !valid_segment(&segment) { return Err("Network segment must use 3–32 letters, digits, - or _.".into()); }
    let mut guard = state.0.lock().map_err(|_| "Receiver state unavailable")?;
    if let Some(ref mut old) = *guard {
        if old.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("Receiver is already running.".into());
        }
    }
    let binary = client_path(&app)?;
    let mut command = Command::new(&binary);
    command.arg("--tauri-receiver").arg(format!("--segment={segment}"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot start receiver: {e}"))?;
    if let Some(output) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines().flatten() {
                if let Some(encoded) = line.strip_prefix(EVENT_PREFIX) {
                    if let Ok(event) = serde_json::from_str::<Value>(encoded) {
                        if event.get("event").and_then(Value::as_str).is_some() {
                            let _ = app.emit("receiver-event", event);
                        }
                    }
                }
            }
            let _ = app.emit("receiver-event", json!({"event":"process_closed"}));
        });
    }
    if let Some(error_output) = child.stderr.take() {
        std::thread::spawn(move || {
            for _line in BufReader::new(error_output).lines() {
                // Drain without emitting raw executable stderr (could contain secrets).
            }
        });
    }
    *guard = Some(child);
    Ok(())
}
#[tauri::command]
fn send_action(state: State<'_, Receiver>, request: Value) -> Result<(), String> {
    let obj = request.as_object().ok_or("Malformed action")?;
    let kind = obj.get("type").and_then(Value::as_str).ok_or("Action type required")?;
    match kind {
        "approve" | "deny" => {
            if obj.len() != 2 || obj.get("id").and_then(Value::as_str)
                .filter(|x| x.len() == 36 && x.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')).is_none() {
                return Err("Invalid approval ID.".into());
            }
        }
        "connect" => {
            if obj.len() != 2 || obj.get("payload").and_then(Value::as_str)
                .filter(|s| s.len() <= 2048).is_none() {
                return Err("Invalid one-time QR payload.".into());
            }
        }
        "stop" | "disconnect" | "revoke" | "rotate" | "status" => {
            if obj.len() != 1 { return Err("Invalid action parameters.".into()); }
        }
        _ => return Err("Action is not permitted.".into()),
    }
    let mut guard = state.0.lock().map_err(|_| "Receiver state unavailable")?;
    let child = guard.as_mut().ok_or("Start the receiver first.")?;
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Err("Receiver is no longer running.".into());
    }
    let stdin = child.stdin.as_mut().ok_or("Receiver command channel closed.")?;
    writeln!(stdin, "{}", request).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}
#[tauri::command]
fn receiver_running(state: State<'_, Receiver>) -> Result<bool, String> {
    let mut guard = state.0.lock().map_err(|_| "Receiver state unavailable")?;
    match guard.as_mut() {
        Some(child) => Ok(child.try_wait().map_err(|e| e.to_string())?.is_none()),
        None => Ok(false),
    }
}
#[tauri::command]
fn stop_client(state: State<'_, Receiver>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "Receiver state unavailable")?;
    if let Some(mut child) = guard.take() { terminate_owned(&mut child); }
    Ok(())
}
#[tauri::command]
fn select_share(app: AppHandle, state: State<'_, Receiver>, folder: bool) -> Result<(), String> {
    let choice = if folder {
        app.dialog().file().blocking_pick_folder()
    } else {
        app.dialog().file().blocking_pick_file()
    };
    let selected = match choice { Some(path) => path, None => return Ok(()) };
    let path = selected.as_path().ok_or("A local filesystem path is required.")?;
    let path = path.to_str().ok_or("Unsupported local path.")?;
    let object = json!({ "type": if folder { "share_folder" } else { "share_file" }, "path": path });
    let mut guard = state.0.lock().map_err(|_| "Receiver state unavailable")?;
    let child = guard.as_mut().ok_or("Start the receiver first.")?;
    if child.try_wait().map_err(|e| e.to_string())?.is_some() {
        return Err("Receiver is no longer running.".into());
    }
    let stdin = child.stdin.as_mut().ok_or("Receiver command channel closed.")?;
    writeln!(stdin, "{}", object).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())
}
#[tauri::command]
fn scan_qr_frame(width: usize, height: usize, gray_b64: String) -> Result<Option<String>, String> {
    if width < 64 || height < 64 || width > 1280 || height > 720 ||
        width.checked_mul(height).filter(|n| *n <= MAX_PIXELS).is_none() {
        return Err("QR frame dimensions out of bounds.".into());
    }
    if gray_b64.len() > 1_300_000 { return Err("QR frame too large.".into()); }
    let pixels = STANDARD.decode(gray_b64).map_err(|_| "Invalid QR frame.")?;
    if pixels.len() != width * height { return Err("QR frame size mismatch.".into()); }
    let mut decoder = quircs::Quirc::default();
    for code in decoder.identify(width, height, &pixels) {
        if let Ok(code) = code {
            if let Ok(data) = code.decode() {
                if let Ok(text) = String::from_utf8(data.payload) {
                    if text.len() <= 2048 { return Ok(Some(text)); }
                }
            }
        }
    }
    Ok(None)
}
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Receiver::default())
        .invoke_handler(tauri::generate_handler![
            start_client, send_action, receiver_running, stop_client, select_share, scan_qr_frame
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let state = window.state::<Receiver>();
                if let Ok(mut owner) = state.0.lock() {
                    if let Some(mut child) = owner.take() { terminate_owned(&mut child); }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("SuperAgent LAN Client GUI startup failed");
}
