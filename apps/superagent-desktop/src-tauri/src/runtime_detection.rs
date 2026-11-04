//! Read-only SuperAgent runtime inventory for Tauri.
//! Combines authenticated loopback Core probes with the official local
//! SuperAgent process journal. Never exports bearer credentials or process
//! command lines to the WebView. File presence or PID alone is not "online".

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, System};

const MAX_REGISTERED_CORES: usize = 24;
const MAX_JOURNAL_ENTRIES: usize = 100;
const MAX_JSON_BYTES: u64 = 2 * 1024 * 1024;

static SELECTED_PORT: OnceLock<Mutex<Option<u16>>> = OnceLock::new();

fn selected_port_lock() -> &'static Mutex<Option<u16>> {
    SELECTED_PORT.get_or_init(|| Mutex::new(None))
}

pub fn selected_port() -> Option<u16> {
    selected_port_lock().lock().ok().and_then(|guard| *guard)
}

#[derive(Clone, Deserialize)]
#[allow(non_snake_case)]
struct RawServerInfo {
    port: u16,
    pid: Option<u32>,
    #[serde(default)]
    startedAt: Option<u64>,
    authToken: String,
}

#[derive(Clone)]
struct CoreRecord {
    info: RawServerInfo,
    origin: &'static str,
}

