use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

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
        let xml_escape = |s: &str| -> String {
            s.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('"', "&quot;")
                .replace('\'', "&apos;")
        };
        let safe_title = xml_escape(title).replace('\'', "''");
        let safe_body = xml_escape(body).replace('\'', "''");
        let ps_script = format!(
            "$ErrorActionPreference='Stop'; \
             [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; \
             [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null; \
             $xml = New-Object Windows.Data.Xml.Dom.XmlDocument; \
             $xml.LoadXml('<toast><visual><binding template=\"ToastText02\"><text id=\"1\">{safe_title}</text><text id=\"2\">{safe_body}</text></binding></visual></toast>'); \
             $toast = [Windows.UI.Notifications.ToastNotification]::new($xml); \
             [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('click.superagent.app').Show($toast);"
        );
        return std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &ps_script,
            ])
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
