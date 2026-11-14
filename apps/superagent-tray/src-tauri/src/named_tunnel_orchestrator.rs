//! Isolated Named Tunnel stack control. Never operates the Gemini Quick Tunnel,
//! existing port 9227, DNS, OAuth clients or privileged OS services.
//! All private owner and Anchor identities must attest through nonce-authenticated
//! loopback status *and* a matching OS executable/process birth before use.
use crate::{named_tunnel_connector, named_tunnel_settings::NamedTunnelSettings};
use reqwest::{redirect::Policy, Client};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs, net::TcpListener, path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use sysinfo::{Pid, System};

const EXPECTED_HOST: &str = "mcp.rcity.web.id";
const EXPECTED_ID: &str = "b2e8c6d9-9317-4d9e-b381-826af22e1778";
const ANCHOR_PORT: u16 = 19320;
const OWNER_PORT: u16 = 19321;
static ACTION_LOCK: AtomicBool = AtomicBool::new(false);
struct ActionGuard;
impl Drop for ActionGuard {
    fn drop(&mut self) { ACTION_LOCK.store(false, Ordering::Release); }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackComponent {
    pub state: String,
    pub verified: bool,
    pub pid: Option<u32>,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTunnelManagerStatus {
    pub tunnel_id: String,
    pub hostname: String,
    pub anchor_port: u16,
    pub owner_port: u16,
    pub configured: bool,
    pub credential_verified: bool,
    pub connector_status: String,
    pub anchor: StackComponent,
    pub owner: StackComponent,
    pub anchor_attached_owner_pid: Option<u32>,
    pub anchor_in_flight_requests: Option<u64>,
    pub start_anchor_ready: bool,
    pub start_owner_ready: bool,
    pub stop_owner_ready: bool,
    pub stop_anchor_ready: bool,
    pub ready_for_cutover: bool,
    pub quick_tunnel_untouched: bool,
    pub blockers: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTunnelStackPlan {
    pub status: NamedTunnelManagerStatus,
    pub available_actions: Vec<String>,
    pub no_runtime_mutation: bool,
    pub requires_native_approval: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTunnelStackActionResult {
    pub action: String,
    pub status: NamedTunnelManagerStatus,
    pub reviewed: bool,
    pub quick_tunnel_untouched: bool,
}

fn component(state: &str, reason: &str) -> StackComponent {
    StackComponent { state: state.into(), verified: false, pid: None, reason: reason.into() }
}
fn safe_lease(dir: &Path, name: &str) -> Result<Option<Value>, String> {
    let file = dir.join(name);
    let meta = match fs::symlink_metadata(&file) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Private lease metadata cannot be inspected".into()),
    };
    if !meta.file_type().is_file() || meta.len() < 50 || meta.len() > 4096 {
        return Err("Private lease is not a bounded regular file".into());
    }
    #[cfg(unix)] {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if meta.nlink() != 1 || meta.permissions().mode() & 0o077 != 0 {
            return Err("Private lease has unsafe link count or permissions".into());
        }
    }
    let data = fs::read(file).map_err(|_| "Private lease is unreadable")?;
    serde_json::from_slice(&data).map(Some).map_err(|_| "Private lease JSON is invalid".into())
}
fn nonce(lease: &Value) -> Result<&str, String> {
    let token = lease["nonce"].as_str().ok_or("Private lease nonce missing")?;
    if token.len() != 64 || !token.bytes().all(|x| x.is_ascii_hexdigit()) {
        return Err("Private lease nonce invalid".into());
    }
    Ok(token)
}
fn pid_birth(lease: &Value) -> Result<(u32, u64), String> {
    let pid = u32::try_from(lease["pid"].as_u64().ok_or("Lease PID missing")?)
        .map_err(|_| "Lease PID outside OS range")?;
    let created = lease["createdAt"].as_u64().ok_or("Lease start time missing")?;
    if pid == 0 || created == 0 { return Err("Lease OS identity invalid".into()); }
    Ok((pid, created))
}
fn process_verified(pid: u32, created: u64, marker: &str, port: u16) -> bool {
    let mut system = System::new();
    system.refresh_processes();
    let Some(process) = system.process(Pid::from_u32(pid)) else { return false };
    let started = process.start_time().saturating_mul(1000);
    if started.abs_diff(created) > 5000 { return false; }
    let Some(exe) = process.exe() else { return false };
    let Some(name) = exe.file_name().and_then(|n| n.to_str()) else { return false };
    // The owner and Anchor run under Bun. Other executables cannot impersonate
    // the private stack even if they happen to know a stale lease nonce.
    if !matches!(name.to_ascii_lowercase().as_str(), "bun" | "bun.exe") {
        return false;
    }
    // Exact executable path attestation: matching "bun.exe" alone is not
    // authority to control an unrelated Bun worker. Only the pinned local
    // runner that this source Tray can launch is eligible.
    let Ok((_, pinned_bun)) = native_runner() else { return false };
    if fs::canonicalize(exe).ok() != fs::canonicalize(&pinned_bun).ok() ||
        fs::canonicalize(&pinned_bun).is_err() { return false; }
    let argv: Vec<String> = process.cmd().iter().map(|x| x.to_string()).collect();
    let has_marker = argv.iter().any(|x| x.replace('\\', "/").contains(marker));
    let has_port = argv.iter().any(|x| x == &port.to_string());
    let prohibited = argv.iter().any(|x| x == "9227" || x == "--token" ||
        x == "--credentials-contents" || x == "--allow-dangerous");
    has_marker && has_port && !prohibited
}
fn client() -> Result<Client, String> {
    Client::builder().redirect(Policy::none()).timeout(Duration::from_secs(3))
        .build().map_err(|_| "Cannot initialize private loopback observer".into())
}
async fn authenticated_status(
    client: &Client, port: u16, lease: &Value, route: &str
) -> Result<Value, String> {
    let token = nonce(lease)?;
    let response = client.get(format!("http://127.0.0.1:{port}{route}"))
        .header(reqwest::header::HOST, format!("127.0.0.1:{port}"))
        .bearer_auth(token).send().await
        .map_err(|_| "Private owner/Anchor loopback is unreachable")?;
    if !response.status().is_success() {
        return Err("Private owner/Anchor nonce challenge rejected".into());
    }
    let bytes = response.bytes().await.map_err(|_| "Private status response unreadable")?;
    if bytes.is_empty() || bytes.len() > 16384 {
        return Err("Private status response size invalid".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Private status JSON invalid".into())
}
fn identity(s: &NamedTunnelSettings) -> Result<(), String> {
    s.validate()?;
    if !s.configured() || s.connector_mode != "remote-managed" ||
        s.tunnel_id != EXPECTED_ID || s.hostname != EXPECTED_HOST ||
        s.anchor_port != ANCHOR_PORT || s.owner_port != OWNER_PORT {
        return Err("Named stack requires the reviewed mcp.rcity.web.id UUID and isolated ports 19320/19321; 9227 is protected".into());
    }
    Ok(())
}

async fn proof(dir: &Path, s: &NamedTunnelSettings)
    -> (StackComponent, StackComponent, Option<u32>, Option<u64>, bool, bool) {
    let c = match client() {
        Ok(c) => c,
        Err(e) => return (component("blocked", &e), component("blocked", &e), None, None, false, false),
    };
    let expected_url = format!("https://{}/mcp", s.hostname);
    let mut anchor = component("absent", "No independently owned Named Anchor lease");
    let mut owner = component("absent", "No independently owned private MCP owner lease");
    let mut attached = None;
    let mut inflight = None;
    let mut anchor_idle = false;
    let mut owner_idle = false;

    match safe_lease(dir, &format!("mcp-tunnel-anchor-{}.json", s.anchor_port)) {
        Err(e) => anchor = component("unverified", &e),
        Ok(Some(lease)) => {
            anchor = component("unverified", "Anchor lease or authenticated OS identity mismatch");
            let valid = lease["version"] == 1 && lease["kind"] == "mcp_tunnel_anchor" &&
                lease["port"] == s.anchor_port && lease["tunnelMode"] == "named-external" &&
                lease["tunnelPid"].is_null() && lease["publicUrl"] == expected_url;
            if valid {
                if let Ok((pid, created)) = pid_birth(&lease) {
                    if process_verified(pid, created, "mcp-tunnel-anchor.ts", s.anchor_port) {
                        if let Ok(status) = authenticated_status(&c, s.anchor_port, &lease,
                            "/_internal/anchor/status").await {
                            let owner_pid = status["currentOwnerPid"].as_u64().and_then(|v| u32::try_from(v).ok());
                            let owner_port = status["currentOwnerPort"].as_u64();
                            let busy = status["inFlightRequests"].as_u64();
                            let sane_owner = (owner_pid.is_none() && status["currentOwnerPid"].is_null() &&
                                status["currentOwnerPort"].is_null()) ||
                                (owner_pid.is_some() && owner_port == Some(u64::from(s.owner_port)));
                            if status["kind"] == "mcp_tunnel_anchor" && status["version"] == 1 &&
                                status["pid"] == pid && status["port"] == s.anchor_port &&
                                status["startedAt"] == created && status["publicUrl"] == expected_url &&
                                status["tunnelMode"] == "named-external" &&
                                status["tunnelPid"].is_null() && sane_owner && busy.is_some() {
                                anchor = StackComponent {
                                    state: "verified_local".into(), verified: true, pid: Some(pid),
                                    reason: "Nonce-authenticated Named Anchor and OS process birth verified".into(),
                                };
                                attached = owner_pid; inflight = busy;
                                anchor_idle = busy == Some(0) && attached.is_none() &&
                                    status["ready"] == false && status["switching"] != true;
                            }
                        }
                    }
                }
            }
        }
        Ok(None) => {}
    }

    match safe_lease(dir, &format!("mcp-owner-{}.json", s.owner_port)) {
        Err(e) => owner = component("unverified", &e),
        Ok(Some(lease)) => {
            owner = component("unverified", "Owner lease or authenticated OS identity mismatch");
            let valid = lease["version"] == 1 && lease["kind"] == "managed_mcp_tunnel_owner" &&
                lease["port"] == s.owner_port &&
                lease["workspace"].as_str().map_or(false, |p| Path::new(p).is_absolute());
            if valid {
                if let Ok((pid, created)) = pid_birth(&lease) {
                    if process_verified(pid, created, "tunnel-owner", s.owner_port) {
                        if let Ok(status) = authenticated_status(&c, s.owner_port, &lease,
                            "/_internal/owner/status").await {
                            let idle = status["draining"] == true && status["activeSessions"] == 0 &&
                                status["inFlightRequests"] == 0 && status["inFlightToolCalls"] == 0;
                            if status["version"] == 1 && status["kind"] == "private_mcp_owner" &&
                                status["pid"] == pid && status["port"] == s.owner_port &&
                                status["startedAt"] == created && status["mode"] == "managed-tunnel" &&
                                status["ingressMode"] == "external-anchor" &&
                                status["publicUrl"] == expected_url && status["oauthEnabled"] == true &&
                                status["safeToolsOnly"] == true && status["backendHealthy"] == true {
                                owner = StackComponent {
                                    state: "verified_local".into(), verified: true, pid: Some(pid),
                                    reason: "Nonce-authenticated OAuth owner and OS process birth verified".into(),
                                };
                                owner_idle = idle;
                            }
                        }
                    }
                }
            }
        }
        Ok(None) => {}
    }
    (anchor, owner, attached, inflight, anchor_idle, owner_idle)
}

pub async fn status(dir: &Path, s: &NamedTunnelSettings) -> NamedTunnelManagerStatus {
    let valid = identity(s).is_ok();
    let connector = named_tunnel_connector::status(dir, s);
    let credential_verified = valid && connector.token_verified;
    let (anchor, owner, attached, inflight, anchor_idle, owner_idle) =
        if valid { proof(dir, s).await } else {
            (component("blocked", "Configured Named Tunnel identity or ports mismatch"),
             component("blocked", "Configured Named Tunnel identity or ports mismatch"),
             None, None, false, false)
        };
    let mut blockers = Vec::new();
    if !valid { blockers.push("Expected remote-managed hostname/UUID and isolated 19320/19321 ports not configured".into()); }
    if !credential_verified { blockers.push("Private Cloudflare token file is unavailable or UUID validation failed".into()); }
    if matches!(connector.status, "lease_unverified" | "lease_mismatch" | "process_unverified") {
        blockers.push("Cloudflare connector lease/process is ambiguous and needs operator reconciliation".into());
    }
    if anchor.state == "unverified" { blockers.push(anchor.reason.clone()); }
    if owner.state == "unverified" { blockers.push(owner.reason.clone()); }
    if attached.is_some() && attached != owner.pid {
        blockers.push("Anchor points to a different owner; no implicit handoff is allowed".into());
    }
    let start_anchor_ready = valid && credential_verified && anchor.state == "absent" &&
        owner.state == "absent" && native_runner().is_ok() && port_unused(s.anchor_port) &&
        !matches!(connector.status, "lease_unverified" | "lease_mismatch" | "process_unverified");
    // The current managed MCP launcher requires an IPC parent and a separate
    // OAuth-writer preflight not supplied by Tray. Refuse rather than run the
    // interactive CLI or create an unverified owner.
    let start_owner_ready = false;
    let stop_owner_ready = valid && owner.verified && owner_idle &&
        anchor.verified && anchor_idle && attached.is_none();
    // Anchor has SIGTERM handlers but no authenticated shutdown command;
    // arbitrary PID signalling cannot satisfy the private stop contract.
    let stop_anchor_ready = false;
    if valid && !anchor.verified && anchor.state != "absent" {
        blockers.push("Named Anchor has not authenticated locally".into());
    }
    if valid && !owner.verified && owner.state != "absent" {
        blockers.push("Private owner has not authenticated locally".into());
    }
    if valid && native_runner().is_err() {
        blockers.push("Start Anchor needs a version-matched, trusted bundled Bun/Anchor launcher; unavailable in this build".into());
    }
    blockers.push("Native owner start unavailable: managed CLI requires IPC and verified OAuth single-writer isolation".into());
    blockers.push("Native Anchor stop unavailable: source Anchor lacks authenticated drain/shutdown IPC".into());
    NamedTunnelManagerStatus {
        tunnel_id: s.tunnel_id.clone(), hostname: s.hostname.clone(),
        anchor_port: s.anchor_port, owner_port: s.owner_port,
        configured: valid, credential_verified,
        connector_status: connector.status.into(),
        anchor, owner, anchor_attached_owner_pid: attached,
        anchor_in_flight_requests: inflight,
        start_anchor_ready, start_owner_ready, stop_owner_ready, stop_anchor_ready,
        ready_for_cutover: false, quick_tunnel_untouched: true, blockers,
    }
}
pub async fn plan(dir: &Path, s: &NamedTunnelSettings) -> NamedTunnelStackPlan {
    let status = status(dir, s).await;
    let mut available_actions = Vec::new();
    if status.start_anchor_ready { available_actions.push("start-anchor".into()); }
    if status.start_owner_ready { available_actions.push("start-owner".into()); }
    if status.stop_owner_ready { available_actions.push("stop-owner".into()); }
    if status.stop_anchor_ready { available_actions.push("stop-anchor".into()); }
    NamedTunnelStackPlan { status, available_actions, no_runtime_mutation: true,
        requires_native_approval: true }
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).map_or(false, |m| m.file_type().is_file() && m.len() > 0)
}
fn native_runner() -> Result<(PathBuf, PathBuf), String> {
    // Reuse the version-matched source Anchor CLI; do not execute a user-supplied
    // arbitrary path or a PATH-selected binary. A packaged release without this
    // CLI must ship a verified launcher before start becomes available.
    if !cfg!(debug_assertions) {
        return Err("Installed Tray has no verified bundled standalone Anchor launcher".into());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
        .canonicalize().map_err(|_| "Cannot locate trusted source checkout")?;
    if !regular(&root.join("package.json")) ||
        !regular(&root.join("scripts/mcp-tunnel-anchor.ts")) {
        return Err("Version-matched independent Anchor CLI unavailable".into());
    }
    let home = dirs::home_dir().ok_or("Cannot locate trusted Bun runtime")?;
    let bun = home.join(".bun").join("bin").join(if cfg!(windows) { "bun.exe" } else { "bun" });
    if !regular(&bun) { return Err("Bun executable is unavailable at the trusted installed path".into()); }
    Ok((root, bun))
}
fn port_unused(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}
pub async fn action(dir: &Path, s: &NamedTunnelSettings, action: &str,
    expected_tunnel_id: &str, reviewed: bool) -> Result<NamedTunnelStackActionResult, String> {
    if !reviewed || expected_tunnel_id != s.tunnel_id ||
       !matches!(action, "start-anchor" | "start-owner" | "stop-owner" | "stop-anchor") {
        return Err("Reviewed action, valid allowlist and exact tunnel ID are required".into());
    }
    identity(s)?;
    if ACTION_LOCK.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("Another Named stack lifecycle action is already in progress".into());
    }
    let _guard = ActionGuard;
    let state = status(dir, s).await;
    let no_connector_conflict = !matches!(state.connector_status.as_str(),
        "lease_unverified" | "lease_mismatch" | "process_unverified");
    match action {
        "start-anchor" => {
            if !state.start_anchor_ready || !no_connector_conflict {
                return Err("Start Anchor blocked: verify private token, fixed UUID/ports and absence of any Anchor or ambiguous connector lease".into());
            }
            let (root, bun) = native_runner()?;
            if !port_unused(s.anchor_port) {
                return Err("Anchor port 19320 is occupied; no process will be adopted or stopped".into());
            }
            // Use existing verified source protocol, never pass credentials or
            // Cloudflare token bytes through arguments/stdout/stderr.
            let mut cmd = Command::new(&bun);
            cmd.arg(root.join("scripts/mcp-tunnel-anchor.ts"))
                .args(["start-profile", &s.anchor_port.to_string(), "--reviewed"])
                .current_dir(&root).stdin(Stdio::null())
                .stdout(Stdio::null()).stderr(Stdio::null());
            // Do not pass the Tray's unrelated API, OAuth, tunnel or session
            // credentials to an independently launched Anchor process.
            cmd.env_clear();
            for name in ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
                "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"] {
                if let Some(value) = std::env::var_os(name) { cmd.env(name, value); }
            }
            cmd.env("SUPERAGENT_CONFIG_DIR", dir);
            #[cfg(windows)] {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000 | 0x0000_0200);
            }
            let mut child = cmd.spawn().map_err(|_| "Unable to start isolated source Anchor CLI")?;
            let mut ready = false;
            for _ in 0..25 {
                if child.try_wait().map_err(|_| "Cannot observe spawned Anchor child")?.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
                let snapshot = status(dir, s).await;
                if snapshot.anchor.verified && snapshot.anchor.pid == Some(child.id()) &&
                    snapshot.anchor_attached_owner_pid.is_none() {
                    ready = true; break;
                }
            }
            if !ready {
                // This is an exact owned Child handle, not a PID-based kill
                // of a possibly unrelated process.
                let _ = child.kill();
                let _ = child.wait();
                return Err("Spawned Anchor did not produce a verified nonce-authenticated lease; no success claimed".into());
            }
        }
        "start-owner" => return Err(
            "Start private owner blocked: existing managed MCP launcher requires an authenticated IPC parent and verified OAuth single-writer isolation; Tray cannot safely invoke it yet".into()),
        "stop-owner" => {
            if !state.stop_owner_ready {
                return Err("Stop private owner blocked: require authenticated process/nonce, explicit prior drain, zero sessions/tools/requests, and detached idle Anchor".into());
            }
            let lease = safe_lease(dir, &format!("mcp-owner-{}.json", s.owner_port))?
                .ok_or("Owner lease disappeared")?;
            let (pid, created) = pid_birth(&lease)?;
            if Some(pid) != state.owner.pid ||
                !process_verified(pid, created, "tunnel-owner", s.owner_port) {
                return Err("Owner changed since review; no stop sent".into());
            }
            let c = client()?;
            let before = authenticated_status(&c, s.owner_port, &lease, "/_internal/owner/status").await?;
            if before["draining"] != true || before["activeSessions"] != 0 ||
                before["inFlightRequests"] != 0 || before["inFlightToolCalls"] != 0 ||
                before["pid"] != pid {
                return Err("Owner is not fully drained; no stop sent".into());
            }
            let response = c.post(format!("http://127.0.0.1:{}/_internal/owner/stop", s.owner_port))
                .header(reqwest::header::HOST, format!("127.0.0.1:{}", s.owner_port))
                .bearer_auth(nonce(&lease)?).send().await
                .map_err(|_| "Authenticated owner shutdown was not acknowledged")?;
            if response.status() != reqwest::StatusCode::OK {
                return Err("Owner refused authenticated graceful stop".into());
            }
            // 200 is only an acknowledgement. Verify lease cleanup, never
            // force-kill another runtime or remove an unverified lease.
            let mut confirmed = false;
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let mut system = System::new();
                system.refresh_processes();
                if matches!(safe_lease(dir,
                    &format!("mcp-owner-{}.json", s.owner_port)), Ok(None)) &&
                    system.process(Pid::from_u32(pid)).is_none() &&
                    port_unused(s.owner_port) {
                    confirmed = true;
                    break;
                }
            }
            if !confirmed {
                return Err("Owner accepted graceful stop but shutdown is unverified; operator inspection required (no forced kill)".into());
            }
        }
        "stop-anchor" => return Err(
            "Stop Anchor blocked: source Anchor has no authenticated graceful shutdown/drain endpoint; PID-only termination is forbidden".into()),
        _ => return Err("Unsupported Named Tunnel stack action".into()),
    }
    Ok(NamedTunnelStackActionResult { action: action.into(),
        status: status(dir, s).await, reviewed: true, quick_tunnel_untouched: true })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn named_tunnel_rejects_injected_identity_and_quick_tunnel_ports() {
        let mut s = NamedTunnelSettings::default();
        s.tunnel_id = EXPECTED_ID.into();
        s.hostname = EXPECTED_HOST.into();
        assert!(identity(&s).is_ok());
        s.owner_port = 9227;
        assert!(identity(&s).is_err());
        s.owner_port = OWNER_PORT;
        s.tunnel_id = "b2e8c6d9-9317-4d9e-b381-826af22e1779".into();
        assert!(identity(&s).is_err());
    }
    #[test]
    fn named_tunnel_nonce_and_lease_reject_malformed_content() {
        assert!(nonce(&serde_json::json!({"nonce":"abc"})).is_err());
        assert!(pid_birth(&serde_json::json!({"pid":0,"createdAt":12})).is_err());
        assert!(!process_verified(u32::MAX, 0, "tunnel-owner", OWNER_PORT));
    }
    #[tokio::test]
    async fn named_tunnel_default_state_is_safe_and_no_actions_claimed() {
        let root = std::env::temp_dir().join(format!("named-stack-{}-{}",
            std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut s = NamedTunnelSettings::default();
        s.tunnel_id = EXPECTED_ID.into();
        s.hostname = EXPECTED_HOST.into();
        let plan = plan(&root, &s).await;
        assert!(!plan.status.ready_for_cutover);
        assert!(plan.status.quick_tunnel_untouched);
        assert!(plan.available_actions.is_empty());
        assert!(!plan.status.stop_anchor_ready);
        assert!(!plan.status.start_owner_ready);
        assert!(action(&root, &s, "restart", EXPECTED_ID, true).await.is_err());
        assert!(action(&root, &s, "stop-owner", "wrong", true).await.is_err());
    }
}
