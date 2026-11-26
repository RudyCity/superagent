use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const DEFAULT_WINDOWS_AUMID: &str = "click.superagent.app";
const POWERSHELL_FALLBACK_AUMID: &str =
    r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";
static WINDOWS_AUMID_REGISTERED: OnceLock<()> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestCategory {
    IncomingAccess,
    ActiveRule,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessRequestNotificationPayload {
    pub request_id: String,
    pub category: RequestCategory,
    pub source_name: String,
    pub target_label: String,
    pub summary: String,
}

fn sanitize_aumid(identifier: &str) -> Option<&str> {
    let trimmed = identifier.trim();
    if !trimmed.is_empty()
        && trimmed.len() <= 128
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        Some(trimmed)
    } else {
        None
    }
}

fn sanitize_display_name(name: Option<&str>) -> String {
    let cleaned: String = name
        .unwrap_or("SuperAgent")
        .chars()
        .filter(|c| !c.is_control())
        .take(64)
        .collect();
    if cleaned.trim().is_empty() {
        "SuperAgent".to_string()
    } else {
        cleaned.trim().to_string()
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn build_windows_toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastText02\"><text id=\"1\">{}</text><text id=\"2\">{}</text></binding></visual></toast>",
        xml_escape(title),
        xml_escape(body)
    )
}

/// Ensures the per-user Windows AppUserModelID registry entry exists so Windows
/// Action Center accepts toasts even when running outside an NSIS Start Menu shortcut.
pub fn ensure_windows_aumid_registered(app: &AppHandle) {
    let identifier = sanitize_aumid(&app.config().identifier).unwrap_or(DEFAULT_WINDOWS_AUMID);
    let display_name = sanitize_display_name(app.config().product_name.as_deref());
    WINDOWS_AUMID_REGISTERED.get_or_init(|| {
        #[cfg(target_os = "windows")]
        register_windows_aumid(identifier, &display_name);
        #[cfg(not(target_os = "windows"))]
        let _ = (identifier, display_name);
    });
}

#[cfg(target_os = "windows")]
fn run_hidden_reg(args: &[&str]) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg.exe")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
}

#[cfg(target_os = "windows")]
fn register_windows_aumid(identifier: &str, display_name: &str) {
    let aumid_key = format!(r"HKCU\Software\Classes\AppUserModelId\{identifier}");
    let _ = run_hidden_reg(&[
        "add",
        &aumid_key,
        "/v",
        "DisplayName",
        "/t",
        "REG_SZ",
        "/d",
        display_name,
        "/f",
    ]);
    let _ = run_hidden_reg(&[
        "add",
        &aumid_key,
        "/v",
        "ShowInSettings",
        "/t",
        "REG_DWORD",
        "/d",
        "1",
        "/f",
    ]);

    let settings_key = format!(
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{identifier}"
    );
    let already_configured = run_hidden_reg(&["query", &settings_key, "/v", "Enabled"])
        .is_some_and(|out| out.status.success());
    if !already_configured {
        let _ = run_hidden_reg(&[
            "add",
            &settings_key,
            "/v",
            "Enabled",
            "/t",
            "REG_DWORD",
            "/d",
            "1",
            "/f",
        ]);
    }
    let _ = run_hidden_reg(&[
        "add",
        &settings_key,
        "/v",
        "ShowInActionCenter",
        "/t",
        "REG_DWORD",
        "/d",
        "1",
        "/f",
    ]);

    if let Some(output) = run_hidden_reg(&[
        "query",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications",
        "/v",
        "ToastEnabled",
    ]) {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("0x0") {
            eprintln!(
                "[tray] Windows OS notifications are disabled (PushNotifications\\ToastEnabled=0); enable Windows Notifications to view desktop toasts."
            );
        }
    }
}

