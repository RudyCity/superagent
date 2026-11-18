//! Core startup preserves owner evidence and requires both private and public readiness.
use crate::{runtime_control, runtime_detection};
use reqwest::{Client, StatusCode};
use serde_json::Value;
use std::{net::{SocketAddr, TcpListener}, path::Path, time::Duration};

pub async fn launched_owner(owner_pid: u32, bootstrap_pid: u32) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        let mut system = sysinfo::System::new();
        system.refresh_processes();
        let mut current = Some(sysinfo::Pid::from_u32(owner_pid));
        for _ in 0..12 {
            let Some(pid) = current else { return false };
            if pid.as_u32() == bootstrap_pid { return true; }
            current = system.process(pid).and_then(sysinfo::Process::parent);
        }
        false
    }).await.map_err(|_| "Core bootstrap ownership inspection failed".into())
}

#[cfg(windows)]
pub(crate) fn listener_matches_output(output: &str, port: u16, pid: u32) -> bool {
    let address = format!("127.0.0.1:{}", port);
    output.lines().any(|line| {
        let fields: Vec<_> = line.split_whitespace().collect();
        fields.len() == 5 && fields[0] == "TCP" && fields[1] == address &&
            fields[3] == "LISTENING" && fields[4].parse::<u32>() == Ok(pid)
    })
}

#[cfg(windows)]
async fn verify_listener(port: u16, pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        let root = std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?;
        let output = std::process::Command::new(std::path::PathBuf::from(root).join("System32/netstat.exe"))
            .args(["-ano", "-p", "TCP"]).creation_flags(0x08000000)
            .output().map_err(|_| "Core listener ownership probe unavailable")?;
        if !output.status.success() || !listener_matches_output(&String::from_utf8_lossy(&output.stdout), port, pid) {
            return Err("Core kernel listener owner does not match its registration");
        }
        Ok(())
    }).await.map_err(|_| "Core listener ownership task failed")?
        .map_err(str::to_owned)
}

pub async fn verified_owner(dir: &Path, port: u16) -> Result<u32, String> {
    let info = runtime_detection::server_info_for_port(dir, port)?;
    let pid = info.pid.filter(|pid| *pid > 0).ok_or("Core owner PID is missing")?;
    let born = info.started_at.filter(|born| *born > 0).ok_or("Core process identity is missing")?;
    #[cfg(windows)]
    verify_listener(port, pid).await?;
    let owner = runtime_control::verified_core_status(dir, port, pid, born).await?;
    let client = Client::builder()
        .timeout(Duration::from_millis(1500))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "Core readiness client unavailable")?;
    let mut response = client.get(format!("http://127.0.0.1:{}/api/status", port))
        .bearer_auth(&info.auth_token).send().await
        .map_err(|_| "Core public readiness did not respond")?;
    if response.status() != StatusCode::OK {
        return Err("Core public readiness did not authenticate".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Core readiness interrupted")? {
        if bytes.len() + chunk.len() > 16 * 1024 {
            return Err("Core readiness response exceeds safe limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Core readiness JSON")?;
    if value["status"] != "online" || value["version"].as_str().is_none_or(str::is_empty) ||
        value["pid"].as_u64().is_some_and(|observed|
            observed != u64::from(pid) && Some(observed) != owner["active"]["pid"].as_u64()) {
        return Err("Core public readiness identity does not match its supervisor".into());
    }
    Ok(pid)
}

/// An occupied port is evidence to refuse a launch, never permission to adopt it.
pub async fn preflight(dir: &Path, port: u16) -> Result<bool, String> {
    if port == 0 { return Err("Invalid Core port".into()); }
    if verified_owner(dir, port).await.is_ok() { return Ok(true); }
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    match TcpListener::bind(address) {
        Ok(reservation) => { drop(reservation); Ok(false) }
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => Err(format!(
            "Core port {} is occupied but its owner registration/readiness could not be verified. Restore the matching registration or review the original owner; no process was stopped and no recovery files were removed.", port)),
        Err(_) => Err("Core listener state is uncertain; startup refused and recovery evidence preserved".into()),
    }
}
