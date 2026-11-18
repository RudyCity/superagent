//! Native-owned, durable, bounded incident inbox. Never stores raw prompts,
//! process commands, approval reasons, private paths, credentials or logs.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
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
    #[serde(default)]
    snoozed_until: Option<u64>,
    #[serde(default)]
    action_started_at: Option<u64>,
    #[serde(default)]
    expired_at: Option<u64>,
    // Stable, native-provided device identity; never derived from user-facing copy.
    #[serde(default)]
    device_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuditEvent {
    at: u64,
    action: String,
    item_id: String,
    source: String,
}
fn audit(ledger: &mut Ledger, action: &str, item_id: &str, source: &str) {
    ledger.history.insert(0, AuditEvent {
        at: now_ms(), action: action.into(), item_id: item_id.into(), source: source.into(),
    });
    ledger.history.truncate(120);
}
fn kind_of(item: &Entry) -> &'static str {
    if item.resolved_at.is_none() && item.severity != "info" { "action" } else { "information" }
}
fn action_status(item: &Entry) -> &'static str {
    if item.expired_at.is_some() { "expired" }
    else if item.resolved_at.is_some() { "resolved" }
    else if item.action_started_at.is_some() { "in_progress" }
    else { "pending" }
}
fn managed(item: &Entry) -> bool {
    item.id.starts_with("mcp-pending:") || item.id.starts_with("health:")
}
fn one_occurrence() -> u32 { 1 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPreferences {
    pub min_severity: String,
    pub os_critical: bool,
    pub os_warnings: bool,
    pub categories: Vec<String>,
    pub retention_days: u64,
    #[serde(default)]
    pub source_levels: BTreeMap<String, String>,
    #[serde(default)]
    pub dnd_enabled: bool,
    #[serde(default)]
    pub dnd_until: Option<u64>,
    #[serde(default = "enabled_by_default")]
    pub dnd_critical_bypass: bool,
    #[serde(default)]
    pub digest_enabled: bool,
    #[serde(default)]
    pub digest_next_at: Option<u64>,
}
fn enabled_by_default() -> bool { true }
impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            min_severity: "warning".into(),
            os_critical: true,
            os_warnings: false,
            categories: SOURCES.iter().map(|s| (*s).to_owned()).collect(),
            retention_days: 30,
            source_levels: BTreeMap::new(),
            dnd_enabled: false,
            dnd_until: None,
            dnd_critical_bypass: true,
            digest_enabled: false,
            digest_next_at: None,
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
        if self.source_levels.len() > SOURCES.len() ||
            self.source_levels.iter().any(|(key, level)|
                !SOURCES.contains(&key.as_str()) ||
                !["info", "warning", "critical", "off"].contains(&level.as_str())) {
            return Err("Invalid notification source rule".into());
        }
        if self.dnd_until.is_some_and(|v| v > 4_102_444_800_000) ||
            self.digest_next_at.is_some_and(|v| v > 4_102_444_800_000) {
            return Err("Invalid notification schedule".into());
        }
        Ok(())
    }
    pub fn os_enabled(&self, source: &str, severity: &str) -> bool {
        let level = |s| match s { "critical" => 2, "warning" => 1, _ => 0 };
        let dnd_active = self.dnd_enabled &&
            self.dnd_until.map_or(true, |until| now_ms() < until);
        let bypass = self.dnd_critical_bypass && source == "security" && severity == "critical";
        let min = self.source_levels.get(source).map(String::as_str)
            .unwrap_or(self.min_severity.as_str());
        self.categories.iter().any(|s| s == source) &&
            min != "off" && level(severity) >= level(min) &&
            (!dnd_active || bypass) &&
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
    #[serde(default)]
    history: Vec<AuditEvent>,
    #[serde(default)]
    last_digest_at: Option<u64>,
}
impl Default for Ledger {
    fn default() -> Self {
        Self { version: 1, items: Vec::new(), preferences: NotificationPreferences::default(), evicted_count: 0, history: Vec::new(), last_digest_at: None }
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
            i.occurrences == 0 ||
            i.device_id.as_ref().is_some_and(|d| d.len() > 64 || d.is_empty() ||
                !d.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))) ||
        ledger.history.len() > 120 ||
        ledger.history.iter().any(|event|
            event.item_id.len() > 180 || event.action.len() > 40 ||
            !SOURCES.contains(&event.source.as_str())) {
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
    ledger.history.truncate(120);
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
    while bytes.len() as u64 > MAX_BYTES && !ledger.history.is_empty() {
        ledger.history.pop();
        bytes = serde_json::to_vec(&*ledger).map_err(|_| "Cannot encode notification store")?;
    }
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
    let now = now_ms();
    let items: Vec<Value> = ledger.items.iter().map(|item| {
        let mut value = serde_json::to_value(item).expect("serializable entry");
        value["kind"] = json!(kind_of(item));
        value["actionStatus"] = json!(action_status(item));
        value["isSnoozed"] = json!(item.snoozed_until.is_some_and(|until| until > now));
        value
    }).collect();
    let recent = ledger.items.iter().filter(|n| n.created_at >= now.saturating_sub(86_400_000));
    let (mut last_day_actions, mut last_day_information) = (0, 0);
    for item in recent {
        if kind_of(item) == "action" { last_day_actions += 1; }
        else { last_day_information += 1; }
    }
    json!({
        "items": items,
        "unreadCount": ledger.items.iter().filter(|n|
            n.read_at.is_none() && n.archived_at.is_none()).count(),
        "actionCount": ledger.items.iter().filter(|n|
            n.archived_at.is_none() && kind_of(n) == "action").count(),
        "openCount": ledger.items.iter().filter(|n|
            n.resolved_at.is_none() && n.archived_at.is_none()).count(),
        "evictedCount": ledger.evicted_count,
        "preferences": ledger.preferences,
        "history": ledger.history,
        "digest": {
            "last24hAction": last_day_actions,
            "last24hInformation": last_day_information,
            "lastSentAt": ledger.last_digest_at
        }
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
        item.action_started_at = None;
        item.expired_at = None;
        item.snoozed_until = None;
        item.read_at = None;
        item.archived_at = None;
        item.last_seen_at = Some(now);
        item.occurrences = item.occurrences.saturating_add(1);
        audit(&mut ledger, "reopened", id, source);
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
        snoozed_until: None, action_started_at: None, expired_at: None,
        device_id: Some("local".into()),
    });
    audit(&mut ledger, "created", id, source);
    write(dir, &mut ledger)?;
    Ok(true)
}
pub fn resolve(dir: &Path, id: &str) -> Result<bool, String> {
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let Some(entry) = ledger.items.iter_mut().find(|n| n.id == id) else { return Ok(false); };
    if entry.resolved_at.is_some() { return Ok(false); }
    entry.resolved_at = Some(now_ms());
    let source = entry.source.clone();
    audit(&mut ledger, "auto_resolved", id, &source);
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
    let mut completed = Vec::new();
    for item in &mut ledger.items {
        if item.id.starts_with(prefix) && item.resolved_at.is_none() && !active.contains(&item.id) {
            item.resolved_at = Some(now);
            completed.push((item.id.clone(), item.source.clone()));
        }
    }
    for (id, source) in &completed { audit(&mut ledger, "auto_resolved", id, source); }
    if !completed.is_empty() { write(dir, &mut ledger)?; }
    Ok(completed.len())
}
/// Only native-published, currently active inbox items are eligible for a
/// bounded navigation ticket. This never exposes title/body or file paths.
pub fn navigation_source(dir: &Path, id: &str) -> Result<Option<String>, String> {
    if id.is_empty() || id.len() > 180 || id.chars().any(char::is_control) {
        return Ok(None);
    }
    let _guard=LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let ledger=read(dir)?;
    Ok(ledger.items.iter().find(|entry|
        entry.id == id && entry.archived_at.is_none() && entry.resolved_at.is_none())
        .map(|entry|entry.source.clone()))
}
/// Only an authenticated native producer may associate a notification with a
/// verified remote device. Existing local incidents have deviceId=local.
pub fn publish_for_device(
    dir: &Path, source: &str, severity: &str, id: &str,
    title: &str, body: &str, device_id: &str,
) -> Result<bool, String> {
    if device_id.is_empty() || device_id.len() > 64 ||
        !device_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) {
        return Err("Invalid verified device ID".into());
    }
    let created = publish(dir, source, severity, id, title, body)?;
    if created {
        let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
        let mut ledger = read(dir)?;
        if let Some(entry) = ledger.items.iter_mut().find(|entry| entry.id == id) {
            entry.device_id = Some(device_id.into());
        }
        write(dir, &mut ledger)?;
    }
    Ok(created)
}
/// Status changes must be supported by the authenticated native request inventory.
pub fn expire_verified(dir: &Path, id: &str) -> Result<bool, String> {
    if !id.starts_with("mcp-pending:") { return Err("Unsupported expiry source".into()); }
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let Some(entry) = ledger.items.iter_mut().find(|item| item.id == id) else { return Ok(false); };
    if entry.resolved_at.is_some() { return Ok(false); }
    let now = now_ms();
    entry.resolved_at = Some(now);
    entry.expired_at = Some(now);
    let source = entry.source.clone();
    audit(&mut ledger, "expired_verified", id, &source);
    write(dir, &mut ledger)?;
    Ok(true)
}
/// Native periodic digest claims a due schedule once, before OS delivery.
pub fn take_daily_digest(dir: &Path) -> Result<Option<(usize, usize)>, String> {
    let _guard = LEDGER_LOCK.lock().map_err(|_| "Notification store locked")?;
    let mut ledger = read(dir)?;
    let now = now_ms();
    if !ledger.preferences.digest_enabled ||
        !ledger.preferences.digest_next_at.is_some_and(|at| at <= now) {
        return Ok(None);
    }
    let since = now.saturating_sub(86_400_000);
    let action = ledger.items.iter().filter(|n|
        n.created_at >= since && kind_of(n) == "action").count();
    let information = ledger.items.iter().filter(|n|
        n.created_at >= since && kind_of(n) == "information").count();
    ledger.last_digest_at = Some(now);
    ledger.preferences.digest_next_at = Some(now.saturating_add(86_400_000));
    write(dir, &mut ledger)?;
    Ok(Some((action, information)))
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
        "acknowledge", "resolve", "reopen", "in-progress", "pause-work",
        "snooze-15m", "snooze-1h", "snooze-1d", "unsnooze"].contains(&action) {
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
    if ["read", "unread", "archive", "restore", "acknowledge", "resolve", "reopen",
        "in-progress", "pause-work", "snooze-15m", "snooze-1h", "snooze-1d",
        "unsnooze"].contains(&action) {
        let key = id.filter(|id| !id.is_empty() && id.len() <= 180)
            .ok_or("Notification ID required")?;
        let item = ledger.items.iter_mut().find(|item| item.id == key)
            .ok_or("Notification not found")?;
        if managed(item) && ["resolve", "reopen"].contains(&action) {
            return Err("Managed incidents require verified native resolution".into());
        }
        let source = item.source.clone();
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
                item.resolved_at = None; item.acknowledged_at = None;
                item.expired_at = None; item.action_started_at = None; changed = true;
            },
            "in-progress" if item.resolved_at.is_none() && item.action_started_at.is_none() => {
                item.action_started_at = Some(now); changed = true;
            },
            "pause-work" if item.resolved_at.is_none() && item.action_started_at.is_some() => {
                item.action_started_at = None; changed = true;
            },
            "snooze-15m" | "snooze-1h" | "snooze-1d" if item.resolved_at.is_none() => {
                let duration = match action {
                    "snooze-15m" => 900_000, "snooze-1h" => 3_600_000, _ => 86_400_000,
                };
                item.snoozed_until = Some(now.saturating_add(duration)); changed = true;
            },
            "unsnooze" if item.snoozed_until.is_some() => {
                item.snoozed_until = None; changed = true;
            },
            _ => {},
        }
        if changed { audit(&mut ledger, action, key, &source); }
    } else {
        for item in &mut ledger.items {
            if item.archived_at.is_some() { continue; }
            if action == "read-all" && item.read_at.is_none() {
                item.read_at = Some(now); changed = true;
            } else if action == "archive-read" && item.read_at.is_some() {
                item.archived_at = Some(now); changed = true;
            }
        }
    }
    if changed {
        if action == "read-all" || action == "archive-read" {
            audit(&mut ledger, action, "bulk", "overview");
        }
        write(dir, &mut ledger)?;
    }
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
                occurrences: 1, last_seen_at: None,
                snoozed_until: None, action_started_at: None,
                expired_at: None, device_id: Some("local".into()),
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
