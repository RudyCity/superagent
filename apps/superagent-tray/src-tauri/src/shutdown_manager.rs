//! Native-only, owner-scoped shutdown review and execution.
//! Graceful and force-stop follow authenticated owner protocols. Manual Kill
//! requires an additional focused native approval and exact OS PID/birth/name
//! pin, allowing the human operator to override missing application attestation.

use super::{config_dir, core_request, lifecycle_console_request, remote_service_detection,
    runtime_control, runtime_detection, server_info, show_main, tray_lifecycle};
use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    fs,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::{Pid, ProcessStatus, System};
use tauri::{AppHandle, Emitter, WebviewWindow};
use uuid::Uuid;

const MANAGED_ORDER: &[&str] = &["guardian", "daemon", "channel_host", "transport", "vision"];
const PLAN_FIELDS: &[&str] = &[
    "port", "operationId", "expectedOwnerPid", "expectedInstanceId", "expectedSupervisorPid",
    "expectedWorkerPid", "expectedRunning", "noActiveJobs", "noPublicIngress",
    "noCoreShutdown", "corePort", "channelMode", "wsPort",
];
const PREVIEW_TTL_MS: u64 = 60_000;

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Item {
    id: String,
    label: String,
    kind: String,
    state: String,
    detail: String,
    owner_verified: bool,
    selectable: bool,
    blocker: Option<String>,
    port: Option<u16>,
    pid: Option<u32>,
    active_sessions: Option<u64>,
    force_selectable: bool,
    manual_kill_selectable: bool,
    process_name: Option<String>,
    process_path: Option<String>,
    process_started_at: Option<u64>,
}
impl Item {
    fn new(id: String, label: &str, kind: &str, state: &str, detail: &str,
        owner_verified: bool, selectable: bool, blocker: Option<String>,
        port: Option<u16>, pid: Option<u32>) -> Self {
        Self {id, label:label.into(), kind:kind.into(), state:state.into(),
            detail:detail.into(), owner_verified, selectable, blocker,
            port, pid, active_sessions:None, force_selectable:false,
            manual_kill_selectable:false, process_name:None, process_path:None, process_started_at:None}
    }
}