pub struct RuntimeCredentials {
    pub port: u16,
    pub auth_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcess {
    pid: u32,
    role: String,
    state: &'static str,
    workspace: String,
    agent_running: bool,
    heartbeat_age_seconds: u64,
    evidence: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCore {
    port: u16,
    source: &'static str,
    pid: Option<u32>,
    pid_verified: bool,
    state: &'static str,
    version: Option<String>,
    selected: bool,
    evidence: &'static str,
    daemon: Option<Value>,
    gateway: Option<Value>,
    services: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeIndependentHost {
    kind: &'static str,
    port: u16,
    pid: Option<u32>,
    state: &'static str,
    backend_ready: Option<bool>,
    detail: String,
    evidence: &'static str,
}

#[derive(Clone)]
struct HostCandidate {
    port: u16,
    pid: Option<u32>,
    instance_id: Option<String>,
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    scanned_at: u64,
    core_count: usize,
    healthy_core_count: usize,
    active_process_count: usize,
    selected_core_port: Option<u16>,
    cores: Vec<RuntimeCore>,
    processes: Vec<RuntimeProcess>,
    independent_hosts: Vec<RuntimeIndependentHost>,
    notes: Vec<String>,
}

struct LocalInventory {
    cores: Vec<CoreRecord>,
    pid_verified: HashSet<u32>,
    os_pids: HashSet<u32>,
    hosts: Vec<HostCandidate>,
    processes: Vec<RuntimeProcess>,
}

fn checked_file_read(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Runtime metadata is missing".to_string())?;
    if !metadata.file_type().is_file() || metadata.len() > max {
        return Err("Runtime metadata must be a bounded regular file".into());
    }
    fs::read(path).map_err(|_| "Runtime metadata cannot be read".into())
}

fn parse_core(path: &Path, expected_port: Option<u16>, origin: &'static str) -> Option<CoreRecord> {
    let bytes = checked_file_read(path, 16 * 1024).ok()?;
    let info: RawServerInfo = serde_json::from_slice(&bytes).ok()?;
    let token = info.authToken.as_bytes();
    if info.port == 0
        || expected_port.is_some_and(|port| port != info.port)
        || token.len() != 48
        || !token.iter().all(u8::is_ascii_hexdigit)
    {
        return None;
    }
    Some(CoreRecord { info, origin })
}

fn core_records(dir: &Path) -> Vec<CoreRecord> {
    let mut indexed = BTreeMap::<u16, CoreRecord>::new();
    if let Some(info) = parse_core(&dir.join("server-info.json"), None, "default") {
        indexed.insert(info.info.port, info);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten().take(150) {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(port_text) = name
                .strip_prefix("server-info-")
                .and_then(|s| s.strip_suffix(".json"))
            else {
                continue;
            };
            let Ok(port) = port_text.parse::<u16>() else {
                continue;
            };
            if port == 0 || indexed.len() >= MAX_REGISTERED_CORES {
                break;
            }
            if let Some(info) = parse_core(&entry.path(), Some(port), "per-port") {
                indexed.insert(port, info);
            }
        }
    }
    indexed.into_values().take(MAX_REGISTERED_CORES).collect()
}

pub fn server_info(dir: &Path) -> Result<RuntimeCredentials, String> {
    let cores = core_records(dir);
    let port = selected_port();
    let chosen = if let Some(selected) = port {
        cores.into_iter().find(|entry| entry.info.port == selected)
            .ok_or_else(|| "Selected Core is no longer registered. Select another active Core from Runtime Detection.".to_string())?
    } else {
        // server-info.json is the authoritative default. Its companion
        // per-port record can overwrite the same entry in the dedup map.
        parse_core(&dir.join("server-info.json"), None, "default")
            .or_else(|| cores.first().cloned())
            .ok_or_else(|| {
                "No SuperAgent Core registration found. Start Core or use Runtime Detection."
                    .to_string()
            })?
    };
    Ok(RuntimeCredentials {
        port: chosen.info.port,
        auth_token: chosen.info.authToken,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    pid: u32,
    mode: String,
    #[serde(default)]
    working_directory: String,
    #[serde(default)]
    started_at: u64,
    #[serde(default)]
    last_heartbeat: u64,
    #[serde(default)]
    is_agent_running: bool,
}

fn read_inventory(dir: &Path) -> LocalInventory {
    let cores = core_records(dir);
    // This OS inspection is independent of Core availability. It checks that a
    // journal heartbeat still belongs to the same process, preventing PID reuse.
    let system = System::new_all();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64);
    let mut pid_verified = HashSet::new();
    for core in &cores {
        if let Some(pid) = core.info.pid {
            if let Some(process) = system.process(Pid::from_u32(pid)) {
                let born_ms = process.start_time().saturating_mul(1000);
                if core.info.startedAt.map_or(true, |registered| {
                    born_ms <= registered.saturating_add(5000)
                }) {
                    pid_verified.insert(pid);
                }
            }
        }
    }
    let journal = checked_file_read(&dir.join("active-processes.json"), MAX_JSON_BYTES)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .unwrap_or_default();
    let mut processes = Vec::new();
    let mut seen = HashSet::new();
    for raw in journal.into_iter().take(MAX_JOURNAL_ENTRIES) {
        let Ok(entry) = serde_json::from_value::<JournalEntry>(raw) else {
            continue;
        };
        if entry.pid == 0 || !seen.insert(entry.pid) {
            continue;
        }
        if !["server", "mcp", "cli", "single", "multi"].contains(&entry.mode.as_str()) {
            continue;
        }
        let process = system.process(Pid::from_u32(entry.pid));
        let heartbeat_age = now_ms.saturating_sub(entry.last_heartbeat);
        let has_matching_pid = process.is_some_and(|found| {
            let created = found.start_time().saturating_mul(1000);
            created <= entry.started_at.saturating_add(5000)
        });
        let heartbeat_fresh =
            entry.last_heartbeat <= now_ms.saturating_add(5000) && heartbeat_age <= 20_000;
        let active = has_matching_pid && heartbeat_fresh;
        let basename = PathBuf::from(&entry.working_directory)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".into());
        processes.push(RuntimeProcess {
            pid: entry.pid,
            role: match entry.mode.as_str() {
                "server" => "Core / API host",
                "mcp" => "MCP host",
                "multi" => "Multi-agent CLI",
                "single" | "cli" => "SuperAgent CLI",
                _ => "SuperAgent process",
            }
            .to_string(),
            state: if active { "active" } else { "stale" },
            workspace: basename.chars().take(96).collect(),
            agent_running: active && entry.is_agent_running,
            heartbeat_age_seconds: heartbeat_age / 1000,
            evidence: if active {
                "OS PID + start time + fresh SuperAgent heartbeat"
            } else {
                "stale journal / PID mismatch / no process"
            },
        });
    }
    processes.sort_by_key(|entry| (entry.state != "active", entry.pid));
    LocalInventory {
        cores,
        pid_verified,
        processes,
    }
}

async fn bounded_json(
    client: &Client,
    info: &RawServerInfo,
    route: &'static str,
) -> Result<(StatusCode, Value), String> {
    let url = format!("http://127.0.0.1:{}{}", info.port, route);
    let mut reply = client
        .get(&url)
        .bearer_auth(&info.authToken)
        .send()
        .await
        .map_err(|_| "Unreachable".to_string())?;
    let status = reply.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = reply
        .chunk()
        .await
        .map_err(|_| "Invalid HTTP response".to_string())?
    {
        if bytes.len() + chunk.len() > 64 * 1024 {
            return Err("Oversized HTTP response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| "Invalid Core JSON".to_string())?;
    Ok((status, value))
}

async fn probe_core(record: CoreRecord, pid_verified: bool) -> RuntimeCore {
    let mut core = RuntimeCore {
        port: record.info.port,
        source: record.origin,
        pid: record.info.pid,
        pid_verified,
        state: "unreachable",
        version: None,
        selected: selected_port() == Some(record.info.port),
        evidence: "registration only; no authenticated API confirmation",
        daemon: None,
        gateway: None,
        services: None,
    };
    let Ok(client) = Client::builder()
        .timeout(Duration::from_millis(1600))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return core;
    };
    match bounded_json(&client, &record.info, "/api/status").await {
        Ok((StatusCode::OK, value))
            if value.get("status").and_then(Value::as_str) == Some("online")
                && value.get("version").and_then(Value::as_str).is_some() =>
        {
            core.state = "online";
            core.version = value
                .get("version")
                .and_then(Value::as_str)
                .map(|s| s.chars().take(50).collect());
            core.evidence = "authenticated /api/status";
            // Existing Core endpoints; unsupported endpoints remain unknown,
            // never reported as definitely stopped.
            let (daemon, gateway, services) = tokio::join!(
                bounded_json(&client, &record.info, "/api/daemon/status"),
                bounded_json(&client, &record.info, "/api/gateway/status"),
                bounded_json(&client, &record.info, "/api/desktop/runtime-services"),
            );
            if let Ok((StatusCode::OK, value)) = daemon {
                core.daemon = Some(json!({
                    "running": value["running"] == true,
                    "totalJobs": value["totalJobsCount"].as_u64().unwrap_or(0),
                    "activeJobs": value["activeJobsCount"].as_u64().unwrap_or(0),
                }));
            }
            if let Ok((StatusCode::OK, value)) = gateway {
                core.gateway = Some(json!({
                    "enabled": value["enabled"] == true,
                    "status": value["status"].as_str().unwrap_or("unknown"),
                }));
            }
            if let Ok((StatusCode::OK, value)) = services {
                // This path is intentionally read-only and already redacted by Core.
                if value["success"] == true && value["scope"] == "this-core-process" {
                    core.services = Some(value);
                }
            }
        }
        Ok((StatusCode::UNAUTHORIZED, _)) | Ok((StatusCode::FORBIDDEN, _)) => {
            core.state = "unauthorized";
            core.evidence = "API reachable but credentials rejected";
        }
        Ok(_) => {
            core.state = "unverified";
            core.evidence = "HTTP response did not authenticate as SuperAgent Core";
        }
        Err(_) => {}
    }
    core
}

pub async fn select_core(dir: &Path, port: u16) -> Result<(), String> {
    let record = core_records(dir)
        .into_iter()
        .find(|r| r.info.port == port)
        .ok_or_else(|| "Core is not registered on the requested port".to_string())?;
    let result = probe_core(record, false).await;
    if result.state != "online" {
        return Err("Cannot select Core until its authenticated health check succeeds".into());
    }
    *selected_port_lock()
        .lock()
        .map_err(|_| "Selected Core lock unavailable")? = Some(port);
    Ok(())
}

pub async fn detect_runtime(dir: &Path) -> Result<RuntimeSnapshot, String> {
    let path = dir.to_owned();
    let local = tokio::task::spawn_blocking(move || read_inventory(&path))
        .await
        .map_err(|_| "Local runtime inspection failed".to_string())?;
    let mut handles = Vec::new();
    for record in local.cores {
        let verified = record
            .info
            .pid
            .is_some_and(|pid| local.pid_verified.contains(&pid));
        handles.push(tokio::spawn(probe_core(record, verified)));
    }
    let mut cores = Vec::new();
    for handle in handles {
        if let Ok(probe) = handle.await {
            cores.push(probe);
        }
    }
    cores.sort_by_key(|core| core.port);
    let effective_port = selected_port()
        .or_else(|| {
            parse_core(&dir.join("server-info.json"), None, "default").map(|core| core.info.port)
        })
        .or_else(|| cores.first().map(|core| core.port));
    for core in &mut cores {
        core.selected = Some(core.port) == effective_port;
    }
    let healthy_core_count = cores.iter().filter(|core| core.state == "online").count();
    let active_process_count = local
        .processes
        .iter()
        .filter(|process| process.state == "active")
        .count();
    Ok(RuntimeSnapshot {
        scanned_at: SystemTime::now().duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_millis() as u64),
        core_count: cores.len(),
        healthy_core_count,
        active_process_count,
        selected_core_port: effective_port,
        cores,
        processes: local.processes,
        notes: vec![
            "Core online requires authenticated GET /api/status; a saved port or PID is not proof.".into(),
            "CLI and MCP processes require a matching OS PID, creation time and fresh process-journal heartbeat.".into(),
            "Muse, Telegram, MCP and tunnel health are per-Core snapshots, not global proof for a separate owner process.".into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    #[tokio::test]
    async fn detects_authentic_local_core_and_live_journal_without_leaking_tokens() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "b".repeat(48);
        let expected = token.clone();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0u8; 4096];
            let bytes = socket.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..bytes]);
            let good = request.contains(&format!("Bearer {}", expected))
                && request.starts_with("GET /api/status ");
            let response = if good {
                r#"{"status":"online","version":"1.14.62"}"#
            } else {
                r#"{"error":"Unauthorized"}"#
            };
            let status = if good { "200 OK" } else { "401 Unauthorized" };
            let reply = format!("HTTP/1.1 {}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", status, response.len(), response);
            socket.write_all(reply.as_bytes()).unwrap();
        });
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "sagent-runtime-live-test-{}-{}",
            std::process::id(),
            unique
        ));
        fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        fs::write(
            dir.join(format!("server-info-{}.json", port)),
            json!({"port":port,"pid":std::process::id(),"startedAt":now,"authToken":token})
                .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("active-processes.json"),
            json!([{
                "pid":std::process::id(),"mode":"mcp","workingDirectory":"C:/test/superagent",
                "startedAt":now,"lastHeartbeat":now,"isAgentRunning":false
            }])
            .to_string(),
        )
        .unwrap();
        let result = detect_runtime(&dir).await.unwrap();
        worker.join().unwrap();
        assert_eq!(result.healthy_core_count, 1);
        assert_eq!(result.cores[0].port, port);
        assert_eq!(result.cores[0].state, "online");
        assert!(result.cores[0].pid_verified);
        assert_eq!(result.processes.len(), 1);
        assert_eq!(result.processes[0].state, "active");
        assert_eq!(result.processes[0].role, "MCP host");
        assert!(!serde_json::to_string(&result).unwrap().contains(&token));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn default_registration_wins_over_an_earlier_per_port_record() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("sagent-preferred-core-test-{}", unique));
        fs::create_dir_all(&dir).unwrap();
        let token = "c".repeat(48);
        fs::write(
            dir.join("server-info-3000.json"),
            json!({"port":3000,"authToken":token}).to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("server-info.json"),
            json!({"port":7999,"authToken":token}).to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("server-info-7999.json"),
            json!({"port":7999,"authToken":token}).to_string(),
        )
        .unwrap();
        assert_eq!(server_info(&dir).unwrap().port, 7999);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn registration_rejects_mismatched_ports_and_invalid_tokens() {
        let root = std::env::temp_dir().join(format!(
            "sagent-detection-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // Add the PID to ensure parallel test processes do not collide.
        let dir = root.join(format!("{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("server-info-7788.json"),
            serde_json::to_vec(&json!({"port": 7888, "authToken": "a".repeat(48)})).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join("server-info-7789.json"),
            serde_json::to_vec(&json!({"port": 7789, "authToken": "not-a-token"})).unwrap(),
        )
        .unwrap();
        assert!(core_records(&dir).is_empty());
        fs::write(
            dir.join("server-info-7788.json"),
            serde_json::to_vec(&json!({"port": 7788, "authToken": "a".repeat(48)})).unwrap(),
        )
        .unwrap();
        assert_eq!(core_records(&dir).len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn runtime_journal_never_treats_dead_or_stale_pids_as_active() {
        let dir = std::env::temp_dir().join(format!(
            "sagent-process-journal-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let stale = json!([{"pid": 4294967290u32, "mode":"mcp",
            "workingDirectory":"C:/projects/superagent", "startedAt": 1,
            "lastHeartbeat": 1, "isAgentRunning": true}]);
        fs::write(dir.join("active-processes.json"), stale.to_string()).unwrap();
        let inventory = read_inventory(&dir);
        assert_eq!(inventory.processes.len(), 1);
        assert_eq!(inventory.processes[0].state, "stale");
        assert!(!inventory.processes[0].agent_running);
        fs::remove_dir_all(dir).unwrap();
    }
}
