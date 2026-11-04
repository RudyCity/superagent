use crate::runtime_control;
use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, System};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteService {
    pub kind: &'static str,
    pub can_stop: bool,
    pub can_restart: bool,
    pub can_regenerate_token: bool,
    pub control_reason: Option<String>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
    pub state: &'static str,
    pub transport: Option<String>,
    pub detail: String,
    pub evidence: &'static str,
}

fn parse_record(path: &Path, max: u64) -> Option<Value> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() || meta.len() > max {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn pid_value(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .filter(|n| *n > 0 && *n <= u32::MAX as u64)
        .map(|n| n as u32)
}
fn port_value(value: &Value) -> Option<u16> {
    value
        .as_u64()
        .filter(|n| *n > 0 && *n <= u16::MAX as u64)
        .map(|n| n as u16)
}
fn millisecond_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |v| v.as_millis() as u64)
}
fn owner_live(system: &System, pid: u32, record_ms: Option<u64>) -> bool {
    let Some(p) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    let born_ms = p.start_time().saturating_mul(1000);
    // Reject a reused PID created after the original registered owner.
    record_ms.map_or(false, |registered| {
        born_ms <= registered.saturating_add(5000)
            && registered <= millisecond_now().saturating_add(60_000)
    })
}
fn tunnel_executable(system: &System, pid: u32) -> bool {
    system.process(Pid::from_u32(pid)).map_or(false, |p| {
        let name = p.name().to_ascii_lowercase();
        name == "cloudflared.exe" || name == "cloudflared"
    })
}
struct Candidate {
    kind: &'static str,
    port: Option<u16>,
    record: Value,
}

