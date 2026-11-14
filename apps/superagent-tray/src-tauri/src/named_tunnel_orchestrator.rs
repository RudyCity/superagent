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
    let Ok(launcher) = native_runner() else { return false };
    let pinned_bun = &launcher.bun;
    if fs::canonicalize(exe).ok() != fs::canonicalize(pinned_bun).ok() ||
        fs::canonicalize(pinned_bun).is_err() { return false; }
    let argv: Vec<String> = process.cmd().iter().map(|x| x.to_string()).collect();
    // Exact script location is pinned, never a matching substring in an
    // unrelated command. The owner is the existing managed IPC child, while
    // the Anchor is the standalone launcher bundle.
    let cli_entry = launcher.root.join("dist/cli.js");
    let pinned_script = if marker == "mcp-tunnel-anchor.ts" {
        &launcher.anchor
    } else {
        &cli_entry
    };
    let expected_script = fs::canonicalize(pinned_script).ok();
    let script_match = expected_script.is_some() && argv.iter().any(|arg|
        fs::canonicalize(Path::new(arg)).ok() == expected_script
    );
    let has_marker = script_match && (marker == "mcp-tunnel-anchor.ts" ||
        argv.iter().any(|x| x == "tunnel-owner"));
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
                            let idle = status["activeSessions"] == 0 &&
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
    // Launch through a version-matched private Bun script that uses the
    // existing authenticated managed-owner IPC protocol, validates OAuth
    // persistence, and attaches only to the detached Named Anchor.
    let start_owner_ready = valid && credential_verified &&
        anchor.verified && anchor_idle && attached.is_none() &&
        owner.state == "absent" && inflight == Some(0) &&
        connector.status == "not_started" &&
        native_runner().is_ok() && port_unused(s.owner_port);
    let stop_owner_ready = valid && owner.verified && owner_idle &&
        anchor.verified && inflight == Some(0) &&
        (attached == owner.pid || (attached.is_none() && anchor_idle));
    // Only a nonce-authenticated, OS-attested, detached and idle Named Anchor
    // can be shut down cooperatively. No PID-only termination is allowed.
    let stop_anchor_ready = valid && anchor.verified && anchor_idle &&
        owner.state == "absent" && attached.is_none() && inflight == Some(0);
    if valid && !anchor.verified && anchor.state != "absent" {
        blockers.push("Named Anchor has not authenticated locally".into());
    }
    if valid && !owner.verified && owner.state != "absent" {
        blockers.push("Private owner has not authenticated locally".into());
    }
    if valid && native_runner().is_err() {
        blockers.push("Start Anchor needs a version-matched, trusted bundled Bun/Anchor launcher; unavailable in this build".into());
    }
    if valid && !start_owner_ready {
        blockers.push("Start private owner requires a detached verified Anchor, private credential, free owner port and version-matched managed IPC launcher".into());
    }
    if valid && !stop_anchor_ready {
        blockers.push("Anchor stop requires an authenticated, detached, request-free Named Anchor and no private owner lease".into());
    }
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
struct NamedLauncher {
    root:PathBuf,
    bun:PathBuf,
    anchor:PathBuf,
    owner:PathBuf,
}
fn valid_manifest(root:&Path)->bool{
    use sha2::{Digest,Sha256};
    let manifest_file=root.join("dist/scripts/mcp-named-launchers.json");
    let package_file=root.join("package.json");
    if !regular(&manifest_file)||!regular(&package_file)||
       !regular(&root.join("dist/cli.js")) {return false;}
    let Ok(m)=fs::symlink_metadata(&manifest_file) else{return false};
    if m.len()>8192||m.len()<100{return false;}
    let (Ok(raw),Ok(package))=(fs::read(&manifest_file),fs::read(&package_file))
    else{return false};
    let (Ok(meta),Ok(pkg))=(serde_json::from_slice::<Value>(&raw),
        serde_json::from_slice::<Value>(&package)) else{return false};
    if meta["schemaVersion"]!=1||meta["target"]!="bun"||
       meta["package"]!="superagent"||
       meta["version"]!=env!("CARGO_PKG_VERSION")||
       pkg["name"]!="superagent"||
       pkg["version"]!=env!("CARGO_PKG_VERSION"){return false;}
    let Some(scripts)=meta["scripts"].as_object() else{return false};
    if scripts.len()!=2{return false;}
    for name in ["mcp-tunnel-anchor.js","mcp-named-owner.js"]{
        let file=root.join("dist/scripts").join(name);
        let Some(hash)=scripts.get(name).and_then(Value::as_str) else{return false};
        if hash.len()!=64||!hash.bytes().all(|x|x.is_ascii_hexdigit())||
           !regular(&file){return false;}
        let Ok(stat)=fs::symlink_metadata(&file) else{return false};
        if stat.len()>20_000_000||stat.len()<1024{return false;}
        let Ok(contents)=fs::read(&file) else{return false};
        if format!("{:x}",Sha256::digest(contents))!=hash{return false;}
    }
    true
}
fn native_runner()->Result<NamedLauncher,String>{
    if cfg!(debug_assertions){
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
            .canonicalize().map_err(|_|"Cannot locate trusted development checkout")?;
        let anchor=root.join("scripts/mcp-tunnel-anchor.ts");
        let owner=root.join("scripts/mcp-named-owner.ts");
        if !regular(&root.join("package.json"))||
           !regular(&root.join("dist/cli.js"))||
           !regular(&anchor)||!regular(&owner){
            return Err("Version-matched source-mode MCP launchers unavailable".into());
        }
        let home=dirs::home_dir().ok_or("Cannot locate trusted development Bun")?;
        let bun=home.join(".bun").join("bin")
            .join(if cfg!(windows){"bun.exe"}else{"bun"});
        if !regular(&bun){
            return Err("Trusted development Bun binary unavailable".into());
        }
        return Ok(NamedLauncher{root,bun,anchor,owner});
    }
    // Installed release: use only the app's own pinned portable Bun sidecar
    // and SHA-256 verified bundled launchers, never PATH/CWD/environment.
    let exe=std::env::current_exe().map_err(|_|"Installed Tray path unavailable")?;
    let dir=exe.parent().ok_or("Installed Tray directory unavailable")?;
    let bun=dir.join(if cfg!(windows){"bun.exe"}else{"bun"});
    let bun_file=fs::symlink_metadata(&bun)
        .map_err(|_|"Bundled Bun sidecar missing")?;
    if !bun_file.file_type().is_file()||bun_file.len()<10_000_000||
       fs::canonicalize(&bun).is_err(){
        return Err("Bundled Bun sidecar identity or size unverified".into());
    }
    for path in [
        dir.join("standalone"),
        dir.join("resources/standalone"),
        dir.join("../Resources/standalone"),
        dir.join("../lib/superagent/standalone"),
        dir.join("../lib/SuperAgent/standalone"),
    ]{
        let Ok(stat)=fs::symlink_metadata(&path) else{continue};
        if !stat.file_type().is_dir(){continue;}
        let Ok(root)=path.canonicalize() else{continue};
        if !valid_manifest(&root){continue;}
        let anchor=root.join("dist/scripts/mcp-tunnel-anchor.js");
        let owner=root.join("dist/scripts/mcp-named-owner.js");
        return Ok(NamedLauncher{root,bun,anchor,owner});
    }
    Err("Installed Named MCP launcher bundle is missing, has a version mismatch, or failed SHA-256 verification".into())
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
            let launcher = native_runner()?;
            if !port_unused(s.anchor_port) {
                return Err("Anchor port 19320 is occupied; no process will be adopted or stopped".into());
            }
            // Use existing verified source protocol, never pass credentials or
            // Cloudflare token bytes through arguments/stdout/stderr.
            let mut cmd = Command::new(&launcher.bun);
            cmd.arg(&launcher.anchor)
                .args(["start-profile", &s.anchor_port.to_string(), "--reviewed"])
                .current_dir(&launcher.root).stdin(Stdio::null())
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
        "start-owner" => {
            if !state.start_owner_ready || !no_connector_conflict {
                return Err("Start owner blocked: authenticated detached Anchor, private credential, isolated OAuth and unused owner port required".into());
            }
            let launcher=native_runner()?;
            if !port_unused(s.owner_port) {
                return Err("Named private MCP owner port is occupied; no process adopted".into());
            }
            let mut cmd=Command::new(&launcher.bun);
            cmd.arg(&launcher.owner)
                .args(["start-profile","--reviewed"])
                .current_dir(&launcher.root).stdin(Stdio::null())
                .stdout(Stdio::null()).stderr(Stdio::null());
            cmd.env_clear();
            for name in ["PATH","HOME","USERPROFILE","APPDATA","LOCALAPPDATA",
                "SystemRoot","WINDIR","TEMP","TMP","TMPDIR","LANG","LC_ALL"] {
                if let Some(value)=std::env::var_os(name){cmd.env(name,value);}
            }
            cmd.env("SUPERAGENT_CONFIG_DIR",dir);
            #[cfg(windows)]{
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000);
            }
            let mut child=cmd.spawn().map_err(|_|"Named owner IPC launcher could not start")?;
            let mut completed=false;
            for _ in 0..320 {
                match child.try_wait().map_err(|_|"Cannot attest named owner launcher exit")? {
                    Some(exit)=>{
                        if !exit.success(){
                            return Err("Named owner launcher refused or failed independent OAuth startup; inspect private status".into());
                        }
                        completed=true;break;
                    },
                    None=>tokio::time::sleep(Duration::from_millis(250)).await,
                }
            }
            if !completed {
                // Terminate only the freshly spawned wrapper child; never an
                // owner PID or unrelated Cloudflare process. Reconcile any
                // separately spawned owner before another start attempt.
                let _=child.kill();let _=child.wait();
                return Err("Named owner IPC launcher timed out; reconcile private lease before retrying".into());
            }
            let after=status(dir,s).await;
            if !after.owner.verified||!after.anchor.verified||
               after.anchor_attached_owner_pid!=after.owner.pid||
               after.owner.pid.is_none()||after.owner.pid==state.owner.pid||
               !after.quick_tunnel_untouched {
                return Err("Named owner launcher exited but authenticated owner/Anchor attachment is unverified".into());
            }
        },
        "stop-owner" => {
            if !state.stop_owner_ready {
                return Err("Stop private owner blocked: require verified ownership, zero active sessions/tools/requests and an idle Named Anchor".into());
            }
            let lease = safe_lease(dir, &format!("mcp-owner-{}.json", s.owner_port))?
                .ok_or("Owner lease disappeared")?;
            let (pid, created) = pid_birth(&lease)?;
            if Some(pid) != state.owner.pid ||
                !process_verified(pid, created, "tunnel-owner", s.owner_port) {
                return Err("Owner changed since review; no stop sent".into());
            }
            let c = client()?;
            let mut before = authenticated_status(&c, s.owner_port, &lease, "/_internal/owner/status").await?;
            if before["activeSessions"] != 0 || before["inFlightRequests"] != 0 ||
                before["inFlightToolCalls"] != 0 || before["pid"] != pid ||
                before["publicUrl"] != format!("https://{}/mcp", s.hostname) {
                return Err("Owner has active sessions, requests, tools, or changed identity; no drain sent".into());
            }
            // Operator has approved a graceful shutdown. Drain only the exact
            // nonce-authenticated owner, then recheck the quiescent state.
            if before["draining"] != true {
                let response = c.post(format!(
                    "http://127.0.0.1:{}/_internal/owner/drain", s.owner_port))
                    .header(reqwest::header::HOST, format!("127.0.0.1:{}", s.owner_port))
                    .bearer_auth(nonce(&lease)?).send().await
                    .map_err(|_|"Private owner did not acknowledge requested drain")?;
                if response.status() != reqwest::StatusCode::OK {
                    return Err("Private owner refused graceful drain".into());
                }
                before = authenticated_status(&c, s.owner_port, &lease,
                    "/_internal/owner/status").await?;
                if before["draining"] != true || before["pid"] != pid ||
                    before["activeSessions"] != 0 ||
                    before["inFlightRequests"] != 0 ||
                    before["inFlightToolCalls"] != 0 {
                    return Err("Owner drain not attested or new activity detected".into());
                }
            }
            if state.anchor_attached_owner_pid == Some(pid) {
                // Detach before stopping: the Anchor must not point at a dead
                // backend. Refuse any stale or swapped control process.
                let anchor_lease = safe_lease(dir,
                    &format!("mcp-tunnel-anchor-{}.json", s.anchor_port))?
                    .ok_or("Named Anchor lease disappeared")?;
                let (anchor_pid,anchor_birth) = pid_birth(&anchor_lease)?;
                if state.anchor.pid != Some(anchor_pid) ||
                    !process_verified(anchor_pid,anchor_birth,
                        "mcp-tunnel-anchor.ts",s.anchor_port) {
                    return Err("Named Anchor process identity changed before detach".into());
                }
                let anchor_before = authenticated_status(&c, s.anchor_port,
                    &anchor_lease, "/_internal/anchor/status").await?;
                if anchor_before["pid"] != anchor_pid ||
                    anchor_before["currentOwnerPid"] != pid ||
                    anchor_before["currentOwnerPort"] != s.owner_port ||
                    anchor_before["inFlightRequests"] != 0 ||
                    anchor_before["switching"] != false ||
                    anchor_before["publicUrl"] != format!("https://{}/mcp",s.hostname) {
                    return Err("Named Anchor has traffic or changed owner; detach forbidden".into());
                }
                let payload = serde_json::json!({
                    "reviewed":true,"expectedAnchorPid":anchor_pid,
                    "expectedPort":s.anchor_port,
                    "expectedPublicUrl":format!("https://{}/mcp",s.hostname),
                    "expectedOwnerPid":pid,"expectedOwnerPort":s.owner_port
                });
                let response = c.post(format!(
                    "http://127.0.0.1:{}/_internal/anchor/detach",s.anchor_port))
                    .header(reqwest::header::HOST,format!("127.0.0.1:{}",s.anchor_port))
                    .bearer_auth(nonce(&anchor_lease)?).json(&payload).send().await
                    .map_err(|_|"Named Anchor did not acknowledge owner detach")?;
                if response.status()!=reqwest::StatusCode::OK {
                    return Err("Named Anchor refused safe drain/detach".into());
                }
                let result:Value=response.json().await
                    .map_err(|_|"Named Anchor detach response malformed")?;
                if result["detached"]!=true||result["ownerPid"]!=pid||
                    result["anchorPid"]!=anchor_pid||
                    result["noQuickTunnelMutation"]!=true {
                    return Err("Named Anchor detach was not attested".into());
                }
                let detached = authenticated_status(&c, s.anchor_port,
                    &anchor_lease, "/_internal/anchor/status").await?;
                if detached["currentOwnerPid"]!=Value::Null ||
                    detached["currentOwnerPort"]!=Value::Null||
                    detached["ready"]!=false ||
                    detached["inFlightRequests"]!=0 {
                    return Err("Named Anchor is not detached after control acknowledgement".into());
                }
            } else if state.anchor_attached_owner_pid.is_some() {
                return Err("Named Anchor points at a different owner; no stop sent".into());
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
        "stop-anchor" => {
            if !state.stop_anchor_ready {
                return Err("Named Anchor must be verified, detached and idle, with no private owner lease".into());
            }
            let lease = safe_lease(dir, &format!("mcp-tunnel-anchor-{}.json", s.anchor_port))?
                .ok_or("Named Anchor lease disappeared")?;
            let (pid, created) = pid_birth(&lease)?;
            if state.anchor.pid != Some(pid) ||
                !process_verified(pid, created, "mcp-tunnel-anchor.ts", s.anchor_port) {
                return Err("Named Anchor process identity changed since review".into());
            }
            let c = client()?;
            let before = authenticated_status(&c, s.anchor_port, &lease,
                "/_internal/anchor/status").await?;
            if before["pid"] != pid || before["port"] != s.anchor_port ||
                before["publicUrl"] != format!("https://{}/mcp", s.hostname) ||
                before["tunnelMode"] != "named-external" ||
                before["currentOwnerPid"] != Value::Null ||
                before["inFlightRequests"] != 0 || before["ready"] != false ||
                before["shutdownRequested"] != false || before["switching"] != false {
                return Err("Named Anchor not detached, idle, or still switching".into());
            }
            let payload = serde_json::json!({
                "reviewed":true,"expectedAnchorPid":pid,"expectedPort":s.anchor_port,
                "expectedPublicUrl":format!("https://{}/mcp", s.hostname),
                "expectedCurrentOwnerPid":null,
            });
            let response = c.post(format!(
                "http://127.0.0.1:{}/_internal/anchor/shutdown", s.anchor_port))
                .header(reqwest::header::HOST,format!("127.0.0.1:{}",s.anchor_port))
                .bearer_auth(nonce(&lease)?).json(&payload).send().await
                .map_err(|_|"Named Anchor did not acknowledge cooperative shutdown")?;
            if response.status()!=reqwest::StatusCode::OK {
                return Err("Named Anchor rejected graceful shutdown; no forced termination".into());
            }
            let accepted:Value=response.json().await
                .map_err(|_|"Named Anchor shutdown acknowledgement malformed")?;
            if accepted["accepted"]!=true || accepted["anchorPid"]!=pid ||
                accepted["noQuickTunnelMutation"]!=true {
                return Err("Named Anchor shutdown acknowledgement not attested".into());
            }
            let mut stopped=false;
            for _ in 0..25 {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let mut system=System::new();
                system.refresh_processes();
                if matches!(safe_lease(dir,
                    &format!("mcp-tunnel-anchor-{}.json",s.anchor_port)),Ok(None)) &&
                    system.process(Pid::from_u32(pid)).is_none() &&
                    port_unused(s.anchor_port) {
                    stopped=true;break;
                }
            }
            if !stopped {
                return Err("Named Anchor accepted shutdown but OS/lease closure is not verified".into());
            }
        },
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
