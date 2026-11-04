//! Explicit, operator-confirmed service lifecycle actions.
//! The WebView never receives tokens, process command lines, tunnel URLs,
//! or a general HTTP/shell interface. Operations require owner identity
//! from protected SuperAgent discovery records and authenticated loopback.
use reqwest::{Client, Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, System};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedLease {
    version: u8,
    kind: String,
    pid: u32,
    port: u16,
    nonce: String,
    created_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupervisorDiscovery {
    supervisor_pid: u32,
    public_port: u16,
    control_port: u16,
    control_token: String,
}

fn read_private(path: &Path, max_bytes: u64) -> Result<Value, String> {
    let meta =
        fs::symlink_metadata(path).map_err(|_| "Owner registration is missing".to_string())?;
    if !meta.file_type().is_file() || meta.len() > max_bytes || meta.len() == 0 {
        return Err("Owner registration is not a bounded regular file".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| "Could not read owner registration")?)
        .map_err(|_| "Owner registration has invalid JSON".into())
}

fn owned_pid(pid: u32, created_at: u64) -> bool {
    if pid == 0 || created_at == 0 {
        return false;
    }
    let mut system = System::new();
    system.refresh_processes();
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return false;
    };
    let birth_ms = process.start_time().saturating_mul(1000);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    birth_ms <= created_at.saturating_add(5_000) && created_at <= now.saturating_add(5_000)
}

