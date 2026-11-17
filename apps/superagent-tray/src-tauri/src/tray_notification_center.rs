//! Bounded, local-only inbox for operational Tray events.
//! The browser can acknowledge/archive entries, but cannot submit arbitrary
//! titles or bodies. Native event producers own trusted notification content.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ITEMS: usize = 300;
const MAX_BYTES: u64 = 256 * 1024;
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    id: String,
    source: String,
    severity: String,
    title: String,
    body: String,
    created_at: u64,
    read_at: Option<u64>,
    archived_at: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    items: Vec<Entry>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_millis() as u64)
}

fn file(dir: &Path) -> std::path::PathBuf {
    dir.join("tray-notifications.json")
}

fn read(dir: &Path) -> Result<Ledger, String> {
    let path = file(dir);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound =>
            return Ok(Ledger { version: 1, items: Vec::new() }),
        Err(_) => return Err("Notification store unavailable".into()),
        Ok(meta) if !meta.file_type().is_file() || meta.len() > MAX_BYTES =>
            return Err("Notification store is not a bounded regular file".into()),
        _ => {}
    }
    let bytes = fs::read(path).map_err(|_| "Cannot read notification store")?;
    let ledger: Ledger = serde_json::from_slice(&bytes)
        .map_err(|_| "Notification store is invalid")?;
    if ledger.version != 1 || ledger.items.len() > MAX_ITEMS ||
        ledger.items.iter().any(|i| i.id.len() > 180 || i.source.len() > 48 ||
            i.title.len() > 160 || i.body.len() > 320 ||
            !["info", "warning", "critical"].contains(&i.severity.as_str())) {
        return Err("Notification store failed validation".into());
    }
    Ok(ledger)
}

fn write(dir: &Path, ledger: &Ledger) -> Result<(), String> {
    let dest = file(dir);
    if let Ok(meta) = fs::symlink_metadata(&dest) {
        if !meta.file_type().is_file() {
            return Err("Notification store destination is unsafe".into());
        }
    }
    fs::create_dir_all(dir).map_err(|_| "Cannot prepare notification directory")?;
    let bytes = serde_json::to_vec(ledger).map_err(|_| "Cannot encode notification store")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Notification store is too large".into());
    }
    let temp = dir.join(format!("tray-notifications-{}-{}.tmp", std::process::id(), now_ms()));
    let mut output = OpenOptions::new().create_new(true).write(true).open(&temp)
        .map_err(|_| "Cannot stage notification store")?;
    if output.write_all(&bytes).and_then(|_| output.sync_all()).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Cannot persist notification store".into());
    }
    drop(output);
    if fs::rename(&temp, &dest).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Cannot replace notification store".into());
    }
    Ok(())
}

fn snapshot(ledger: &Ledger) -> Value {
    let unread = ledger.items.iter()
        .filter(|n| n.read_at.is_none() && n.archived_at.is_none()).count();
    json!({ "items": ledger.items, "unreadCount": unread })
}

/// Native producers supply category, stable event key and bounded public UI copy.
/// Repeated events with the same key are not re-added, including after restarts.
pub fn publish(
    dir: &Path, source: &str, severity: &str, id: &str, title: &str, body: &str,
) -> Result<bool, String> {
    if !["core", "reminder", "security", "runtime", "delegate", "desktop-live",
        "terminal", "lan-devices", "muse-files", "jobs", "updates", "settings",
        "shutdown", "overview", "logs"].contains(&source) ||
        !["info", "warning", "critical"].contains(&severity) ||
        id.is_empty() || id.len() > 180 || id.chars().any(char::is_control) {
        return Err("Unsupported notification event".into());
    }
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    if ledger.items.iter().any(|item| item.id == id) { return Ok(false); }
    let trim = |value: &str, limit: usize| -> String {
        value.chars().filter(|c| !c.is_control()).take(limit).collect()
    };
    ledger.items.insert(0, Entry {
        id: id.into(), source: source.into(), severity: severity.into(),
        title: trim(title, 80), body: trim(body, 160),
        created_at: now_ms(), read_at: None, archived_at: None,
    });
    ledger.items.truncate(MAX_ITEMS);
    write(dir, &ledger)?;
    Ok(true)
}

/// Read and acknowledge only; no browser-controlled notification insertion.
pub fn perform(dir: &Path, action: &str, id: Option<&str>) -> Result<Value, String> {
    if !["list", "read", "unread", "archive", "restore", "read-all",
          "archive-read"].contains(&action) {
        return Err("Unsupported notification action".into());
    }
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    if action == "list" { return Ok(snapshot(&ledger)); }
    let now = now_ms();
    let mut changed = false;
    if ["read", "unread", "archive", "restore"].contains(&action) {
        let key = id.filter(|id| !id.is_empty() && id.len() <= 180)
            .ok_or("Notification ID required")?;
        let entry = ledger.items.iter_mut().find(|entry| entry.id == key)
            .ok_or("Notification not found")?;
        match action {
            "read" if entry.read_at.is_none() => { entry.read_at = Some(now); changed = true; },
            "unread" if entry.read_at.is_some() => { entry.read_at = None; changed = true; },
            "archive" if entry.archived_at.is_none() => {
                entry.archived_at = Some(now); changed = true;
            },
            "restore" if entry.archived_at.is_some() => {
                entry.archived_at = None; changed = true;
            },
            _ => {}
        }
    } else {
        for entry in &mut ledger.items {
            if entry.archived_at.is_some() { continue; }
            if action == "read-all" && entry.read_at.is_none() {
                entry.read_at = Some(now); changed = true;
            } else if action == "archive-read" && entry.read_at.is_some() {
                entry.archived_at = Some(now); changed = true;
            }
        }
    }
    if changed { write(dir, &ledger)?; }
    Ok(snapshot(&ledger))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn isolated() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "superagent-notification-test-{}-{}", std::process::id(), now_ms()
        ))
    }
    #[test]
    fn retains_inbox_across_reads_dedupes_and_acknowledges() {
        let dir = isolated();
        assert_eq!(perform(&dir, "list", None).unwrap()["unreadCount"], 0);
        assert!(publish(&dir, "core", "critical", "core-1", "Core offline", "Check runtime").unwrap());
        assert!(!publish(&dir, "core", "critical", "core-1", "duplicate", "duplicate").unwrap());
        assert_eq!(perform(&dir, "list", None).unwrap()["unreadCount"], 1);
        assert_eq!(perform(&dir, "read", Some("core-1")).unwrap()["unreadCount"], 0);
        assert_eq!(perform(&dir, "unread", Some("core-1")).unwrap()["unreadCount"], 1);
        assert_eq!(perform(&dir, "read-all", None).unwrap()["unreadCount"], 0);
        assert_eq!(perform(&dir, "archive-read", None).unwrap()["items"][0]["archivedAt"].is_null(), false);
        assert_eq!(perform(&dir, "restore", Some("core-1")).unwrap()["items"][0]["archivedAt"], Value::Null);
        assert!(perform(&dir, "archive", Some("missing")).is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn rejects_invalid_store_and_untrusted_producers() {
        let dir = isolated();
        assert!(publish(&dir, "arbitrary", "critical", "x", "x", "x").is_err());
        assert!(publish(&dir, "core", "critical", "bad\nid", "x", "x").is_err());
        assert!(perform(&dir, "delete-all", None).is_err());
        fs::create_dir_all(&dir).unwrap();
        fs::write(file(&dir), b"invalid json").unwrap();
        assert!(perform(&dir, "list", None).is_err());
        assert!(publish(&dir, "core", "info", "x", "x", "x").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
