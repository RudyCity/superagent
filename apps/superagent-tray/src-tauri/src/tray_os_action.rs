//! Trusted, process-local OS toast click mapping. No public URL or caller
//! supplied title/body is accepted as a route, grant or incident identity.
use serde_json::{json,Value};
use std::{collections::HashMap,path::Path,sync::{Mutex,OnceLock},time::{Duration,Instant}};
use uuid::Uuid;
use crate::tray_notification_center;
const TTL:Duration=Duration::from_secs(120);
const CAPACITY:usize=64;
struct Ticket {
    incident_id:String,
    target:tray_notification_center::NavigationTarget,
    issued:Instant,
}
static TICKETS:OnceLock<Mutex<HashMap<i32,Ticket>>>=OnceLock::new();
static ACTIVATION:OnceLock<Mutex<Option<Ticket>>>=OnceLock::new();
#[cfg(test)]
static TEST_ACTIVATION_LOCK: Mutex<()> = Mutex::new(());
fn tickets()->&'static Mutex<HashMap<i32,Ticket>>{
    TICKETS.get_or_init(||Mutex::new(HashMap::new()))
}
fn activation()->&'static Mutex<Option<Ticket>>{
    ACTIVATION.get_or_init(||Mutex::new(None))
}
/// Call only from the native incident emitter after publishing its inbox row.
pub fn issue(dir:&Path,incident_id:&str)->Result<i32,String>{
    if incident_id.is_empty()||incident_id.len()>180{
        return Err("OS_NOTIFICATION_ID_INVALID".into());
    }
    let target=tray_notification_center::navigation_target(dir,incident_id)?
        .ok_or("OS_NOTIFICATION_NOT_IN_INBOX")?;
    let mut owned=tickets().lock().map_err(|_|"OS_NOTIFICATION_TICKETS_UNAVAILABLE")?;
    owned.retain(|_,v|v.issued.elapsed()<TTL);
    if owned.len()>=CAPACITY{return Err("OS_NOTIFICATION_CAPACITY_REACHED".into())}
    for _ in 0..20 {
        let seed=Uuid::new_v4();
        let bytes=seed.as_bytes();
        let candidate=i32::from_be_bytes([bytes[0],bytes[1],bytes[2],bytes[3]])
            & 0x7fff_ffff;
        if candidate==0||owned.contains_key(&candidate){continue}
        owned.insert(candidate,Ticket{incident_id:incident_id.to_owned(),target,issued:Instant::now()});
        return Ok(candidate);
    }
    Err("OS_NOTIFICATION_NONCE_UNAVAILABLE".into())
}
pub fn cancel(id:i32){
    if let Ok(mut owned)=tickets().lock(){owned.remove(&id);}
}
/// User clicked the system-provided notification ID, never the toast text.
pub fn activate(dir:&Path,id:i32)->bool{
    let ticket=match tickets().lock(){
        Ok(mut x)=>x.remove(&id),
        Err(_)=>return false,
    };
    let Some(ticket)=ticket else{return false};
    if ticket.issued.elapsed()>=TTL{return false}
    if tray_notification_center::navigation_target(dir,&ticket.incident_id)
        .ok().flatten().as_ref()!=Some(&ticket.target){return false}
    if let Ok(mut slot)=activation().lock(){
        // Ledger lookup or slot contention cannot extend the original lease.
        if ticket.issued.elapsed()>=TTL{return false}
        slot.replace(ticket);
        return true
    }
    false
}
/// WebView may only consume an OS-click already verified in this native process.
/// A stale/expired event has no destination and cannot mark notifications read.
pub fn take(dir:&Path)->Value{
    let ticket=match activation().lock(){
        Ok(mut x)=>x.take(),
        Err(_)=>None,
    };
    let Some(ticket)=ticket else{return json!({"status":"NONE"})};
    if ticket.issued.elapsed()>=TTL{return json!({"status":"EXPIRED"})}
    if tray_notification_center::navigation_target(dir,&ticket.incident_id)
        .ok().flatten().as_ref()!=Some(&ticket.target){return json!({"status":"EXPIRED"})}
    if ticket.issued.elapsed()>=TTL{return json!({"status":"EXPIRED"})}
    json!({"status":"READY","incidentId":ticket.incident_id})
}
#[cfg(test)]
#[path = "../../../../tests/tray_os_activation_security.rs"]
mod security_tests;
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn forged_replayed_and_resolved_os_toasts_cannot_activate(){
        let _guard=TEST_ACTIVATION_LOCK.lock().unwrap();
        let dir=std::env::temp_dir().join(format!("sa-os-click-{}",Uuid::new_v4()));
        tray_notification_center::publish(&dir,"security","critical",
            "mcp-pending:connections:req_os_1","Access needed","Review").unwrap();
        let id=issue(&dir,"mcp-pending:connections:req_os_1").unwrap();
        assert!(!activate(&dir,id.wrapping_add(1)));
        assert!(activate(&dir,id));
        assert!(!activate(&dir,id));
        assert_eq!(take(&dir)["status"],"READY");
        assert_eq!(take(&dir)["status"],"NONE");
        let id=issue(&dir,"mcp-pending:connections:req_os_1").unwrap();
        tray_notification_center::resolve(&dir,"mcp-pending:connections:req_os_1").unwrap();
        assert!(!activate(&dir,id));
        assert!(issue(&dir,"mcp-pending:connections:req_os_1").is_err());
        let _=std::fs::remove_dir_all(dir);
    }
}
