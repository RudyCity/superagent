//! Connection logs and telemetry engine for SuperAgent Tray.
//! Aggregates, parses, filters, searches, and paginates all inbound and outbound
//! connection logs across Chrome Delegate WebSocket sessions, MCP tool activities,
//! OAuth handshakes, Cloudflare/OpenAI tunnels, and Core server HTTP requests.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_TAIL_BYTES: u64 = 1024 * 1024; // Read at most 1MB tail per log source for speed

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLogEntry {
    pub id: String,
    pub timestamp: u64,
    pub timestamp_iso: String,
    pub source: String,       // "delegate" | "mcp" | "oauth" | "tunnel" | "server"
    pub source_label: String, // "Chrome Delegate" | "MCP Activity" | "OAuth Flow" | "Tunnel Bridge" | "Core Server"
    pub direction: String,    // "in" | "out" | "event"
    pub event: String,        // e.g. "socket_open", "connected", "tool_call", "http_request"
    pub endpoint: String,     // e.g. "ws://127.0.0.1:17341", "POST /api/daemon/jobs"
    pub remote_address: Option<String>,
    pub client_id: Option<String>,
    pub status: String, // "success" | "info" | "warn" | "error"
    pub duration_ms: Option<u64>,
    pub detail: String,
    pub raw_json: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLogsQuery {
    pub page: Option<usize>,
    pub page_size: Option<usize>,
    pub search: Option<String>,
    pub source: Option<String>,
    pub direction: Option<String>,
    pub status: Option<String>,
    pub time_range: Option<String>,
    pub sort_by: Option<String>,
    pub sort_order: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLogsResponse {
    pub items: Vec<ConnectionLogEntry>,
    pub total_count: usize,
    pub page: usize,
    pub page_size: usize,
    pub total_pages: usize,
    pub has_next: bool,
    pub has_prev: bool,
    pub source_stats: HashMap<String, usize>,
    pub direction_stats: HashMap<String, usize>,
    pub status_stats: HashMap<String, usize>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn iso_to_ms(iso: &str) -> Option<u64> {
    // Parse ISO-8601 timestamps without heavy dependencies
    // Formats: 2026-11-04T07:58:04.183Z or 2026-11-04T07:58:04Z or with offset
    if iso.len() < 19 {
        return None;
    }
    let parts: Vec<&str> = iso.split('T').collect();
    if parts.len() != 2 {
        return None;
    }
    let date_parts: Vec<u32> = parts[0].split('-').filter_map(|s| s.parse().ok()).collect();
    if date_parts.len() != 3 {
        return None;
    }
    let year = date_parts[0];
    let month = date_parts[1];
    let day = date_parts[2];

    let time_clean = parts[1].trim_end_matches('Z');
    let time_sub: Vec<&str> = time_clean.split('.').collect();
    let hms: Vec<u32> = time_sub[0].split(':').filter_map(|s| s.parse().ok()).collect();
    if hms.len() != 3 {
        return None;
    }
    let hour = hms[0];
    let min = hms[1];
    let sec = hms[2];
    let millis: u32 = if time_sub.len() > 1 {
        let frac = time_sub[1].chars().take(3).collect::<String>();
        frac.parse::<u32>().unwrap_or(0) * (10u32.pow(3 - frac.len() as u32))
    } else {
        0
    };

    // Gregorian day calculation
    let mut total_days: i64 = 0;
    for y in 1970..year {
        let is_leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        total_days += if is_leap { 366 } else { 365 };
    }
    let is_leap_year = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let days_in_months = [
        31,
        if is_leap_year { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    for m in 1..month {
        total_days += days_in_months[(m - 1) as usize];
    }
    total_days += (day as i64) - 1;

    let total_seconds = total_days * 86400
        + (hour as i64) * 3600
        + (min as i64) * 60
        + (sec as i64);
    let total_ms = (total_seconds * 1000) + (millis as i64);
    if total_ms >= 0 {
        Some(total_ms as u64)
    } else {
        None
    }
}

fn ms_to_iso(ms: u64) -> String {
    let secs = ms / 1000;
    let millis = ms % 1000;

    let mut days = secs / 86400;
    let day_secs = secs % 86400;
    let hour = day_secs / 3600;
    let min = (day_secs % 3600) / 60;
    let sec = day_secs % 60;

    let mut year = 1970;
    loop {
        let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if is_leap { 366 } else { 365 };
        if days >= days_in_year {
            days -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let days_in_months = [
        31,
        if is_leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &dim in &days_in_months {
        if days >= dim {
            days -= dim;
            month += 1;
        } else {
            break;
        }
    }
    let day = days + 1;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, min, sec, millis
    )
}

fn read_tail_lines(path: &Path, max_bytes: u64) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(metadata) = file.metadata() else {
        return Vec::new();
    };
    let len = metadata.len();
    let seek_pos = if len > max_bytes { len - max_bytes } else { 0 };
    if file.seek(SeekFrom::Start(seek_pos)).is_err() {
        return Vec::new();
    }

    let mut buffer = String::new();
    if file.read_to_string(&mut buffer).is_err() {
        return Vec::new();
    }

    let mut lines: Vec<String> = buffer
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // If seek dropped the first line in half, drop the first element
    if seek_pos > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

pub fn collect_all_logs(config_dir: &Path) -> Vec<ConnectionLogEntry> {
    let mut entries = Vec::new();

    // 1. Chrome Delegate WebSocket connections (~/.superagent-r/logs/delegate-connections-*.jsonl)
    let logs_dir = config_dir.join("logs");
    if let Ok(dir_entries) = std::fs::read_dir(&logs_dir) {
        let mut files: Vec<PathBuf> = dir_entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("delegate-connections-") && n.ends_with(".jsonl"))
                    .unwrap_or(false)
            })
            .collect();
        files.sort();
        for file in files.into_iter().rev().take(7) {
            let lines = read_tail_lines(&file, MAX_TAIL_BYTES);
            for line in lines {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let ts_str = v["timestamp"].as_str().unwrap_or("");
                    let ts = iso_to_ms(ts_str).unwrap_or_else(now_ms);
                    let event = v["event"].as_str().unwrap_or("unknown").to_string();
                    let conn_id = v["connectionId"].as_str().map(|s| s.to_string());
                    let endpoint = v["endpoint"].as_str().unwrap_or("ws://127.0.0.1:17341").to_string();
                    let remote_ip = v["remoteAddress"].as_str().map(|s| s.to_string());
                    let remote_port = v["remotePort"].as_u64();
                    let remote_addr = remote_ip.map(|ip| {
                        if let Some(port) = remote_port {
                            format!("{}:{}", ip, port)
                        } else {
                            ip
                        }
                    });
                    let client_id = v["clientId"].as_str().map(|s| s.to_string());
                    let profile_label = v["profileLabel"].as_str();
                    let reason_code = v["reasonCode"].as_str();
                    let close_code = v["closeCode"].as_u64();
                    let duration = v["connectedDurationMs"].as_u64().or_else(|| v["handshakeDurationMs"].as_u64());

                    let (direction, status, detail) = match event.as_str() {
                        "listener_started" => (
                            "event".to_string(),
                            "info".to_string(),
                            format!("WebSocket listener started on port {}", v["listenerPort"].as_u64().unwrap_or(17341)),
                        ),
                        "socket_open" => (
                            "in".to_string(),
                            "info".to_string(),
                            format!("Inbound WebSocket opened from {}", remote_addr.as_deref().unwrap_or("unknown")),
                        ),
                        "connected" => (
                            "in".to_string(),
                            "success".to_string(),
                            format!(
                                "Client authenticated: {} ({})",
                                profile_label.unwrap_or("Delegate"),
                                client_id.as_deref().unwrap_or("no-client-id")
                            ),
                        ),
                        "handshake_rejected" => (
                            "in".to_string(),
                            "error".to_string(),
                            format!("Handshake rejected: {}", reason_code.unwrap_or("AUTH_FAILED")),
                        ),
                        "origin_rejected" => (
                            "in".to_string(),
                            "warn".to_string(),
                            "Rejected WebSocket handshake due to untrusted origin".to_string(),
                        ),
                        "disconnected" => (
                            "event".to_string(),
                            "info".to_string(),
                            format!(
                                "Disconnected: {} (code {})",
                                reason_code.unwrap_or("CLOSED"),
                                close_code.unwrap_or(1000)
                            ),
                        ),
                        "socket_error" => (
                            "event".to_string(),
                            "error".to_string(),
                            format!("Socket transport error: {}", v["transportErrorCode"].as_str().unwrap_or("UNKNOWN")),
                        ),
                        _ => (
                            "event".to_string(),
                            "info".to_string(),
                            format!("Event: {}", event),
                        ),
                    };

                    entries.push(ConnectionLogEntry {
                        id: format!("del_{}_{}", ts, conn_id.as_deref().unwrap_or("evt")),
                        timestamp: ts,
                        timestamp_iso: if !ts_str.is_empty() { ts_str.to_string() } else { ms_to_iso(ts) },
                        source: "delegate".to_string(),
                        source_label: "Chrome Delegate".to_string(),
                        direction,
                        event,
                        endpoint,
                        remote_address: remote_addr,
                        client_id,
                        status,
                        duration_ms: duration,
                        detail,
                        raw_json: Some(line),
                    });
                }
            }
        }
    }

    // 2. MCP Activity (~/.superagent-r/mcp-activity.jsonl)
    let mcp_activity_file = config_dir.join("mcp-activity.jsonl");
    if mcp_activity_file.exists() {
        let lines = read_tail_lines(&mcp_activity_file, MAX_TAIL_BYTES);
        for line in lines {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let ts = v["ts"].as_u64().unwrap_or_else(now_ms);
                let pid = v["pid"].as_u64().unwrap_or(0);
                let evt = &v["event"];
                let evt_type = evt["type"].as_str().unwrap_or("event").to_string();
                let tool_name = evt["tool"].as_str().unwrap_or("");
                let ok = evt["ok"].as_bool().unwrap_or(true);
                let duration = evt["durationMs"].as_u64();
                let chat_line = v["chatLine"].as_str().unwrap_or("");

                let (direction, status, endpoint, event_name, detail) = if evt_type == "tool_call" {
                    (
                        "out".to_string(),
                        if ok { "success".to_string() } else { "error".to_string() },
                        format!("mcp://tools/{}", tool_name),
                        format!("tool_call:{}", tool_name),
                        if !chat_line.is_empty() {
                            chat_line.lines().next().unwrap_or("").to_string()
                        } else {
                            format!("Invoked tool {} (ok={})", tool_name, ok)
                        },
                    )
                } else {
                    (
                        "event".to_string(),
                        "info".to_string(),
                        format!("mcp://pid/{}", pid),
                        evt_type,
                        "MCP event dispatched".to_string(),
                    )
                };

                entries.push(ConnectionLogEntry {
                    id: format!("mcp_{}_{}", ts, tool_name),
                    timestamp: ts,
                    timestamp_iso: ms_to_iso(ts),
                    source: "mcp".to_string(),
                    source_label: "MCP Activity".to_string(),
                    direction,
                    event: event_name,
                    endpoint,
                    remote_address: None,
                    client_id: Some(format!("pid:{}", pid)),
                    status,
                    duration_ms: duration,
                    detail,
                    raw_json: Some(line),
                });
            }
        }
    }

    // 3. MCP OAuth & HTTP Audits (~/.superagent-r/mcp-oauth-audit.jsonl)
    let mcp_oauth_file = config_dir.join("mcp-oauth-audit.jsonl");
    if mcp_oauth_file.exists() {
        let lines = read_tail_lines(&mcp_oauth_file, MAX_TAIL_BYTES);
        for line in lines {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let ts_str = v["timestamp"].as_str().unwrap_or("");
                let ts = iso_to_ms(ts_str).unwrap_or_else(now_ms);
                let pid = v["pid"].as_u64().unwrap_or(0);
                let stage = v["stage"].as_str().unwrap_or("oauth_stage").to_string();
                let method = v["method"].as_str().unwrap_or("POST").to_string();
                let status_code = v["statusCode"].as_u64().unwrap_or(200);
                let duration = v["durationMs"].as_u64();
                let status = if status_code < 400 {
                    "success".to_string()
                } else {
                    "error".to_string()
                };

                entries.push(ConnectionLogEntry {
                    id: format!("oauth_{}_{}", ts, pid),
                    timestamp: ts,
                    timestamp_iso: if !ts_str.is_empty() { ts_str.to_string() } else { ms_to_iso(ts) },
                    source: "oauth".to_string(),
                    source_label: "OAuth Flow".to_string(),
                    direction: "in".to_string(),
                    event: stage.clone(),
                    endpoint: format!("{} /{}", method, stage),
                    remote_address: None,
                    client_id: Some(format!("pid:{}", pid)),
                    status,
                    duration_ms: duration,
                    detail: format!("HTTP {} - {} ({}ms)", status_code, stage, duration.unwrap_or(0)),
                    raw_json: Some(line),
                });
            }
        }
    }

    // 4. MCP Owner Lifecycle Events (~/.superagent-r/mcp-owner-*-events.jsonl)
    if let Ok(dir_entries) = std::fs::read_dir(config_dir) {
        for entry in dir_entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("mcp-owner-") && name.ends_with("-events.jsonl") {
                let lines = read_tail_lines(&entry.path(), 512 * 1024);
                for line in lines {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        let ts_str = v["at"].as_str().unwrap_or("");
                        let ts = iso_to_ms(ts_str).unwrap_or_else(now_ms);
                        let event = v["event"].as_str().unwrap_or("lifecycle").to_string();
                        let owner_pid = v["ownerPid"].as_u64().unwrap_or(0);
                        let backend_pid = v["backendPid"].as_u64();
                        let is_err = event.contains("failed") || event.contains("invalidated");
                        let status = if is_err { "error".to_string() } else { "success".to_string() };

                        entries.push(ConnectionLogEntry {
                            id: format!("owner_{}_{}", ts, owner_pid),
                            timestamp: ts,
                            timestamp_iso: if !ts_str.is_empty() { ts_str.to_string() } else { ms_to_iso(ts) },
                            source: "mcp".to_string(),
                            source_label: "MCP Activity".to_string(),
                            direction: "event".to_string(),
                            event: event.clone(),
                            endpoint: format!("mcp://owner/{}", owner_pid),
                            remote_address: None,
                            client_id: backend_pid.map(|p| format!("backend:{}", p)),
                            status,
                            duration_ms: v["durationMs"].as_u64(),
                            detail: format!("Owner lifecycle: {} (pid {}, backend {:?})", event, owner_pid, backend_pid),
                            raw_json: Some(line),
                        });
                    }
                }
            }
        }
    }

    // 5. Core Server HTTP REST/SSE Requests & Responses (~/.superagent-r/superagent-server.log)
    let server_log_file = config_dir.join("superagent-server.log");
    if server_log_file.exists() {
        let lines = read_tail_lines(&server_log_file, MAX_TAIL_BYTES);
        for line in lines {
            if line.starts_with('[') {
                if let Some(close_idx) = line.find(']') {
                    let ts_str = &line[1..close_idx];
                    let ts = iso_to_ms(ts_str).unwrap_or_else(now_ms);
                    let rest = line[close_idx + 1..].trim();

                    if rest.starts_with("[Request]") {
                        let req_text = rest.trim_start_matches("[Request]").trim();
                        let parts: Vec<&str> = req_text.split_whitespace().collect();
                        let method = parts.first().copied().unwrap_or("GET");
                        let path = parts.get(1).copied().unwrap_or("/");

                        entries.push(ConnectionLogEntry {
                            id: format!("req_{}_{}", ts, path.replace('/', "_")),
                            timestamp: ts,
                            timestamp_iso: ts_str.to_string(),
                            source: "server".to_string(),
                            source_label: "Core Server".to_string(),
                            direction: "in".to_string(),
                            event: "http_request".to_string(),
                            endpoint: format!("{} {}", method, path),
                            remote_address: Some("127.0.0.1".to_string()),
                            client_id: None,
                            status: "info".to_string(),
                            duration_ms: None,
                            detail: format!("Inbound HTTP request: {} {}", method, path),
                            raw_json: Some(line.clone()),
                        });
                    } else if rest.starts_with("[Response]") {
                        let resp_text = rest.trim_start_matches("[Response]").trim();
                        let status_code: u64 = if resp_text.contains("Status: ") {
                            resp_text.split("Status: ").nth(1).and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse().ok()).unwrap_or(200)
                        } else {
                            200
                        };
                        let is_err = status_code >= 400;

                        entries.push(ConnectionLogEntry {
                            id: format!("resp_{}_{}", ts, status_code),
                            timestamp: ts,
                            timestamp_iso: ts_str.to_string(),
                            source: "server".to_string(),
                            source_label: "Core Server".to_string(),
                            direction: "out".to_string(),
                            event: "http_response".to_string(),
                            endpoint: format!("Status {}", status_code),
                            remote_address: Some("127.0.0.1".to_string()),
                            client_id: None,
                            status: if is_err { "error".to_string() } else { "success".to_string() },
                            duration_ms: None,
                            detail: format!("Outbound HTTP response status: {}", status_code),
                            raw_json: Some(line.clone()),
                        });
                    }
                }
            }
        }
    }

    // 6. Tunnel Bridge & WebSocket Server Logs (~/.superagent-r/bridge.log)
    let bridge_log_file = config_dir.join("bridge.log");
    if bridge_log_file.exists() {
        let lines = read_tail_lines(&bridge_log_file, 512 * 1024);
        for line in lines {
            if line.starts_with('[') {
                if let Some(close_idx) = line.find(']') {
                    let ts_str = &line[1..close_idx];
                    let ts = iso_to_ms(ts_str).unwrap_or_else(now_ms);
                    let rest = line[close_idx + 1..].trim();

                    if rest.contains("[BRIDGE]") {
                        let msg = rest.replace("[BRIDGE]", "").trim().to_string();
                        let (direction, status) = if msg.contains("Exit Hook") || msg.contains("Closed") {
                            ("event".to_string(), "warn".to_string())
                        } else if msg.contains("Listening") || msg.contains("Started") {
                            ("event".to_string(), "success".to_string())
                        } else {
                            ("event".to_string(), "info".to_string())
                        };

                        entries.push(ConnectionLogEntry {
                            id: format!("bridge_{}", ts),
                            timestamp: ts,
                            timestamp_iso: ts_str.to_string(),
                            source: "tunnel".to_string(),
                            source_label: "Tunnel Bridge".to_string(),
                            direction,
                            event: "bridge_lifecycle".to_string(),
                            endpoint: "ws://127.0.0.1:9223".to_string(),
                            remote_address: None,
                            client_id: None,
                            status,
                            duration_ms: None,
                            detail: msg,
                            raw_json: Some(line.clone()),
                        });
                    }
                }
            }
        }
    }

    // 7. Tunnel Client Logs (~/.superagent-r/tunnel-client.log)
    let tunnel_client_file = config_dir.join("tunnel-client.log");
    if tunnel_client_file.exists() {
        let lines = read_tail_lines(&tunnel_client_file, 512 * 1024);
        for line in lines {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                let time_str = v["time"].as_str().unwrap_or("");
                let ts = iso_to_ms(time_str).unwrap_or_else(now_ms);
                let level = v["level"].as_str().unwrap_or("INFO").to_ascii_lowercase();
                let msg = v["msg"].as_str().unwrap_or("").to_string();
                let tunnel_id = v["tunnel_id"].as_str().unwrap_or("");
                let component = v["component"].as_str().unwrap_or("tunnel");
                let status = match level.as_str() {
                    "error" => "error".to_string(),
                    "warn" => "warn".to_string(),
                    _ => "info".to_string(),
                };

                entries.push(ConnectionLogEntry {
                    id: format!("tunnel_{}_{}", ts, tunnel_id),
                    timestamp: ts,
                    timestamp_iso: if !time_str.is_empty() { time_str.to_string() } else { ms_to_iso(ts) },
                    source: "tunnel".to_string(),
                    source_label: "Tunnel Bridge".to_string(),
                    direction: if level == "warn" || level == "error" { "event".to_string() } else { "out".to_string() },
                    event: component.to_string(),
                    endpoint: if !tunnel_id.is_empty() { format!("tunnel://{}", tunnel_id) } else { "tunnel://client".to_string() },
                    remote_address: None,
                    client_id: v["client_instance_id"].as_str().map(|s| s.to_string()),
                    status,
                    duration_ms: v["latency_ms"].as_u64(),
                    detail: msg,
                    raw_json: Some(line),
                });
            }
        }
    }

    entries
}

