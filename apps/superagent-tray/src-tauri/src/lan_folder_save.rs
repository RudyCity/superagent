//! Native only, consent-based folder import for SuperAgent LAN.
//! Accepts a fully verified, bounded SAFOLDER1 archive from the Tray viewer;
//! destination is chosen in a native folder picker. No remote paths or overwrites.
use std::{collections::HashSet, fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}};
use serde_json::{json, Value};
use tauri_plugin_dialog::DialogExt;
use sha2::{Digest, Sha256};
use base64::{engine::general_purpose::STANDARD, Engine as _};

const MAX_PACKAGE: usize = 4 * 1024 * 1024;
const MAX_MANIFEST: usize = 32 * 1024;
const MAX_FILES: usize = 64;
const MAX_DEPTH: usize = 9; // 8 nested directories + filename
const MAGIC: &[u8] = b"SAFOLDER1"; // exactly 9 bytes

struct FolderPart {
    path: PathBuf,
    offset: usize,
    size: usize,
}

fn safe_component(segment: &str) -> bool {
    if segment.is_empty() || segment.len() > 96 || segment == "." || segment == ".."
        || segment.starts_with('.') || segment.ends_with('.') || segment.ends_with(' ')
        || !segment.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
        || !segment.bytes().all(|b| b.is_ascii_alphanumeric() || b" _.-()".contains(&b))
    { return false; }
    let prefix = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(prefix.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((prefix.starts_with("COM") || prefix.starts_with("LPT")) && prefix.len() == 4
            && (b'1'..=b'9').contains(&prefix.as_bytes()[3])) { return false; }
    let lower = segment.to_ascii_lowercase();
    if ["pem","key","p12","pfx","jks","kdbx","asc"]
        .iter().any(|ext| lower.ends_with(&format!(".{ext}"))) { return false; }
    let words = ["secret","secrets","password","passwords","passwd","credential",
        "credentials","private","token","tokens","apikey","api-key","accesskey",
        "access-key","id_rsa","id_dsa","id_ecdsa","id_ed25519","keystore",
        "wallet","recovery","seedphrase"];
    for word in words {
        for (start, _) in lower.match_indices(word) {
            let end = start + word.len();
            let before = start == 0 || b"_ .(-".contains(&lower.as_bytes()[start - 1]);
            let after = end == lower.len() || b"_ .)-".contains(&lower.as_bytes()[end]);
            if before && after { return false; }
        }
    }
    true
}

fn inspect_folder(bytes: &[u8]) -> Result<Vec<FolderPart>, String> {
    if bytes.len() > MAX_PACKAGE || bytes.len() < MAGIC.len() + 4
        || !bytes.starts_with(MAGIC) { return Err("Invalid folder header".into()); }
    let start = MAGIC.len();
    let manifest_len = u32::from_be_bytes(bytes[start..start + 4].try_into().unwrap()) as usize;
    if manifest_len < 10 || manifest_len > MAX_MANIFEST ||
        start + 4 + manifest_len > bytes.len() {
        return Err("Folder manifest length outside limits".into());
    }
    let document: Value = serde_json::from_slice(&bytes[start + 4..start + 4 + manifest_len])
        .map_err(|_| "Malformed folder manifest")?;
    let object = document.as_object().ok_or("Folder manifest must be an object")?;
    if object.len() != 2 || !object.contains_key("version") || !object.contains_key("files") ||
        document["version"].as_u64() != Some(1) {
        return Err("Unsupported folder manifest schema".into());
    }
    let files = document["files"].as_array().ok_or("Folder file list required")?;
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("Folder must contain 1-64 files".into());
    }
    let mut offset = start + 4 + manifest_len;
    let mut seen = HashSet::<String>::new();
    let mut parts = Vec::with_capacity(files.len());
    for entry in files {
        let file = entry.as_object().ok_or("Invalid folder file entry")?;
        if file.len() != 3 || !file.contains_key("path") || !file.contains_key("size")
            || !file.contains_key("sha256") { return Err("Unknown folder entry field".into()); }
        let relative = entry["path"].as_str().ok_or("Folder path missing")?;
        if relative.is_empty() || relative.len() > 900 || relative.contains('\\')
            || relative.starts_with('/') || relative.contains(':')
            || relative.chars().any(|c| c.is_control()) {
            return Err("Unsafe folder path".into());
        }
        let components: Vec<&str> = relative.split('/').collect();
        if components.len() > MAX_DEPTH || components.iter().any(|part| !safe_component(part)) {
            return Err("Unsafe folder path component".into());
        }
        if !seen.insert(relative.to_ascii_lowercase()) {
            return Err("Duplicate folder path (case-insensitive)".into());
        }
        let length = entry["size"].as_u64().ok_or("Invalid file size")?;
        if length > MAX_PACKAGE as u64 { return Err("File exceeds folder package limit".into()); }
        let length = length as usize;
        if length > bytes.len().saturating_sub(offset) { return Err("Truncated folder entry".into()); }
        let digest = entry["sha256"].as_str().ok_or("Missing file checksum")?;
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) ||
            format!("{:x}", Sha256::digest(&bytes[offset..offset + length])) != digest.to_ascii_lowercase() {
            return Err("Invalid folder file SHA-256".into());
        }
        let mut safe_path = PathBuf::new();
        for component in components { safe_path.push(component); }
        parts.push(FolderPart { path: safe_path, offset, size: length });
        offset += length;
    }
    if offset != bytes.len() { return Err("Unaccounted trailing folder content".into()); }
    for name in &seen {
        let components: Vec<&str> = name.split('/').collect();
        for i in 1..components.len() {
            if seen.contains(&components[..i].join("/")) {
                return Err("Folder file conflicts with directory".into());
            }
        }
    }
    Ok(parts)
}

