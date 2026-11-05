//! Native Tray -> authenticated selected local Core -> strict service manager.
//! The WebView can choose ONLY named services and allowlisted operation fields.
//! This module does not execute shells, open arbitrary URLs, or expose tokens.
use serde_json::Value;

const SERVICES: &[&str] = &[
    "all", "core", "mcp", "transport", "channel_host", "muse",
    "telegram", "vision", "guardian", "daemon", "tray",
    "process_supervisor",
];
const ACTIONS: &[&str] = &[
    "inventory", "status", "health", "doctor", "dashboard",
    "logs", "profile", "watchdog", "plan", "configure", "reconcile",
    "start", "stop", "restart", "upgrade", "rollback", "drain", "reload", "recycle",
];
const MUTATIONS: &[&str] = &[
    "configure", "reconcile", "start", "stop", "restart", "upgrade",
    "rollback", "drain", "reload", "recycle",
];
const TARGETS: &[&str] = &[
    "tray", "transport", "channel_host", "vision", "guardian", "daemon",
];
const FIELDS: &[&str] = &[
    "action", "service", "port", "targetAction", "confirm",
    "operationId", "expectedBuildDigest", "expectedOwnerPid",
    "expectedInstanceId",
    "noPublicIngress", "corePort", "channelMode", "wsPort",
    "expectedSupervisorPid", "noCoreShutdown", "expectedWorkerPid",
    "expectedRunning", "noActiveJobs", "expectedProcessIdentity",
    "expectedLegacyCommandDigest", "clientMode", "expectedReleaseRevision",
    "expectedCurrentDigest", "revision", "autoRecover", "startOnBoot",
    "failureThreshold", "maxRestartsPerHour", "intervalSeconds",
    "reviewed", "limit",
];
pub fn validate(input: Value) -> Result<Value,String> {
    let value=input.as_object().ok_or("Lifecycle command must be an object")?;
    if value.len()>28 || value.keys().any(|key| !FIELDS.contains(&key.as_str())) {
        return Err("Unexpected lifecycle field".into());
    }
    let action=value.get("action").and_then(Value::as_str).ok_or("Action is required")?;
    if !ACTIONS.contains(&action){return Err("Unsupported lifecycle action".into());}
    let service=value.get("service").and_then(Value::as_str).unwrap_or("all");
    if !SERVICES.contains(&service){return Err("Service is not allowlisted".into());}
    if MUTATIONS.contains(&action) {
        let core_recycle=service=="core" && action=="recycle";
        if (!TARGETS.contains(&service) && !core_recycle) ||
            value.get("confirm")!=Some(&Value::Bool(true)) {
            return Err("Native lifecycle mutation requires exact service and confirmation".into());
        }
        if action!="configure" && action!="reconcile" &&
            !value.get("operationId").and_then(Value::as_str)
                .is_some_and(|id|id.len()>=8&&id.len()<=128) {
            return Err("Planned operation ID required".into());
        }
    }
    if action=="plan"{
        let operation=value.get("targetAction").and_then(Value::as_str).unwrap_or("");
        let core_recycle=service=="core" && operation=="recycle";
        if (!TARGETS.contains(&service) && !core_recycle) ||
            !["start","stop","restart","upgrade","rollback","recycle"].contains(&operation) ||
            (service=="core" && operation!="recycle") {
            return Err("Native lifecycle plan target is restricted".into());
        }
    }
    if action=="watchdog"&&value.get("confirm")==Some(&Value::Bool(true)){
        return Err("Native Tray can inspect watchdog but cannot run recovery".into());
    }
    if let Some(port)=value.get("port"){
        if !port.as_u64().is_some_and(|x|(1024..=65535).contains(&x)){
            return Err("Invalid lifecycle port".into());
        }
    }
    if let Some(limit)=value.get("limit"){
        if !limit.as_u64().is_some_and(|x|(1..=200).contains(&x)){
            return Err("Invalid lifecycle history limit".into());
        }
    }
    if let Some(id)=value.get("operationId"){
        if !id.as_str().is_some_and(|s|s.len()<=128 &&
            s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')) {
            return Err("Malformed lifecycle operation ID".into());
        }
    }
    Ok(input)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_exact_allowlisted_native_lifecycle_requests(){
        assert!(validate(json!({"action":"dashboard"})).is_ok());
        assert!(validate(json!({"action":"profile","service":"tray"})).is_ok());
        assert!(validate(json!({"action":"plan","service":"tray","targetAction":"upgrade"})).is_ok());
        assert!(validate(json!({"action":"plan","service":"core","port":7888,
            "targetAction":"recycle"})).is_ok());
        assert!(validate(json!({"action":"plan","service":"core","port":7888,
            "targetAction":"restart"})).is_err());
        assert!(validate(json!({"action":"configure","service":"tray","confirm":true,
            "revision":"default","autoRecover":false})).is_ok());
        for bad in [
            json!({"action":"stop","service":"mcp","confirm":true,"operationId":"abcdefghijkl"}),
            json!({"action":"stop","service":"tray","confirm":false,"operationId":"abcdefghijkl"}),
            json!({"action":"watchdog","confirm":true}),
            json!({"action":"plan","service":"rest_tunnel","targetAction":"stop"}),
            json!({"action":"start","service":"tray","confirm":true}),
            json!({"action":"logs","url":"https://evil.example"}),
            json!({"action":"status","port":0}),
            json!({"action":"status","service":"invalid"}),
            json!({"action":"status","host":"127.0.0.1"}),
        ] {assert!(validate(bad).is_err());}
    }
}
