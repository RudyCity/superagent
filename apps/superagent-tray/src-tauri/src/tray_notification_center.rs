//! Native-owned, durable, bounded incident inbox. Never stores raw prompts,
//! process commands, approval reasons, private paths, credentials or logs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ITEMS: usize = 300;
const MAX_BYTES: u64 = 256 * 1024;
const SOURCES: &[&str] = &[
    "core", "reminder", "security", "runtime", "delegate", "desktop-live",
    "terminal", "lan-devices", "muse-files", "jobs", "updates", "settings",
    "shutdown", "overview", "logs", "mcp", "tunnel",
];
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
    #[serde(default)]
    acknowledged_at: Option<u64>,
    #[serde(default)]
    resolved_at: Option<u64>,
    #[serde(default = "one_occurrence")]
    occurrences: u32,
    #[serde(default)]
    last_seen_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    navigation_revision: Option<String>,
}
fn one_occurrence() -> u32 { 1 }

/// Independent from occurrence timestamps: an explicit Mark unread wins over
/// an older in-flight navigation ACK, even within the same clock tick.
fn advance_navigation_revision(entry: &mut Entry) {
    entry.navigation_revision = Some(uuid::Uuid::new_v4().to_string());
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NavigationTarget {
    pub source: String,
    profile: std::path::PathBuf,
    created_at: u64,
    revision: Option<String>,
    occurrences: u32,
}

fn navigation_target_for_entry(dir: &Path, entry: &Entry) -> Result<NavigationTarget, String> {
    Ok(NavigationTarget {
        source: entry.source.clone(),
        profile: fs::canonicalize(dir).map_err(|_| "Notification profile unavailable")?,
        created_at: entry.created_at,
        revision: entry.navigation_revision.clone(),
        occurrences: entry.occurrences,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPreferences {
    pub min_severity: String,
    pub os_critical: bool,
    pub os_warnings: bool,
    pub categories: Vec<String>,
    pub retention_days: u64,
}
impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            min_severity: "warning".into(),
            os_critical: true,
            os_warnings: false,
            categories: SOURCES.iter().map(|s| (*s).to_owned()).collect(),
            retention_days: 30,
        }
    }
}
impl NotificationPreferences {
    pub fn validate(&self) -> Result<(), String> {
        if !["info", "warning", "critical"].contains(&self.min_severity.as_str()) ||
            ![7, 30, 90].contains(&self.retention_days) ||
            self.categories.len() > SOURCES.len() ||
            self.categories.iter().any(|s| !SOURCES.contains(&s.as_str())) {
            return Err("Invalid notification preferences".into());
        }
        let unique: HashSet<&str> = self.categories.iter().map(String::as_str).collect();
        if unique.len() != self.categories.len() {
            return Err("Duplicate notification categories".into());
        }
        Ok(())
    }
    pub fn os_enabled(&self, source: &str, severity: &str) -> bool {
        let level = |s| match s { "critical" => 2, "warning" => 1, _ => 0 };
        self.categories.iter().any(|s| s == source) &&
            level(severity) >= level(&self.min_severity) &&
            match severity {
                "critical" => self.os_critical,
                "warning" | "info" => self.os_warnings,
                _ => false,
            }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ledger {
    version: u8,
    items: Vec<Entry>,
    #[serde(default)]
    preferences: NotificationPreferences,
    #[serde(default)]
    evicted_count: u64,
}
impl Default for Ledger {
    fn default() -> Self {
        Self { version: 1, items: Vec::new(), preferences: NotificationPreferences::default(), evicted_count: 0 }
    }
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |t| t.as_millis() as u64)
}
fn file(dir: &Path) -> std::path::PathBuf { dir.join("tray-notifications.json") }
fn read(dir: &Path) -> Result<Ledger, String> {
    let path = file(dir);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Ledger::default()),
        Err(_) => return Err("Notification store unavailable".into()),
        Ok(meta) if !meta.file_type().is_file() || meta.len() > MAX_BYTES =>
            return Err("Notification store is not a bounded regular file".into()),
        _ => {}
    }
    let bytes = fs::read(path).map_err(|_| "Cannot read notification store")?;
    let ledger: Ledger = serde_json::from_slice(&bytes).map_err(|_| "Notification store is invalid")?;
    if ledger.version != 1 || ledger.items.len() > MAX_ITEMS ||
        ledger.items.iter().any(|i| i.id.len() > 180 || i.source.len() > 48 ||
            i.title.len() > 160 || i.body.len() > 320 || i.id.chars().any(char::is_control) ||
            !SOURCES.contains(&i.source.as_str()) ||
            !["info", "warning", "critical"].contains(&i.severity.as_str()) ||
            i.occurrences == 0 || i.navigation_revision.as_ref()
                .is_some_and(|revision| uuid::Uuid::parse_str(revision).is_err())) {
        return Err("Notification store failed validation".into());
    }
    ledger.preferences.validate()?;
    Ok(ledger)
}
fn evict_oldest_low_priority(ledger: &mut Ledger) {
    if ledger.items.is_empty() { return; }
    // Preserve active unread critical incidents ahead of archived/read records.
    let choice = ledger.items.iter().rposition(|i|
        i.archived_at.is_some() || i.resolved_at.is_some() || i.read_at.is_some())
        .or_else(|| ledger.items.iter().rposition(|i| i.severity == "info"))
        .or_else(|| ledger.items.iter().rposition(|i| i.severity == "warning"))
        .unwrap_or(ledger.items.len() - 1);
    ledger.items.remove(choice);
    ledger.evicted_count = ledger.evicted_count.saturating_add(1);
}
fn compact(ledger: &mut Ledger) {
    let cutoff = now_ms().saturating_sub(ledger.preferences.retention_days * 86_400_000);
    let before = ledger.items.len();
    ledger.items.retain(|i| {
        let freshest = [i.created_at, i.read_at.unwrap_or(0), i.archived_at.unwrap_or(0),
            i.acknowledged_at.unwrap_or(0), i.resolved_at.unwrap_or(0),
            i.last_seen_at.unwrap_or(0)].into_iter().max().unwrap_or(0);
        freshest >= cutoff ||
            (i.archived_at.is_none() && i.resolved_at.is_none() && i.read_at.is_none())
    });
    ledger.evicted_count = ledger.evicted_count.saturating_add((before - ledger.items.len()) as u64);
    while ledger.items.len() > MAX_ITEMS { evict_oldest_low_priority(ledger); }
}
fn write(dir: &Path, ledger: &mut Ledger) -> Result<(), String> {
    let dest = file(dir);
    if let Ok(meta) = fs::symlink_metadata(&dest) {
        if !meta.file_type().is_file() {
            return Err("Notification store destination is unsafe".into());
        }
    }
    fs::create_dir_all(dir).map_err(|_| "Cannot prepare notification directory")?;
    compact(ledger);
    let mut bytes = serde_json::to_vec(&*ledger).map_err(|_| "Cannot encode notification store")?;
    while bytes.len() as u64 > MAX_BYTES && !ledger.items.is_empty() {
        evict_oldest_low_priority(ledger);
        bytes = serde_json::to_vec(&*ledger).map_err(|_| "Cannot encode notification store")?;
    }
    if bytes.len() as u64 > MAX_BYTES { return Err("Notification store is too large".into()); }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock unavailable")?.as_nanos();
    let temp = dir.join(format!("tray-notifications-{}-{nanos}.tmp", std::process::id()));
    let mut output = OpenOptions::new().create_new(true).write(true).open(&temp)
        .map_err(|_| "Cannot stage notification store")?;
    if output.write_all(&bytes).and_then(|_| output.sync_all()).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Cannot persist notification store".into());
    }
    drop(output);
    // Never follow a symlink introduced since the initial destination inspection.
    if let Ok(meta) = fs::symlink_metadata(&dest) {
        if !meta.file_type().is_file() {
            let _ = fs::remove_file(&temp);
            return Err("Notification store destination changed".into());
        }
    }
    if fs::rename(&temp, &dest).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Cannot replace notification store".into());
    }
    Ok(())
}
fn snapshot(ledger: &Ledger) -> Value {
    json!({
        "items": ledger.items,
        "unreadCount": ledger.items.iter().filter(|n|
            n.read_at.is_none() && n.archived_at.is_none()).count(),
        "openCount": ledger.items.iter().filter(|n|
            n.resolved_at.is_none() && n.archived_at.is_none()).count(),
        "evictedCount": ledger.evicted_count,
        "preferences": ledger.preferences,
    })
}
/// Native producers supply fixed public copy and an incident identity.
/// A repeated active incident is deduplicated; a resolved incident can reopen.
pub fn publish(
    dir: &Path, source: &str, severity: &str, id: &str, title: &str, body: &str,
) -> Result<bool, String> {
    if !SOURCES.contains(&source) ||
        !["info", "warning", "critical"].contains(&severity) ||
        id.is_empty() || id.len() > 180 || id.chars().any(char::is_control) {
        return Err("Unsupported notification event".into());
    }
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let now = now_ms();
    if let Some(item) = ledger.items.iter_mut().find(|i| i.id == id) {
        if item.resolved_at.is_none() { return Ok(false); }
        item.resolved_at = None;
        item.acknowledged_at = None;
        item.read_at = None;
        item.archived_at = None;
        item.last_seen_at = Some(now);
        advance_navigation_revision(item);
        item.occurrences = item.occurrences.saturating_add(1);
        write(dir, &mut ledger)?;
        return Ok(true);
    }
    let trim = |value: &str, limit: usize| -> String {
        value.chars().filter(|c| !c.is_control()).take(limit).collect()
    };
    ledger.items.insert(0, Entry {
        id: id.into(), source: source.into(), severity: severity.into(),
        title: trim(title, 80), body: trim(body, 160), created_at: now,
        read_at: None, archived_at: None, acknowledged_at: None,
        resolved_at: None, occurrences: 1, last_seen_at: None,
        navigation_revision: Some(uuid::Uuid::new_v4().to_string()),
    });
    write(dir, &mut ledger)?;
    Ok(true)
}
pub fn resolve(dir: &Path, id: &str) -> Result<bool, String> {
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let Some(entry) = ledger.items.iter_mut().find(|n| n.id == id) else { return Ok(false); };
    if entry.resolved_at.is_some() { return Ok(false); }
    entry.resolved_at = Some(now_ms());
    advance_navigation_revision(entry);
    write(dir, &mut ledger)?;
    Ok(true)
}
/// Reconcile only a complete, authenticated projection. Never infer a denied
/// approval from a missing network response, unverified owner or partial page.
pub fn resolve_missing(
    dir: &Path, prefix: &str, active: &HashSet<String>,
) -> Result<usize, String> {
    if !["mcp-pending:", "health:"].contains(&prefix) { return Err("Unsupported incident group".into()); }
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let now = now_ms();
    let mut changed = 0;
    for item in &mut ledger.items {
        if item.id.starts_with(prefix) && item.resolved_at.is_none() && !active.contains(&item.id) {
            item.resolved_at = Some(now);
            advance_navigation_revision(item);
            changed += 1;
        }
    }
    if changed > 0 { write(dir, &mut ledger)?; }
    Ok(changed)
}
/// Only native-published, currently active inbox items are eligible for a
/// bounded navigation ticket. This never exposes title/body or file paths.
pub fn navigation_target(dir: &Path, id: &str) -> Result<Option<NavigationTarget>, String> {
    if id.is_empty() || id.len() > 180 || id.chars().any(char::is_control) {
        return Ok(None);
    }
    let _guard=LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let ledger=read(dir)?;
    ledger.items.iter().find(|entry|
        entry.id == id && entry.archived_at.is_none() && entry.resolved_at.is_none())
        .map(|entry| navigation_target_for_entry(dir, entry)).transpose()
}
/// Revalidate and persist under the same ledger lock. A backend await must not
/// read a replacement occurrence, a reopened item or an explicit Mark unread.
pub fn mark_navigation_read(dir: &Path, id: &str, target: &NavigationTarget,
    expires_at: std::time::Instant) -> Result<bool, String> {
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let Some(entry) = ledger.items.iter_mut().find(|entry|
        entry.id == id && entry.archived_at.is_none() && entry.resolved_at.is_none())
        else { return Ok(false); };
    if navigation_target_for_entry(dir, entry)? != *target ||
        std::time::Instant::now() >= expires_at { return Ok(false); }
    if entry.read_at.is_none() {
        entry.read_at = Some(now_ms());
        advance_navigation_revision(entry);
        write(dir, &mut ledger)?;
    }
    Ok(true)
}
pub fn should_notify_os(dir: &Path, source: &str, severity: &str) -> Result<bool, String> {
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    Ok(read(dir)?.preferences.os_enabled(source, severity))
}
pub fn save_preferences(dir: &Path, preferences: NotificationPreferences) -> Result<Value, String> {
    preferences.validate()?;
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    ledger.preferences = preferences;
    write(dir, &mut ledger)?;
    Ok(snapshot(&ledger))
}
/// All changes require the local foreground Tray. The browser cannot publish events.
pub fn perform(dir: &Path, action: &str, id: Option<&str>) -> Result<Value, String> {
    if !["list", "read", "unread", "archive", "restore", "read-all", "archive-read",
        "acknowledge", "resolve", "reopen"].contains(&action) {
        return Err("Unsupported notification action".into());
    }
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    if action == "list" {
        let before = ledger.items.len();
        compact(&mut ledger);
        if ledger.items.len() != before { write(dir, &mut ledger)?; }
        return Ok(snapshot(&ledger));
    }
    let now = now_ms();
    let mut changed = false;
    if ["read", "unread", "archive", "restore", "acknowledge", "resolve", "reopen"].contains(&action) {
        let key = id.filter(|id| !id.is_empty() && id.len() <= 180)
            .ok_or("Notification ID required")?;
        let item = ledger.items.iter_mut().find(|item| item.id == key)
            .ok_or("Notification not found")?;
        // An explicit interaction with an incident also reads it. Preserve
        // "Mark unread" as the sole intentional exception. Apply both changes
        // in the same native ledger write so they cannot diverge.
        if action != "unread" && item.read_at.is_none() {
            item.read_at = Some(now);
            changed = true;
        }
        match action {
            "unread" if item.read_at.is_some() => { item.read_at = None; changed = true; },
            "archive" if item.archived_at.is_none() => { item.archived_at = Some(now); changed = true; },
            "restore" if item.archived_at.is_some() => { item.archived_at = None; changed = true; },
            "acknowledge" if item.acknowledged_at.is_none() && item.resolved_at.is_none() => {
                item.acknowledged_at = Some(now); changed = true;
            },
            "resolve" if item.resolved_at.is_none() => { item.resolved_at = Some(now); changed = true; },
            "reopen" if item.resolved_at.is_some() => {
                item.resolved_at = None; item.acknowledged_at = None; changed = true;
            },
            _ => {},
        }
        if changed || action == "unread" {
            advance_navigation_revision(item);
            changed = true;
        }
    } else {
        for item in &mut ledger.items {
            if item.archived_at.is_some() { continue; }
            if action == "read-all" && item.read_at.is_none() {
                item.read_at = Some(now); advance_navigation_revision(item); changed = true;
            } else if action == "archive-read" && item.read_at.is_some() {
                item.archived_at = Some(now); advance_navigation_revision(item); changed = true;
            }
        }
    }
    if changed { write(dir, &mut ledger)?; }
    Ok(snapshot(&ledger))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn isolated() -> std::path::PathBuf {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("superagent-notification-test-{}-{n}", std::process::id()))
    }
    #[test]
    fn persists_dedupes_reopens_and_resolves_incidents() {
        let dir = isolated();
        assert_eq!(perform(&dir, "list", None).unwrap()["unreadCount"], 0);
        assert!(publish(&dir, "core", "critical", "core-1", "Core offline", "Check runtime").unwrap());
        assert!(!publish(&dir, "core", "critical", "core-1", "duplicate", "duplicate").unwrap());
        assert_eq!(perform(&dir, "acknowledge", Some("core-1")).unwrap()["unreadCount"], 0);
        assert!(resolve(&dir, "core-1").unwrap());
        assert!(!resolve(&dir, "core-1").unwrap());
        assert!(publish(&dir, "core", "critical", "core-1", "Core offline", "Check runtime").unwrap());
        assert_eq!(perform(&dir, "list", None).unwrap()["items"][0]["occurrences"], 2);
        assert_eq!(perform(&dir, "unread", Some("core-1")).unwrap()["unreadCount"], 1);
        assert_eq!(perform(&dir, "read-all", None).unwrap()["unreadCount"], 0);
        assert_eq!(perform(&dir, "archive-read", None).unwrap()["items"][0]["archivedAt"].is_null(), false);
        assert_eq!(perform(&dir, "restore", Some("core-1")).unwrap()["items"][0]["archivedAt"], Value::Null);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn incident_buttons_are_read_in_one_persisted_transaction() {
        let dir = isolated();
        for action in ["read", "archive", "acknowledge", "resolve"] {
            publish(&dir, "core", "warning", action, "Issue", "Open incident").unwrap();
            let snapshot = perform(&dir, action, Some(action)).unwrap();
            assert!(!snapshot["items"].as_array().unwrap().iter()
                .find(|entry| entry["id"] == action).unwrap()["readAt"].is_null(),
                "{action} must mark the notification read");
        }

        // Undoing an archive or reopening an incident is still an interaction,
        // not a request to reset the unread badge.
        perform(&dir, "unread", Some("archive")).unwrap();
        let restored = perform(&dir, "restore", Some("archive")).unwrap();
        assert_eq!(restored["items"].as_array().unwrap().iter()
            .find(|entry| entry["id"] == "archive").unwrap()["readAt"].is_null(), false);
        perform(&dir, "unread", Some("resolve")).unwrap();
        let reopened = perform(&dir, "reopen", Some("resolve")).unwrap();
        assert_eq!(reopened["items"].as_array().unwrap().iter()
            .find(|entry| entry["id"] == "resolve").unwrap()["readAt"].is_null(), false);

        // The deliberately explicit Mark unread control remains available.
        assert_eq!(perform(&dir, "unread", Some("read")).unwrap()["items"]
            .as_array().unwrap().iter().find(|entry| entry["id"] == "read")
            .unwrap()["readAt"], Value::Null);
        let persisted = perform(&dir, "list", None).unwrap();
        assert_eq!(persisted["unreadCount"], 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reconciles_complete_security_inventory_without_erasing_history() {
        let dir = isolated();
        publish(&dir, "security", "critical", "mcp-pending:one", "Pending", "Review").unwrap();
        publish(&dir, "security", "critical", "mcp-pending:two", "Pending", "Review").unwrap();
        let mut active = HashSet::new();
        active.insert("mcp-pending:one".to_owned());
        assert_eq!(resolve_missing(&dir, "mcp-pending:", &active).unwrap(), 1);
        let rows = perform(&dir, "list", None).unwrap();
        assert_eq!(rows["items"][0]["id"], "mcp-pending:two");
        assert!(!rows["items"][0]["resolvedAt"].is_null());
        assert!(resolve_missing(&dir, "arbitrary:", &active).is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn bounds_oversized_history_without_losing_all_critical_incidents() {
        let dir = isolated();
        let mut ledger = Ledger::default();
        let now = now_ms();
        for i in 0..MAX_ITEMS {
            ledger.items.push(Entry {
                id: format!("{}-{i}", "I".repeat(160)),
                source: "core".into(), severity: "critical".into(),
                title: '"'.to_string().repeat(160), body: '\\'.to_string().repeat(320),
                created_at: now, read_at: None, archived_at: None,
                acknowledged_at: None, resolved_at: None,
                occurrences: 1, last_seen_at: None, navigation_revision: None,
            });
        }
        write(&dir, &mut ledger).unwrap();
        let stored = read(&dir).unwrap();
        assert!(!stored.items.is_empty());
        assert!(stored.items.len() < MAX_ITEMS);
        assert!(stored.evicted_count > 0);
        assert!(fs::metadata(file(&dir)).unwrap().len() <= MAX_BYTES);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn migrates_legacy_inbox_without_dropping_records() {
        let dir = isolated();
        fs::create_dir_all(&dir).unwrap();
        fs::write(file(&dir), r#"{"version":1,"items":[{"id":"old","source":"core",
            "severity":"warning","title":"Old","body":"Old message","createdAt":1,
            "readAt":null,"archivedAt":null}]}"#).unwrap();
        let result = perform(&dir, "list", None).unwrap();
        assert_eq!(result["items"][0]["id"], "old");
        assert_eq!(result["items"][0]["occurrences"], 1);
        assert_eq!(result["preferences"]["minSeverity"], "warning");
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn validates_preferences_and_refuses_corrupted_storage() {
        let dir = isolated();
        assert!(publish(&dir, "arbitrary", "critical", "x", "x", "x").is_err());
        assert!(publish(&dir, "core", "critical", "bad\nid", "x", "x").is_err());
        assert!(perform(&dir, "delete-all", None).is_err());
        let mut prefs = NotificationPreferences::default();
        prefs.categories = vec!["core".into(), "core".into()];
        assert!(save_preferences(&dir, prefs).is_err());
        let mut prefs = NotificationPreferences::default();
        prefs.os_critical = false;
        assert!(!prefs.os_enabled("core", "critical"));
        prefs.os_critical = true;
        assert!(prefs.os_enabled("core", "critical"));
        save_preferences(&dir, prefs).unwrap();
        fs::write(file(&dir), b"invalid json").unwrap();
        assert!(perform(&dir, "list", None).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