fn verified_name(name: &str) -> Result<String, String> {
    let original = name.strip_suffix(".safolder").ok_or("Selected package must end in .safolder")?;
    if !safe_component(original) { return Err("Unsafe folder name".into()); }
    Ok(original.to_owned())
}

fn store_folder(root: &Path, name: &str, bytes: &[u8], items: &[FolderPart])
    -> Result<(String, usize), String>
{
    if !root.is_dir() { return Err("Selected folder is not a local directory".into()); }
    let guid = uuid::Uuid::new_v4().simple().to_string();
    let stage = root.join(format!(".superagent-folder-{guid}.staging"));
    let final_name = format!("{}-{}", name, &guid[..8]);
    let finished = root.join(&final_name);
    fs::create_dir(&stage).map_err(|_| "Unable to create private import staging folder")?;
    let result = (|| -> Result<(), String> {
        for item in items {
            let dest = stage.join(&item.path);
            if !dest.starts_with(&stage) { return Err("Unsafe folder output path".into()); }
            let parent = dest.parent().ok_or("Missing folder parent")?;
            fs::create_dir_all(parent).map_err(|_| "Could not create output subdirectory")?;
            let mut out = OpenOptions::new().write(true).create_new(true).open(&dest)
                .map_err(|_| "Cannot create unique received file")?;
            out.write_all(&bytes[item.offset..item.offset + item.size])
                .and_then(|_| out.sync_all())
                .map_err(|_| "Received file write failed")?;
        }
        fs::rename(&stage, &finished).map_err(|_| "Could not publish completed folder")?;
        Ok(())
    })();
    if let Err(err) = result {
        let _ = fs::remove_dir_all(&stage);
        return Err(err);
    }
    Ok((final_name, items.len()))
}

#[tauri::command]
pub async fn lan_folder_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    data: String,
    sha256: String,
) -> Result<Value, String> {
    if window.label() != "main" { return Err("Folder picker requires the main Tray window".into()); }
    let safe_name = verified_name(&name)?;
    if data.len() > 5_600_000 || sha256.len() != 64
        || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid folder transfer metadata".into());
    }
    let bytes = STANDARD.decode(data.as_bytes()).map_err(|_| "Invalid folder encoding")?;
    if bytes.is_empty() || bytes.len() > MAX_PACKAGE ||
        format!("{:x}", Sha256::digest(&bytes)) != sha256.to_ascii_lowercase() {
        return Err("Folder transfer SHA-256 mismatch".into());
    }
    // Parse and hash all entry contents BEFORE showing the save picker.
    let files = inspect_folder(&bytes)?;
    let choice = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    }).await.map_err(|_| "Native folder selection failed")?;
    let Some(choice) = choice else { return Ok(json!({"saved":false,"cancelled":true})); };
    let dir = choice.into_path().map_err(|_| "Only local directories are supported")?;
    let (created, count) = store_folder(&dir, &safe_name, &bytes, &files)?;
    Ok(json!({"saved":true,"folder":created,"files":count,"bytes":bytes.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let files: Vec<Value> = entries.iter().map(|(path, content)| json!({
            "path":path, "size":content.len(), "sha256":format!("{:x}",Sha256::digest(content)),
        })).collect();
        let manifest = serde_json::to_vec(&json!({"version":1,"files":files})).unwrap();
        let mut out = MAGIC.to_vec();
        out.extend_from_slice(&(manifest.len() as u32).to_be_bytes());
        out.extend_from_slice(&manifest);
        for (_, bytes) in entries { out.extend_from_slice(bytes); }
        out
    }
    #[test]
    fn verified_nested_import_and_blocks_traversal_and_corruption() {
        let safe = archive(&[("docs/report.txt", b"hello"), ("notes.txt", b"ok")]);
        let parts = inspect_folder(&safe).unwrap();
        assert_eq!(parts.len(),2);
        let temp = std::env::temp_dir().join(format!("sa-folder-test-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&temp).unwrap();
        let (dirname,count) = store_folder(&temp, "Report", &safe, &parts).unwrap();
        assert_eq!(count,2);
        assert_eq!(fs::read(temp.join(dirname).join("docs/report.txt")).unwrap(),b"hello");
        fs::remove_dir_all(temp).unwrap();
        assert!(inspect_folder(&archive(&[("../secret",b"X")])).is_err());
        assert!(inspect_folder(&archive(&[("A.txt",b"1"),("a.txt",b"2")])).is_err());
        let mut corrupt = safe.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(inspect_folder(&corrupt).is_err());
        assert!(!safe_component("CON.txt"));
        assert!(!safe_component(".env"));
        assert!(!safe_component("secret\\path"));
        assert!(verified_name("pack.safolder").is_ok());
        assert!(verified_name("../escape.safolder").is_err());
    }
}
