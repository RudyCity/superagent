//! Narrow, native-owned notification navigation tickets. Never a general
//! Desktop UI screenshot, input, privilege-grant or MCP project capability.
//! Tokens are process-local, unpredictable, one-use and expire after 15 s.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::{Mutex, OnceLock},
    time::{Duration, Instant}};
use uuid::Uuid;
use crate::tray_notification_center;

const TTL: Duration = Duration::from_secs(15);
const MAX_TICKETS: usize = 64;
#[derive(Debug, Clone)]
pub struct Ticket {
    pub incident_id: String,
    pub route: &'static str,
    pub pending: Option<(String, &'static str)>,
    issued: Instant,
}
static TICKETS: OnceLock<Mutex<HashMap<String, Ticket>>> = OnceLock::new();
fn tickets() -> &'static Mutex<HashMap<String, Ticket>> {
    TICKETS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn safe_id(id: &str, max: usize) -> bool {
    !id.is_empty() && id.len() <= max && id.is_ascii() &&
    id.bytes().all(|b| b.is_ascii_alphanumeric() ||
        matches!(b, b'-' | b'_' | b':' | b'.'))
}
// Legacy daemon incident keys include one of two fixed English labels. They
// must never grant arbitrary spaces, slashes, URLs or user-selected labels.
fn safe_event_id(id:&str)->bool {
    if safe_id(id,180) {return true;}
    for suffix in [":Scheduled run needs attention",
        ":Scheduled notification delivery failed"] {
        if let Some(prefix)=id.strip_suffix(suffix) {
            return id.len()<=180 && prefix.strip_prefix("daemon-run:")
                .is_some_and(|run|safe_id(run,160));
        }
    }
    false
}
fn hash_id(id: &str) -> String { format!("{:x}", Sha256::digest(id.as_bytes())) }

/// All routes are constants. Titles, bodies, caller-provided paths and URLs
/// never become navigation destinations.
fn fixed_route(source: &str, id: &str) -> Option<(&'static str, Option<(String, &'static str)>)> {
    if !safe_event_id(id) { return None; }
    if source == "security" && id.starts_with("mcp-pending:") {
        let rest = &id["mcp-pending:".len()..];
        let (tab, request) = if let Some(rest) = rest.strip_prefix("connections:") {
            ("connections", rest)
        } else if let Some(rest) = rest.strip_prefix("mcp:") {
            ("mcp", rest)
        } else { ("legacy", rest) };
        if !safe_id(request, 150) { return None; }
        let route=match tab {
            "connections" => "security:connections",
            "mcp" => "security:mcp",
            _ => "security",
        };
        return Some((route,Some((request.to_owned(),tab))));
    }
    let route = match (source, id) {
        ("runtime", "health:muse") => "runtime:muse",
        ("runtime", "health:telegram") => "settings:muse",
        ("runtime", "health:channel-hosts") => "runtime:hosts",
        ("delegate", "health:delegate-listener") => "delegate:diagnostics",
        ("core", _) => "runtime:core",
        ("security", _) => "security",
        ("mcp", _) => "runtime:mcp",
        ("tunnel", _) => "runtime:cloudflare",
        ("delegate", _) => "delegate:connection",
        ("runtime", _) => "runtime:core",
        ("desktop-live", _) => "desktop-live",
        ("terminal", _) => "terminal",
        ("lan-devices", _) => "lan-devices:devices",
        ("reminder", id) if id.starts_with("reminder:") => "history",
        ("reminder", _) => "jobs",
        ("jobs", id) if id.starts_with("daemon-run:") &&
            (id.ends_with(":Scheduled run needs attention") ||
             id.ends_with(":Scheduled notification delivery failed")) => "history",
        ("jobs", _) => "jobs",
        ("updates", _) => "updates",
        ("shutdown", _) | ("overview", _) => "overview",
        ("settings", _) => "settings:general",
        ("muse-files", _) => "muse-files",
        ("logs", _) => "logs",
        _ => return None,
    };
    Some((route, None))
}
pub fn issue(dir: &Path, incident_id: &str) -> Result<Value,String> {
    let source = tray_notification_center::navigation_source(dir, incident_id)?
        .ok_or("NAVIGATION_TARGET_EXPIRED")?;
    let (route,pending) = fixed_route(&source,incident_id)
        .ok_or("NAVIGATION_TARGET_UNSUPPORTED")?;
    let nonce = Uuid::new_v4().to_string();
    let mut map = tickets().lock().map_err(|_| "NAVIGATION_TICKETS_UNAVAILABLE")?;
    map.retain(|_,entry| entry.issued.elapsed() < TTL);
    if map.len() >= MAX_TICKETS { return Err("NAVIGATION_CAPACITY_REACHED".into()); }
    map.insert(nonce.clone(), Ticket {
        incident_id:incident_id.to_owned(), route, pending, issued:Instant::now(),
    });
    Ok(json!({"status":"ISSUED","nonce":nonce,"route":route,
        "incidentHash":hash_id(incident_id),"expiresInMs":TTL.as_millis(),
        "nativeVersion":env!("CARGO_PKG_VERSION")}))
}
pub fn consume(dir:&Path, incident_id:&str, nonce:&str, route:&str,
    target_found:bool) -> Result<Option<Ticket>,String> {
    // Remove before validation: no duplicate click can reuse a ticket.
    if !safe_id(nonce, 80) { return Ok(None); }
    let entry=tickets().lock().map_err(|_| "NAVIGATION_TICKETS_UNAVAILABLE")?
        .remove(nonce);
    let Some(entry)=entry else {return Ok(None)};
    if entry.issued.elapsed()>=TTL || entry.incident_id!=incident_id ||
        entry.route!=route || !target_found {return Ok(None)}
    let source=tray_notification_center::navigation_source(dir,incident_id)?;
    let Some(source)=source else {return Ok(None)};
    if fixed_route(&source,incident_id).map(|(r,_)|r)!=Some(entry.route) {
        return Ok(None);
    }
    Ok(Some(entry))
}
pub fn receipt(incident_id:&str,route:&str,status:&str)->Value{
    let target_tab = route.split_once(':').map(|(_, tab)| tab);
    json!({
        "status": status,
        "route": route,
        "targetTab": target_tab,
        "targetFound": status == "DELIVERED",
        "incidentHash": hash_id(incident_id),
        "nativeVersion": env!("CARGO_PKG_VERSION"),
        "webviewDigest": env!("SUPERAGENT_TRAY_UI_DIGEST"),
        "sourceBuildSha": option_env!("SUPERAGENT_TRAY_SOURCE_REVISION"),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_routes_ignore_titles_and_reject_path_and_url_shape() {
        assert_eq!(fixed_route("security","mcp-pending:connections:req_012")
            .unwrap().0,"security:connections");
        assert_eq!(fixed_route("security","mcp-pending:req_old")
            .unwrap().0,"security");
        assert_eq!(fixed_route("core","health:core").unwrap().0,"runtime:core");
        assert_eq!(fixed_route("jobs","daemon-run:run_42:Scheduled run needs attention")
            .unwrap().0,"history");
        assert!(fixed_route("jobs","daemon-run:run_42:fake arbitrary label").is_none());
        assert!(fixed_route("security","mcp-pending:connections:../abc").is_none());
        assert!(fixed_route("security","mcp-pending:connections:http://other").is_none());
        assert!(fixed_route("core","../../private").is_none());
    }
    #[test]
    fn native_ticket_is_bound_to_incident_route_and_single_use() {
        let dir=std::env::temp_dir().join(format!("sa-nav-{}",Uuid::new_v4()));
        tray_notification_center::publish(&dir,"security","critical",
            "mcp-pending:connections:req_valid","Pending","Review").unwrap();
        let issued=issue(&dir,"mcp-pending:connections:req_valid").unwrap();
        let nonce=issued["nonce"].as_str().unwrap();
        assert!(consume(&dir,"mcp-pending:connections:req_other",nonce,
            "security:connections",true).unwrap().is_none());
        assert!(consume(&dir,"mcp-pending:connections:req_valid",nonce,
            "security:connections",true).unwrap().is_none());
        assert!(consume(&dir,"mcp-pending:connections:req_valid","../tampered",
            "security:connections",true).unwrap().is_none());
        let issued=issue(&dir,"mcp-pending:connections:req_valid").unwrap();
        let nonce=issued["nonce"].as_str().unwrap();
        assert!(consume(&dir,"mcp-pending:connections:req_valid",nonce,
            "security:mcp",true).unwrap().is_none());
        let issued=issue(&dir,"mcp-pending:connections:req_valid").unwrap();
        let nonce=issued["nonce"].as_str().unwrap();
        assert!(consume(&dir,"mcp-pending:connections:req_valid",nonce,
            "security:connections",false).unwrap().is_none());
        let issued=issue(&dir,"mcp-pending:connections:req_valid").unwrap();
        let nonce=issued["nonce"].as_str().unwrap();
        assert!(consume(&dir,"mcp-pending:connections:req_valid",nonce,
            "security:connections",true).unwrap().is_some());
        assert!(consume(&dir,"mcp-pending:connections:req_valid",nonce,
            "security:connections",true).unwrap().is_none());
        let delivered = receipt("mcp-pending:connections:req_valid", "security:connections", "DELIVERED");
        assert_eq!(delivered["targetFound"], Value::Bool(true));
        assert_eq!(delivered["targetTab"], Value::String("connections".into()));
        assert_eq!(delivered["webviewDigest"].as_str().map(str::len), Some(64));
        let not_delivered = receipt("mcp-pending:connections:req_valid", "security:connections", "NOT_DELIVERED");
        assert_eq!(not_delivered["targetFound"], Value::Bool(false));
        tray_notification_center::resolve(&dir,"mcp-pending:connections:req_valid").unwrap();
        assert!(issue(&dir,"mcp-pending:connections:req_valid").is_err());
        let _=std::fs::remove_dir_all(dir);
    }
}