fn read_lease(dir: &Path, port: u16, pid: u32) -> Result<ManagedLease, String> {
    if port < 1024 || port == 7888 {
        return Err("Protected or invalid MCP owner port".into());
    }
    let lease: ManagedLease = serde_json::from_value(read_private(
        &dir.join(format!("mcp-owner-{}.json", port)),
        8192,
    )?)
    .map_err(|_| "Invalid MCP owner lease")?;
    if lease.version != 1
        || lease.kind != "managed_mcp_tunnel_owner"
        || lease.port != port
        || lease.pid != pid
        || lease.nonce.len() != 64
        || !lease
            .nonce
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || !owned_pid(lease.pid, lease.created_at)
    {
        return Err("MCP owner identity did not match the running process".into());
    }
    let state = read_private(&dir.join(format!("mcp-{}.json", port)), 8192)?;
    if state["port"] != port || state["pid"] != pid || state["startedAt"] != lease.created_at {
        return Err("MCP owner and HTTP registry are inconsistent".into());
    }
    Ok(lease)
}
fn read_supervisor(dir: &Path, port: u16, pid: u32) -> Result<SupervisorDiscovery, String> {
    let owner: SupervisorDiscovery = serde_json::from_value(read_private(
        &dir.join(format!("core-supervisor-{}.json", port)),
        4096,
    )?)
    .map_err(|_| "Invalid Core supervisor registration")?;
    if owner.public_port != port
        || owner.supervisor_pid != pid
        || owner.control_port == 0
        || owner.control_token.len() != 64
        || !owner
            .control_token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Core supervisor owner identity did not match the requested service".into());
    }
    Ok(owner)
}
fn client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not build private loopback client".into())
}
async fn call(
    port: u16,
    path: &str,
    token: &str,
    method: Method,
    timeout: Duration,
) -> Result<(StatusCode, Value), String> {
    let client = client(timeout)?;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let mut response = client
        .request(method, url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Owner loopback control did not respond".to_string())?;
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Owner loopback response was interrupted")?
    {
        if body.len() + chunk.len() > 16 * 1024 {
            return Err("Owner status exceeds safe response limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    let parsed =
        serde_json::from_slice(&body).map_err(|_| "Owner returned invalid JSON".to_string())?;
    Ok((status, parsed))
}

fn verify_mcp_identity(lease: &ManagedLease, status: &Value) -> Result<(), String> {
    if status["version"] != 1
        || status["kind"] != "private_mcp_owner"
        || status["mode"] != "managed-tunnel"
        || status["pid"] != lease.pid
        || status["port"] != lease.port
        || status["startedAt"] != lease.created_at
        || status["publicTunnelStarted"] != true
        || !status["draining"].is_boolean()
        || !status["activeSessions"].is_u64()
        || !status["inFlightRequests"].is_u64()
        || status["inflightToolEffects"] != "unknown"
    {
        return Err("MCP owner authentication or identity mismatch".into());
    }
    Ok(())
}
async fn mcp_status(lease: &ManagedLease) -> Result<Value, String> {
    let (http, status) = call(
        lease.port,
        "/_internal/owner/status",
        &lease.nonce,
        Method::GET,
        Duration::from_millis(2300),
    )
    .await?;
    if http != StatusCode::OK {
        return Err("MCP managed owner rejected private status".into());
    }
    verify_mcp_identity(lease, &status)?;
    Ok(status)
}
fn verify_supervisor_identity(owner: &SupervisorDiscovery, status: &Value) -> Result<(), String> {
    if status["supervisorPid"] != owner.supervisor_pid
        || status["publicPort"] != owner.public_port
        || status["ownerContract"]["version"] != 1
        || status["ownerContract"]["role"] != "core-supervisor"
        || status["ownerContract"]["mcpLifecycle"] != "not-owned"
        || !status["active"]["pid"].is_u64()
    {
        return Err("Core supervisor identity/contract mismatch".into());
    }
    Ok(())
}
async fn supervisor_status(owner: &SupervisorDiscovery) -> Result<Value, String> {
    let (http, status) = call(
        owner.control_port,
        "/status",
        &owner.control_token,
        Method::GET,
        Duration::from_millis(2500),
    )
    .await?;
    if http != StatusCode::OK {
        return Err("Core supervisor refused private status".into());
    }
    verify_supervisor_identity(owner, &status)?;
    Ok(status)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MuseLease {
    version: u8,
    pid: u32,
    process_started_at: u64,
    control_port: u16,
    control_id: String,
    control_token: String,
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
fn read_muse_lease(dir: &Path, port: u16, pid: u32) -> Result<MuseLease, String> {
    if port == 0 || pid == 0 {
        return Err("Invalid Muse owner port/PID".into());
    }
    let candidates = fs::read_dir(dir).map_err(|_| "Muse owner directory unavailable")?;
    let prefix = format!("muse-owner-{}-", pid);
    for entry in candidates.flatten().take(2048) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(nonce) = name
            .strip_prefix(&prefix)
            .and_then(|n| n.strip_suffix(".json"))
        else {
            continue;
        };
        if nonce.len() != 12
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            continue;
        }
        let Ok(value) = read_private(&entry.path(), 1024) else {
            continue;
        };
        let Ok(lease) = serde_json::from_value::<MuseLease>(value) else {
            continue;
        };
        if lease.version != 1
            || lease.pid != pid
            || lease.control_port != port
            || lease.control_id.len() != 32
            || !lease
                .control_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || lease.control_token.len() != 64
            || !lease
                .control_token
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !owned_pid(pid, lease.process_started_at)
        {
            continue;
        }
        let Ok(presence) = read_private(
            &dir.join(format!("muse-watch-{}-{}.json", pid, nonce)),
            1024,
        ) else {
            continue;
        };
        if presence["version"] != 1
            || presence["pid"] != pid
            || presence["controlPort"] != port
            || presence["controlId"] != lease.control_id
            || presence["processStartedAt"]
                .as_u64()
                .unwrap_or(0)
                .abs_diff(lease.process_started_at)
                > 5000
        {
            continue;
        }
        let updated = presence["updatedAt"].as_u64().unwrap_or(0);
        if updated == 0
            || updated > now_millis().saturating_add(5000)
            || now_millis().saturating_sub(updated) > 30_000
        {
            continue;
        }
        return Ok(lease);
    }
    Err("No recent, matching, authenticated Muse owner record. Older CLI instances need a controlled restart".into())
}
fn verify_muse_identity(lease: &MuseLease, status: &Value) -> Result<(), String> {
    if status["version"] != 1
        || status["service"] != "superagent-muse-owner"
        || status["pid"] != lease.pid
        || status["controlPort"] != lease.control_port
        || status["controlId"] != lease.control_id
        || status["processStartedAt"] != lease.process_started_at
        || !status["running"].is_boolean()
        || !status["ready"].is_boolean()
        || !status["activeTask"].is_boolean()
        || !status["queueSize"].is_u64()
        || !status["tunnelOwned"].is_boolean()
    {
        return Err("Muse private lifecycle owner returned an invalid identity".into());
    }
    Ok(())
}
async fn muse_status(lease: &MuseLease) -> Result<Value, String> {
    let (http, value) = call(
        lease.control_port,
        "/_muse/status",
        &lease.control_token,
        Method::GET,
        Duration::from_secs(2),
    )
    .await?;
    if http != StatusCode::OK {
        return Err("Muse owner refused authenticated status".into());
    }
    verify_muse_identity(lease, &value)?;
    Ok(value)
}

/// Credential-free capability for a *verified* owner. No token or code ever
/// enters the inventory response; the UI only learns whether rotation is safe.
pub async fn can_regenerate_token(dir: &Path, kind: &str, port: u16, pid: u32) -> bool {
    match kind {
        "mcp" => {
            let Ok(lease) = read_lease(dir, port, pid) else {
                return false;
            };
            let Ok(status) = mcp_status(&lease).await else {
                return false;
            };
            if status["reloadable"] != true
                || status["oauthEnabled"] != true
                || status["draining"] == true
            {
                return false;
            }
            read_private(&dir.join(format!("mcp-{}.json", port)), 8192).is_ok_and(|state| {
                state["authMode"] == "oauth" && state["pid"] == pid && state["port"] == port
            })
        }
        "muse-watch" => {
            let Ok(lease) = read_muse_lease(dir, port, pid) else {
                return false;
            };
            let Ok(status) = muse_status(&lease).await else {
                return false;
            };
            status["running"] == true
                && status["tokenRotationSupported"] == true
                && status["activeTask"] != true
                && status["queueSize"] == 0
        }
        _ => false,
    }
}

/// Rotates the Muse owner token using the protected loopback channel. The
/// owner copies the new credential into the local OS clipboard. Rust validates
/// the private owner before and after, and receives only redacted confirmation.
pub async fn regenerate_muse_token(dir: &Path, port: u16, pid: u32) -> Result<Value, String> {
    let lease = read_muse_lease(dir, port, pid)?;
    let before = muse_status(&lease).await?;
    if before["running"] != true || before["tokenRotationSupported"] != true {
        return Err("This Muse owner does not support live bearer rotation".into());
    }
    if before["activeTask"] == true || before["queueSize"].as_u64().unwrap_or(1) > 0 {
        return Err("Muse task active or queued; token rotation rejected".into());
    }
    let (status, result) = call(
        lease.control_port,
        "/_muse/token/rotate",
        &lease.control_token,
        Method::POST,
        Duration::from_secs(12),
    )
    .await?;
    if status != StatusCode::OK
        || result["success"] != true
        || result["action"] != "regenerate-token"
        || result["kind"] != "muse-watch"
        || result["pid"] != lease.pid
        || result["controlId"] != lease.control_id
        || !result["copied"].is_boolean()
    {
        return Err("Muse owner did not verify live token rotation".into());
    }
    let after = muse_status(&lease).await?;
    if after["running"] != true || after["tokenRotationSupported"] != true {
        return Err(
            "Muse token rotation returned but owner lost readiness; inspect before retry".into(),
        );
    }
    Ok(
        json!({"success":true,"kind":"muse-watch","action":"regenerate-token",
        "port":port,"pid":pid,"copied":result["copied"],
        "message":if result["copied"]==true {
            "Muse WSS bearer rotated; new setup copied to OS clipboard with five-minute previous-token grace"
        } else {
            "Muse bearer rotated, but clipboard delivery failed. Recover from the protected Muse configuration"
        }}),
    )
}

pub async fn capabilities(dir: &Path, kind: &str, port: u16, pid: u32) -> (bool, bool) {
    match kind {
        "mcp" => {
            if let Ok(lease) = read_lease(dir, port, pid) {
                if let Ok(status) = mcp_status(&lease).await {
                    let busy = status["draining"] == true
                        || status["activeSessions"].as_u64().unwrap_or(1) > 0
                        || status["inFlightRequests"].as_u64().unwrap_or(1) > 0;
                    return (
                        !busy,
                        status["draining"] != true && status["reloadable"] == true,
                    );
                }
            }
            (false, false)
        }
        "muse-watch" => {
            if let Ok(lease) = read_muse_lease(dir, port, pid) {
                if let Ok(status) = muse_status(&lease).await {
                    let busy = status["activeTask"] == true
                        || status["queueSize"].as_u64().unwrap_or(1) > 0;
                    return (
                        !busy && status["running"] == true,
                        !busy && status["tunnelOwned"] != true,
                    );
                }
            }
            (false, false)
        }
        "core-supervisor" => {
            if let Ok(owner) = read_supervisor(dir, port, pid) {
                if supervisor_status(&owner).await.is_ok() {
                    return (false, true);
                }
            }
            (false, false)
        }
        _ => (false, false),
    }
}
/// Safe, non-secret operator explanation for disabled lifecycle buttons.
pub async fn unavailable_reason(dir: &Path, kind: &str, port: u16, pid: u32) -> Option<String> {
    match kind {
        "mcp" => {
            let lease = match read_lease(dir, port, pid) {
                Ok(lease) => lease,
                Err(_) => return Some("Managed MCP owner identity was not verified".into()),
            };
            let status = match mcp_status(&lease).await {
                Ok(status) => status,
                Err(_) => return Some("Managed MCP owner did not authenticate its private status".into()),
            };
            let mut messages = Vec::new();
            if status["draining"] == true {
                messages.push("Owner is draining".to_string());
            }
            let sessions = status["activeSessions"].as_u64().unwrap_or(0);
            let in_flight = status["inFlightRequests"].as_u64().unwrap_or(0);
            if sessions > 0 || in_flight > 0 {
                messages.push(format!("Stop blocked: {} active session(s), {} in-flight request(s)", sessions, in_flight));
            }
            if status["reloadable"] != true {
                messages.push("Restart unavailable: legacy MCP owner lacks safe backend reload".into());
            }
            if messages.is_empty() {
                None
            } else {
                Some(messages.join("; "))
            }
        },
        "muse-watch" => {
            let lease = read_muse_lease(dir,port,pid).ok()?;
            let status = muse_status(&lease).await.ok()?;
            let mut messages=Vec::new();
            if status["activeTask"] == true || status["queueSize"].as_u64().unwrap_or(0)>0 {
                messages.push("Active or queued Muse tasks prevent Stop/Restart");
            }
            if status["tunnelOwned"] == true {
                messages.push("Restart disabled to prevent public tunnel URL rotation");
            }
            if status["running"] == false {
                messages.push("Watcher is stopped; restart is available if owner is healthy");
            }
            if messages.is_empty() {None} else {Some(messages.join("; "))}
        },
        "core-supervisor" => Some("Core Stop requires an explicit verified drain; only generation-preserving Restart is supported".into()),
        _ => None,
    }
}

pub async fn control(
    dir: &Path,
    kind: &str,
    action: &str,
    port: u16,
    pid: u32,
) -> Result<Value, String> {
    if port == 0 || pid == 0 || !["stop", "restart"].contains(&action) {
        return Err("Invalid lifecycle action or target".into());
    }
    match (kind,action) {
        ("muse-watch", "stop" | "restart") => {
            let lease = read_muse_lease(dir, port, pid)?;
            let before = muse_status(&lease).await?;
            if before["activeTask"] == true ||
                before["queueSize"].as_u64().unwrap_or(1) > 0 {
                return Err("Muse has active or queued tasks. No task was interrupted".into());
            }
            if action == "restart" && before["tunnelOwned"] == true {
                return Err("Muse owns an external tunnel; automatic restart would rotate its URL".into());
            }
            if action == "stop" && before["running"] != true {
                return Err("Muse Watch is already stopped".into());
            }
            let endpoint = if action == "stop" { "/_muse/stop" } else { "/_muse/restart" };
            let (http, response) = call(
                lease.control_port, endpoint, &lease.control_token,
                Method::POST, Duration::from_secs(35),
            ).await?;
            if http != StatusCode::OK || response["success"] != true ||
                response["action"] != action || response["pid"] != pid ||
                response["controlId"] != lease.control_id {
                return Err("Muse owner rejected lifecycle action; no force or replay was attempted".into());
            }
            let after = muse_status(&lease).await?;
            let expected_running = action == "restart";
            if after["running"] != expected_running {
                return Err("Muse owner did not confirm the requested lifecycle state".into());
            }
            Ok(json!({"success":true,"kind":"muse-watch","action":action,"port":port,
                "message":if expected_running {
                    "Muse Watch restarted using the same CLI owner and watcher configuration"
                } else {
                    "Muse Watch stopped safely; the owner remains available for Restart"
                }}))
        }
        ("mcp","restart")=>{
            let lease=read_lease(dir,port,pid)?;
            let before=mcp_status(&lease).await?;
            if before["reloadable"]!=true {
                return Err("Legacy MCP owner cannot reload safely. No service was stopped.".into())
            }
            if before["draining"]==true{return Err("MCP owner already draining".into())}
            let original=read_private(&dir.join(format!("mcp-{}.json",port)),8192)?;
            let url=original["publicUrl"].as_str()
                .filter(|s|s.starts_with("https://"))
                .ok_or("Missing pinned public MCP URL; cannot safely reload")?
                .to_owned();
            let (http,response)=call(port,"/_internal/owner/reload",&lease.nonce,
                Method::POST,Duration::from_secs(75)).await?;
            if http!=StatusCode::OK||response["success"]!=true{
                return Err("MCP owner declined reload; original owner was not force-stopped".into())
            }
            let after=mcp_status(&lease).await?;
            let current=read_private(&dir.join(format!("mcp-{}.json",port)),8192)?;
            if after["pid"]!=before["pid"]||
                current["publicUrl"]!=url||
                response["url"]!=url||
                !response["pid"].is_u64() {
                return Err("MCP post-reload identity or public URL changed; inspect manually".into())
            }
            Ok(json!({"success":true,"kind":"mcp","action":"restart","port":port,
                "message":"MCP backend reloaded; owner and public tunnel URL preserved"}))
        }
        ("mcp","stop")=>{
            let lease=read_lease(dir,port,pid)?;
            let status=mcp_status(&lease).await?;
            if status["draining"]==true {
                return Err("MCP owner is already draining; manual reconciliation required".into())
            }
            if status["activeSessions"].as_u64().unwrap_or(1)>0||
                status["inFlightRequests"].as_u64().unwrap_or(1)>0 {
                return Err("MCP has active sessions or in-flight requests. Stop rejected; no drain was started".into())
            }
            let (http,drain)=call(port,"/_internal/owner/drain",&lease.nonce,
                Method::POST,Duration::from_secs(3)).await?;
            if http!=StatusCode::OK {return Err("MCP owner refused graceful drain".into())}
            verify_mcp_identity(&lease,&drain)?;
            if drain["draining"]!=true||
                drain["activeSessions"].as_u64().unwrap_or(1)>0||
                drain["inFlightRequests"].as_u64().unwrap_or(1)>0{
                return Err("MCP owner drain became busy; no stop requested".into())
            }
            let (http,reply)=call(port,"/_internal/owner/stop",&lease.nonce,
                Method::POST,Duration::from_secs(4)).await?;
            if http!=StatusCode::OK {return Err("MCP owner refused graceful stop; no force used".into())}
            // Exit may complete asynchronously, never claim the process is
            // stopped until the owner or registry disappeared.
            for _ in 0..25 {
                if !owned_pid(lease.pid,lease.created_at) {return Ok(json!({
                    "success":true,"kind":"mcp","action":"stop","port":port,
                    "message":"MCP owner stopped gracefully"
                }))}
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let _=reply;
            Err("MCP owner acknowledged stop but process is still alive; inspect state before retry".into())
        }
        ("core-supervisor","restart")=>{
            let owner=read_supervisor(dir,port,pid)?;
            let before=supervisor_status(&owner).await?;
            let (http,response)=call(owner.control_port,"/restart",
                &owner.control_token,Method::POST,Duration::from_secs(35)).await?;
            if http!=StatusCode::OK {
                return Err("Core supervisor refused restart; existing worker remains owned".into())
            }
            verify_supervisor_identity(&owner,&response)?;
            if response["active"]["pid"]==before["active"]["pid"]{
                return Err("Core supervisor returned unchanged active generation".into())
            }
            Ok(json!({"success":true,"kind":"core-supervisor","action":"restart",
                "port":port,"message":"Core Supervisor activated a new worker and retained the previous session owner"}))
        }
        ("core-supervisor","stop")=>Err("Core stop is not supported by the supervisor's safe lifecycle contract; use explicit drain/manual shutdown".into()),
        _=>Err("No verified owner control channel for this service. Stop/restart disabled; never kill a PID".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reloads_mock_managed_mcp_owner_without_changing_public_url_or_killing_pid() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();
        let now = now_millis();
        let nonce = "a".repeat(64);
        let public = "https://test-mcp.example.invalid/mcp";
        let dir = std::env::temp_dir().join(format!("sa-mcp-test-{}-{}", pid, now));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("mcp-owner-{}.json", port)),
            json!({
                "version":1,"kind":"managed_mcp_tunnel_owner",
                "port":port,"pid":pid,"createdAt":now,"nonce":nonce,"workspace":"test"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join(format!("mcp-{}.json", port)),
            json!({
                "port":port,"pid":pid,"startedAt":now,"publicUrl":public,
            })
            .to_string(),
        )
        .unwrap();
        let token = nonce.clone();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut handled = 0;
            while handled < 3 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(e) => panic!("MCP mock socket error: {}", e),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                assert!(req.contains(&format!("Bearer {}", token)));
                let data = if req.starts_with("POST /_internal/owner/reload ") {
                    json!({"success":true,"pid":98765,"previousPid":98764,
                        "url":public})
                } else {
                    assert!(req.starts_with("GET /_internal/owner/status "));
                    json!({"version":1,"kind":"private_mcp_owner","pid":pid,"port":port,
                        "startedAt":now,"mode":"managed-tunnel","activeSessions":0,
                        "inFlightRequests":0,"draining":false,
                        "inflightToolEffects":"unknown","safeToolsOnly":true,
                        "oauthEnabled":true,"publicTunnelStarted":true,"reloadable":true})
                };
                let body = data.to_string();
                let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                stream.write_all(reply.as_bytes()).unwrap();
                handled += 1;
            }
            assert_eq!(handled, 3);
        });
        let result = control(&dir, "mcp", "restart", port, pid).await.unwrap();
        worker.join().unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "restart");
        assert!(!result.to_string().contains(public));
        assert!(!result.to_string().contains(&nonce));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn restarts_mock_authenticated_core_supervisor_without_terminating_existing_worker() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let control_port = listener.local_addr().unwrap().port();
        let public_port = 7905u16;
        let pid = std::process::id();
        let now = now_millis();
        let token = "b".repeat(64);
        let dir = std::env::temp_dir().join(format!("sa-core-owner-test-{}-{}", pid, now));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("core-supervisor-{}.json", public_port)),
            json!({
                "supervisorPid":pid,"publicPort":public_port,
                "controlPort":control_port,"controlToken":token
            })
            .to_string(),
        )
        .unwrap();
        let expected = token.clone();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut handled = 0;
            while handled < 2 && Instant::now() < deadline {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(e) => panic!("Core mock socket error: {}", e),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                assert!(req.contains(&format!("Bearer {}", expected)));
                let active = if req.starts_with("POST /restart ") {
                    1002
                } else {
                    assert!(req.starts_with("GET /status "));
                    1001
                };
                let data = json!({
                    "ownerContract":{"version":1,"role":"core-supervisor",
                        "mcpLifecycle":"not-owned","replayPolicy":"explicit-resume-only"},
                    "supervisorPid":pid,"publicPort":public_port,
                    "active":{"pid":active,"port":8103,"since":now},
                    "retained":if active==1002 {vec![1001]} else {vec![]},
                });
                let body = data.to_string();
                let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                stream.write_all(reply.as_bytes()).unwrap();
                handled += 1;
            }
            assert_eq!(handled, 2);
        });
        let result = control(&dir, "core-supervisor", "restart", public_port, pid)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(result["action"], "restart");
        assert_eq!(result["success"], true);
        assert!(!result.to_string().contains(&token));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn regenerates_muse_token_through_verified_private_owner_without_exposing_secret() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id();
        let stamp = now_millis();
        let nonce = "abcdef018765";
        let id = "2".repeat(32);
        let auth = "3".repeat(64);
        let dir = std::env::temp_dir().join(format!("sa-muse-rotate-{}-{}", pid, stamp));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("muse-owner-{}-{}.json", pid, nonce)),
            json!({
                "version":1,"pid":pid,"processStartedAt":stamp,"controlPort":port,
                "controlId":id,"controlToken":auth
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join(format!("muse-watch-{}-{}.json", pid, nonce)),
            json!({
                "version":1,"pid":pid,"processStartedAt":stamp,"controlPort":port,
                "controlId":id,"updatedAt":stamp,"running":true,"ready":true,"transport":"websocket"
            })
            .to_string(),
        )
        .unwrap();
        let expected = auth.clone();
        let control = id.clone();
        let mock = std::thread::spawn(move || {
            let until = Instant::now() + Duration::from_secs(8);
            let mut served = 0;
            while served < 4 && Instant::now() < until {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(e) => panic!("Muse rotation mock listener failed: {}", e),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]);
                assert!(request.contains(&format!("Bearer {}", expected)));
                let response = if request.starts_with("POST /_muse/token/rotate ") {
                    json!({"success":true,"action":"regenerate-token","kind":"muse-watch",
                        "pid":pid,"controlId":control,"copied":true})
                } else {
                    assert!(request.starts_with("GET /_muse/status "));
                    json!({"version":1,"service":"superagent-muse-owner",
                        "pid":pid,"processStartedAt":stamp,"controlPort":port,
                        "controlId":control,"running":true,"ready":true,
                        "activeTask":false,"queueSize":0,"tunnelOwned":true,
                        "tokenRotationSupported":true})
                };
                let body = response.to_string();
                let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
                stream.write_all(reply.as_bytes()).unwrap();
                served += 1;
            }
            assert_eq!(served, 4);
        });
        assert!(can_regenerate_token(&dir, "muse-watch", port, pid).await);
        let result = regenerate_muse_token(&dir, port, pid).await.unwrap();
        mock.join().unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["copied"], true);
        let output = result.to_string();
        assert!(!output.contains(&auth));
        assert!(!output.contains(&id));
        assert!(!output.contains("newToken"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn controls_private_muse_owner_after_exact_identity_check_without_credential_exposure() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::time::Instant;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let port = server.local_addr().unwrap().port();
        let pid = std::process::id();
        let started = now_millis();
        let token = "a".repeat(64);
        let ident = "b".repeat(32);
        let nonce = "abcdefabcdef";
        let dir = std::env::temp_dir().join(format!("sa-muse-private-owner-{}-{}", pid, started));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("muse-owner-{}-{}.json", pid, nonce)),
            json!({
                "version":1,"pid":pid,"processStartedAt":started,
                "controlPort":port,"controlId":ident,"controlToken":token
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join(format!("muse-watch-{}-{}.json", pid, nonce)),
            json!({
                "version":1,"pid":pid,"processStartedAt":started,"controlPort":port,
                "controlId":ident,"updatedAt":started,"running":true,"ready":true,
                "transport":"websocket"
            })
            .to_string(),
        )
        .unwrap();
        let expected = token.clone();
        let id = ident.clone();
        let worker = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut served = 0;
            let mut running = true;
            while served < 3 && Instant::now() < deadline {
                let (mut stream, _) = match server.accept() {
                    Ok(v) => v,
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(e) => panic!("Mock private owner listener error: {}", e),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buf = [0u8; 4096];
                let length = stream.read(&mut buf).unwrap();
                let request = String::from_utf8_lossy(&buf[..length]);
                assert!(request.contains(&format!("Bearer {}", expected)));
                let value = if request.starts_with("POST /_muse/stop ") {
                    running = false;
                    json!({"success":true,"action":"stop","pid":pid,"controlId":id})
                } else {
                    assert!(request.starts_with("GET /_muse/status "));
                    json!({"version":1,"service":"superagent-muse-owner","pid":pid,
                        "controlPort":port,"processStartedAt":started,"controlId":id,
                        "running":running,"ready":running,"activeTask":false,
                        "queueSize":0,"tunnelOwned":false})
                };
                let body = value.to_string();
                let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",body.len(),body);
                stream.write_all(reply.as_bytes()).unwrap();
                served += 1;
            }
            assert_eq!(served, 3);
        });
        let result = control(&dir, "muse-watch", "stop", port, pid)
            .await
            .unwrap();
        worker.join().unwrap();
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "stop");
        let public = result.to_string();
        assert!(!public.contains(&token));
        assert!(!public.contains(&ident));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_arbitrary_services_actions_and_reused_or_dead_process() {
        let dir = std::env::temp_dir();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (kind, action) in [
            ("cloudflare", "stop"),
            ("muse-watch", "restart"),
            ("channel-host", "stop"),
            ("mcp", "force"),
        ] {
            assert!(runtime
                .block_on(control(&dir, kind, action, 8857, 999_999))
                .is_err());
        }
        assert!(!owned_pid(999_999, 12345))
    }
    #[test]
    fn validates_private_owner_identity_before_any_request() {
        let dir = std::env::temp_dir().join(format!(
            "superagent-tray-owner-check-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let port = 8787;
        let file = dir.join(format!("mcp-owner-{}.json", port));
        fs::write(
            &file,
            json!({"version":1,"kind":"managed_mcp_tunnel_owner",
            "pid":std::process::id(),"port":port,"createdAt":1234,
            "nonce":"a".repeat(64)})
            .to_string(),
        )
        .unwrap();
        assert!(read_lease(&dir, port, std::process::id()).is_err());
        assert!(read_lease(&dir, port, std::process::id().saturating_add(1)).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
