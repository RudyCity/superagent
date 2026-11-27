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
/// Explicit title semantics for desktop rules (registry v3). `App` treats the
/// window title as volatile metadata; `Exact` binds the rule to
/// `scope.windowTitle`. Absent keeps the legacy inference used by older Core
/// builds.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TitlePolicy {
    App,
    Exact,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Rule {
    Desktop {
        id: String,
        effect: String,
        app: ExecutableIdentity,
        operations: Vec<String>,
        #[serde(rename = "titlePolicy", default, skip_serializing_if = "Option::is_none")]
        title_policy: Option<TitlePolicy>,
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
    fn kind(&self) -> &str {
        match self { Rule::Desktop { .. } => "desktop", Rule::File { .. } => "file" }
    }
    fn effect(&self) -> &str {
        match self { Rule::Desktop { effect, .. } | Rule::File { effect, .. } => effect }
    }
    fn same_target(&self, other: &Rule) -> bool {
        match (self, other) {
            (
                Rule::Desktop { effect: e1, app: a1, title_policy: t1, scope: s1, .. },
                Rule::Desktop { effect: e2, app: a2, title_policy: t2, scope: s2, .. },
            ) => {
                e1 == e2
                    && a1.platform == a2.platform
                    && a1.sha256.eq_ignore_ascii_case(&a2.sha256)
                    && if a1.platform == "win32" {
                        a1.executable_path.eq_ignore_ascii_case(&a2.executable_path)
                    } else {
                        a1.executable_path == a2.executable_path
                    }
                    && s1.window_title == s2.window_title
                    && t1 == t2
                    && s1.element_role == s2.element_role
                    && s1.element_label == s2.element_label
            }
            (
                Rule::File { effect: e1, app: a1, scope: s1, .. },
                Rule::File { effect: e2, app: a2, scope: s2, .. },
            ) => {
                e1 == e2
                    && a1.platform == a2.platform
                    && a1.sha256.eq_ignore_ascii_case(&a2.sha256)
                    && if a1.platform == "win32" {
                        a1.executable_path.eq_ignore_ascii_case(&a2.executable_path)
                            && s1.path.eq_ignore_ascii_case(&s2.path)
                    } else {
                        a1.executable_path == a2.executable_path && s1.path == s2.path
                    }
                    && s1.recursive == s2.recursive
            }
            _ => false,
        }
    }
    fn validate(&self) -> Result<(), String> {
        let (effect, app, operations, allowed) = match self {
            Rule::Desktop { effect, app, operations, scope, title_policy, .. } => {
                if *title_policy == Some(TitlePolicy::Exact) && scope.window_title.is_none() {
                    return Err("Exact title policy requires a window title".into());
                }
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
pub(crate) fn verified_executable_from_path(raw_path: &str) -> Result<(String, ExecutableIdentity), String> {
    if !descriptor(raw_path, 2048) { return Err("Invalid executable path length or characters".into()); }
    let path = Path::new(raw_path);
    let meta = fs::symlink_metadata(path).map_err(|_| "Executable file not found or inaccessible")?;
    if meta.file_type().is_symlink() {
        return Err("Symbolic links cannot be registered".into());
    }
    if !meta.is_file() {
        return Err("Target path is not a regular executable file".into());
    }
    let canonical = fs::canonicalize(path).map_err(|_| "Executable path cannot be resolved")?;
    let raw = canonical.to_string_lossy().to_string();
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
    if !valid_path(&executable_path, platform) {
        return Err("Executable path has invalid format".into());
    }
    #[cfg(windows)]
    if !executable_path.to_lowercase().ends_with(".exe") {
        return Err("Target file must be a Windows .exe binary".into());
    }

    let mut file = File::open(&canonical).map_err(|_| "Executable cannot be read")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|_| "Executable hash computation failed")?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }

    let app_name = Path::new(&executable_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Application")
        .to_string();

    let identity = ExecutableIdentity {
        platform: platform.into(),
        executable_path,
        sha256: format!("{:x}", hasher.finalize()),
    };
    Ok((app_name, identity))
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAppEntry {
    pub name: String,
    pub executable_path: String,
}

fn scan_dir_executables(dir: &Path, depth: u8, apps: &mut Vec<InstalledAppEntry>, seen: &mut HashSet<String>) {
    if depth == 0 { return; }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("exe")) == Some(true) {
                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let stem_lower = stem.to_lowercase();
                if stem_lower.starts_with("unins") || stem_lower.starts_with("elevate")
                    || stem_lower.starts_with("update") || stem_lower.contains("crash")
                    || stem_lower.contains("setup") || stem_lower.starts_with("vc_redist") {
                    continue;
                }
                let raw = path.to_string_lossy().to_string();
                let key = raw.to_lowercase();
                if !seen.contains(&key) {
                    seen.insert(key);
                    apps.push(InstalledAppEntry {
                        name: stem.to_string(),
                        executable_path: raw,
                    });
                }
            }
        } else if path.is_dir() && depth > 1 {
            let dir_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let dir_lower = dir_name.to_lowercase();
            if !dir_name.starts_with('.') && dir_lower != "node_modules" && dir_lower != "windows"
                && dir_lower != "temp" && dir_lower != "common files" {
                scan_dir_executables(&path, depth - 1, apps, seen);
            }
        }
    }
}

fn discover_installed_desktop_apps() -> Vec<InstalledAppEntry> {
    let mut apps: Vec<InstalledAppEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    #[cfg(windows)]
    {
        let mut search_dirs = Vec::new();
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            let programs = PathBuf::from(local_app_data).join("Programs");
            if programs.is_dir() { search_dirs.push(programs); }
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let p = PathBuf::from(pf);
            if p.is_dir() { search_dirs.push(p); }
        }
        if let Some(pf86) = std::env::var_os("ProgramFiles(x86)") {
            let p = PathBuf::from(pf86);
            if p.is_dir() { search_dirs.push(p); }
        }

        for dir in search_dirs {
            scan_dir_executables(&dir, 2, &mut apps, &mut seen);
        }

        let ps_script = r#"
$paths = @(Get-Item -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\*', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\*' -ErrorAction SilentlyContinue)
$list = @()
foreach ($item in $paths) {
  $val = Get-ItemPropertyValue -Path $item.PSPath -Name '(default)' -ErrorAction SilentlyContinue
  if (-not $val) { continue }
  $clean = [string]$val
  $clean = $clean.Trim(' ').Trim('"')
  if ($clean -and (Test-Path $clean -PathType Leaf)) {
    $ext = [System.IO.Path]::GetExtension($clean)
    if ($ext -ieq '.exe') {
      $name = [System.IO.Path]::GetFileNameWithoutExtension($clean)
      $list += [pscustomobject]@{ name = $name; executablePath = $clean }
    }
  }
}
$pkgs = @{}
Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { -not $_.IsFramework -and $_.InstallLocation } | ForEach-Object {
  if ($_.PackageFamilyName) { $pkgs[$_.PackageFamilyName] = $_.InstallLocation }
}
Get-StartApps -ErrorAction SilentlyContinue | ForEach-Object {
  $aid = [string]$_.AppID
  $idx = $aid.IndexOf('!')
  if ($idx -gt 0) {
    $fam = $aid.Substring(0, $idx)
    $loc = $pkgs[$fam]
    if ($loc) {
      $mf = Join-Path $loc 'AppxManifest.xml'
      if (Test-Path -LiteralPath $mf -PathType Leaf) {
        try {
          [xml]$x = Get-Content -LiteralPath $mf -Raw -ErrorAction Stop
          $appIdPart = $aid.Substring($idx + 1)
          $nodes = @($x.Package.Applications.Application)
          $match = $nodes | Where-Object { $_.Id -eq $appIdPart -and $_.Executable } | Select-Object -First 1
          if (-not $match) { $match = $nodes | Where-Object { $_.Executable } | Select-Object -First 1 }
          if ($match -and $match.Executable) {
            $exe = Join-Path $loc $match.Executable
            if ($exe.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
              $s = [System.IO.File]::OpenRead($exe)
              $s.Dispose()
              $appName = ([string]$_.Name).Trim()
              if ($appName) {
                $list += [pscustomobject]@{ name = $appName; executablePath = $exe }
              }
            }
          }
        } catch {}
      }
    }
  }
}
$list | ConvertTo-Json -Compress
"#;
        if let Ok(output) = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
            .output()
        {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    let trimmed = text.trim();
                    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                        let items: Vec<&Value> = match &val {
                            Value::Array(arr) => arr.iter().collect(),
                            Value::Object(_) => vec![&val],
                            _ => Vec::new(),
                        };
                        for item in items {
                            if let (Some(name), Some(path)) = (
                                item.get("name").and_then(Value::as_str),
                                item.get("executablePath").and_then(Value::as_str),
                            ) {
                                let key = path.to_lowercase();
                                if !seen.contains(&key) && Path::new(path).is_file() {
                                    seen.insert(key);
                                    apps.push(InstalledAppEntry {
                                        name: name.to_string(),
                                        executable_path: path.to_string(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        for root in &["/Applications", "/System/Applications"] {
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("app") {
                        let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("App").to_string();
                        let key = p.to_string_lossy().to_string();
                        if !seen.contains(&key) {
                            seen.insert(key.clone());
                            apps.push(InstalledAppEntry { name, executable_path: key });
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for root in &["/usr/share/applications", "/usr/local/share/applications"] {
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.extension().and_then(|s| s.to_str()) == Some("desktop") {
                        if let Ok(content) = fs::read_to_string(&p) {
                            let mut name = None;
                            let mut exec = None;
                            for line in content.lines() {
                                if line.starts_with("Name=") && name.is_none() {
                                    name = Some(line.trim_start_matches("Name=").trim().to_string());
                                } else if line.starts_with("Exec=") && exec.is_none() {
                                    let raw_exec = line.trim_start_matches("Exec=").split_whitespace().next().unwrap_or("");
                                    exec = Some(raw_exec.to_string());
                                }
                            }
                            if let (Some(n), Some(e)) = (name, exec) {
                                if !e.is_empty() && !seen.contains(&e) {
                                    seen.insert(e.clone());
                                    apps.push(InstalledAppEntry { name: n, executable_path: e });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    if apps.len() > 150 {
        apps.truncate(150);
    }
    apps
}

#[tauri::command]
pub(crate) async fn list_installed_desktop_apps(
    window: tauri::WebviewWindow,
) -> Result<Vec<InstalledAppEntry>, String> {
    focused(&window, false)?;
    let apps = tauri::async_runtime::spawn_blocking(discover_installed_desktop_apps)
        .await
        .map_err(|_| "Installed app discovery failed")?;
    Ok(apps)
}

#[tauri::command]
pub(crate) async fn pick_permanent_access_executable(
    app: tauri::AppHandle, window: tauri::WebviewWindow,
) -> Result<Option<String>, String> {
    focused(&window, false)?;
    let win = window.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        let builder = app.dialog().file().set_parent(&win);
        #[cfg(windows)]
        let builder = builder.add_filter("Executable (*.exe)", &["exe"]);
        #[cfg(target_os = "macos")]
        let builder = builder.add_filter("Application (*.app)", &["app"]);
        builder.blocking_pick_file()
    }).await.map_err(|_| "Native executable picker failed")?;
    focused(&window, false)?;
    let Some(selected) = selection else { return Ok(None) };
    let selected = selected.into_path().map_err(|_| "Only native local paths allowed")?;
    let meta = fs::symlink_metadata(&selected).map_err(|_| "Selected executable unavailable")?;
    if meta.file_type().is_symlink() {
        return Err("Symlink or reparse point cannot be enrolled".into());
    }
    if !meta.is_file() { return Err("Pick a regular executable file".into()); }
    let canonical = fs::canonicalize(&selected).map_err(|_| "Cannot canonicalize executable path")?;
    let raw = canonical.to_string_lossy().to_string();
    #[cfg(windows)]
    let path = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned();
    #[cfg(not(windows))]
    let path = raw;
    let platform = if cfg!(windows) { "win32" } else if cfg!(target_os="macos") { "darwin" } else { "linux" };
    if !valid_path(&path, platform) { return Err("Invalid executable path".into()); }
    #[cfg(windows)]
    if !path.to_lowercase().ends_with(".exe") {
        return Err("Only .exe executable files are supported".into());
    }
    Ok(Some(path))
}

#[tauri::command]
pub(crate) async fn pick_permanent_access_path(
    app: tauri::AppHandle, window: tauri::WebviewWindow, directory: bool,
) -> Result<Option<String>, String> {
    focused(&window, false)?;
    let win = window.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        let builder = app.dialog().file().set_parent(&win);
        if directory { builder.blocking_pick_folder() }
        else { builder.blocking_pick_file() }
    }).await.map_err(|_| "Native file/folder picker failed")?;
    focused(&window, false)?;
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
    let path = raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_owned();
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
    executable_path: Option<String>,
) -> Result<Registry, String> {
    focused(&window, true)?;
    if (kind == "desktop" && pid > 0 && !descriptor(&native_id, 256))
        || (kind == "desktop" && pid == 0 && executable_path.as_deref().map_or(true, |p| p.trim().is_empty()))
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
    // Desktop registration binds to exact OS window or verified executable. File policy
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
    } else if pid > 0 {
        let inventory = super::core_request(Method::GET, "/api/desktop/live/windows", None).await?;
        let (application,title) = match_window(&inventory, pid, &native_id)?;
        (application, title, verified_app(pid)?, None)
    } else {
        let exe_raw = executable_path.as_deref().ok_or("Executable path required for installed application")?;
        let (app_name, id) = verified_executable_from_path(exe_raw)?;
        (app_name, "All windows of this executable".to_string(), id, None)
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
        chosen_path.as_deref().unwrap_or(if exact_window && pid > 0 { &title } else { "All windows of this exact executable" })
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
    } else if pid > 0 {
        if exact_window {
            let fresh = super::core_request(Method::GET, "/api/desktop/live/windows", None).await?;
            let (fresh_app, fresh_title) = match_window(&fresh, pid, &native_id)?;
            if fresh_app != application || fresh_title != title {
                return Err("Window title or application changed while approval was shown".into());
            }
        } else if let Ok(fresh) = super::core_request(Method::GET, "/api/desktop/live/windows", None).await {
            if let Ok((fresh_app, _)) = match_window(&fresh, pid, &native_id) {
                if fresh_app != application {
                    return Err("Window application changed while approval was shown".into());
                }
            }
        }
        if verified_app(pid)? != identity {
            return Err("Process identity changed while approval was shown".into());
        }
    } else {
        let exe_raw = executable_path.as_deref().ok_or("Executable path required")?;
        let (_, fresh_identity) = verified_executable_from_path(exe_raw)?;
        if fresh_identity != identity {
            return Err("Executable binary changed while approval was displayed".into());
        }
    }
    let rule = if kind == "desktop" {
        Rule::Desktop {
            id: uuid::Uuid::new_v4().simple().to_string(), effect, app: identity.clone(),
            operations: operations.clone(),
            title_policy: Some(if exact_window && pid > 0 { TitlePolicy::Exact } else { TitlePolicy::App }),
            scope: DesktopScope {
                window_title: if exact_window && pid > 0 { Some(title) } else { None },
                element_role, element_label,
            },
        }
    } else {
        Rule::File {
            id: uuid::Uuid::new_v4().simple().to_string(), effect, app: identity.clone(),
            operations: operations.clone(),
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
    if let Some(pos) = policy.rules.iter().position(|r| r.same_target(&rule)) {
        let mut merged_ops = match &policy.rules[pos] {
            Rule::Desktop { operations, .. } | Rule::File { operations, .. } => operations.clone(),
        };
        for op in match &rule {
            Rule::Desktop { operations, .. } | Rule::File { operations, .. } => operations,
        } {
            if !merged_ops.contains(op) {
                merged_ops.push(op.clone());
            }
        }
        match &mut policy.rules[pos] {
            Rule::Desktop { operations, .. } | Rule::File { operations, .. } => {
                *operations = merged_ops;
            }
        }
    } else {
        if policy.rules.len() >= MAX_RULES { return Err("Access registry full".into()); }
        policy.rules.push(rule.clone());
    }
    save(&dir, &policy)?;
    let target_desc = match &rule {
        Rule::Desktop { scope, .. } => scope.window_title.clone().unwrap_or_else(|| "All windows".into()),
        Rule::File { scope, .. } => format!("{}{}", scope.path, if scope.recursive { " (recursive)" } else { "" }),
    };
    let _ = record_audit_entry(&dir, &AccessAuditEntry {
        id: uuid::Uuid::new_v4().simple().to_string(),
        timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        kind: rule.kind().to_string(),
        application: application.clone(),
        executable_path: identity.executable_path.clone(),
        operation: operations.join(", "),
        target: target_desc,
        effect: rule.effect().to_string(),
        rule_id: Some(rule.id().to_string()),
    });
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
    let _ = record_audit_entry(&dir, &AccessAuditEntry {
        id: uuid::Uuid::new_v4().simple().to_string(),
        timestamp: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        kind: "rule_management".into(),
        application: "Access Manager".into(),
        executable_path: "SuperAgent Tray".into(),
        operation: "revoke".into(),
        target: id.clone(),
        effect: "deny".into(),
        rule_id: Some(id),
    });
    Ok(policy)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessAuditEntry {
    pub id: String,
    pub timestamp: u64,
    pub kind: String,
    pub application: String,
    pub executable_path: String,
    pub operation: String,
    pub target: String,
    pub effect: String,
    pub rule_id: Option<String>,
}

pub(crate) fn record_audit_entry(dir: &Path, entry: &AccessAuditEntry) -> Result<(), String> {
    let file_path = dir.join("desktop-access-audit.jsonl");
    let mut line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut file = OpenOptions::new().create(true).append(true).open(file_path).map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_permanent_access_audit_log(
    window: tauri::WebviewWindow, limit: Option<usize>,
) -> Result<Vec<AccessAuditEntry>, String> {
    focused(&window, false)?;
    let dir = super::config_dir()?;
    let file_path = dir.join("desktop-access-audit.jsonl");
    if !file_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let max = limit.unwrap_or(50).min(200);
    let mut entries = Vec::new();
    for line in content.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        if let Ok(entry) = serde_json::from_str::<AccessAuditEntry>(trimmed) {
            entries.push(entry);
            if entries.len() >= max { break; }
        }
    }
    Ok(entries)
}

#[tauri::command]
pub(crate) fn clear_permanent_access_audit_log(
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    focused(&window, true)?;
    let dir = super::config_dir()?;
    let file_path = dir.join("desktop-access-audit.jsonl");
    if file_path.exists() {
        let _ = fs::remove_file(file_path);
    }
    Ok(true)
}
const PENDING_RULE_REQUESTS_FILENAME: &str = "pending-active-rule-requests.json";
const MAX_PENDING_RULE_REQUESTS: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingActiveRuleRequest {
    pub id: String,
    pub source_name: String,
    pub kind: String,
    pub effect: String,
    pub target_path: String,
    pub recursive: bool,
    pub operations: Vec<String>,
    pub reason: String,
    pub created_at: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<u64>,
}

fn pending_rule_requests_path(dir: &Path) -> PathBuf {
    dir.join(PENDING_RULE_REQUESTS_FILENAME)
}

pub(crate) fn load_pending_rule_requests(dir: &Path) -> Result<Vec<PendingActiveRuleRequest>, String> {
    let target = pending_rule_requests_path(dir);
    let metadata = match fs::symlink_metadata(&target) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Cannot inspect pending active rule requests".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_REGISTRY_BYTES {
        return Err("Unsafe pending active rule requests store".into());
    }
    let bytes = fs::read(&target).map_err(|_| "Pending active rule requests unreadable")?;
    let items: Vec<PendingActiveRuleRequest> = serde_json::from_slice(&bytes)
        .map_err(|_| "Pending active rule requests JSON invalid")?;
    Ok(items)
}

pub(crate) fn save_pending_rule_requests(dir: &Path, items: &[PendingActiveRuleRequest]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|_| "Cannot create config directory")?;
    let target = pending_rule_requests_path(dir);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err("Unsafe pending active rule requests destination".into());
        }
    }
    let trimmed: Vec<PendingActiveRuleRequest> = items.iter().take(MAX_PENDING_RULE_REQUESTS).cloned().collect();
    let bytes = serde_json::to_vec_pretty(&trimmed).map_err(|_| "Cannot encode pending active rule requests")?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err("Pending active rule requests store too large".into());
    }
    let tmp = dir.join(format!("pending-active-rule-requests-{}.tmp", uuid::Uuid::new_v4()));
    {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)
            .map_err(|_| "Cannot create pending rule requests transaction")?;
        if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err("Cannot commit pending rule requests transaction".into());
        }
    }
    if fs::rename(&tmp, &target).is_err() {
        let _ = fs::remove_file(&tmp);
        return Err("Cannot replace pending rule requests atomically".into());
    }
    Ok(())
}

pub(crate) fn enqueue_active_rule_request(
    dir: &Path,
    mut req: PendingActiveRuleRequest,
) -> Result<PendingActiveRuleRequest, String> {
    let mut items = load_pending_rule_requests(dir)?;
    if let Some(existing) = items.iter().find(|item| {
        item.status == "pending"
            && item.kind == req.kind
            && item.effect == req.effect
            && item.recursive == req.recursive
            && item.target_path.eq_ignore_ascii_case(&req.target_path)
            && item.operations == req.operations
    }) {
        return Ok(existing.clone());
    }
    if req.id.is_empty() {
        req.id = format!("rule_req_{}", uuid::Uuid::new_v4().simple());
    }
    req.status = "pending".into();
    req.decided_at = None;
    items.insert(0, req.clone());
    save_pending_rule_requests(dir, &items)?;
    Ok(req)
}

#[tauri::command]
pub(crate) fn get_pending_active_rule_requests(
    window: tauri::WebviewWindow,
) -> Result<Vec<PendingActiveRuleRequest>, String> {
    focused(&window, false)?;
    let dir = super::config_dir()?;
    load_pending_rule_requests(&dir)
}

#[tauri::command]
pub(crate) fn submit_active_rule_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    source_name: String,
    kind: String,
    effect: String,
    target_path: String,
    recursive: bool,
    operations: Vec<String>,
    reason: String,
) -> Result<PendingActiveRuleRequest, String> {
    focused(&window, false)?;
    let clean_source = source_name.trim();
    let clean_target = target_path.trim();
    let clean_reason = reason.trim();
    if clean_source.is_empty() || clean_source.len() > 120 || clean_source.chars().any(char::is_control) {
        return Err("Invalid source name".into());
    }
    if !["file", "desktop"].contains(&kind.as_str()) {
        return Err("Rule request kind must be file or desktop".into());
    }
    if !["allow", "deny"].contains(&effect.as_str()) {
        return Err("Rule request effect must be allow or deny".into());
    }
    if !descriptor(clean_target, 2048) {
        return Err("Invalid target path or executable".into());
    }
    let allowed_ops: &[&str] = if kind == "file" {
        &["read", "write", "delete"]
    } else {
        &["view", "input"]
    };
    if operations.is_empty()
        || operations.len() > allowed_ops.len()
        || operations.iter().any(|op| !allowed_ops.contains(&op.as_str()))
    {
        return Err("Invalid rule request operations".into());
    }
    if clean_reason.len() > 500 || clean_reason.chars().any(char::is_control) {
        return Err("Invalid reason".into());
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let dir = super::config_dir()?;
    let created = enqueue_active_rule_request(
        &dir,
        PendingActiveRuleRequest {
            id: format!("rule_req_{}", uuid::Uuid::new_v4().simple()),
            source_name: clean_source.to_string(),
            kind,
            effect,
            target_path: clean_target.to_string(),
            recursive,
            operations,
            reason: if clean_reason.is_empty() {
                "Permintaan aturan aktif baru untuk host.".into()
            } else {
                clean_reason.to_string()
            },
            created_at: now,
            status: "pending".into(),
            decided_at: None,
        },
    )?;

    let incident_id = format!("mcp-pending:requests:rule:{}", created.id);
    let body = format!(
        "{} meminta aturan {} ({}) untuk {}. Tinjau di Pusat Permintaan.",
        created.source_name,
        created.kind,
        created.operations.join(", "),
        created.target_path
    );
    let _ = super::record_operational_incident(
        &app,
        "security",
        "critical",
        &incident_id,
        "Permintaan Aturan Aktif",
        &body,
    );
    let _ = tauri::Emitter::emit(&app, "access-manager://requests-updated", ());
    Ok(created)
}

#[tauri::command]
pub(crate) async fn approve_pending_active_rule_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
    operations: Option<Vec<String>>,
) -> Result<Value, String> {
    focused(&window, true)?;
    let dir = super::config_dir()?;
    let mut items = load_pending_rule_requests(&dir)?;
    let idx = items
        .iter()
        .position(|item| item.id == request_id && item.status == "pending")
        .ok_or("Pending active rule request not found or already decided")?;
    let req = items[idx].clone();
    let final_ops = operations.unwrap_or_else(|| req.operations.clone());
    if final_ops.is_empty() {
        return Err("Select at least one operation".into());
    }

    let policy = if req.kind == "file" {
        register_permanent_access_rule(
            app.clone(),
            window,
            0,
            String::new(),
            req.effect.clone(),
            "file".into(),
            final_ops.clone(),
            false,
            None,
            None,
            Some(req.target_path.clone()),
            Some(req.recursive),
            None,
        )
        .await?
    } else {
        register_permanent_access_rule(
            app.clone(),
            window,
            0,
            String::new(),
            req.effect.clone(),
            "desktop".into(),
            final_ops.clone(),
            false,
            None,
            None,
            None,
            None,
            Some(req.target_path.clone()),
        )
        .await?
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    items[idx].status = "approved".into();
    items[idx].operations = final_ops;
    items[idx].decided_at = Some(now);
    save_pending_rule_requests(&dir, &items)?;

    let incident_id = format!("mcp-pending:requests:rule:{}", req.id);
    if super::tray_notification_center::resolve(&dir, &incident_id).unwrap_or(false) {
        let _ = tauri::Emitter::emit(&app, "tray-notifications-changed", ());
    }
    let _ = tauri::Emitter::emit(&app, "access-manager://requests-updated", ());

    Ok(serde_json::json!({
        "registry": policy,
        "requests": items,
    }))
}

#[tauri::command]
pub(crate) fn deny_pending_active_rule_request(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request_id: String,
) -> Result<Vec<PendingActiveRuleRequest>, String> {
    focused(&window, true)?;
    let dir = super::config_dir()?;
    let mut items = load_pending_rule_requests(&dir)?;
    let idx = items
        .iter()
        .position(|item| item.id == request_id && item.status == "pending")
        .ok_or("Pending active rule request not found or already decided")?;
    let req = items[idx].clone();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    items[idx].status = "denied".into();
    items[idx].decided_at = Some(now);
    save_pending_rule_requests(&dir, &items)?;

    let _ = record_audit_entry(
        &dir,
        &AccessAuditEntry {
            id: uuid::Uuid::new_v4().simple().to_string(),
            timestamp: now,
            kind: req.kind.clone(),
            application: req.source_name,
            executable_path: req.target_path.clone(),
            operation: req.operations.join(", "),
            target: req.target_path,
            effect: "deny".into(),
            rule_id: Some(req.id.clone()),
        },
    );

    let incident_id = format!("mcp-pending:requests:rule:{}", req.id);
    if super::tray_notification_center::resolve(&dir, &incident_id).unwrap_or(false) {
        let _ = tauri::Emitter::emit(&app, "tray-notifications-changed", ());
    }
    let _ = tauri::Emitter::emit(&app, "access-manager://requests-updated", ());
    Ok(items)
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
                title_policy:None,
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
    #[test]
    fn strips_windows_verbatim_namespace_prefix() {
        let raw = r"\\?\C:\Apps\Workspace";
        let path = raw.strip_prefix(r"\\?\").unwrap_or(raw);
        assert_eq!(path, r"C:\Apps\Workspace");
        assert!(valid_path(path, "win32"));
    }
    #[test]
    fn detects_identical_target_for_deduplication() {
        let app1 = ExecutableIdentity {
            platform: "win32".into(),
            executable_path: r"C:\Apps\bun.exe".into(),
            sha256: "a".repeat(64),
        };
        let app2 = ExecutableIdentity {
            platform: "win32".into(),
            executable_path: r"c:\apps\bun.exe".into(), // case difference on win32
            sha256: "A".repeat(64),                     // case difference in hash
        };
        let r1 = Rule::File {
            id: "r1".into(),
            effect: "allow".into(),
            app: app1,
            operations: vec!["read".into()],
            scope: FileScope {
                path: r"D:\Project".into(),
                recursive: true,
            },
        };
        let r2 = Rule::File {
            id: "r2".into(),
            effect: "allow".into(),
            app: app2,
            operations: vec!["write".into()],
            scope: FileScope {
                path: r"d:\project".into(),
                recursive: true,
            },
        };
        assert!(r1.same_target(&r2));
    }
    #[test]
    fn detects_identical_desktop_target_for_deduplication() {
        let app1 = ExecutableIdentity {
            platform: "win32".into(),
            executable_path: r"C:\Apps\Chrome.exe".into(),
            sha256: "b".repeat(64),
        };
        let app2 = ExecutableIdentity {
            platform: "win32".into(),
            executable_path: r"c:\apps\chrome.exe".into(),
            sha256: "B".repeat(64),
        };
        let r1 = Rule::Desktop {
            id: "r1".into(),
            effect: "allow".into(),
            app: app1,
            operations: vec!["view".into()],
            title_policy: None,
            scope: DesktopScope {
                window_title: None,
                element_role: None,
                element_label: None,
            },
        };
        let r2 = Rule::Desktop {
            id: "r2".into(),
            effect: "allow".into(),
            app: app2,
            operations: vec!["input".into()],
            title_policy: None,
            scope: DesktopScope {
                window_title: None,
                element_role: None,
                element_label: None,
            },
        };
        assert!(r1.same_target(&r2));
    }
    #[test]
    fn parses_and_round_trips_explicit_title_policy() {
        let app = ExecutableIdentity {
            platform: "win32".into(),
            executable_path: r"C:\Apps\Live.exe".into(),
            sha256: "c".repeat(64),
        };
        let json = serde_json::json!({
            "version": 2,
            "defaultEffect": "deny",
            "rules": [{
                "id": "r-exact",
                "kind": "desktop",
                "effect": "allow",
                "app": {
                    "platform": "win32",
                    "executablePath": r"C:\Apps\Live.exe",
                    "sha256": "c".repeat(64),
                },
                "operations": ["view"],
                "titlePolicy": "exact",
                "scope": { "windowTitle": "Pinned Editor" },
            }],
        });
        let registry: Registry = serde_json::from_value(json).expect("registry parses");
        assert_eq!(registry.rules.len(), 1);
        match &registry.rules[0] {
            Rule::Desktop { title_policy, scope, .. } => {
                assert_eq!(*title_policy, Some(TitlePolicy::Exact));
                assert_eq!(scope.window_title.as_deref(), Some("Pinned Editor"));
            }
            _ => panic!("expected desktop rule"),
        }
        let serialized = serde_json::to_value(&registry).expect("registry serializes");
        assert_eq!(serialized["rules"][0]["titlePolicy"], "exact");
        let _ = app;
    }
    #[test]
    fn rejects_exact_title_policy_without_a_bound_title() {
        let rule = Rule::Desktop {
            id: "r-exact".into(),
            effect: "allow".into(),
            app: ExecutableIdentity {
                platform: "win32".into(),
                executable_path: r"C:\Apps\Live.exe".into(),
                sha256: "c".repeat(64),
            },
            operations: vec!["view".into()],
            title_policy: Some(TitlePolicy::Exact),
            scope: DesktopScope { window_title: None, element_role: None, element_label: None },
        };
        assert!(rule.validate().is_err());
    }
    #[test]
    fn deduplication_distinguishes_title_policy() {
        let app = ExecutableIdentity {
            platform: "win32".into(),
            executable_path: r"C:\Apps\Live.exe".into(),
            sha256: "c".repeat(64),
        };
        let make = |policy: Option<TitlePolicy>| Rule::Desktop {
            id: "r1".into(),
            effect: "allow".into(),
            app: app.clone(),
            operations: vec!["view".into()],
            title_policy: policy,
            scope: DesktopScope { window_title: None, element_role: None, element_label: None },
        };
        assert!(make(Some(TitlePolicy::App)).same_target(&make(Some(TitlePolicy::App))));
        assert!(!make(Some(TitlePolicy::App)).same_target(&make(Some(TitlePolicy::Exact))));
        assert!(!make(Some(TitlePolicy::App)).same_target(&make(None)));
    }
    #[test]
    fn audit_entry_appends_and_reads_back() {
        let root = std::env::temp_dir().join(format!("access-audit-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = AccessAuditEntry {
            id: "audit-1".into(),
            timestamp: 123456789,
            kind: "desktop".into(),
            application: "Chrome".into(),
            executable_path: r"C:\Apps\Chrome.exe".into(),
            operation: "view, input".into(),
            target: "All windows".into(),
            effect: "allow".into(),
            rule_id: Some("rule-1".into()),
        };
        record_audit_entry(&root, &entry).unwrap();
        let file_path = root.join("desktop-access-audit.jsonl");
        let content = fs::read_to_string(file_path).unwrap();
        assert!(content.contains("Chrome"));
        assert!(content.contains("audit-1"));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn verifies_executable_from_real_binary() {
        let current_exe = std::env::current_exe().unwrap();
        let path_str = current_exe.to_string_lossy().to_string();
        #[cfg(windows)]
        let path_str = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str).to_owned();
        let (name, identity) = verified_executable_from_path(&path_str).unwrap();
        assert!(!name.is_empty());
        assert_eq!(identity.executable_path.to_lowercase(), path_str.to_lowercase());
        assert_eq!(identity.sha256.len(), 64);
    }
    #[test]
    fn pending_active_rule_requests_enqueue_deduplicate_and_persist() {
        let root = std::env::temp_dir().join(format!("pending-rule-req-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = enqueue_active_rule_request(
            &root,
            PendingActiveRuleRequest {
                id: String::new(),
                source_name: "Gemini MCP".into(),
                kind: "file".into(),
                effect: "allow".into(),
                target_path: r"D:\Project\Sample".into(),
                recursive: true,
                operations: vec!["read".into(), "write".into()],
                reason: "Butuh baca dan tulis workspace".into(),
                created_at: 1700000000000,
                status: "pending".into(),
                decided_at: None,
            },
        )
        .unwrap();
        assert!(first.id.starts_with("rule_req_"));
        let dup = enqueue_active_rule_request(&root, first.clone()).unwrap();
        assert_eq!(dup.id, first.id);
        let loaded = load_pending_rule_requests(&root).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].target_path, r"D:\Project\Sample");
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn installed_app_discovery_returns_structured_entries() {
        let apps = discover_installed_desktop_apps();
        // Discovery is best-effort and bounded to 150 items
        assert!(apps.len() <= 150);
        for a in &apps {
            assert!(!a.name.is_empty());
            assert!(!a.executable_path.is_empty());
        }
    }
}