fn running(state: &str) -> bool {
    !matches!(state, "inactive" | "stopped" | "stale" | "embedded")
}
fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_millis() as u64)
}
fn pid_of(value: &Value) -> Option<u32> {
    value.as_u64().filter(|x| *x>0 && *x<=u32::MAX as u64).map(|x| x as u32)
}
fn port_of(value: &Value) -> Option<u16> {
    value.as_u64().filter(|x| (1024..=65535).contains(x)).map(|x| x as u16)
}
fn verified_action(state: &Value) -> bool {
    state["ownershipVerified"] == true &&
        state["actions"].as_array().is_some_and(|actions| actions.iter().any(|x| x=="stop"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Preview {
    preview_id: String,
    created_at: u64,
    services: Vec<Item>,
    exit_ready: bool,
    warning: Option<String>,
}
impl Preview {
    fn active(&self) -> impl Iterator<Item=&Item> {
        self.services.iter().filter(|item| running(&item.state))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Step {
    id: String,
    label: String,
    status: String,
    message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Progress {
    run_id: String,
    stage: String,
    exit_after: bool,
    steps: Vec<Step>,
    error: Option<String>,
}
#[derive(Default)]
struct Manager {
    preview: Option<Preview>,
    progress: Option<Progress>,
    busy: bool,
}
static MANAGER: OnceLock<Mutex<Manager>> = OnceLock::new();
fn manager() -> &'static Mutex<Manager> {
    MANAGER.get_or_init(|| Mutex::new(Manager::default()))
}
fn locked() -> Result<std::sync::MutexGuard<'static, Manager>, String> {
    manager().lock().map_err(|_| "SHUTDOWN_STATE_UNAVAILABLE".into())
}
pub fn is_running() -> bool {
    locked().map_or(true, |state| state.busy)
}
fn redacted(error: &str) -> String {
    if error.starts_with("SHUTDOWN_") || error.starts_with("EXIT_") {
        return error.chars().take(180).collect();
    }
    "SHUTDOWN_OWNER_REJECTED: status uncertain, inspect Runtime Detection before retry".into()
}

fn active_core_instances(instances:&Value) -> Result<bool,String> {
    for kind in ["subagents","superagents","procs"] {
        let entries=instances[kind].as_array()
            .ok_or("SHUTDOWN_CORE_AGENT_REPORT_UNAVAILABLE")?;
        for entry in entries {
            if kind=="procs" {
                if entry["hasExited"]!=true {return Ok(true);}
                continue;
            }
            // Unknown states are not completion evidence. Fail closed until
            // the task owner reports a recognized terminal outcome.
            let terminal=matches!(entry["status"].as_str(),
                Some("completed"|"complete"|"done"|"success"|"failed"|"error"|
                    "cancelled"|"canceled"|"stopped"));
            if !terminal {return Ok(true);}
        }
    }
    Ok(false)
}

async fn verify_direct_core_idle(expected_pid:u32, expected_port:u16) -> Result<(),String> {
    let credentials=server_info()?;
    if credentials.pid!=Some(expected_pid) || credentials.port!=expected_port {
        return Err("SHUTDOWN_CORE_OWNER_CHANGED".into());
    }
    let workspaces=core_request(Method::GET,"/api/workspaces",None).await?;
    let list=workspaces["workspaces"].as_array()
        .ok_or("SHUTDOWN_CORE_SESSION_REPORT_UNAVAILABLE")?;
    if !list.is_empty() {
        return Err("SHUTDOWN_CORE_SESSIONS_ACTIVE: close active Core sessions before exit".into());
    }
    let instances=core_request(Method::GET,"/api/instances",None).await?;
    if active_core_instances(&instances)? {
        return Err("SHUTDOWN_CORE_AGENT_RUNNING: finish active tasks before exit".into());
    }
    let daemon=core_request(Method::GET,"/api/daemon/status",None).await?;
    if pid_of(&daemon["pid"])!=Some(expected_pid) ||
        daemon["activeJobsCount"].as_u64()!=Some(0) ||
        !daemon["running"].is_boolean() {
        return Err("SHUTDOWN_CORE_SCHEDULER_BUSY_OR_UNVERIFIED".into());
    }
    Ok(())
}

/// Only OS-observed service entries can be manually killed. An unknown
/// runtime executable is allowed after human approval, but critical OS
/// processes and this Tray cannot be selected. No free-form PID control.
fn manual_process_allowed(kind:&str,pid:u32,name:&str)->bool {
    if pid<=4 || pid==std::process::id() {return false;}
    let executable=name.to_ascii_lowercase();
    if executable.trim().is_empty()||executable.len()>128 ||
        !executable.chars().all(|ch|ch.is_ascii_graphic()||ch==' ') {
        return false;
    }
    let base=executable.strip_suffix(".exe").unwrap_or(&executable);
    if matches!(base,"superagent-tray"|"system"|"registry"|"smss"|"csrss"|
        "wininit"|"winlogon"|"lsass"|"services"|"svchost"|"dwm"|
        "explorer"|"systemd"|"launchd"|"kernel_task"|"windowserver"|
        "loginwindow"|"finder") {
        return false;
    }
    if kind=="cloudflare" {return base=="cloudflared";}
    matches!(kind,"managed"|"core"|"core-supervisor"|"mcp"|
        "muse-watch"|"daemon-direct"|"external")
}

/// Local Guardian fallback works while the Core HTTP lifecycle inventory is
/// unavailable. A bounded, non-symlinked lease must match the live OS process
/// and its birth timestamp; an arbitrary node/bun PID is never inferred.
fn guardian_lease_matches(value:&Value,port:u16,pid:u32,birth_seconds:u64,now_ms:u64)->bool {
    let born_ms=birth_seconds.saturating_mul(1000);
    let registered=value["startedAt"].as_u64().unwrap_or(0);
    value["version"]==1 && value["port"].as_u64()==Some(u64::from(port)) &&
        value["pid"].as_u64()==Some(u64::from(pid)) &&
        registered>0 && registered>=born_ms &&
        // Guardian startup may authenticate an existing Core before writing
        // its lease; allow bounded startup time, but never a reused PID born
        // after the recorded lease.
        registered<=born_ms.saturating_add(60_000) &&
        registered<=now_ms.saturating_add(5_000)
}
fn guardian_os_candidates(dir:&std::path::Path,system:&System)->Vec<Item> {
    let Ok(entries)=fs::read_dir(dir) else{return Vec::new()};
    let now_ms=timestamp();
    let mut found=Vec::new();
    for entry in entries.take(128).flatten() {
        let file_name=entry.file_name();
        let Some(raw)=file_name.to_str() else{continue};
        let Some(port)=raw.strip_prefix("core-guardian-")
            .and_then(|s|s.strip_suffix(".json"))
            .and_then(|s|s.parse::<u16>().ok())
            .filter(|port|*port>=1024) else {continue};
        let path=entry.path();
        let Ok(metadata)=fs::symlink_metadata(&path) else{continue};
        if !metadata.file_type().is_file()||metadata.len()==0||
            metadata.len()>1024 {continue}
        let Some(lease)=fs::read(&path).ok()
            .and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok())
        else {continue};
        let Some(pid)=pid_of(&lease["pid"]) else{continue};
        let Some(process)=system.process(Pid::from_u32(pid)) else{continue};
        if !guardian_lease_matches(&lease,port,pid,process.start_time(),now_ms) ||
            matches!(process.status(),ProcessStatus::Zombie|ProcessStatus::Dead) ||
            !manual_process_allowed("managed",pid,process.name()) {continue}
        found.push(Item::new(
            format!("guardian-os:{port}:{pid}"),"Guardian watchdog (OS lease)",
            "managed","unverified",
            "Local Guardian lease and live OS process match; Core inventory is not required for a manual kill",
            false,false,
            Some("Manual Kill requires separate focused native approval".into()),
            Some(port),Some(pid)));
        if found.len()>=16{break}
    }
    found
}

async fn inspect() -> Result<Preview, String> {
    let dir = config_dir()?;
    // Core API failure must not remove the manual, OS-pinned fallback.
    // Missing runtime fields are shown as unavailable, never as stopped.
    let runtime=match runtime_detection::detect_runtime(&dir).await {
        Ok(value)=>serde_json::to_value(value).unwrap_or_else(|_|json!({})),
        Err(_)=>json!({}),
    };
    let remote = remote_service_detection::scan(&dir).await;
    let mut items = Vec::new();
    let mut force_system = System::new();
    force_system.refresh_processes();
    let mut warning = if runtime.get("cores").and_then(Value::as_array).is_none() {
        Some("Core runtime discovery unavailable; showing OS-observed owners only.".into())
    } else {None};
    let inventory = match lifecycle_console_request(json!({"action":"inventory"})).await {
        Ok(v) => v,
        Err(_) => {
            warning=Some("Authenticated lifecycle inventory unavailable; unknown owners cannot be stopped.".into());
            json!({})
        }
    };
    let states = inventory["services"].as_array();

    for remote_owner in &remote {
        if !running(remote_owner.state) { continue; }
        match remote_owner.kind {
            "mcp" => {
                let (port,pid) = (remote_owner.port,remote_owner.pid);
                let eligible = remote_owner.can_stop && port.is_some() && pid.is_some();
                let mut item = Item::new(
                    format!("mcp:{}:{}",port.unwrap_or(0),pid.unwrap_or(0)),
                    "MCP owner", "mcp", remote_owner.state,
                    if eligible {"Verified owner; graceful drain requires zero sessions and requests"}
                    else {"Active sessions, in-flight requests or owner verification block shutdown"},
                    eligible, eligible,
                    if eligible {None} else {Some("MCP owner busy or unverifiable; close sessions first".into())},
                    port,pid);
                item.active_sessions = states.and_then(|rows| rows.iter().find(|row|
                    row["service"]=="mcp" && row["port"].as_u64()==port.map(u64::from)))
                    .and_then(|row| row["details"]["activeSessions"].as_u64());
                // Even a busy MCP owner may support an explicit forced stop,
                // but only through its independently authenticated private API.
                item.force_selectable = remote_owner.source=="registry" &&
                    matches!(remote_owner.state,"observed"|"online") &&
                    if let (Some(port),Some(pid))=(port,pid) {
                        runtime_control::can_force_stop_mcp(&dir,port,pid).await
                    } else {false};
                items.push(item);
            }
            "core-supervisor" => {
                let verified=remote_owner.source=="registry" && remote_owner.can_restart &&
                    remote_owner.pid.is_some() &&
                    matches!(remote_owner.state,"online"|"observed");
                let mut item=Item::new(
                    format!("supervisor:{}:{}",remote_owner.port.unwrap_or(0),remote_owner.pid.unwrap_or(0)),
                    "Core Supervisor","core-supervisor",remote_owner.state,
                    if verified {
                        "Authenticated supervisor owner; Force Stop All may terminate the exact supervisor PID"
                    } else {
                        "Supervisor process observed; manual PID kill may interrupt all Core generations"
                    },
                    verified,false,Some(if verified {
                        "No graceful full-stop contract; Force Stop All requires typed + native approval".into()
                    } else {
                        "No verified full-stop protocol; manual kill requires separate approval".into()
                    }),
                    remote_owner.port,remote_owner.pid);
                item.force_selectable=verified;
                items.push(item);
            }
            "cloudflare" | "muse-watch" => {
                let mut item=Item::new(
                    format!("observed:{}:{}",remote_owner.kind,remote_owner.pid.unwrap_or(0)),
                    if remote_owner.kind=="cloudflare" {"Cloudflare tunnel"} else {"Muse watcher"},
                    remote_owner.kind,remote_owner.state,
                    "Observed process; no universal verified stop protocol is available",
                    false,false,Some("Stop through the exact owner-specific control first".into()),
                    remote_owner.port,remote_owner.pid);
                // An OS-observed Cloudflare process is NEVER adopted. Only a
                // private registry-backed birth-verified cloudflared can be
                // force-stopped after typed + native human approval.
                item.force_selectable = if remote_owner.kind=="cloudflare" {
                    remote_owner.source=="registry" &&
                        matches!(remote_owner.state,"online"|"observed") &&
                        remote_owner.pid.is_some()
                } else {
                    remote_owner.source=="registry" &&
                        (remote_owner.can_stop || remote_owner.can_restart) &&
                        matches!(remote_owner.state,"online"|"observed"|"idle") &&
                        remote_owner.pid.is_some()
                };
                item.owner_verified = item.force_selectable;
                if item.force_selectable {
                    item.detail=if remote_owner.kind=="cloudflare" {
                        "Registered Cloudflare owner; force stop disconnects the public tunnel and may change its URL".into()
                    } else {
                        "Authenticated Muse Watch owner; Force Stop All may terminate the exact watcher PID".into()
                    };
                }
                items.push(item);
            }
            _ => {}
        }
    }

    if let Some(states) = states {
        for name in MANAGED_ORDER {
            let Some(s) = states.iter().find(|s| s["service"]==*name) else {
                items.push(Item::new(format!("managed:{name}"),name,"managed","unknown",
                    "Missing authenticated owner status",false,false,
                    Some("Owner status unavailable".into()),None,None));
                continue;
            };
            let mut state=s["state"].as_str().unwrap_or("unknown");
            let port=port_of(&s["port"]);
            let pid=pid_of(&s["ownerPid"]);
            // An owner PID paired with an "inactive" service is ambiguous,
            // not proof that the process exited. Never silently ignore it.
            if state=="inactive" && pid.is_some() {state="unverified";}
            let mut eligible=running(state)&&verified_action(s)&&port.is_some()&&pid.is_some();
            let mut blocker = if eligible {None} else {
                Some("No verified idle owner or stop capability".into())
            };
            if *name=="daemon" && s["details"]["activeJobs"].as_u64().unwrap_or(1)>0 {
                eligible=false;
                blocker=Some("Scheduled job running; wait for completion".into());
            }
            if *name=="vision" && s["details"]["activeRequests"].as_u64().unwrap_or(1)>0 {
                eligible=false;
                blocker=Some("Vision inference running; wait for completion".into());
            }
            if *name=="channel_host" && (s["details"]["taskActive"]==true ||
                s["details"]["watcherActive"]==true) {
                eligible=false;
                blocker=Some("Channel task or watcher is active".into());
            }
            if state=="embedded"||state=="inactive" {
                eligible=false;blocker=None;
            }
            let label=match *name {
                "guardian"=>"Guardian watchdog","daemon"=>"Daemon scheduler",
                "channel_host"=>"Channel host","transport"=>"T-Line transport",
                _=>"Managed Vision",
            };
            let mut item=Item::new(format!("managed:{name}"),label,"managed",state,
                if eligible {"Authenticated owner; stop will use a fresh operation plan"}
                else {"Managed-service owner state and activity must be confirmed"},
                s["ownershipVerified"]==true,eligible,blocker,port,pid);
            if *name=="daemon" {item.active_sessions=s["details"]["activeJobs"].as_u64();}
            items.push(item);
        }
        for name in ["rest_tunnel","muse_tunnel","muse","telegram"] {
            if let Some(s)=states.iter().find(|s| s["service"]==name) {
                if running(s["state"].as_str().unwrap_or("unknown")) {
                    items.push(Item::new(format!("external:{name}"),name,"external",
                        s["state"].as_str().unwrap_or("unknown"),
                        "Separate public-disruption or channel-owner approval is required",
                        false,false,Some("Cannot include this service in universal shutdown".into()),
                        port_of(&s["port"]),pid_of(&s["ownerPid"])));
                }
            }
        }
    } else {
        items.push(Item::new("inventory-unavailable".into(),"Lifecycle inventory","system",
            "unknown","Cannot certify managed services without authenticated Core",
            false,false,Some("Restore Core inventory or review owners individually".into()),None,None));
    }

    // Local lease fallback: include the Guardian even if the authenticated
    // lifecycle API is unreachable. If it is already listed, do not duplicate.
    for guardian in guardian_os_candidates(&dir,&force_system) {
        if items.iter().any(|item:&Item|item.id=="managed:guardian"&&
            item.pid==guardian.pid) {continue}
        if let Some(unknown)=items.iter_mut().find(|item|item.id=="managed:guardian"&&
            item.pid.is_none()) {
            unknown.pid=guardian.pid;
            unknown.port=guardian.port;
            unknown.state="unverified".into();
            unknown.detail=guardian.detail;
            unknown.blocker=guardian.blocker;
        } else {
            items.push(guardian);
        }
    }
    let empty_cores=Vec::new();
    let cores=runtime["cores"].as_array().unwrap_or(&empty_cores);
    let supervisor_attested=states.and_then(|s|s.iter().find(|row|row["service"]=="core"))
        .is_some_and(|s|s["ownershipVerified"]==true);
    for core in cores {
        let state=core["state"].as_str().unwrap_or("unknown");
        let selected=core["selected"]==true;
        let pid=pid_of(&core["pid"]);
        let port=port_of(&core["port"]);
        // A supervisor registry (even a stale one) prevents treating this as a
        // direct Core. Do not accidentally shutdown a supervised worker while
        // its independent supervisor still owns the public listener.
        let supervised=supervisor_attested || port.is_some_and(|p|
            fs::symlink_metadata(dir.join(format!("core-supervisor-{p}.json"))).is_ok());
        let verified=selected && state=="online" && core["pidVerified"]==true && !supervised;
        let idle=if let (true,Some(pid),Some(port))=(verified,pid,port) {
            verify_direct_core_idle(pid,port).await.is_ok()
        } else {false};
        let eligible=verified && idle;
        items.push(Item::new(format!("core:{}:{}",port.unwrap_or(0),pid.unwrap_or(0)),
            if selected {"Selected Core API"} else {"Other Core API"},"core",state,
            if supervised {"A supervised Core has no supported full-stop contract"}
            else {"Authenticated direct Core; stopped last after dependent services"},
            verified,eligible,
            if !running(state) {None} else if eligible {None}
            else if verified {Some("Active Core sessions, agent tasks or scheduler work prevent graceful exit".into())}
            else {Some("Core is supervised, foreign, or identity is unverified".into())},
            port,pid));
    }
    if cores.is_empty() {
        items.push(Item::new("core-absent".into(),"Core API","core","inactive",
            "No registered Core process is running",false,false,None,None,None));
    }

    // A directly owned Core has an embedded scheduler, not a managed supervisor
    // worker. Inspect the authenticated worker API, never an arbitrary PID.
    if cores.iter().any(|core| core["selected"]==true && core["state"]=="online" &&
        core["pidVerified"]==true) &&
        items.iter().any(|item|item.kind=="managed" && item.id=="managed:daemon" &&
            item.state=="unverified") {
        let core=server_info()?;
        let status=core_request(Method::GET,"/api/daemon/status",None).await.ok();
        let matched=status.as_ref().is_some_and(|s|
            pid_of(&s["pid"])==core.pid && s["activeJobsCount"].as_u64().is_some());
        if let Some(item)=items.iter_mut().find(|item|item.id=="managed:daemon") {
            let running_daemon=status.as_ref().is_some_and(|s|s["running"]==true);
            let idle=matched && status.as_ref().is_some_and(|s|
                s["activeJobsCount"].as_u64()==Some(0));
            item.state=if !matched {"unverified"} else if running_daemon {"active"} else {"inactive"}.into();
            item.kind="daemon-direct".into();
            item.owner_verified=matched;
            item.selectable=running_daemon&&idle;
            item.pid=core.pid;item.port=Some(core.port);
            item.active_sessions=status.as_ref().and_then(|s|s["activeJobsCount"].as_u64());
            item.blocker=if !running_daemon&&matched {None} else if idle {None}
                else {Some("Scheduler job active or Core worker changed".into())};
            item.detail="Authenticated direct Core scheduler; stops without deleting jobs".into();
        }
    }
    let agent_count=runtime["processes"].as_array()
        .map(|v|v.iter().filter(|p|p["state"]=="active").count()).unwrap_or(0);
    if agent_count>0 {
        items.push(Item::new("active-agents".into(),"Active CLI / Agent sessions","agents",
            "active",&format!("{agent_count} active processes; no blanket agent kill is permitted"),
            false,false,Some("Finish or stop agents from their own session controls".into()),
            None,None));
    }
    if let Some(hosts)=runtime["independentHosts"].as_array() {
        for host in hosts {
            let state=host["state"].as_str().unwrap_or("unknown");
            let port=port_of(&host["port"]);
            if running(state)&&!items.iter().any(|item| item.port==port &&
                (item.kind=="managed" || item.kind=="daemon-direct")) {
                items.push(Item::new(
                    format!("independent:{}:{}",host["kind"].as_str().unwrap_or("host"),port.unwrap_or(0)),
                    "Unregistered independent host","external",state,
                    "Host observed but no matching stoppable managed owner",
                    false,false,Some("Owner-specific control required".into()),port,pid_of(&host["pid"])));
            }
        }
    }
    if items.len()>100 {
        return Err("SHUTDOWN_TOO_MANY_OWNERS: narrow runtime before shutdown".into());
    }
    // A human may explicitly select OS-observed processes whose application
    // owner is unverified. Pin both process birth and name; no UI-supplied PID
    // is accepted by the backend and no process tree is traversed.
    for item in &mut items {
        // Force Stop All is intentionally broader than graceful selection.
        // Once a local SuperAgent owner is independently verified, active work
        // may block graceful stop but not the operator's typed + native force
        // approval. OS-only/foreign entries remain excluded.
        let verified_local=item.owner_verified &&
            matches!(item.kind.as_str(),"managed"|"daemon-direct"|"core"|
                "core-supervisor"|"muse-watch");
        let verified_guardian_lease=item.id.starts_with("guardian-os:");
        item.force_selectable |= verified_local || verified_guardian_lease ||
            (item.selectable &&
                matches!(item.kind.as_str(),"managed"|"daemon-direct"|"core"));
        if let Some(pid)=item.pid {
            if let Some(process)=force_system.process(Pid::from_u32(pid)) {
                let name=process.name().to_string();
                if manual_process_allowed(&item.kind,pid,&name) && running(&item.state) &&
                    !matches!(process.status(),ProcessStatus::Zombie|ProcessStatus::Dead) {
                    item.manual_kill_selectable=true;
                    item.process_name=Some(name);
                    item.process_path=process.exe()
                        .map(|path|path.to_string_lossy().into_owned());
                }
                item.process_started_at=Some(process.start_time());
            }
        }
        if item.force_selectable &&
            matches!(item.kind.as_str(),"managed"|"daemon-direct"|"core"|
                "core-supervisor"|"muse-watch") &&
            !item.manual_kill_selectable {
            item.force_selectable=false;
        }
        item.force_selectable &= item.process_started_at.is_some();
    }
    let exit_ready=items.iter().all(|item| !running(&item.state) || item.selectable);
    Ok(Preview {preview_id:Uuid::new_v4().simple().to_string(),
        created_at:timestamp(),services:items,exit_ready,warning})
}

fn validate_selection(preview: &Preview, selected: &[String], exit_after: bool)
    -> Result<Vec<Item>,String>
{
    if selected.len()>32 ||
        (selected.is_empty() && (!exit_after || preview.active().next().is_some() ||
            !preview.exit_ready)) {
        return Err("SHUTDOWN_SELECTION_SIZE_INVALID".into());
    }
    let mut unique=HashSet::new();
    let mut chosen=Vec::new();
    for id in selected {
        if !unique.insert(id) {return Err("SHUTDOWN_DUPLICATE_SERVICE".into());}
        let item=preview.services.iter().find(|item|item.id==*id)
            .ok_or("SHUTDOWN_UNKNOWN_SERVICE")?;
        if !item.selectable || !item.owner_verified || !running(&item.state) {
            return Err("SHUTDOWN_UNVERIFIED_SELECTION".into());
        }
        chosen.push(item.clone());
    }
    if exit_after && (!preview.exit_ready ||
        preview.active().any(|item| !unique.contains(&item.id))) {
        return Err("SHUTDOWN_EXIT_BLOCKED: every active owner must support verified stop".into());
    }
    // Core must never be stopped while an active dependency was skipped.
    if chosen.iter().any(|item|item.kind=="core") &&
        preview.active().any(|item|item.kind!="core" && !unique.contains(&item.id)) {
        return Err("SHUTDOWN_CORE_DEPENDENCY_NOT_SELECTED".into());
    }
    chosen.sort_by_key(|item| match item.kind.as_str() {
        "mcp"=>0,"managed"=>match item.id.as_str() {
            "managed:guardian"=>1,"managed:daemon"=>2,"managed:channel_host"=>3,
            "managed:transport"=>4,_=>5
        },"daemon-direct"=>2,"core"=>9,_=>8,
    });
    Ok(chosen)
}

fn same_force_owner(before:&Item,after:&Item)->bool {
    before.id==after.id && before.pid==after.pid && before.port==after.port &&
        before.process_started_at.is_some() &&
        before.process_started_at==after.process_started_at &&
        after.force_selectable && running(&after.state)
}
fn force_candidates(preview:&Preview)->Result<Vec<Item>,String> {
    let mut selected:Vec<Item>=preview.active()
        .filter(|item|item.force_selectable && item.process_started_at.is_some())
        .cloned().collect();
    if selected.is_empty() {
        return Err("SHUTDOWN_FORCE_NO_VERIFIED_OWNER".into());
    }
    // Independent MCP / registered Cloudflare first, managed services next,
    // and direct Core last. A supervisor/foreign process never enters the list.
    selected.sort_by_key(|item|match item.kind.as_str(){
        "mcp"=>0,"cloudflare"=>1,"managed"=>2,"daemon-direct"=>3,"core"=>9,_=>8,
    });
    Ok(selected)
}
// The legacy comparison guard is retained for regression tests; the live
// manual-kill path intentionally revalidates directly with the OS instead.
#[cfg(test)]
fn same_manual_owner(before:&Item,after:&Item)->bool {
    before.id==after.id && before.kind==after.kind && before.pid==after.pid &&
        before.port==after.port && before.process_started_at.is_some() &&
        before.process_started_at==after.process_started_at &&
        before.process_name==after.process_name &&
        before.process_path==after.process_path &&
        after.manual_kill_selectable && running(&after.state)
}
fn manual_candidates(preview:&Preview,ids:&[String])->Result<Vec<Item>,String> {
    if ids.is_empty()||ids.len()>64{return Err("SHUTDOWN_MANUAL_SELECTION_INVALID".into());}
    let mut unique=HashSet::new();
    let mut unique_pids=HashSet::new();
    let mut chosen=Vec::new();
    for id in ids {
        if !unique.insert(id){return Err("SHUTDOWN_MANUAL_DUPLICATE_SELECTION".into());}
        let item=preview.services.iter().find(|item|item.id==*id)
            .ok_or("SHUTDOWN_MANUAL_UNKNOWN_SERVICE")?;
        if !item.manual_kill_selectable || !running(&item.state) ||
            item.process_started_at.is_none() || item.process_name.is_none() {
            return Err("SHUTDOWN_MANUAL_PID_UNAVAILABLE".into());
        }
        let pid=item.pid.ok_or("SHUTDOWN_MANUAL_PID_UNAVAILABLE")?;
        if !manual_process_allowed(&item.kind,pid,
            item.process_name.as_deref().unwrap_or("")) {
            return Err("SHUTDOWN_MANUAL_EXECUTABLE_NOT_ALLOWED".into());
        }
        // One OS PID may represent multiple services (e.g. Core + daemon).
        // Kill that PID at most once and never recursively kill children.
        if unique_pids.insert(pid){chosen.push(item.clone());}
    }
    // Guardian first, supervisor before its workers. This prevents the
    // in-process Guardian from reviving a just-killed Core supervisor while
    // the rest of the selected generation is being retired.
    chosen.sort_by_key(|item|match item.kind.as_str(){
        "managed" if item.id=="managed:guardian" ||
            item.id.starts_with("guardian-os:")=>0,
        "cloudflare"=>1,"mcp"=>2,"muse-watch"=>3,"managed"=>4,
        "daemon-direct"=>5,"external"=>6,"core-supervisor"=>8,"core"=>9,_=>7,
    });
    Ok(chosen)
}
fn manual_process_identity_matches(item:&Item,birth:u64,name:&str,path:Option<&str>)->bool {
    item.process_started_at==Some(birth) &&
    item.process_name.as_deref()==Some(name) &&
    item.process_path.as_deref().is_none_or(|expected|Some(expected)==path)
}

/// Manual override checks the exact OS process rather than depending on
/// another Core/lifecycle inventory request after the human approves it.
fn manual_os_identity_matches(item:&Item)->bool {
    let (Some(pid),Some(_birth),Some(name))=(
        item.pid,item.process_started_at,item.process_name.as_deref()
    ) else {return false};
    if !item.manual_kill_selectable ||
        !manual_process_allowed(&item.kind,pid,name) {return false;}
    let mut system=System::new();
    system.refresh_processes();
    system.process(Pid::from_u32(pid)).is_some_and(|process|
        !matches!(process.status(),ProcessStatus::Zombie|ProcessStatus::Dead) &&
        manual_process_identity_matches(item,process.start_time(),process.name(),
            process.exe().and_then(|p|p.to_str())))
}

async fn manual_kill_one(item:&Item)->Result<(),String> {
    let pid=item.pid.ok_or("SHUTDOWN_MANUAL_PID_UNAVAILABLE")?;
    let birth=item.process_started_at.ok_or("SHUTDOWN_MANUAL_BIRTH_UNAVAILABLE")?;
    let expected=item.process_name.as_deref()
        .ok_or("SHUTDOWN_MANUAL_EXECUTABLE_UNAVAILABLE")?;
    if !item.manual_kill_selectable ||
        !manual_process_allowed(&item.kind,pid,expected) {
        return Err("SHUTDOWN_MANUAL_EXECUTABLE_NOT_ALLOWED".into());
    }
    let mut system=System::new();
    system.refresh_processes();
    let Some(process)=system.process(Pid::from_u32(pid)) else {
        // The pinned process already exited; never adopt a replacement.
        return Ok(());
    };
    if !manual_process_identity_matches(item,process.start_time(),process.name(),
        process.exe().and_then(|p|p.to_str())) {
        return Err("SHUTDOWN_MANUAL_PID_REUSED_OR_CHANGED".into());
    }
    if !process.kill(){return Err("SHUTDOWN_MANUAL_OS_SIGNAL_DENIED".into());}
    let began=Instant::now();
    loop {
        tokio::time::sleep(Duration::from_millis(200)).await;
        system.refresh_processes();
        match system.process(Pid::from_u32(pid)) {
            None=>return Ok(()),
            Some(current) if current.start_time()!=birth =>
                return Err("SHUTDOWN_MANUAL_PID_REUSED_AFTER_SIGNAL".into()),
            // SIGKILL has terminated a zombie/dead owner, even if the
            // parent process has not finished collecting its exit receipt.
            Some(current) if matches!(current.status(),
                ProcessStatus::Zombie|ProcessStatus::Dead)=>return Ok(()),
            _=>{}
        }
        if began.elapsed()>Duration::from_secs(8) {
            return Err("SHUTDOWN_MANUAL_EXIT_UNVERIFIED".into());
        }
    }
}

fn os_birth_matches(item:&Item)->bool {
    let (Some(pid),Some(birth))=(item.pid,item.process_started_at) else{return false};
    let mut system=System::new();
    system.refresh_processes();
    system.process(Pid::from_u32(pid)).is_some_and(|p|p.start_time()==birth)
}
async fn force_stop_daemon(item:&Item)->Result<(),String> {
    if !item.force_selectable || !manual_os_identity_matches(item) {
        return Err("SHUTDOWN_FORCE_DAEMON_IDENTITY_CHANGED".into());
    }
    let status=core_request(Method::GET,"/api/daemon/status",None).await?;
    if pid_of(&status["pid"])!=item.pid || status["running"]!=true {
        return Err("SHUTDOWN_FORCE_DAEMON_OWNER_CHANGED".into());
    }

    // First request cooperative cancellation of every active daemon run and
    // stop future scheduling. This preserves daemon job definitions.
    core_request(Method::POST,"/api/daemon/stop",Some(json!({"force":true}))).await?;
    let began=Instant::now();
    loop {
        let after=core_request(Method::GET,"/api/daemon/status",None).await?;
        if pid_of(&after["pid"])!=item.pid {
            return Err("SHUTDOWN_FORCE_DAEMON_OWNER_CHANGED".into());
        }
        if after["running"]==false && after["activeJobsCount"].as_u64()==Some(0) {
            return Ok(());
        }
        if began.elapsed()>Duration::from_secs(3) {break;}
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    // A runner that ignores AbortSignal must not make Force Stop All a no-op.
    // The user already supplied typed + native destructive approval, so kill
    // only the exact verified Core worker PID/birth captured in the preview.
    manual_kill_one(item).await
}

async fn force_stop_one(item:&Item)->Result<(),String> {
    // Confirm fresh native identity, not a stale cached preview or WebView PID.
    let fresh=inspect().await?;
    let live=fresh.services.iter().find(|current|current.id==item.id);
    if !live.is_some_and(|current|same_force_owner(item,current)) {
        // A previously owned Cloudflare child may already have exited as a
        // consequence of stopping its parent MCP owner.
        if item.kind=="cloudflare" && !os_birth_matches(item) {
            let mut system=System::new();
            system.refresh_processes();
            if item.pid.is_some_and(|pid|system.process(Pid::from_u32(pid)).is_none()){
                return Ok(());
            }
        }
        return Err("SHUTDOWN_FORCE_OWNER_CHANGED".into());
    }
    if !os_birth_matches(item){return Err("SHUTDOWN_FORCE_PROCESS_BIRTH_CHANGED".into());}
    match item.kind.as_str(){
        "mcp"=>{
            runtime_control::force_stop_mcp(&config_dir()?,
                item.port.ok_or("SHUTDOWN_FORCE_PORT_REQUIRED")?,
                item.pid.ok_or("SHUTDOWN_FORCE_PID_REQUIRED")?,
                item.process_started_at.ok_or("SHUTDOWN_FORCE_BIRTH_REQUIRED")?).await
        }
        "cloudflare"=>{
            // A Cloudflare entry scanned from an arbitrary OS process is not an
            // owned service. Re-verify exact private registry provenance and
            // executable immediately before sending the native force signal.
            let verified=remote_service_detection::scan(&config_dir()?).await
                .into_iter().any(|owner|owner.kind=="cloudflare" &&
                    owner.source=="registry" &&
                    matches!(owner.state,"online"|"observed") &&
                    owner.pid==item.pid && owner.port==item.port);
            if !verified{return Err("SHUTDOWN_FORCE_TUNNEL_NOT_REGISTERED".into());}
            let pid=item.pid.ok_or("SHUTDOWN_FORCE_PID_REQUIRED")?;
            let mut system=System::new();
            system.refresh_processes();
            let process=system.process(Pid::from_u32(pid))
                .ok_or("SHUTDOWN_FORCE_OWNER_EXITED")?;
            let name=process.name().to_ascii_lowercase();
            if !matches!(name.as_str(),"cloudflared"|"cloudflared.exe") ||
                Some(process.start_time())!=item.process_started_at {
                return Err("SHUTDOWN_FORCE_TUNNEL_IDENTITY_CHANGED".into());
            }
            if !process.kill(){return Err("SHUTDOWN_FORCE_TUNNEL_SIGNAL_REJECTED".into());}
            let began=Instant::now();
            loop{
                system.refresh_processes();
                if system.process(Pid::from_u32(pid)).is_none(){
                    return Ok(());
                }
                if began.elapsed()>Duration::from_secs(6){
                    return Err("SHUTDOWN_FORCE_TUNNEL_EXIT_UNVERIFIED".into());
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        // Daemon force-stop is deliberately stronger than graceful stop:
        // abort active runs, stop scheduling, then exact-PID terminate the
        // verified Core worker only if cooperative cancellation does not settle.
        "managed" if item.id=="managed:daemon"=>force_stop_daemon(item).await,
        "daemon-direct"=>force_stop_daemon(item).await,
        // Existing owner-bound stop plans remain mandatory for every other
        // supported service. No generic process-tree or Core-supervisor kill.
        "managed"|"core" if item.selectable=>stop_one(item).await,
        _=>Err("SHUTDOWN_FORCE_NO_OWNER_PROTOCOL".into()),
    }
}

fn stop_plan_request(service: &str, plan: &Value, port: u16, expected_pid:u32) -> Result<Value,String> {
    if !MANAGED_ORDER.contains(&service) || plan["service"]!=service ||
        plan["action"]!="stop" || port_of(&plan["port"])!=Some(port) ||
        plan["allowed"]==false {
        return Err("SHUTDOWN_PLAN_IDENTITY_MISMATCH".into());
    }
    let plan_pid=if service=="daemon" {
        pid_of(&plan["expectedWorkerPid"])
    } else {
        pid_of(&plan["expectedOwnerPid"])
    };
    if plan_pid!=Some(expected_pid) {
        return Err("SHUTDOWN_PLAN_OWNER_CHANGED".into());
    }
    let operation=plan["operationId"].as_str()
        .filter(|s|s.len()>=8&&s.len()<=128)
        .ok_or("SHUTDOWN_PLAN_OPERATION_ID_MISSING")?;
    let mut command=Map::new();
    command.insert("action".into(),json!("stop"));
    command.insert("service".into(),json!(service));
    command.insert("confirm".into(),json!(true));
    command.insert("operationId".into(),json!(operation));
    for field in PLAN_FIELDS {
        if let Some(value)=plan.get(*field) {
            command.insert((*field).into(),value.clone());
        }
    }
    Ok(Value::Object(command))
}
fn same_owner(before: &Item, after: &Item) -> bool {
    before.id==after.id && before.pid==after.pid && before.port==after.port &&
        after.selectable && after.owner_verified && running(&after.state)
}
fn exit_pid_verified(pid:u32) -> bool {
    let mut system=System::new();
    system.refresh_processes();
    system.process(Pid::from_u32(pid)).is_none()
}

async fn stop_one(item: &Item) -> Result<(),String> {
    let fresh=inspect().await?;
    let now=fresh.services.iter().find(|other|other.id==item.id)
        .ok_or("SHUTDOWN_OWNER_CHANGED")?;
    if !same_owner(item,now) {return Err("SHUTDOWN_OWNER_CHANGED_OR_BUSY".into());}
    match item.kind.as_str() {
        "managed" => {
            let service=item.id.strip_prefix("managed:").ok_or("SHUTDOWN_INVALID_SERVICE")?;
            let port=item.port.ok_or("SHUTDOWN_MISSING_PORT")?;
            let plan=lifecycle_console_request(json!({"action":"plan",
                "service":service,"targetAction":"stop","port":port})).await?;
            let command=stop_plan_request(service,&plan,port,
                item.pid.ok_or("SHUTDOWN_MISSING_OWNER_PID")?)?;
            lifecycle_console_request(command).await?;
            // Do not call a second mutation on timeout or an ambiguous receipt.
            let after=inspect().await?;
            if after.services.iter().find(|s|s.id==item.id)
                .is_some_and(|s|running(&s.state)) {
                return Err("SHUTDOWN_OWNER_STILL_PRESENT: review the operation receipt".into());
            }
        }
        "mcp" => {
            runtime_control::control(&config_dir()?,"mcp","stop",
                item.port.ok_or("SHUTDOWN_MISSING_PORT")?,
                item.pid.ok_or("SHUTDOWN_MISSING_PID")?).await?;
            let after=remote_service_detection::scan(&config_dir()?).await;
            if after.iter().any(|other|other.kind=="mcp" &&
                other.port==item.port && other.pid==item.pid && running(other.state)) {
                return Err("SHUTDOWN_MCP_OWNER_STILL_RUNNING".into());
            }
        }
        "daemon-direct" => {
            let status=core_request(Method::GET,"/api/daemon/status",None).await?;
            if pid_of(&status["pid"])!=item.pid ||
                status["activeJobsCount"].as_u64()!=Some(0) || status["running"]!=true {
                return Err("SHUTDOWN_DAEMON_OWNER_CHANGED_OR_BUSY".into());
            }
            core_request(Method::POST,"/api/daemon/stop",Some(json!({}))).await?;
            let after=core_request(Method::GET,"/api/daemon/status",None).await?;
            if pid_of(&after["pid"])!=item.pid || after["running"]!=false {
                return Err("SHUTDOWN_DAEMON_STOP_UNVERIFIED".into());
            }
        }
        "core" => {
            let refreshed=inspect().await?;
            if refreshed.active().any(|other|other.id!=item.id) {
                return Err("SHUTDOWN_CORE_DEPENDENCIES_STILL_RUNNING".into());
            }
            let credentials=server_info()?;
            if credentials.pid!=item.pid || Some(credentials.port)!=item.port {
                return Err("SHUTDOWN_CORE_OWNER_CHANGED".into());
            }
            verify_direct_core_idle(
                item.pid.ok_or("SHUTDOWN_MISSING_PID")?,
                item.port.ok_or("SHUTDOWN_MISSING_PORT")?,
            ).await?;
            if fs::symlink_metadata(config_dir()?.join(
                format!("core-supervisor-{}.json",credentials.port))).is_ok() {
                return Err("SHUTDOWN_CORE_SUPERVISOR_DISCOVERED".into());
            }
            core_request(Method::POST,"/api/shutdown",Some(json!({}))).await?;
            let pid=item.pid.ok_or("SHUTDOWN_MISSING_PID")?;
            let start=Instant::now();
            loop {
                if exit_pid_verified(pid) {break;}
                if start.elapsed()>Duration::from_secs(8) {
                    return Err("SHUTDOWN_CORE_EXIT_UNVERIFIED".into());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        _ => return Err("SHUTDOWN_SERVICE_NOT_STOPPABLE".into()),
    }
    Ok(())
}

fn set_progress(app:&AppHandle, progress:&Progress) {
    if let Ok(mut state)=locked(){state.progress=Some(progress.clone());}
    let _=app.emit("shutdown-manager-progress",progress);
}
fn replacement_matches(before:&Item,current:&Item)->bool {
    if before.pid.is_none()||current.pid.is_none()||before.pid==current.pid ||
        !running(&current.state)||before.port!=current.port {
        return false;
    }
    if before.id=="managed:guardian"||before.id.starts_with("guardian-os:") {
        return current.id=="managed:guardian"||current.id.starts_with("guardian-os:");
    }
    match before.kind.as_str() {
        "core-supervisor"=>current.kind=="core-supervisor",
        "core"=>current.kind=="core",
        "mcp"=>current.kind=="mcp",
        "cloudflare"=>current.kind=="cloudflare"&&before.port.is_some(),
        _=>before.id==current.id,
    }
}

async fn run_manual_shutdown(app:AppHandle,chosen:Vec<Item>,mut progress:Progress) {
    let mut partial=false;
    for (index,item) in chosen.iter().enumerate() {
        progress.steps[index].status="stopping".into();
        progress.steps[index].message=format!(
            "OS kill requested for PID {}; checking process birth and executable",
            item.pid.unwrap_or(0));
        set_progress(&app,&progress);
        match manual_kill_one(item).await {
            Ok(())=>{
                progress.steps[index].status="stopped".into();
                progress.steps[index].message=format!(
                    "PID {} exit verified; services may auto-restart with a new PID",
                    item.pid.unwrap_or(0));
            }
            Err(error)=>{
                partial=true;
                progress.steps[index].status="blocked".into();
                progress.steps[index].message=redacted(&error);
                progress.error=Some(redacted(&error));
            }
        }
        set_progress(&app,&progress);
    }
    // One bounded post-stop observation: do not kill replacement PIDs under
    // the old approval. A new owner requires a fresh preview and human choice.
    tokio::time::sleep(Duration::from_millis(900)).await;
    match tokio::time::timeout(Duration::from_secs(10),inspect()).await {
        Ok(Ok(after))=>{
            for (index,item) in chosen.iter().enumerate(){
                if progress.steps[index].status!="stopped"{continue}
                if let Some(new_owner)=after.services.iter().find(|current|
                    replacement_matches(item,current)) {
                    partial=true;
                    progress.steps[index].status="restarted".into();
                    progress.steps[index].message=format!(
                        "PID {} exited; new PID {} detected. Review and approve separately.",
                        item.pid.unwrap_or(0),new_owner.pid.unwrap_or(0));
                    progress.error=Some("SHUTDOWN_MANUAL_OWNER_RESPAWNED".into());
                }
            }
        }
        _=>{
            partial=true;
            progress.error=Some("SHUTDOWN_MANUAL_POSTCHECK_UNAVAILABLE".into());
        }
    }
    progress.stage=if partial {"partial"} else {"complete"}.into();
    set_progress(&app,&progress);
    if let Ok(mut state)=locked(){state.busy=false;state.preview=None;}
}

async fn run_force_shutdown(app:AppHandle, chosen:Vec<Item>, mut progress:Progress) {
    let mut partial=false;
    for item in &chosen {
        let Some(step)=progress.steps.iter().position(|step|step.id==item.id) else {
            partial=true;
            progress.error=Some("SHUTDOWN_FORCE_PROGRESS_MISMATCH".into());
            continue;
        };
        progress.steps[step].status="stopping".into();
        progress.steps[step].message="Revalidating registered owner and process birth".into();
        set_progress(&app,&progress);
        match force_stop_one(item).await{
            Ok(())=>{
                progress.steps[step].status="stopped".into();
                progress.steps[step].message="Registered owner exit verified".into();
            }
            Err(error)=>{
                partial=true;
                progress.steps[step].status="blocked".into();
                progress.steps[step].message=redacted(&error);
                progress.error=Some(redacted(&error));
            }
        }
        // Force Stop All must attempt every independently pinned owner. A
        // failure in one daemon must not silently skip the remaining daemons.
        set_progress(&app,&progress);
    }
    // Unknown/foreign owners are never taken over. A force-stop may finish
    // only partially; keep the Tray running for evidence and reconciliation.
    let remaining=inspect().await.map(|after|
        after.active().any(|item|!matches!(item.kind.as_str(),"daemon-direct") ||
            item.state=="active"));
    match remaining{
        Ok(false) if !partial=>progress.stage="complete".into(),
        _=>{
            progress.stage="partial".into();
            if progress.error.is_none() {
                progress.error=Some("SHUTDOWN_FORCE_REMAINING_OWNERS_REQUIRE_REVIEW".into());
            }
        }
    }
    set_progress(&app,&progress);
    if let Ok(mut state)=locked(){state.busy=false;state.preview=None;}
}

async fn run_shutdown(app:AppHandle, chosen:Vec<Item>, exit_after:bool, mut progress:Progress) {
    for (index,item) in chosen.iter().enumerate() {
        progress.steps[index].status=if item.kind=="mcp" {"draining"} else {"stopping"}.into();
        progress.steps[index].message=if item.kind=="mcp" {
            "Verifying zero active sessions before authenticated owner drain"
        } else {
            "Revalidating exact owner and requesting graceful stop"
        }.into();
        set_progress(&app,&progress);
        match stop_one(item).await {
            Ok(()) => {
                progress.steps[index].status="stopped".into();
                progress.steps[index].message="Owner-specific shutdown verified".into();
                set_progress(&app,&progress);
            }
            Err(error) => {
                progress.steps[index].status="blocked".into();
                progress.steps[index].message=redacted(&error);
                progress.stage="partial".into();
                progress.error=Some(redacted(&error));
                for other in progress.steps.iter_mut().skip(index+1) {
                    other.status="skipped".into();
                    other.message="Not attempted after an uncertain or blocked shutdown".into();
                }
                set_progress(&app,&progress);
                if let Ok(mut state)=locked(){state.busy=false;state.preview=None;}
                return;
            }
        }
    }
    if exit_after {
        let dir=config_dir();
        let remaining=match dir {
            Ok(dir)=>remote_service_detection::scan(&dir).await
                .iter().any(|service|running(service.state) &&
                    matches!(service.kind,"mcp"|"cloudflare"|"muse-watch"|"core-supervisor")),
            Err(_)=>true,
        };
        if remaining {
            progress.stage="partial".into();
            progress.error=Some("SHUTDOWN_POSTCHECK_ACTIVE_OWNER".into());
        } else {
            progress.stage="complete".into();
            set_progress(&app,&progress);
            tray_lifecycle::cleanup();
            app.exit(0);
            return;
        }
    } else {
        progress.stage="complete".into();
    }
    set_progress(&app,&progress);
    if let Ok(mut state)=locked(){state.busy=false;state.preview=None;}
}

pub fn open(app:&AppHandle) {
    show_main(app,false);
    let _=app.emit("desktop-open-shutdown-manager",());
}

#[tauri::command]
pub async fn shutdown_manager_action(
    app:AppHandle,window:WebviewWindow,action:String,
    preview_id:Option<String>,selected:Option<Vec<String>>,exit_after:Option<bool>,
    force_confirmation:Option<String>,
) -> Result<Value,String> {
    if window.label()!="main" || !window.is_visible().unwrap_or(false) ||
        window.is_minimized().unwrap_or(true) {
        return Err("SHUTDOWN_NATIVE_WINDOW_REQUIRED".into());
    }
    match action.as_str() {
        "status" => {
            if preview_id.is_some()||selected.is_some()||exit_after.is_some()||
                force_confirmation.is_some() {
                return Err("SHUTDOWN_UNEXPECTED_ARGUMENT".into());
            }
            let state=locked()?;
            Ok(json!({"busy":state.busy,"progress":state.progress.clone()}))
        }
        "preview" => {
            if preview_id.is_some()||selected.is_some()||exit_after.is_some()||
                force_confirmation.is_some() {
                return Err("SHUTDOWN_UNEXPECTED_ARGUMENT".into());
            }
            if locked()?.busy{return Err("SHUTDOWN_ALREADY_RUNNING".into());}
            let preview=inspect().await?;
            locked()?.preview=Some(preview.clone());
            Ok(json!({"preview":preview}))
        }
        "manual_kill" => {
            if !window.is_focused().unwrap_or(false) {
                return Err("SHUTDOWN_FOCUSED_NATIVE_WINDOW_REQUIRED".into());
            }
            if exit_after.is_some() ||
                force_confirmation.as_deref()!=Some("KILL SELECTED") {
                return Err("SHUTDOWN_MANUAL_TYPED_APPROVAL_REQUIRED".into());
            }
            let token=preview_id.ok_or("SHUTDOWN_PREVIEW_REQUIRED")?;
            let ids=selected.ok_or("SHUTDOWN_MANUAL_SELECTION_REQUIRED")?;
            let original={
                let state=locked()?;
                if state.busy{return Err("SHUTDOWN_ALREADY_RUNNING".into());}
                state.preview.clone().ok_or("SHUTDOWN_PREVIEW_REQUIRED")?
            };
            if original.preview_id!=token ||
                timestamp().saturating_sub(original.created_at)>PREVIEW_TTL_MS {
                return Err("SHUTDOWN_PREVIEW_EXPIRED".into());
            }
            let chosen=manual_candidates(&original,&ids)?;
            let mut summary=format!(
                "MANUALLY KILL {} DISTINCT OS PROCESS(ES)?\n\n\
                This is an irreversible owner-authorized emergency override.\n\
                Active agent jobs, MCP sessions, Core generations and Cloudflare tunnels\n\
                may be interrupted. Their supervisors may start replacement processes.\n\n",
                chosen.len());
            for item in chosen.iter().take(16) {
                summary.push_str(&format!("PID {} · {} · {}\n",
                    item.pid.unwrap_or(0),
                    item.process_name.as_deref().unwrap_or("unknown"),
                    item.label));
                if let Some(path)=item.process_path.as_deref() {
                    summary.push_str(&format!("  Executable: {}\n",path.chars().take(240).collect::<String>()));
                }
            }
            if chosen.len()>16 {
                summary.push_str(&format!("...and {} more selected process(es).\n",
                    chosen.len()-16));
            }
            summary.push_str(
                "\nOnly the exact OS PIDs selected in this preview are targeted. \
                No process tree is killed. Continue?");
            let dialog=app.clone();
            let dialog_parent=window.clone();
            let approved=tauri::async_runtime::spawn_blocking(move||{
                use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
                dialog.dialog().message(summary)
                    .title("SuperAgent · Shutdown Manager")
                    .parent(&dialog_parent)
                    .buttons(
                    MessageDialogButtons::OkCancelCustom(
                        "Kill selected OS processes".into(),"Cancel".into()
                    )).blocking_show()
            }).await.map_err(|_|"SHUTDOWN_NATIVE_APPROVAL_FAILED")?;
            if !approved{return Err("SHUTDOWN_OPERATOR_CANCELLED".into());}
            // The selected process identity was pinned during preview and
            // displayed in the human approval dialog. A failed Core inventory
            // must not veto this deliberate OS-only override, but process
            // reuse, disappearance or executable changes still block it.
            if chosen.iter().any(|item|!manual_os_identity_matches(item)) {
                return Err("SHUTDOWN_MANUAL_PROCESS_CHANGED_SINCE_PREVIEW".into());
            }
            let progress=Progress {run_id:Uuid::new_v4().simple().to_string(),
                stage:"running".into(),exit_after:false,
                steps:chosen.iter().map(|item|Step {
                    id:item.id.clone(),label:format!(
                        "{} · PID {}",item.label,item.pid.unwrap_or(0)),
                    status:"queued".into(),
                    message:"Manual kill approved; awaiting exact OS process verification".into(),
                }).collect(),error:None};
            {
                let mut state=locked()?;
                if state.busy{return Err("SHUTDOWN_ALREADY_RUNNING".into());}
                if state.preview.as_ref().is_none_or(|p|p.preview_id!=token){
                    return Err("SHUTDOWN_PREVIEW_REPLACED".into());
                }
                state.busy=true;state.progress=Some(progress.clone());
            }
            set_progress(&app,&progress);
            let run_id=progress.run_id.clone();
            tauri::async_runtime::spawn(run_manual_shutdown(app,chosen,progress));
            Ok(json!({"accepted":true,"runId":run_id}))
        }
        "force_all" => {
            if !window.is_focused().unwrap_or(false) {
                return Err("SHUTDOWN_FOCUSED_NATIVE_WINDOW_REQUIRED".into());
            }
            if selected.is_some()||exit_after.is_some() ||
                force_confirmation.as_deref()!=Some("FORCE STOP ALL") {
                return Err("SHUTDOWN_FORCE_TYPED_APPROVAL_REQUIRED".into());
            }
            let token=preview_id.ok_or("SHUTDOWN_PREVIEW_REQUIRED")?;
            let original={
                let state=locked()?;
                if state.busy{return Err("SHUTDOWN_ALREADY_RUNNING".into());}
                state.preview.clone().ok_or("SHUTDOWN_PREVIEW_REQUIRED")?
            };
            if original.preview_id!=token ||
                timestamp().saturating_sub(original.created_at)>PREVIEW_TTL_MS {
                return Err("SHUTDOWN_PREVIEW_EXPIRED".into());
            }
            let chosen=force_candidates(&original)?;
            let blocked=original.active().filter(|item|!item.force_selectable).count();
            let summary=format!(
                "FORCE STOP ALL VERIFIED SUPERAGENT OWNERS?\n\n\
                Force stop may interrupt MCP sessions, in-flight requests and public \
                Cloudflare tunnels. Quick Tunnel URLs can change after restart.\n\n\
                {} authenticated owner(s) eligible. {} unknown, foreign or \
                unsupported owner(s) WILL REMAIN RUNNING.\n\n\
                The Tray stays open for status verification. Continue?",
                chosen.len(),blocked);
            let dialog=app.clone();
            let dialog_parent=window.clone();
            let approved=tauri::async_runtime::spawn_blocking(move||{
                use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
                dialog.dialog().message(summary)
                    .title("SuperAgent · Shutdown Manager")
                    .parent(&dialog_parent)
                    .buttons(
                    MessageDialogButtons::OkCancelCustom(
                        "Force stop verified owners".into(),"Cancel".into()
                    )).blocking_show()
            }).await.map_err(|_|"SHUTDOWN_NATIVE_APPROVAL_FAILED")?;
            if !approved{return Err("SHUTDOWN_OPERATOR_CANCELLED".into());}
            let latest=inspect().await?;
            for item in &chosen {
                if !latest.services.iter().any(|current|same_force_owner(item,current)) {
                    return Err("SHUTDOWN_FORCE_OWNER_CHANGED_SINCE_PREVIEW".into());
                }
            }
            let progress=Progress {run_id:Uuid::new_v4().simple().to_string(),
                stage:"running".into(),exit_after:false,
                steps:original.active().map(|item|Step {
                    id:item.id.clone(),label:item.label.clone(),
                    status:if item.force_selectable {"queued"} else {"blocked"}.into(),
                    message:if item.force_selectable {
                        "Force stop approved; awaiting fresh owner verification".into()
                    } else {
                        "Not force-stoppable: foreign, busy, or unverified owner".into()
                    },
                }).collect(),error:None};
            {
                let mut state=locked()?;
                if state.busy{return Err("SHUTDOWN_ALREADY_RUNNING".into());}
                if state.preview.as_ref().is_none_or(|p|p.preview_id!=token) {
                    return Err("SHUTDOWN_PREVIEW_REPLACED".into());
                }
                state.busy=true;state.progress=Some(progress.clone());
            }
            set_progress(&app,&progress);
            let run_id=progress.run_id.clone();
            tauri::async_runtime::spawn(run_force_shutdown(app,chosen,progress));
            Ok(json!({"accepted":true,"runId":run_id}))
        }
        "execute" => {
            if force_confirmation.is_some(){
                return Err("SHUTDOWN_UNEXPECTED_ARGUMENT".into());
            }
            if !window.is_focused().unwrap_or(false) {
                return Err("SHUTDOWN_FOCUSED_NATIVE_WINDOW_REQUIRED".into());
            }
            let token=preview_id.ok_or("SHUTDOWN_PREVIEW_REQUIRED")?;
            let ids=selected.ok_or("SHUTDOWN_SELECTION_REQUIRED")?;
            let exit=exit_after.ok_or("SHUTDOWN_EXIT_CHOICE_REQUIRED")?;
            let original={
                let state=locked()?;
                if state.busy {return Err("SHUTDOWN_ALREADY_RUNNING".into());}
                state.preview.clone().ok_or("SHUTDOWN_PREVIEW_REQUIRED")?
            };
            if original.preview_id!=token ||
                timestamp().saturating_sub(original.created_at)>PREVIEW_TTL_MS {
                return Err("SHUTDOWN_PREVIEW_EXPIRED".into());
            }
            let chosen=validate_selection(&original,&ids,exit)?;
            let dialog=app.clone();
            let dialog_parent=window.clone();
            let summary=format!(
                "Stop {} verified service(s){}?\n\n\
                Active jobs and sessions are never force-killed. Services that change owner, \
                become busy or refuse graceful shutdown will remain running. \
                Results are shown in Shutdown Manager.",
                chosen.len(),if exit {" and exit SuperAgent Tray"}else {""}
            );
            let approved=tauri::async_runtime::spawn_blocking(move||{
                use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
                dialog.dialog().message(summary)
                    .title("SuperAgent · Shutdown Manager")
                    .parent(&dialog_parent)
                    .buttons(
                    MessageDialogButtons::OkCancelCustom(
                        "Confirm graceful shutdown".into(),"Cancel".into()
                    )).blocking_show()
            }).await.map_err(|_|"SHUTDOWN_NATIVE_APPROVAL_FAILED")?;
            if !approved{return Err("SHUTDOWN_OPERATOR_CANCELLED".into());}
            let latest=inspect().await?;
            for item in &chosen {
                let Some(current)=latest.services.iter().find(|row|row.id==item.id) else {
                    return Err("SHUTDOWN_OWNER_CHANGED_SINCE_PREVIEW".into());
                };
                if !same_owner(item,current) {
                    return Err("SHUTDOWN_OWNER_CHANGED_SINCE_PREVIEW".into());
                }
            }
            // Exit-all requires a fresh complete preflight. Partial stop-selected
            // never exits the Tray, even when all chosen services stop.
            if exit && (!latest.exit_ready ||
                latest.active().any(|row|!ids.contains(&row.id))) {
                return Err("SHUTDOWN_EXIT_READINESS_CHANGED".into());
            }
            let progress=Progress {run_id:Uuid::new_v4().simple().to_string(),
                stage:"running".into(),exit_after:exit,
                steps:chosen.iter().map(|s|Step {id:s.id.clone(),label:s.label.clone(),
                    status:"queued".into(),message:"Awaiting owner verification".into()}).collect(),
                error:None};
            {
                let mut state=locked()?;
                if state.busy {return Err("SHUTDOWN_ALREADY_RUNNING".into());}
                if state.preview.as_ref().is_none_or(|p|p.preview_id!=token) {
                    return Err("SHUTDOWN_PREVIEW_REPLACED".into());
                }
                state.busy=true;
                state.progress=Some(progress.clone());
            }
            set_progress(&app,&progress);
            let run_id=progress.run_id.clone();
            tauri::async_runtime::spawn(run_shutdown(app,chosen,exit,progress));
            Ok(json!({"accepted":true,"runId":run_id}))
        }
        _ => Err("SHUTDOWN_UNSUPPORTED_ACTION".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(id:&str, selectable:bool)->Item {
        Item::new(id.into(),id,"managed","active","verified",selectable,selectable,
            if selectable {None}else {Some("busy".into())},Some(8095),Some(123))
    }
    fn preview(rows:Vec<Item>,ready:bool)->Preview {
        Preview {preview_id:"ticket".into(),created_at:1,services:rows,
            exit_ready:ready,warning:None}
    }
    #[test]
    fn rejects_unknown_duplicate_unverified_or_partial_exit() {
        let p=preview(vec![item("managed:vision",true),item("managed:guardian",false)],false);
        assert!(validate_selection(&p,&["foreign".into()],false).is_err());
        assert!(validate_selection(&p,&["managed:vision".into(),"managed:vision".into()],false).is_err());
        assert!(validate_selection(&p,&["managed:guardian".into()],false).is_err());
        assert!(validate_selection(&p,&["managed:vision".into()],true).is_err());
        assert_eq!(validate_selection(&p,&["managed:vision".into()],false).unwrap().len(),1);
    }
    #[test]
    fn permits_exit_when_every_service_is_already_stopped() {
        let p=preview(vec![Item::new("core-absent".into(),"Core","core","inactive",
            "Offline",false,false,None,None,None)],true);
        assert!(validate_selection(&p,&[],true).unwrap().is_empty());
        assert!(validate_selection(&p,&[],false).is_err());
    }
    #[test]
    fn requires_complete_selection_before_exit() {
        let p=preview(vec![item("managed:vision",true),item("managed:guardian",true)],true);
        assert!(validate_selection(&p,&["managed:vision".into()],true).is_err());
        assert!(validate_selection(&p,&["managed:vision".into(),"managed:guardian".into()],true).is_ok());
    }
    #[test]
    fn stop_plan_strips_unexpected_fields_and_pins_owner() {
        let request=stop_plan_request("vision",&json!({"service":"vision","action":"stop",
            "port":8095,"operationId":"a-valid-operation","expectedOwnerPid":123,
            "expectedInstanceId":"pinned","noPublicIngress":true,
            "token":"must-never-leak","url":"https://evil.invalid"}),8095,123).unwrap();
        assert_eq!(request["confirm"],true);
        assert_eq!(request["expectedOwnerPid"],123);
        assert!(request.get("token").is_none());
        assert!(request.get("url").is_none());
        assert!(stop_plan_request("vision",&json!({"service":"vision","action":"stop",
            "port":8095,"operationId":"a-valid-operation","expectedOwnerPid":999}),8095,123).is_err());
        assert!(stop_plan_request("vision",&json!({"service":"vision","action":"stop",
            "port":8096,"operationId":"a-valid-operation"}),8095,123).is_err());
        assert!(stop_plan_request("core",&json!({"service":"core",
            "action":"stop","port":8095,"operationId":"a-valid-operation"}),8095,123).is_err());
    }
    #[test]
    fn direct_core_never_exits_with_active_or_unverified_agents() {
        assert!(!active_core_instances(&json!({
            "subagents":[{"status":"completed"}],
            "superagents":[],
            "procs":[{"hasExited":true}]
        })).unwrap());
        assert!(active_core_instances(&json!({
            "subagents":[{"status":"running"}],"superagents":[],"procs":[]
        })).unwrap());
        assert!(active_core_instances(&json!({
            "subagents":[],"superagents":[{"status":"unknown"}],"procs":[]
        })).unwrap());
        assert!(active_core_instances(&json!({
            "subagents":[],"superagents":[],"procs":[{"hasExited":false}]
        })).unwrap());
        assert!(active_core_instances(&json!({
            "subagents":[],"superagents":[]
        })).is_err());
    }
    #[test]
    fn force_candidates_include_only_explicitly_verified_and_birth_pinned_owners() {
        let mut owned=item("mcp:9227:123",false);
        owned.kind="mcp".into();owned.port=Some(9227);
        owned.force_selectable=true;owned.process_started_at=Some(1800000000);
        let mut foreign=item("observed:cloudflare:18140",false);
        foreign.kind="cloudflare".into();
        foreign.process_started_at=Some(1800000001);
        let mut guardian=item("managed:guardian",false);
        guardian.force_selectable=true; // no OS process-birth attestation
        let p=preview(vec![foreign,guardian,owned.clone()],false);
        let chosen=force_candidates(&p).unwrap();
        assert_eq!(chosen.len(),1);
        assert_eq!(chosen[0].id,owned.id);
        assert!(same_force_owner(&owned,&chosen[0]));
        assert!(force_candidates(&preview(vec![item("unverified",false)],false)).is_err());
    }
    #[test]
    fn force_candidates_include_busy_verified_daemon_even_when_graceful_stop_is_blocked() {
        let mut daemon=item("managed:daemon",false);
        daemon.kind="managed".into();
        daemon.owner_verified=true;
        daemon.selectable=false;
        daemon.force_selectable=true;
        daemon.pid=Some(4242);
        daemon.port=Some(7888);
        daemon.process_name=Some("bun.exe".into());
        daemon.process_started_at=Some(1_800_000_010);
        daemon.manual_kill_selectable=true;
        daemon.active_sessions=Some(2);
        let chosen=force_candidates(&preview(vec![daemon.clone()],false)).unwrap();
        assert_eq!(chosen.len(),1);
        assert_eq!(chosen[0].id,"managed:daemon");
        assert!(!chosen[0].selectable);
        assert!(chosen[0].force_selectable);
        assert_eq!(chosen[0].active_sessions,Some(2));
    }

    #[test]
    fn force_authorization_fails_closed_on_pid_birth_or_owner_changes() {
        let mut trusted=item("observed:cloudflare:18140",false);
        trusted.kind="cloudflare".into();
        trusted.force_selectable=true;trusted.process_started_at=Some(1700000000);
        let mut after=trusted.clone();
        after.pid=Some(18141);
        assert!(!same_force_owner(&trusted,&after));
        after=trusted.clone();after.process_started_at=Some(1700000010);
        assert!(!same_force_owner(&trusted,&after));
        after=trusted.clone();after.force_selectable=false;
        assert!(!same_force_owner(&trusted,&after));
        after=trusted.clone();after.port=Some(9228);
        assert!(!same_force_owner(&trusted,&after));
    }
    #[test]
    fn force_candidate_order_never_adopts_unverified_supervisors() {
        let mut core=item("core:7888:700",true);
        core.kind="core".into();core.force_selectable=true;
        core.process_started_at=Some(1700000000);
        let mut cloudflare=item("observed:cloudflare:800",false);
        cloudflare.kind="cloudflare".into();
        cloudflare.force_selectable=true;cloudflare.process_started_at=Some(1700000001);
        let mut mcp=item("mcp:9227:900",false);
        mcp.kind="mcp".into();mcp.force_selectable=true;
        mcp.process_started_at=Some(1700000002);
        let mut supervisor=item("supervisor:7888:999",false);
        supervisor.kind="core-supervisor".into();
        supervisor.process_started_at=Some(1700000003);
        let p=preview(vec![core,supervisor,mcp,cloudflare],false);
        let names:Vec<String>=force_candidates(&p).unwrap().iter()
            .map(|item|item.kind.clone()).collect();
        assert_eq!(names,vec!["mcp","cloudflare","core"]);
    }
    #[test]
    fn guardian_os_lease_fallback_rejects_pid_reuse_and_stale_owner_records() {
        let valid=json!({"version":1,"port":7888,"pid":25204,
            "startedAt":1_800_000_003_000u64,"instanceId":"owner"});
        assert!(guardian_lease_matches(&valid,7888,25204,1_800_000_000,
            1_800_000_003_100));
        assert!(!guardian_lease_matches(&valid,7888,25205,1_800_000_000,
            1_800_000_003_100));
        assert!(!guardian_lease_matches(&valid,7889,25204,1_800_000_000,
            1_800_000_003_100));
        assert!(!guardian_lease_matches(&valid,7888,25204,1_800_001_000,
            1_800_001_003_100));
        assert!(!guardian_lease_matches(&valid,7888,25204,1_799_999_900,
            1_800_000_003_100));
        assert!(!guardian_lease_matches(&valid,7888,25204,1_800_000_000,
            1_799_000_000_000));
        let no_birth=json!({"version":1,"port":7888,"pid":25204});
        assert!(!guardian_lease_matches(&no_birth,7888,25204,1_800_000_000,
            1_800_000_003_100));
    }
    #[test]
    fn manual_process_identity_blocks_executable_path_swaps() {
        let mut item=item("guardian-os:7888:25204",false);
        item.manual_kill_selectable=true;item.process_name=Some("bun.exe".into());
        item.process_started_at=Some(1_800_000_000);
        item.process_path=Some("C:\\SuperAgent\\bun.exe".into());
        assert!(manual_process_identity_matches(&item,1_800_000_000,
            "bun.exe",Some("C:\\SuperAgent\\bun.exe")));
        assert!(!manual_process_identity_matches(&item,1_800_000_000,
            "bun.exe",Some("C:\\Windows\\bun.exe")));
        assert!(!manual_process_identity_matches(&item,1_800_000_001,
            "bun.exe",Some("C:\\SuperAgent\\bun.exe")));
        assert!(!manual_process_identity_matches(&item,1_800_000_000,
            "node.exe",Some("C:\\SuperAgent\\bun.exe")));
        assert!(!manual_process_identity_matches(&item,1_800_000_000,
            "bun.exe",None));
    }
    #[test]
    fn explicit_manual_kill_allows_reviewed_owners_but_not_system_or_tray() {
        let pid=std::process::id().saturating_add(5000);
        assert!(manual_process_allowed("managed",pid,"bun.exe"));
        assert!(manual_process_allowed("managed",pid,"powershell.exe"));
        assert!(manual_process_allowed("core-supervisor",pid,"node.exe"));
        assert!(manual_process_allowed("cloudflare",pid,"cloudflared.exe"));
        assert!(!manual_process_allowed("cloudflare",pid,"bun.exe"));
        assert!(!manual_process_allowed("managed",pid,"svchost.exe"));
        assert!(!manual_process_allowed("core",pid,"lsass.exe"));
        assert!(!manual_process_allowed("managed",pid,"superagent-tray.exe"));
        assert!(!manual_process_allowed("managed",std::process::id(),"bun.exe"));
        assert!(!manual_process_allowed("managed",4,"bun.exe"));
        assert!(!manual_process_allowed("agents",pid,"bun.exe"));
    }
    #[test]
    fn manual_candidates_dedupe_shared_pid_and_enforce_birth_and_owner_kind() {
        let mut guardian=item("managed:guardian",false);
        guardian.kind="managed".into();guardian.pid=Some(25204);
        guardian.process_name=Some("bun.exe".into());
        guardian.process_started_at=Some(1_800_000_000);
        guardian.manual_kill_selectable=true;
        let mut core=item("core:7888:25204",false);
        core.kind="core".into();core.pid=Some(25204);
        core.process_name=Some("bun.exe".into());
        core.process_started_at=Some(1_800_000_000);
        core.manual_kill_selectable=true;
        let mut external=item("observed:cloudflare:18140",false);
        external.kind="cloudflare".into();external.pid=Some(18140);
        external.process_name=Some("cloudflared.exe".into());
        external.process_started_at=Some(1_800_000_100);
        external.manual_kill_selectable=true;
        let mut supervisor=item("supervisor:7888:3628",false);
        supervisor.kind="core-supervisor".into();supervisor.pid=Some(3628);
        supervisor.process_name=Some("bun.exe".into());
        supervisor.process_started_at=Some(1_800_000_200);
        supervisor.manual_kill_selectable=true;
        let all=preview(vec![guardian.clone(),core.clone(),external.clone(),supervisor.clone()],false);
        let ids=vec![guardian.id.clone(),core.id.clone(),external.id.clone(),supervisor.id.clone()];
        let chosen=manual_candidates(&all,&ids).unwrap();
        assert_eq!(chosen.len(),3);
        assert_eq!(chosen[0].id,"managed:guardian");
        assert_eq!(chosen[1].kind,"cloudflare");
        assert_eq!(chosen.last().unwrap().kind,"core-supervisor");
        assert!(manual_candidates(&all,&[guardian.id.clone(),guardian.id.clone()]).is_err());
        assert!(manual_candidates(&all,&["unknown:pid".into()]).is_err());
        assert!(manual_candidates(&all,&[]).is_err());
        let mut changed=supervisor.clone();changed.process_started_at=Some(1_800_000_999);
        assert!(!same_manual_owner(&supervisor,&changed));
        changed=supervisor.clone();changed.process_name=Some("node.exe".into());
        assert!(!same_manual_owner(&supervisor,&changed));
        changed=supervisor.clone();changed.manual_kill_selectable=false;
        assert!(!same_manual_owner(&supervisor,&changed));
    }
    #[test]
    fn replacement_detection_flags_only_new_owner_pid_for_same_service_and_port() {
        let mut original=item("guardian-os:7888:101",false);
        original.kind="managed".into();original.port=Some(7888);original.pid=Some(101);
        let mut next=item("guardian-os:7888:202",false);
        next.kind="managed".into();next.port=Some(7888);next.pid=Some(202);
        assert!(replacement_matches(&original,&next));
        next.port=Some(7889);
        assert!(!replacement_matches(&original,&next));
        next.port=Some(7888);next.pid=Some(101);
        assert!(!replacement_matches(&original,&next));
        next.pid=Some(202);next.state="stopped".into();
        assert!(!replacement_matches(&original,&next));
        let mut sup=item("supervisor:7888:701",false);
        sup.kind="core-supervisor".into();sup.port=Some(7888);sup.pid=Some(701);
        let mut restarted=item("supervisor:7888:702",false);
        restarted.kind="core-supervisor".into();
        restarted.port=Some(7888);restarted.pid=Some(702);
        assert!(replacement_matches(&sup,&restarted));
        restarted.kind="cloudflare".into();
        assert!(!replacement_matches(&sup,&restarted));
    }
    #[test]
    fn manual_kill_disposable_child_helper() {
        if std::env::var("SA_TRAY_KILL_TEST_CHILD").as_deref()==Ok("1") {
            std::thread::sleep(Duration::from_secs(15));
        }
    }
    #[tokio::test]
    async fn manual_kill_terminates_only_a_disposable_child_created_by_this_test() {
        use std::process::{Command, Stdio};
        // Never target an ambient Core, Guardian, tunnel, user app, or runner.
        let executable=std::env::current_exe().expect("current test executable");
        let mut child=Command::new(executable)
            .arg("--exact")
            .arg("shutdown_manager::tests::manual_kill_disposable_child_helper")
            .env("SA_TRAY_KILL_TEST_CHILD","1")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().expect("spawn disposable isolated test child");
        let pid=child.id();
        let mut info=None;
            for _ in 0..30 {
                let mut system=System::new();
                system.refresh_processes();
                if let Some(process)=system.process(Pid::from_u32(pid)) {
                    if child.try_wait().expect("poll disposable child").is_none() {
                        info=Some((
                            process.name().to_string(),
                            process.start_time(),
                            process.exe().map(|path|path.to_string_lossy().into_owned()),
                        ));
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let (name,birth,path)=info.expect("disposable helper still alive");
            assert!(manual_process_allowed("managed",pid,&name));
            let mut owner=Item::new(format!("disposable:{pid}"),
                "Isolated test helper","managed","active",
                "Disposable child owned by the running native test only",
                false,false,None,None,Some(pid));
            owner.manual_kill_selectable=true;
            owner.process_name=Some(name);
            owner.process_started_at=Some(birth);
            owner.process_path=path;
            // Reap the specifically spawned child in parallel so Unix does not
            // retain its zombie PID while the native kill verifier polls.
            let reaper=std::thread::spawn(move||child.wait());
            manual_kill_one(&owner).await.expect("native OS kill and exit verification");
            let status=reaper.join().expect("join disposable child reaper")
                .expect("reap disposable child");
            assert!(!status.success(),"disposable child exited normally, not by OS kill");
    }
    #[test]
    fn manual_candidates_reject_os_unpinned_or_protected_processes() {
        let mut item=item("managed:guardian",false);
        item.manual_kill_selectable=true;item.process_name=Some("bun.exe".into());
        item.process_started_at=None;
        let p=preview(vec![item.clone()],false);
        assert!(manual_candidates(&p,&[item.id.clone()]).is_err());
        item.process_started_at=Some(1_800_000_000);
        item.process_name=Some("svchost.exe".into());
        let p=preview(vec![item.clone()],false);
        assert!(manual_candidates(&p,&[item.id.clone()]).is_err());
    }
    #[test]
    fn pid_or_port_change_invalidates_authorization() {
        let before=item("mcp:8857:123",true);
        let mut after=before.clone();
        after.pid=Some(999);
        assert!(!same_owner(&before,&after));
        after=before.clone();after.selectable=false;
        assert!(!same_owner(&before,&after));
    }
}