/// Registry files are bounded and scanned without deleting or mutating stale entries.
fn read_candidates(dir: &Path) -> Vec<Candidate> {
    let mut records = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return records;
    };
    let mut names = entries
        .flatten()
        .take(2048)
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            )
        })
        .collect::<Vec<_>>();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path) in names {
        let key = if let Some(port) = name
            .strip_prefix("mcp-")
            .and_then(|s| s.strip_suffix(".json"))
            .and_then(|s| s.parse::<u16>().ok())
        {
            if port == 0 {
                continue;
            }
            ("mcp", Some(port))
        } else if let Some(port) = name
            .strip_prefix("tunnel-")
            .and_then(|s| s.strip_suffix(".json"))
            .and_then(|s| s.parse::<u16>().ok())
        {
            if port == 0 {
                continue;
            }
            ("cloudflare", Some(port))
        } else if let Some(port) = name
            .strip_prefix("core-supervisor-")
            .and_then(|s| s.strip_suffix(".json"))
            .and_then(|s| s.parse::<u16>().ok())
        {
            if port == 0 {
                continue;
            }
            ("core-supervisor", Some(port))
        } else if name.starts_with("muse-watch-") && name.ends_with(".json") {
            ("muse-watch", None)
        } else {
            continue;
        };
        if records.len() >= 100 {
            break;
        }
        if let Some(value) = parse_record(&path, 8192) {
            if key.0 == "muse-watch" {
                if value["version"] != 1 {
                    continue;
                }
                // Journal filename includes both PID and a per-watcher nonce.
                let Some(pid) = pid_value(&value["pid"]) else {
                    continue;
                };
                if !name.starts_with(&format!("muse-watch-{}-", pid)) {
                    continue;
                }
            } else if key.0 == "core-supervisor" {
                if port_value(&value["publicPort"]) != key.1
                    || pid_value(&value["supervisorPid"]).is_none()
                {
                    continue;
                }
            } else if port_value(&value["port"]) != key.1 {
                continue;
            }
            records.push(Candidate {
                kind: key.0,
                port: if key.0 == "muse-watch" {
                    port_value(&value["controlPort"])
                } else {
                    key.1
                },
                record: value,
            });
        }
    }
    records
}
async fn observed_mcp_endpoint(port: u16) -> bool {
    // Unauthorized GET is allowed only as a probe, never credentialed: no
    // model/tools can be invoked and a 401 challenge is expected.
    let Ok(client) = Client::builder()
        .timeout(Duration::from_millis(1250))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{}/mcp", port))
        .send()
        .await
    else {
        return false;
    };
    let challenge = response
        .headers()
        .get("www-authenticate")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    response.status() == StatusCode::UNAUTHORIZED && challenge.contains("bearer")
}
async fn evaluate(candidate: Candidate, system: &System, now: u64, dir: &Path) -> RemoteService {
    let pid = if candidate.kind == "core-supervisor" {
        pid_value(&candidate.record["supervisorPid"])
    } else {
        pid_value(&candidate.record["pid"])
    };
    let registered = candidate.record["startedAt"]
        .as_u64()
        .or_else(|| candidate.record["processStartedAt"].as_u64());
    let alive = pid.is_some_and(|id| owner_live(system, id, registered));
    let mut service = RemoteService {
        kind: candidate.kind,
        can_stop: false,
        can_restart: false,
        can_regenerate_token: false,
        control_reason: None,
        port: candidate.port,
        pid,
        state: "stale",
        transport: None,
        detail: String::new(),
        evidence: "registry only: owner PID is dead, reused or unverifiable",
    };
    if !alive && candidate.kind != "core-supervisor" {
        return service;
    }
    match candidate.kind {
        "core-supervisor" => {
            if let (Some(port), Some(pid)) = (candidate.port, pid) {
                if system.process(Pid::from_u32(pid)).is_some() {
                    let (stop, restart) =
                        runtime_control::capabilities(dir, candidate.kind, port, pid).await;
                    service.can_stop = stop;
                    service.can_restart = restart;
                    service.control_reason =
                        runtime_control::unavailable_reason(dir, candidate.kind, port, pid).await;
                    service.state = if restart { "online" } else { "unverified" };
                    service.evidence = if restart {
                        "authenticated Core Supervisor owner contract"
                    } else {
                        "supervisor registry present, private lifecycle not verified"
                    };
                    service.detail = "Supervisor owns Core generations and session affinity".into();
                }
            }
        }
        "mcp" => {
            let provider = candidate.record["tunnelProvider"]
                .as_str()
                .unwrap_or("unknown");
            service.transport = Some(provider.chars().take(24).collect());
            if let Some(port) = candidate.port {
                if observed_mcp_endpoint(port).await {
                    service.state = "observed";
                    service.evidence = "owner PID verified + local MCP Bearer challenge";
                    service.detail =
                        "MCP HTTP listener responds (authentication not attempted)".into();
                    if let Some(pid) = pid {
                        (service.can_stop, service.can_restart) =
                            runtime_control::capabilities(dir, "mcp", port, pid).await;
                        service.can_regenerate_token =
                            runtime_control::can_regenerate_token(dir, "mcp", port, pid).await;
                        if !service.can_stop || !service.can_restart {
                            service.control_reason =
                                runtime_control::unavailable_reason(dir, "mcp", port, pid).await;
                        }
                    }
                } else {
                    service.state = "unverified";
                    service.evidence = "owner PID matches but MCP HTTP endpoint is not confirmed";
                    service.detail = "Check owner endpoint, proxy, and MCP lifecycle".into();
                }
            }
        }
        "cloudflare" => {
            let kind = candidate.record["serviceKind"]
                .as_str()
                .unwrap_or("unknown");
            service.transport = Some(kind.chars().take(30).collect());
            if !pid.is_some_and(|id| tunnel_executable(system, id)) {
                service.state = "unverified";
                service.evidence = "owner PID matches, but process is not cloudflared";
                return service;
            }
            let heartbeat = &candidate.record["heartbeat"];
            let success = heartbeat["lastSuccessAt"].as_u64().unwrap_or(0);
            let fresh = success > 0
                && success <= now.saturating_add(5000)
                && now.saturating_sub(success) <= 120_000;
            if fresh && heartbeat["lastStatus"] == "healthy" {
                service.state = "online";
                service.evidence = "cloudflared owner PID + healthy recent tunnel heartbeat";
                service.detail = "Cloudflare quick tunnel reports healthy ingress".into();
            } else {
                service.state = "observed";
                service.evidence =
                    "cloudflared owner PID verified; public ingress health is not fresh";
                service.detail = "Tunnel process alive; external reachability not confirmed".into();
            }
        }
        "muse-watch" => {
            let updated = candidate.record["updatedAt"].as_u64().unwrap_or(0);
            let fresh = updated > 0
                && updated <= now.saturating_add(5000)
                && now.saturating_sub(updated) <= 30_000;
            let transport = candidate.record["transport"].as_str().unwrap_or("unknown");
            if !["telegram", "websocket", "https"].contains(&transport) {
                return service;
            }
            service.transport = Some(transport.into());
            if fresh {
                if let (Some(port), Some(pid)) = (candidate.port, pid) {
                    (service.can_stop, service.can_restart) =
                        runtime_control::capabilities(dir, "muse-watch", port, pid).await;
                    service.can_regenerate_token =
                        runtime_control::can_regenerate_token(dir, "muse-watch", port, pid).await;
                    if !service.can_stop || !service.can_restart {
                        service.control_reason =
                            runtime_control::unavailable_reason(dir, "muse-watch", port, pid).await;
                    }
                }
                if candidate.record["running"] == false && service.can_restart {
                    service.state = "idle";
                    service.evidence = "authenticated Muse owner + fresh heartbeat";
                    service.detail = "Muse Watch stopped; private owner ready to restart".into();
                    return service;
                }
                service.state = if candidate.record["ready"] == true {
                    "online"
                } else {
                    "observed"
                };
                service.evidence = "owner PID verified + recent Muse Watch heartbeat";
                service.detail = if service.state == "online" {
                    "Muse Watch transport reports ready (not proof of remote task delivery)"
                } else {
                    "Muse Watch listener active; remote ingress not ready"
                }
                .into();
            } else {
                service.state = "unverified";
                service.evidence = "owner PID verified but Muse Watch heartbeat is old";
                service.detail = "Could be stopped or blocked; restart is not automatic".into();
            }
        }
        _ => {}
    }
    service
}

