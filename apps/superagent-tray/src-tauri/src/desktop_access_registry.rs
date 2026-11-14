//! Host-owned permanent application/file registration (schema v2).
//! No time expiry: privileges persist until host revokes them. Registration
//! requires a focused native Tray, OS-verified process binary + SHA-256,
//! freshly verified native window, and explicit attended OS dialog.
//! This does not override OS/UAC, native input safety, or short-lived sessions.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};
use sysinfo::{Pid, System};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use reqwest::Method;
use serde_json::Value;

const MAX_REGISTRY_BYTES: u64 = 128 * 1024;
const MAX_RULES: usize = 128;
const FILENAME: &str = "desktop-access-registry.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutableIdentity {
    platform: String,
    executable_path: String,
    sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    window_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    element_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    element_label: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileScope {
    path: String,
    recursive: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Rule {
    Desktop {
        id: String,
        effect: String,
        app: ExecutableIdentity,
        operations: Vec<String>,
        scope: DesktopScope,
    },
    File {
        id: String,
        effect: String,
        app: ExecutableIdentity,
        operations: Vec<String>,
        scope: FileScope,
    },
}
impl Rule {
    fn id(&self) -> &str {
        match self { Rule::Desktop { id, .. } | Rule::File { id, .. } => id }
    }
    fn validate(&self) -> Result<(), String> {
        let (effect, app, operations, allowed) = match self {
            Rule::Desktop { effect, app, operations, scope, .. } => {
                if scope.window_title.as_ref().is_some_and(|x| !descriptor(x, 512))
                    || scope.element_role.as_ref().is_some_and(|x| !descriptor(x, 128))
                    || scope.element_label.as_ref().is_some_and(|x| !descriptor(x, 512))
                    || (scope.element_label.is_some() && scope.element_role.is_none())
                { return Err("Invalid desktop scope".into()); }
                (effect, app, operations, &["view", "input"][..])
            }
            Rule::File { effect, app, operations, scope, .. } => {
                if !valid_path(&scope.path, &app.platform) {
                    return Err("Invalid file scope".into());
                }
                (effect, app, operations, &["read", "write", "delete"][..])
            }
        };
        if !self.id().bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || self.id().is_empty() || self.id().len() > 64
            || !["allow", "deny"].contains(&effect.as_str())
            || !["win32", "darwin", "linux"].contains(&app.platform.as_str())
            || !valid_path(&app.executable_path, &app.platform)
            || app.sha256.len() != 64 || !app.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || operations.is_empty() || operations.len() > allowed.len()
            || operations.iter().any(|op| !allowed.contains(&op.as_str()))
            || operations.iter().collect::<HashSet<_>>().len() != operations.len()
        { return Err("Invalid permanent access rule".into()); }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    version: u8,
    default_effect: String,
    rules: Vec<Rule>,
}
impl Default for Registry {
    fn default() -> Self { Self { version: 2, default_effect: "deny".into(), rules: vec![] } }
}
impl Registry {
    fn validate(&self) -> Result<(), String> {
        if self.version != 2 || self.default_effect != "deny" || self.rules.len() > MAX_RULES {
            return Err("Unsupported registry version or default policy".into());
        }
        let mut ids = HashSet::new();
        for rule in &self.rules {
            rule.validate()?;
            if !ids.insert(rule.id()) { return Err("Duplicate permanent access rule ID".into()); }
        }
        Ok(())
    }
}
fn descriptor(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.trim() == s && !s.chars().any(|c| c.is_control())
}
fn valid_path(p: &str, platform: &str) -> bool {
    if !descriptor(p, 2048) || p.contains("..") || p.contains('*') || p.contains('?') {
        return false;
    }
    if platform == "win32" {
        let bytes = p.as_bytes();
        bytes.len() >= 4 && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':' && bytes[2] == b'\\'
            && !p.contains('/') && !p.contains("\\\\")
    } else {
        p.starts_with('/') && !p.contains('\\') && !p.contains("//")
    }
}
fn registry_path(dir: &Path) -> PathBuf { dir.join(FILENAME) }
fn load(dir: &Path) -> Result<Registry, String> {
    let target = registry_path(dir);
    let metadata = match fs::symlink_metadata(&target) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Registry::default()),
        Err(_) => return Err("Cannot inspect native access registry".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink()
        || metadata.len() > MAX_REGISTRY_BYTES || metadata.len() < 2
    { return Err("Unsafe access registry destination".into()); }
    let bytes = fs::read(&target).map_err(|_| "Access registry unreadable")?;
    let policy: Registry = serde_json::from_slice(&bytes)
        .map_err(|_| "Access registry JSON invalid")?;
    policy.validate()?;
    Ok(policy)
}
fn save(dir: &Path, policy: &Registry) -> Result<(), String> {
    policy.validate()?;
    fs::create_dir_all(dir).map_err(|_| "Cannot create registry directory")?;
    let target = registry_path(dir);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Unsafe registry destination".into());
        }
    }
    let bytes = serde_json::to_vec_pretty(policy).map_err(|_| "Cannot encode registry")?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES { return Err("Registry too large".into()); }
    let tmp = dir.join(format!("desktop-access-registry-{}.tmp", uuid::Uuid::new_v4()));
    {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)
            .map_err(|_| "Cannot create registry transaction")?;
        if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err("Cannot commit registry transaction".into());
        }
    }
    if fs::rename(&tmp, &target).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err("Cannot replace registry atomically; previous registry preserved".into());
    }
    Ok(())
}
fn focused(window: &tauri::WebviewWindow, write: bool) -> Result<(), String> {
    if window.label() != "main" { return Err("Only native main Tray may manage registration".into()); }
    if write && (!window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true) || !window.is_focused().unwrap_or(false)) {
        return Err("Focus the native SuperAgent Tray before changing access".into());
    }
    Ok(())
}
fn verified_app(pid: u32) -> Result<ExecutableIdentity, String> {
    if pid == 0 { return Err("Invalid PID".into()); }
    let mut system = System::new_all();
    system.refresh_processes();
    let proc = system.process(Pid::from_u32(pid)).ok_or("Process exited or is inaccessible")?;
    let exe = proc.exe().ok_or("OS executable identity unavailable")?;
    let resolved = fs::canonicalize(exe).map_err(|_| "Executable cannot be resolved")?;
    let mut file = File::open(&resolved).map_err(|_| "Executable cannot be read")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "Executable hash failed")?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }
    let raw = resolved.to_string_lossy().to_string();
    #[cfg(windows)]
    let executable_path = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned();
    #[cfg(not(windows))]
    let executable_path = raw;
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        _ => return Err("Unsupported registration host".into()),
    };
    let identity = ExecutableIdentity {
        platform: platform.into(), executable_path, sha256: format!("{:x}", hasher.finalize()),
    };
    if !valid_path(&identity.executable_path, platform) {
        return Err("OS returned unsafe executable identity".into());
    }
    Ok(identity)
}
fn match_window(inventory: &Value, pid: u32, native_id: &str) -> Result<(String, String), String> {
    let windows = inventory.get("windows").and_then(Value::as_array)
        .ok_or("Native window inventory unavailable")?;
    let matches: Vec<_> = windows.iter().filter(|w| {
        w.get("pid").and_then(Value::as_u64) == Some(u64::from(pid)) &&
        w.get("nativeId").and_then(Value::as_str) == Some(native_id)
    }).collect();
    if matches.len() != 1 { return Err("Exact OS window missing or ambiguous".into()); }
    let app = matches[0].get("application").and_then(Value::as_str)
        .ok_or("Application name unavailable")?;
    let title = matches[0].get("title").and_then(Value::as_str)
        .ok_or("Window title unavailable")?;
    if !descriptor(app, 256) || !descriptor(title, 512) {
        return Err("Invalid native window metadata".into());
    }
    Ok((app.into(), title.into()))
}
async fn native_confirmation(app: tauri::AppHandle, prompt: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().message(prompt)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Confirm permanent rule".into(), "Cancel".into()))
            .blocking_show()
    }).await.map_err(|_| "Native approval dialog unavailable".into())
}
static REGISTRY_APPROVAL_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct ApprovalBusy;
impl Drop for ApprovalBusy {
    fn drop(&mut self) { REGISTRY_APPROVAL_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst); }
}
fn begin_approval() -> Result<ApprovalBusy, String> {
    use std::sync::atomic::Ordering::SeqCst;
    REGISTRY_APPROVAL_ACTIVE.compare_exchange(false, true, SeqCst, SeqCst)
        .map_err(|_| "Another native approval is in progress")?;
    Ok(ApprovalBusy)
}
#[tauri::command]
pub(crate) fn get_permanent_access_registry(window: tauri::WebviewWindow) -> Result<Registry, String> {
    focused(&window, false)?;
    let dir = super::config_dir()?;
    // First-run initialization is a DENY-ALL registry, never an implicit grant.
    if !registry_path(&dir).exists() {
        save(&dir, &Registry::default())?;
    }
    load(&dir)
}
#[tauri::command]
pub(crate) async fn pick_permanent_access_path(
    app: tauri::AppHandle, window: tauri::WebviewWindow, directory: bool,
) -> Result<Option<String>, String> {
    focused(&window, true)?;
    let selection = tauri::async_runtime::spawn_blocking(move || {
        if directory { app.dialog().file().blocking_pick_folder() }
        else { app.dialog().file().blocking_pick_file() }
    }).await.map_err(|_| "Native file/folder picker failed")?;
    focused(&window, true)?;
    let Some(selected) = selection else { return Ok(None) };
    let selected = selected.into_path().map_err(|_| "Only native local paths allowed")?;
    let meta = fs::symlink_metadata(&selected).map_err(|_| "Selected path unavailable")?;
    if meta.file_type().is_symlink() {
        return Err("Symlink or reparse point cannot be enrolled".into());
    }
    if directory && !meta.is_dir() { return Err("Only a directory can be recursive".into()); }
    if !directory && !meta.is_file() { return Err("Pick a regular file".into()); }
    let canonical = fs::canonicalize(&selected).map_err(|_| "Cannot canonicalize file path")?;
    let raw = canonical.to_string_lossy().to_string();
    #[cfg(windows)]
    let path = raw.strip_prefix(r"\?\").unwrap_or(&raw).to_owned();
    #[cfg(not(windows))]
    let path = raw;
    let platform = if cfg!(windows) { "win32" } else if cfg!(target_os="macos") {
        "darwin"
    } else { "linux" };
    if !valid_path(&path, platform) { return Err("Invalid local file path".into()); }
    Ok(Some(path))
}
#[tauri::command]
pub(crate) async fn register_permanent_access_rule(
    app: tauri::AppHandle, window: tauri::WebviewWindow,
    pid: u32, native_id: String, effect: String,
    kind: String, operations: Vec<String>,
    exact_window: bool, element_role: Option<String>, element_label: Option<String>,
    file_path: Option<String>, recursive: Option<bool>,
) -> Result<Registry, String> {
    focused(&window, true)?;
    if (kind == "desktop" && !descriptor(&native_id, 256))
        || !["allow", "deny"].contains(&effect.as_str())
        || !["desktop", "file"].contains(&kind.as_str()) || operations.is_empty() {
        return Err("Invalid registration request".into());
    }
    // File rules apply ONLY to SuperAgent Core-managed file tools. They cannot
    // sandbox arbitrary filesystem access inside Antigravity/Chrome.
    if kind == "file" && (element_role.is_some() || element_label.is_some()) {
        return Err("Accessibility fields cannot be used for Core-managed file rules".into());
    }
    if element_role.as_ref().is_some_and(|r| !descriptor(r, 128))
        || element_label.as_ref().is_some_and(|r| !descriptor(r, 512))
        || (element_label.is_some() && element_role.is_none()) {
        return Err("Element scope must have a valid role and optional label".into());
    }
    let _busy = begin_approval()?;
    // Reject concurrent edits while native confirmation is displayed.
    let before_approval = load(&super::config_dir()?)?;
    // Desktop registration binds to exact OS window. File policy instead
    // binds to authenticated selected Core process, never a browser-supplied
    // PID or app name. Scope is displayed explicitly in the host dialog.
    let (application, title, identity, core_pid) = if kind == "file" {
        // A supervised Core may route authenticated requests to a worker PID
        // different from the supervisor registry PID. Resolve the actual
        // executing authenticated worker and attest it via OS process table.
        let response = super::core_request(Method::GET,
            "/api/desktop/live/access-executable", None).await?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            return Err("Core process attestation unavailable".into());
        }
        let core_pid = response.get("pid").and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("Core process PID invalid")?;
        let identity = verified_app(core_pid)?;
        ("SuperAgent Core file tools".to_owned(), "Core-managed file access".to_owned(),
          identity, Some(core_pid))
    } else {
        let inventory = super::core_request(Method::GET, "/api/desktop/live/windows", None).await?;
        let (application,title) = match_window(&inventory, pid, &native_id)?;
        (application, title, verified_app(pid)?, None)
    };
    let chosen_path = if kind == "file" {
        let requested = file_path.as_deref().ok_or("File path required")?;
        // Actual existing file/folder only: no symlink or lexical traversal.
        let meta = fs::symlink_metadata(requested).map_err(|_| "File/folder not found")?;
        if meta.file_type().is_symlink() { return Err("Symbolic links cannot be registered".into()); }
        let canonical = fs::canonicalize(requested).map_err(|_| "Cannot canonicalize file scope")?;
        let raw = canonical.to_string_lossy().to_string();
        #[cfg(windows)]
        let value = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned();
        #[cfg(not(windows))]
        let value = raw;
        if !valid_path(&value, &identity.platform) { return Err("Invalid file path".into()); }
        if recursive.unwrap_or(false) && !meta.is_dir() {
            return Err("Recursive scope requires a real directory".into());
        }
        Some(value)
    } else { None };
    let prompt = format!(
        "REGISTER PERMANENT {} RULE\n\nApplication: {}\nExecutable: {}\nSHA-256: {}\nWindow: {}\nKind: {}\nOperations: {}\nScope: {}\n\nThis rule has NO TIME LIMIT. It remains until you revoke it.\nBlocked rules always override allowed rules.\nSession tokens and OS restrictions remain separate.\nOnly approve if you selected this precise app/scope.",
        effect.to_uppercase(), application, identity.executable_path,
        identity.sha256, title, kind, operations.join(", "),
        chosen_path.as_deref().unwrap_or(if exact_window { &title } else { "All windows of this exact executable" })
    );
    let prompt = format!(
        "{prompt}
Target element role: {}
Target element label: {}
(Exact accessibility semantics are checked at each dispatch.)",
        element_role.as_deref().unwrap_or("All controls"),
        element_label.as_deref().unwrap_or("Any label")
    );
    if !native_confirmation(app, prompt).await? {
        return Err("Host declined access registration".into());
    }
    focused(&window, true)?;
    if kind == "file" {
        let verified = super::core_request(Method::GET,
            "/api/desktop/live/access-executable", None).await?;
        if verified.get("pid").and_then(Value::as_u64) != core_pid.map(u64::from)
            || verified_app(core_pid.ok_or("Core PID absent")?)? != identity {
            return Err("Core worker changed while native approval was shown".into());
        }
    } else {
        let fresh = super::core_request(Method::GET, "/api/desktop/live/windows", None).await?;
        if match_window(&fresh, pid, &native_id)? != (application, title.clone())
            || verified_app(pid)? != identity {
            return Err("Process identity or window changed while approval was shown".into());
        }
    }
    let rule = if kind == "desktop" {
        Rule::Desktop {
            id: uuid::Uuid::new_v4().simple().to_string(), effect, app: identity,
            operations,
            scope: DesktopScope {
                window_title: if exact_window { Some(title) } else { None },
                element_role, element_label,
            },
        }
    } else {
        Rule::File {
            id: uuid::Uuid::new_v4().simple().to_string(), effect, app: identity,
            operations,
            scope: FileScope { path: chosen_path.ok_or("File path not verified")?,
                recursive: recursive.unwrap_or(false) },
        }
    };
    rule.validate()?;
    let dir = super::config_dir()?;
    let mut policy = load(&dir)?;
    if policy != before_approval {
        return Err("Registry changed during approval; retry with current settings".into());
    }
    if policy.rules.len() >= MAX_RULES { return Err("Access registry full".into()); }
    policy.rules.push(rule);
    save(&dir, &policy)?;
    Ok(policy)
}
#[tauri::command]
pub(crate) fn revoke_permanent_access_rule(
    window: tauri::WebviewWindow, id: String,
) -> Result<Registry, String> {
    focused(&window, true)?;
    let dir = super::config_dir()?;
    let mut policy = load(&dir)?;
    let before = policy.rules.len();
    policy.rules.retain(|entry| entry.id() != id);
    if policy.rules.len() == before { return Err("Rule not found".into()); }
    save(&dir, &policy)?;
    Ok(policy)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn permanent_rules_are_versioned_and_default_denied() {
        assert_eq!(Registry::default().default_effect, "deny");
        assert!(Registry::default().rules.is_empty());
        let root = std::env::temp_dir().join(format!("access-registry-test-{}", uuid::Uuid::new_v4()));
        save(&root, &Registry::default()).unwrap();
        assert_eq!(load(&root).unwrap(), Registry::default());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn registry_update_is_atomic_and_replaces_existing_path() {
        let root = std::env::temp_dir().join(format!("access-replace-{}",uuid::Uuid::new_v4()));
        save(&root,&Registry::default()).unwrap();
        let app = ExecutableIdentity{
            platform:"win32".into(),
            executable_path:r"C:\Apps\Editor.exe".into(),
            sha256:"e".repeat(64),
        };
        let new_state = Registry{
            version:2,default_effect:"deny".into(),rules:vec![Rule::Desktop{
                id:"registered-editor".into(),effect:"allow".into(),
                app,operations:vec!["view".into()],
                scope:DesktopScope{window_title:None,element_role:None,element_label:None},
            }],
        };
        save(&root,&new_state).unwrap();
        assert_eq!(load(&root).unwrap(),new_state);
        save(&root,&Registry::default()).unwrap();
        assert!(load(&root).unwrap().rules.is_empty());
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn rejects_unc_or_wildcard_path_and_unknown_modes() {
        assert!(!valid_path(r"\\server\share\file", "win32"));
        assert!(!valid_path(r"C:\Apps\*", "win32"));
        assert!(valid_path(r"C:\Apps\Antigravity.exe", "win32"));
        assert!(!valid_path("/home/../private", "linux"));
    }
}
