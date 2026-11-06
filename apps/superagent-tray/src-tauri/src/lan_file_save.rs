//! Save a single fully verified LAN-received file, via explicit native Save As.
 //! Never accepts a caller-selected filesystem path or overwrites existing files.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::Write;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn lan_file_save(
    app: tauri::AppHandle, window: tauri::WebviewWindow,
    name: String, data: String, sha256: String,
) -> Result<Value, String> {
    if window.label() != "main" { return Err("Save requires main Tray window".into()); }
    let safe = !name.is_empty() && name.len() <= 96
        && !name.starts_with('.') && !name.ends_with('.') && !name.ends_with(' ')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b" _.-()".contains(&b));
    if !safe { return Err("Unsafe received filename".into()); }
    if data.len() > 5_600_000 || !sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || sha256.len() != 64 { return Err("Invalid file metadata".into()); }
    let bytes = STANDARD.decode(data.as_bytes()).map_err(|_| "Malformed received base64")?;
    if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024
        || format!("{:x}", Sha256::digest(&bytes)) != sha256.to_ascii_lowercase() {
        return Err("Received file SHA-256 mismatch or file too large".into());
    }
    let choice = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_file_name(&name).blocking_save_file()
    }).await.map_err(|_| "Native Save As dialog failed")?;
    let Some(choice) = choice else { return Ok(json!({"saved":false,"cancelled":true})); };
    let path = choice.into_path().map_err(|_| "Only local files are supported")?;
    // Create-new prevents arbitrary overwrites, even if the native dialog
    // inadvertently picked an existing path or a preexisting symlink.
    let mut output = std::fs::OpenOptions::new()
        .write(true).create_new(true).open(&path)
        .map_err(|_| "Selected destination exists or cannot be created")?;
    if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = std::fs::remove_file(&path);
        return Err(format!("File save interrupted: {}", error.kind()));
    }
    Ok(json!({"saved":true,"bytes":bytes.len()}))
}