pub async fn scan(dir: &Path) -> Vec<RemoteService> {
    let path = dir.to_owned();
    let Ok(candidates) = tokio::task::spawn_blocking(move || read_candidates(&path)).await else {
        return vec![];
    };
    let mut system = System::new();
    system.refresh_processes();
    let now = millisecond_now();
    let mut results = Vec::new();
    let mut dedup = HashSet::<(&str, Option<u16>, Option<u32>)>::new();
    // Only a few MCP HTTP pings may be needed; bounded by 100 persisted files.
    for candidate in candidates {
        let evaluated = evaluate(candidate, &system, now, dir).await;
        if dedup.insert((evaluated.kind, evaluated.port, evaluated.pid)) {
            results.push(evaluated);
        }
    }
    results.sort_by_key(|item| (item.kind, item.port, item.pid));
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn confirms_live_mcp_challenge_without_credentials_or_leaking_public_url() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        let listener = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buf = [0u8; 2048];
            let count = stream.read(&mut buf).unwrap();
            let request = String::from_utf8_lossy(&buf[..count]);
            assert!(request.starts_with("GET /mcp "));
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"mcp\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let started = millisecond_now();
        let root =
            std::env::temp_dir().join(format!("sa-remote-live-{}-{}", std::process::id(), started));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(format!("mcp-{}.json", port)),
            serde_json::json!({
                "pid":std::process::id(),"port":port,"startedAt":started,
                "tunnelProvider":"cloudflare", "publicUrl":"https://must-not-leak.example",
                "bearerToken":"must-not-leak"
            })
            .to_string(),
        )
        .unwrap();
        let result = scan(&root).await;
        listener.join().unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].state, "observed");
        let safe = serde_json::to_string(&result[0]).unwrap();
        assert!(!safe.contains("must-not-leak"));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fresh_muse_presence_is_visible_but_old_heartbeat_is_not_ready() {
        let stamp = millisecond_now();
        let root =
            std::env::temp_dir().join(format!("sa-muse-presence-{}-{}", std::process::id(), stamp));
        fs::create_dir_all(&root).unwrap();
        let filename = root.join(format!(
            "muse-watch-{}-abcdef012345.json",
            std::process::id()
        ));
        let value = serde_json::json!({
            "version":1,"pid":std::process::id(),"processStartedAt":stamp,
            "watcherStartedAt":stamp,"updatedAt":stamp,"transport":"telegram",
            "ready":true,"botToken":"must-not-leak"
        });
        fs::write(&filename, value.to_string()).unwrap();
        let live = scan(&root).await;
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].state, "online");
        assert!(!serde_json::to_string(&live[0])
            .unwrap()
            .contains("must-not-leak"));
        let mut stale = value;
        stale["updatedAt"] = serde_json::json!(1);
        fs::write(&filename, stale.to_string()).unwrap();
        let old = scan(&root).await;
        assert_eq!(old[0].state, "unverified");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_only_matching_bounded_registry_and_sanitizes_source_fields() {
        let dir = std::env::temp_dir().join(format!("sa-remote-detection-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("mcp-8857.json"),
            serde_json::json!({
                "pid":std::process::id(),"port":8857,"startedAt":millisecond_now(),
                "publicUrl":"https://sensitive.example","bearerToken":"secret"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("mcp-8858.json"),
            serde_json::json!({"pid":1,"port":8857}).to_string(),
        )
        .unwrap();
        let list = read_candidates(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].port, Some(8857));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_pid_is_never_reported_online_even_with_healthy_heartbeat() {
        let system = System::new();
        assert!(!owner_live(&system, 4_294_967_290, Some(millisecond_now())));
    }
}