/// Dispatches a native OS notification across Windows, Linux, and macOS.
/// Uses Tauri's notification plugin as the primary cross-platform path (preserving
/// OS toast activation ticket IDs when provided), and falls back to native OS
/// notification binaries (`powershell.exe` Toast on Windows, `notify-send`/`zenity`
/// on Linux, `osascript` on macOS) if the desktop notification daemon is unavailable.
pub fn dispatch_os_notification(
    app: &AppHandle,
    title: &str,
    body: &str,
    ticket_id: Option<i32>,
) -> Result<(), String> {
    ensure_windows_aumid_registered(app);

    let mut builder = app.notification().builder().title(title).body(body);
    if let Some(id) = ticket_id {
        builder = builder.id(id);
    }

    match builder.show() {
        Ok(()) => Ok(()),
        Err(plugin_err) => {
            if send_os_fallback_notification(title, body) {
                Ok(())
            } else {
                Err(format!("OS notification delivery failed: {plugin_err}"))
            }
        }
    }
}

#[tauri::command]
pub fn notify_access_request(
    app: AppHandle,
    payload: AccessRequestNotificationPayload,
) -> Result<(), String> {
    let title = match payload.category {
        RequestCategory::IncomingAccess => {
            format!("Permintaan Akses Masuk · {}", payload.source_name)
        }
        RequestCategory::ActiveRule => {
            format!("Permintaan Aturan Aktif · {}", payload.source_name)
        }
    };

    let body = format!("{}: {}", payload.target_label, payload.summary);
    dispatch_os_notification(&app, &title, &body, None)?;
    let _ = app.emit("access-manager://new-request", &payload);
    Ok(())
}

#[tauri::command]
pub fn open_request_center(app: AppHandle, category: Option<RequestCategory>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    let _ = app.emit("access-manager://focus-request-center", category);
    Ok(())
}

fn send_os_fallback_notification(title: &str, body: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        if std::process::Command::new("notify-send")
            .args([
                "--app-name=SuperAgent Tray",
                "--urgency=critical",
                "--",
                title,
                body,
            ])
            .spawn()
            .is_ok()
        {
            return true;
        }
        let text = format!("{title}: {body}");
        return std::process::Command::new("zenity")
            .args(["--notification", &format!("--text={text}")])
            .spawn()
            .is_ok();
    }

    #[cfg(target_os = "macos")]
    {
        let escaped_body = body.replace('\\', "\\\\").replace('"', "\\\"");
        let escaped_title = title.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display notification \"{escaped_body}\" with title \"{escaped_title}\" sound name \"Submarine\""
        );
        return std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .is_ok();
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let xml = build_windows_toast_xml(title, body);
        let ps_script = "$ErrorActionPreference='Stop'; \
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
            [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; \
            $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
            $xml.LoadXml($env:SUPERAGENT_TOAST_XML); \
            $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); \
            try { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:SUPERAGENT_TOAST_AUMID).Show($toast) } \
            catch { [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:SUPERAGENT_TOAST_FALLBACK_AUMID).Show($toast) }";
        return std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                ps_script,
            ])
            .env("SUPERAGENT_TOAST_XML", xml)
            .env("SUPERAGENT_TOAST_AUMID", DEFAULT_WINDOWS_AUMID)
            .env("SUPERAGENT_TOAST_FALLBACK_AUMID", POWERSHELL_FALLBACK_AUMID)
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = (title, body);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{build_windows_toast_xml, sanitize_aumid, sanitize_display_name};

    #[test]
    fn windows_toast_xml_escapes_special_characters() {
        let xml = build_windows_toast_xml("Permintaan <Akses> & \"Aturan\"", "Path 'C:\\a&b'");
        assert!(xml.contains("&lt;Akses&gt; &amp; &quot;Aturan&quot;"));
        assert!(xml.contains("Path &apos;C:\\a&amp;b&apos;"));
    }

    #[test]
    fn aumid_validation_rejects_unsafe_or_empty_identifiers() {
        assert_eq!(sanitize_aumid("click.superagent.app"), Some("click.superagent.app"));
        assert_eq!(sanitize_aumid(""), None);
        assert_eq!(sanitize_aumid("bad\\key"), None);
        assert_eq!(sanitize_aumid("bad key"), None);
    }

    #[test]
    fn display_name_sanitization_strips_control_chars_with_safe_default() {
        assert_eq!(sanitize_display_name(Some("SuperAgent\n")), "SuperAgent");
        assert_eq!(sanitize_display_name(Some("   ")), "SuperAgent");
        assert_eq!(sanitize_display_name(None), "SuperAgent");
    }
}