pub fn query_connection_logs(
    config_dir: &Path,
    query: ConnectionLogsQuery,
) -> ConnectionLogsResponse {
    let mut all = collect_all_logs(config_dir);
    let now = now_ms();

    // Calculate source, direction, and status statistics across ALL entries before filtering
    let mut source_stats: HashMap<String, usize> = HashMap::new();
    let mut direction_stats: HashMap<String, usize> = HashMap::new();
    let mut status_stats: HashMap<String, usize> = HashMap::new();

    for item in &all {
        *source_stats.entry(item.source.clone()).or_insert(0) += 1;
        *direction_stats.entry(item.direction.clone()).or_insert(0) += 1;
        *status_stats.entry(item.status.clone()).or_insert(0) += 1;
    }

    // Apply Filter: Source
    if let Some(ref source) = query.source {
        if source != "all" && !source.is_empty() {
            all.retain(|item| item.source.eq_ignore_ascii_case(source));
        }
    }

    // Apply Filter: Direction ("in" | "out" | "event")
    if let Some(ref direction) = query.direction {
        if direction != "all" && !direction.is_empty() {
            all.retain(|item| item.direction.eq_ignore_ascii_case(direction));
        }
    }

    // Apply Filter: Status ("success" | "info" | "warn" | "error")
    if let Some(ref status) = query.status {
        if status != "all" && !status.is_empty() {
            all.retain(|item| item.status.eq_ignore_ascii_case(status));
        }
    }

    // Apply Filter: Time Range
    if let Some(ref time_range) = query.time_range {
        match time_range.as_str() {
            "1h" => {
                let threshold = now.saturating_sub(3600 * 1000);
                all.retain(|item| item.timestamp >= threshold);
            }
            "24h" => {
                let threshold = now.saturating_sub(86400 * 1000);
                all.retain(|item| item.timestamp >= threshold);
            }
            "7d" => {
                let threshold = now.saturating_sub(7 * 86400 * 1000);
                all.retain(|item| item.timestamp >= threshold);
            }
            _ => {}
        }
    }

    // Apply Filter: Text Search
    if let Some(ref search) = query.search {
        let needle = search.trim().to_lowercase();
        if !needle.is_empty() {
            all.retain(|item| {
                item.event.to_lowercase().contains(&needle)
                    || item.endpoint.to_lowercase().contains(&needle)
                    || item.detail.to_lowercase().contains(&needle)
                    || item.source_label.to_lowercase().contains(&needle)
                    || item
                        .client_id
                        .as_deref()
                        .map(|c| c.to_lowercase().contains(&needle))
                        .unwrap_or(false)
                    || item
                        .remote_address
                        .as_deref()
                        .map(|a| a.to_lowercase().contains(&needle))
                        .unwrap_or(false)
            });
        }
    }

    // Apply Sorting
    let sort_by = query.sort_by.as_deref().unwrap_or("timestamp");
    let sort_order = query.sort_order.as_deref().unwrap_or("desc");
    let is_asc = sort_order == "asc";

    all.sort_by(|a, b| {
        let cmp = match sort_by {
            "source" => a.source.cmp(&b.source),
            "direction" => a.direction.cmp(&b.direction),
            "event" => a.event.cmp(&b.event),
            "endpoint" => a.endpoint.cmp(&b.endpoint),
            "status" => a.status.cmp(&b.status),
            "duration" => a.duration_ms.unwrap_or(0).cmp(&b.duration_ms.unwrap_or(0)),
            _ => a.timestamp.cmp(&b.timestamp),
        };
        if is_asc {
            cmp
        } else {
            cmp.reverse()
        }
    });

    let total_count = all.len();
    let page_size = query.page_size.unwrap_or(25).clamp(1, 100);
    let total_pages = if total_count == 0 {
        1
    } else {
        (total_count + page_size - 1) / page_size
    };
    let page = query.page.unwrap_or(1).clamp(1, total_pages);

    let start = (page - 1) * page_size;
    let end = (start + page_size).min(total_count);

    let items = if start < total_count {
        all[start..end].to_vec()
    } else {
        Vec::new()
    };

    ConnectionLogsResponse {
        items,
        total_count,
        page,
        page_size,
        total_pages,
        has_next: page < total_pages,
        has_prev: page > 1,
        source_stats,
        direction_stats,
        status_stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_iso_parsing_and_formatting() {
        let iso = "2026-11-04T07:58:04.183Z";
        let ms = iso_to_ms(iso).expect("Failed to parse iso");
        assert!(ms > 0);
        let back = ms_to_iso(ms);
        assert_eq!(back, iso);
    }

    #[test]
    fn test_filter_and_pagination() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("sa_test_logs_{}", unique));
        let logs_dir = temp_dir.join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();

        // Write a mock delegate log
        let delegate_file = logs_dir.join("delegate-connections-2026-11-04.jsonl");
        let mut f = File::create(&delegate_file).unwrap();
        writeln!(
            f,
            r#"{{"timestamp":"2026-11-04T07:58:04.183Z","event":"socket_open","pid":2512,"listenerPort":17341,"endpoint":"ws://127.0.0.1:17341","remoteAddress":"127.0.0.1","remotePort":49976,"connectionId":"conn-1"}}"#
        ).unwrap();
        writeln!(
            f,
            r#"{{"timestamp":"2026-11-04T07:58:05.183Z","event":"connected","pid":2512,"listenerPort":17341,"endpoint":"ws://127.0.0.1:17341","clientId":"client-alpha","profileLabel":"Chrome Profile 1","connectionId":"conn-1","connectedDurationMs":500}}"#
        ).unwrap();
        writeln!(
            f,
            r#"{{"timestamp":"2026-11-04T07:58:06.183Z","event":"handshake_rejected","pid":2512,"listenerPort":17341,"endpoint":"ws://127.0.0.1:17341","reasonCode":"AUTH_FAILED","connectionId":"conn-2"}}"#
        ).unwrap();

        // Query all
        let res = query_connection_logs(&temp_dir, ConnectionLogsQuery {
            page: Some(1),
            page_size: Some(10),
            search: None,
            source: None,
            direction: None,
            status: None,
            time_range: None,
            sort_by: Some("timestamp".to_string()),
            sort_order: Some("desc".to_string()),
        });
        assert_eq!(res.total_count, 3);
        assert_eq!(res.items.len(), 3);
        assert_eq!(res.items[0].event, "handshake_rejected"); // newest first

        // Query with filter: direction = "in", status = "error"
        let err_res = query_connection_logs(&temp_dir, ConnectionLogsQuery {
            page: Some(1),
            page_size: Some(10),
            search: None,
            source: None,
            direction: Some("in".to_string()),
            status: Some("error".to_string()),
            time_range: None,
            sort_by: None,
            sort_order: None,
        });
        assert_eq!(err_res.total_count, 1);
        assert_eq!(err_res.items[0].event, "handshake_rejected");

        // Query with search: "client-alpha"
        let search_res = query_connection_logs(&temp_dir, ConnectionLogsQuery {
            page: Some(1),
            page_size: Some(10),
            search: Some("client-alpha".to_string()),
            source: None,
            direction: None,
            status: None,
            time_range: None,
            sort_by: None,
            sort_order: None,
        });
        assert_eq!(search_res.total_count, 1);
        assert_eq!(search_res.items[0].client_id.as_deref(), Some("client-alpha"));

        // Cleanup
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

