//! Native-only, owner-scoped shutdown review and execution.
//! This module never signals a PID by name, force-kills, or adopts an OS process.
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
use sysinfo::{Pid, System};
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
}
impl Item {
    fn new(id: String, label: &str, kind: &str, state: &str, detail: &str,
        owner_verified: bool, selectable: bool, blocker: Option<String>,
        port: Option<u16>, pid: Option<u32>) -> Self {
        Self {id, label:label.into(), kind:kind.into(), state:state.into(),
            detail:detail.into(), owner_verified, selectable, blocker,
            port, pid, active_sessions:None}
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
fn redacted(error: &str) -> String {
    if error.starts_with("SHUTDOWN_") || error.starts_with("EXIT_") {
        return error.chars().take(180).collect();
    }
    "SHUTDOWN_OWNER_REJECTED: status uncertain, inspect Runtime Detection before retry".into()
}

async fn inspect() -> Result<Preview, String> {
    let dir = config_dir()?;
    let runtime = serde_json::to_value(runtime_detection::detect_runtime(&dir).await?)
        .map_err(|_| "SHUTDOWN_RUNTIME_SNAPSHOT_UNAVAILABLE")?;
    let remote = remote_service_detection::scan(&dir).await;
    let mut items = Vec::new();
    let mut warning = None;
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
                items.push(item);
            }
            "cloudflare" | "muse-watch" => {
                items.push(Item::new(
                    format!("observed:{}:{}",remote_owner.kind,remote_owner.pid.unwrap_or(0)),
                    if remote_owner.kind=="cloudflare" {"Cloudflare tunnel"} else {"Muse watcher"},
                    remote_owner.kind,remote_owner.state,
                    "Observed process; no universal verified stop protocol is available",
                    false,false,Some("Stop through the exact owner-specific control first".into()),
                    remote_owner.port,remote_owner.pid));
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
            let state=s["state"].as_str().unwrap_or("unknown");
            let port=port_of(&s["port"]);
            let pid=pid_of(&s["ownerPid"]);
            let mut eligible=running(state)&&verified_action(s)&&port.is_some();
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

    let cores=runtime["cores"].as_array().ok_or("SHUTDOWN_CORE_INVENTORY_MISSING")?;
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
        let eligible=verified && pid.is_some() && port.is_some();
        items.push(Item::new(format!("core:{}:{}",port.unwrap_or(0),pid.unwrap_or(0)),
            if selected {"Selected Core API"} else {"Other Core API"},"core",state,
            if supervised {"A supervised Core has no supported full-stop contract"}
            else {"Authenticated direct Core; stopped last after dependent services"},
            eligible,eligible,
            if !running(state) {None} else if eligible {None}
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

fn stop_plan_request(service: &str, plan: &Value, port: u16) -> Result<Value,String> {
    if !MANAGED_ORDER.contains(&service) || plan["service"]!=service ||
        plan["action"]!="stop" || port_of(&plan["port"])!=Some(port) ||
        plan["allowed"]==false {
        return Err("SHUTDOWN_PLAN_IDENTITY_MISMATCH".into());
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
            let command=stop_plan_request(service,&plan,port)?;
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
async fn run_shutdown(app:AppHandle, chosen:Vec<Item>, exit_after:bool, mut progress:Progress) {
    for (index,item) in chosen.iter().enumerate() {
        progress.steps[index].status="stopping".into();
        progress.steps[index].message="Revalidating exact owner and requesting graceful stop".into();
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
) -> Result<Value,String> {
    if window.label()!="main" || !window.is_visible().unwrap_or(false) ||
        window.is_minimized().unwrap_or(true) {
        return Err("SHUTDOWN_NATIVE_WINDOW_REQUIRED".into());
    }
    match action.as_str() {
        "status" => {
            if preview_id.is_some()||selected.is_some()||exit_after.is_some() {
                return Err("SHUTDOWN_UNEXPECTED_ARGUMENT".into());
            }
            let state=locked()?;
            Ok(json!({"busy":state.busy,"progress":state.progress}))
        }
        "preview" => {
            if preview_id.is_some()||selected.is_some()||exit_after.is_some() {
                return Err("SHUTDOWN_UNEXPECTED_ARGUMENT".into());
            }
            if locked()?.busy{return Err("SHUTDOWN_ALREADY_RUNNING".into());}
            let preview=inspect().await?;
            locked()?.preview=Some(preview.clone());
            Ok(json!({"preview":preview}))
        }
        "execute" => {
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
            let summary=format!(
                "Stop {} verified service(s){}?\n\n\
                Active jobs and sessions are never force-killed. Services that change owner, \
                become busy or refuse graceful shutdown will remain running. \
                Results are shown in Shutdown Manager.",
                chosen.len(),if exit {" and exit SuperAgent Tray"}else {""}
            );
            let approved=tauri::async_runtime::spawn_blocking(move||{
                use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};
                dialog.dialog().message(summary).buttons(
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
            "token":"must-never-leak","url":"https://evil.invalid"}),8095).unwrap();
        assert_eq!(request["confirm"],true);
        assert_eq!(request["expectedOwnerPid"],123);
        assert!(request.get("token").is_none());
        assert!(request.get("url").is_none());
        assert!(stop_plan_request("vision",&json!({"service":"vision","action":"stop",
            "port":8096,"operationId":"a-valid-operation"}),8095).is_err());
        assert!(stop_plan_request("core",&json!({"service":"core",
            "action":"stop","port":8095,"operationId":"a-valid-operation"}),8095).is_err());
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
