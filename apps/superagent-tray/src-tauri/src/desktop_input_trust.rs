//! Operator-owned Trusted Desktop Input preferences.
//!
//! Persisting a target authorizes ONLY a fresh native host approval prompt in
//! Core. This document never grants native mouse/keyboard input on its own.
//! Entries bind to an exact PID + native window identity + observed app/title,
//! expire within 30 minutes, and can be revoked from the Tray at any time.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_TARGETS: usize = 16;
pub const MAX_LIFETIME_MS: u64 = 30 * 60_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedTarget {
    pub pid: u32,
    pub native_id: String,
    pub title: String,
    pub application: String,
    pub approved_at: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopInputPolicy {
    pub version: u8,
    pub mode: String,
    pub targets: Vec<TrustedTarget>,
}
impl Default for DesktopInputPolicy {
    fn default() -> Self {
        Self {
            version: 1,
            mode: "trusted".into(),
            targets: vec![],
        }
    }
}
pub fn now_ms() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Host clock unavailable")?;
    u64::try_from(duration.as_millis()).map_err(|_| "Host clock invalid".into())
}
fn descriptor(value: &str, max_len: usize) -> bool {
    !value.trim().is_empty()
        && value.trim() == value
        && value.len() <= max_len
        && !value.chars().any(|c| c.is_control())
}
impl TrustedTarget {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        if self.pid == 0
            || !descriptor(&self.native_id, 256)
            || !descriptor(&self.application, 256)
            || !descriptor(&self.title, 512)
            || self.expires_at <= self.approved_at
            || self.expires_at - self.approved_at > MAX_LIFETIME_MS
            || self.expires_at > now.saturating_add(MAX_LIFETIME_MS)
            || self.approved_at > now.saturating_add(60_000)
        {
            return Err("Trusted desktop window identity or expiry invalid".into());
        }
        Ok(())
    }
}
impl DesktopInputPolicy {
    pub fn validate(&self, now: u64) -> Result<(), String> {
        if self.version != 1
            || !["trusted", "off"].contains(&self.mode.as_str())
            || self.targets.len() > MAX_TARGETS
        {
            return Err("Trusted desktop input policy invalid".into());
        }
        let mut identities = std::collections::HashSet::new();
        for target in &self.targets {
            target.validate(now)?;
            if !identities.insert((target.pid, target.native_id.as_str())) {
                return Err("Duplicate trusted window identity".into());
            }
        }
        if self.mode == "off" && !self.targets.is_empty() {
            return Err("Disabled trusted mode cannot retain target approvals".into());
        }
        Ok(())
    }
}
pub fn policy_path(dir: &Path) -> PathBuf {
    dir.join("desktop-input-trusted.json")
}
pub fn load(dir: &Path) -> Result<DesktopInputPolicy, String> {
    let file = policy_path(dir);
    let metadata = match fs::symlink_metadata(&file) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DesktopInputPolicy::default())
        }
        Err(_) => return Err("Trusted input policy cannot be inspected".into()),
    };
    if !metadata.file_type().is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 16384
        || metadata.len() < 2
    {
        return Err("Trusted input policy must be a bounded regular file".into());
    }
    let bytes = fs::read(&file).map_err(|_| "Trusted input policy unreadable")?;
    let policy: DesktopInputPolicy =
        serde_json::from_slice(&bytes).map_err(|_| "Trusted input policy JSON invalid")?;
    let now = now_ms()?;
    policy.validate(now)?;
    Ok(DesktopInputPolicy {
        targets: policy
            .targets
            .into_iter()
            .filter(|t| t.expires_at > now)
            .collect(),
        ..policy
    })
}
pub fn save(dir: &Path, policy: &DesktopInputPolicy) -> Result<(), String> {
    policy.validate(now_ms()?)?;
    if let Ok(meta) = fs::symlink_metadata(policy_path(dir)) {
        if !meta.file_type().is_file() || meta.file_type().is_symlink() {
            return Err("Refusing non-regular trusted policy destination".into());
        }
    }
    fs::create_dir_all(dir).map_err(|_| "Trusted policy directory unavailable")?;
    let bytes =
        serde_json::to_vec_pretty(policy).map_err(|_| "Trusted policy serialization failed")?;
    if bytes.len() > 16384 {
        return Err("Trusted policy exceeds size limit".into());
    }
    let temp = dir.join(format!(
        "desktop-input-trusted-{}-{}.tmp",
        std::process::id(),
        now_ms()?
    ));
    {
        let mut writer = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "Trusted policy temp file unavailable")?;
        if writer
            .write_all(&bytes)
            .and_then(|_| writer.sync_all())
            .is_err()
        {
            let _ = fs::remove_file(&temp);
            return Err("Trusted policy write failed".into());
        }
    }
    if fs::rename(&temp, policy_path(dir)).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Cannot replace trusted policy; previous policy retained".into());
    }
    Ok(())
}
pub fn set_mode(dir: &Path, mode: &str) -> Result<DesktopInputPolicy, String> {
    if !["trusted", "off"].contains(&mode) {
        return Err("Unsupported desktop input mode".into());
    }
    let mut policy = load(dir)?;
    policy.mode = mode.to_owned();
    if mode == "off" {
        policy.targets.clear();
    }
    save(dir, &policy)?;
    Ok(policy)
}
pub fn trust(dir: &Path, target: TrustedTarget) -> Result<DesktopInputPolicy, String> {
    let now = now_ms()?;
    target.validate(now)?;
    if target.expires_at <= now {
        return Err("Approval already expired".into());
    }
    let mut policy = load(dir)?;
    if policy.mode != "trusted" {
        return Err("Enable Trusted mode before approving an exact window".into());
    }
    policy
        .targets
        .retain(|entry| entry.pid != target.pid || entry.native_id != target.native_id);
    if policy.targets.len() >= MAX_TARGETS {
        return Err("Trusted target list is full".into());
    }
    policy.targets.push(target);
    save(dir, &policy)?;
    Ok(policy)
}
pub fn revoke(dir: &Path, pid: u32, native_id: &str) -> Result<DesktopInputPolicy, String> {
    if pid == 0 || !descriptor(native_id, 256) {
        return Err("Invalid revoke target".into());
    }
    let mut policy = load(dir)?;
    policy
        .targets
        .retain(|entry| entry.pid != pid || entry.native_id != native_id);
    save(dir, &policy)?;
    Ok(policy)
}
pub fn revoke_all(dir: &Path) -> Result<DesktopInputPolicy, String> {
    let mut policy = load(dir)?;
    policy.targets.clear();
    save(dir, &policy)?;
    Ok(policy)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "desktop-trusted-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ))
    }
    fn target(pid: u32) -> TrustedTarget {
        let now = now_ms().unwrap();
        TrustedTarget {
            pid,
            native_id: format!("hwnd-{pid}"),
            title: "Exact test window".into(),
            application: "Antigravity".into(),
            approved_at: now,
            expires_at: now + 300_000,
        }
    }
    #[test]
    fn default_is_trusted_but_grants_no_input_without_targets() {
        let root = dir();
        assert_eq!(load(&root).unwrap(), DesktopInputPolicy::default());
        assert!(load(&root).unwrap().targets.is_empty());
    }
    #[test]
    fn host_confirmed_targets_are_exact_short_lived_and_revocable() {
        let root = dir();
        let policy = trust(&root, target(123)).unwrap();
        assert_eq!(policy.targets.len(), 1);
        assert_eq!(load(&root).unwrap().targets[0].native_id, "hwnd-123");
        assert!(trust(&root, target(123)).is_ok());
        assert_eq!(load(&root).unwrap().targets.len(), 1);
        revoke(&root, 123, "hwnd-123").unwrap();
        assert!(load(&root).unwrap().targets.is_empty());
        trust(&root, target(123)).unwrap();
        assert!(set_mode(&root, "off").unwrap().targets.is_empty());
        assert!(trust(&root, target(123)).is_err());
        set_mode(&root, "trusted").unwrap();
        assert!(load(&root).unwrap().targets.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
    #[test]
    fn rejects_unsafe_input_symlinks_and_long_lived_targets() {
        let root = dir();
        let mut bad = target(3);
        bad.expires_at += MAX_LIFETIME_MS;
        assert!(trust(&root, bad).is_err());
        let mut bad = target(3);
        bad.native_id = "../any".into();
        // IDs are treated as identities only, never as file paths.
        assert!(bad.validate(now_ms().unwrap()).is_ok());
        assert!(set_mode(&root, "anything").is_err());
        fs::create_dir_all(&root).unwrap();
        fs::write(policy_path(&root), b"not JSON").unwrap();
        assert!(load(&root).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}

// Native Tray commands. The WebView cannot grant Core input by writing a flag.
// Trust is stored only after OS window discovery and an attended native dialog.
use reqwest::Method;
use serde_json::Value;

fn guard_tray(window: &tauri::WebviewWindow, focus_required: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Desktop input settings require the native main Tray window".into());
    }
    if focus_required
        && (!window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(true)
            || !window.is_focused().unwrap_or(false))
    {
        return Err("Bring the native Tray to the foreground first".into());
    }
    Ok(())
}
fn from_inventory(
    inventory: &Value,
    pid: u64,
    native_id: &str,
) -> Result<(String, String), String> {
    let windows = inventory
        .get("windows")
        .and_then(Value::as_array)
        .ok_or("Verified native window inventory unavailable")?;
    let matches: Vec<_> = windows
        .iter()
        .filter(|item| {
            item.get("pid").and_then(Value::as_u64) == Some(pid)
                && item.get("nativeId").and_then(Value::as_str) == Some(native_id)
        })
        .collect();
    if matches.len() != 1 {
        return Err("Exact window is missing or ambiguous".into());
    }
    let application = matches[0]
        .get("application")
        .and_then(Value::as_str)
        .ok_or("Native application identity missing")?;
    let title = matches[0]
        .get("title")
        .and_then(Value::as_str)
        .ok_or("Native window title missing")?;
    let valid = |value: &str, max: usize| {
        !value.is_empty()
            && value.len() <= max
            && value.trim() == value
            && !value.chars().any(|c| c.is_control())
    };
    if !valid(application, 256) || !valid(title, 512) {
        return Err("Invalid OS-discovered app/window identity".into());
    }
    Ok((application.to_string(), title.to_string()))
}
static NATIVE_APPROVAL_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
struct NativeApprovalGuard;
impl Drop for NativeApprovalGuard {
    fn drop(&mut self) {
        NATIVE_APPROVAL_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
#[tauri::command]
pub(crate) fn get_desktop_input_policy(
    window: tauri::WebviewWindow,
) -> Result<DesktopInputPolicy, String> {
    guard_tray(&window, false)?;
    load(&super::config_dir()?)
}
#[tauri::command]
pub(crate) async fn list_desktop_input_windows(
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    guard_tray(&window, true)?;
    super::core_request(Method::GET, "/api/desktop/live/windows", None).await
}
#[tauri::command]
pub(crate) fn set_desktop_input_mode(
    window: tauri::WebviewWindow,
    mode: String,
) -> Result<DesktopInputPolicy, String> {
    guard_tray(&window, true)?;
    set_mode(&super::config_dir()?, &mode)
}
#[tauri::command]
pub(crate) async fn trust_desktop_input_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    pid: u64,
    native_id: String,
    duration_minutes: u64,
) -> Result<DesktopInputPolicy, String> {
    guard_tray(&window, true)?;
    if pid == 0
        || pid > u32::MAX as u64
        || !descriptor(&native_id, 256)
        || ![5, 10, 15, 30].contains(&duration_minutes)
    {
        return Err("A valid exact window and bounded expiry are required".into());
    }
    if load(&super::config_dir()?)?.mode != "trusted" {
        return Err("Trusted Desktop Input mode is disabled".into());
    }
    if NATIVE_APPROVAL_ACTIVE
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return Err("Another native desktop input approval is pending".into());
    }
    let _guard = NativeApprovalGuard;
    let inventory = super::core_request(Method::GET, "/api/desktop/live/windows", None).await?;
    let (application, title) = from_inventory(&inventory, pid, &native_id)?;
    let prompt = format!(
        "TRUST this EXACT desktop window for input approval requests?\n\n         Application: {}\nWindow: {}\nPID: {}\nNative window ID: {}\n         Expires in: {} minutes\n\n         This does NOT grant mouse/keyboard access. Each input session must         be independently approved by a second native host dialog in Core.         Revoke this target at any time in Security Approval Manager.",
        application, title, pid, native_id, duration_minutes,
    );
    let dialog_app = app.clone();
    let accepted = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
        dialog_app
            .dialog()
            .message(prompt)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Trust exact window".into(),
                "Deny".into(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|_| "Native desktop input dialog failed")?;
    if !accepted {
        return Err("Native host declined trusting this window".into());
    }
    guard_tray(&window, false)?;
    // Recheck identity after the dialog: prevent reusing a replaced HWND.
    let fresh = super::core_request(Method::GET, "/api/desktop/live/windows", None).await?;
    if from_inventory(&fresh, pid, &native_id)? != (application.clone(), title.clone()) {
        return Err("Window identity changed while host approval was displayed".into());
    }
    let now = now_ms()?;
    trust(
        &super::config_dir()?,
        TrustedTarget {
            pid: pid as u32,
            native_id,
            application,
            title,
            approved_at: now,
            expires_at: now + duration_minutes * 60_000,
        },
    )
}
#[tauri::command]
pub(crate) fn revoke_desktop_input_window(
    window: tauri::WebviewWindow,
    pid: u64,
    native_id: String,
) -> Result<DesktopInputPolicy, String> {
    guard_tray(&window, true)?;
    if pid == 0 || pid > u32::MAX as u64 {
        return Err("Invalid revoke target".into());
    }
    revoke(&super::config_dir()?, pid as u32, &native_id)
}
#[tauri::command]
pub(crate) fn revoke_all_desktop_input_windows(
    window: tauri::WebviewWindow,
) -> Result<DesktopInputPolicy, String> {
    guard_tray(&window, true)?;
    revoke_all(&super::config_dir()?)
}
