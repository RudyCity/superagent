//! Local-only, versioned SuperAgent Tray preferences.
//! Kept entirely outside Core's daemon/model/Muse configuration files.
//! WebView can read/write only this fixed schema (no paths, secrets or URLs).

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraySettings {
    pub version: u8,
    pub auto_launch_with_superagent: bool,
    pub notifications_enabled: bool,
    pub close_to_tray: bool,
    pub runtime_scan_seconds: u64,
    pub jobs_refresh_seconds: u64,
    pub notification_poll_seconds: u64,
    pub startup_page: String,
}

impl Default for TraySettings {
    fn default() -> Self {
        Self {
            version: 1,
            auto_launch_with_superagent: true,
            notifications_enabled: true,
            close_to_tray: true,
            runtime_scan_seconds: 20,
            jobs_refresh_seconds: 30,
            notification_poll_seconds: 15,
            startup_page: "jobs".to_owned(),
        }
    }
}

impl TraySettings {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported Tray settings version".into());
        }
        if ![10, 20, 30, 60, 120].contains(&self.runtime_scan_seconds) {
            return Err("Runtime scan interval must be 10, 20, 30, 60, or 120 seconds".into());
        }
        if ![15, 30, 60, 120].contains(&self.jobs_refresh_seconds) {
            return Err("Jobs refresh interval must be 15, 30, 60, or 120 seconds".into());
        }
        if ![15, 30, 60, 120].contains(&self.notification_poll_seconds) {
            return Err("Notification poll interval must be 15, 30, 60, or 120 seconds".into());
        }
        if !["jobs", "runtime", "history", "logs", "delegate", "terminal", "muse-files"].contains(&self.startup_page.as_str()) {
            return Err("Unsupported Tray startup page".into());
        }
        Ok(())
    }
}

pub fn settings_file(dir: &Path) -> PathBuf {
    dir.join("tray-settings.json")
}

pub fn load(dir: &Path) -> Result<TraySettings, String> {
    let file = settings_file(dir);
    let metadata = match fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TraySettings::default());
        }
        Err(_) => return Err("Tray settings cannot be inspected".into()),
    };
    if !metadata.file_type().is_file() || metadata.len() > 4096 {
        return Err("Tray settings must be a regular, bounded local JSON file".into());
    }
    let bytes = fs::read(&file).map_err(|_| "Tray settings cannot be read")?;
    let settings: TraySettings =
        serde_json::from_slice(&bytes).map_err(|_| "Tray settings are invalid or incomplete")?;
    settings.validate()?;
    Ok(settings)
}

/// Best-effort read for startup/notification loop; never panics or mutates
/// a corrupted file. The Settings UI reports validation errors separately.
pub fn load_or_default(dir: &Path) -> TraySettings {
    load(dir).unwrap_or_default()
}

pub fn save(dir: &Path, settings: &TraySettings) -> Result<(), String> {
    settings.validate()?;
    // Refuse replacing a symlink or an unexpected existing directory.
    if let Ok(meta) = fs::symlink_metadata(settings_file(dir)) {
        if !meta.file_type().is_file() {
            return Err("Tray settings destination is not a regular file".into());
        }
    }
    fs::create_dir_all(dir).map_err(|_| "Tray settings directory unavailable")?;
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|_| "Tray settings serialization failed")?;
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock unavailable")?
        .as_nanos();
    let temp = dir.join(format!("tray-settings-{}-{suffix}.tmp", std::process::id()));
    {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "Cannot prepare atomic Tray settings write")?;
        if let Err(error) = output.write_all(&bytes).and_then(|_| output.sync_all()) {
            let _ = fs::remove_file(&temp);
            return Err(format!("Cannot persist Tray settings: {error}"));
        }
    }
    // Windows MoveFileEx replaces a regular destination atomically.
    // If the filesystem refuses replacement, leave the previous file intact.
    if fs::rename(&temp, settings_file(dir)).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Cannot replace Tray settings; previous preferences remain unchanged".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn isolated_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "superagent-tray-settings-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn defaults_roundtrip_and_persist_without_touching_core_config() {
        let dir = isolated_dir();
        let initial = load(&dir).unwrap();
        assert_eq!(initial, TraySettings::default());
        let changed = TraySettings {
            auto_launch_with_superagent: false,
            notifications_enabled: false,
            close_to_tray: false,
            runtime_scan_seconds: 60,
            jobs_refresh_seconds: 120,
            notification_poll_seconds: 30,
            startup_page: "runtime".into(),
            ..initial
        };
        save(&dir, &changed).unwrap();
        assert_eq!(load(&dir).unwrap(), changed);
        assert!(!dir.join("server-info.json").exists());
        assert!(!dir.join("daemon-jobs.json").exists());
        assert!(!dir.join("model-config.json").exists());
        save(&dir, &TraySettings::default()).unwrap();
        assert_eq!(load(&dir).unwrap(), TraySettings::default());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_extra_fields_invalid_intervals_and_version_without_overwriting() {
        let dir = isolated_dir();
        let good = TraySettings::default();
        save(&dir, &good).unwrap();
        let bytes = fs::read(settings_file(&dir)).unwrap();
        for raw in [
            r#"{"version":1,"arbitraryCommand":"powershell"}"#,
            r#"{"version":1,"autoLaunchWithSuperagent":false}"#,
            r#"{"version":0}"#,
        ] {
            assert!(serde_json::from_str::<TraySettings>(raw).is_err());
        }
        let mut candidate = good.clone();
        candidate.runtime_scan_seconds = 1;
        assert!(save(&dir, &candidate).is_err());
        candidate = good.clone();
        candidate.startup_page = "../mcp".into();
        assert!(save(&dir, &candidate).is_err());
        candidate = good.clone();
        candidate.version = 2;
        assert!(save(&dir, &candidate).is_err());
        assert_eq!(fs::read(settings_file(&dir)).unwrap(), bytes);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupted_or_oversize_file_is_not_silently_overwritten() {
        let dir = isolated_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(settings_file(&dir), b"not JSON").unwrap();
        assert!(load(&dir).is_err());
        fs::write(settings_file(&dir), vec![b'x'; 4097]).unwrap();
        assert!(load(&dir).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
