use super::*;

fn publish(dir: &Path, id: &str) {
    tray_notification_center::publish(dir, "security", "critical", id, "Pending", "Review").unwrap();
}

fn isolated() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("sa-nav-security-{}", Uuid::new_v4()))
}

#[test]
fn ticket_cannot_move_to_another_native_profile_with_the_same_incident() {
    let first = isolated();
    let second = isolated();
    let id = "mcp-pending:connections:req_profile";
    publish(&first, id);
    publish(&second, id);
    let issued = issue(&first, id).unwrap();
    let nonce = issued["nonce"].as_str().unwrap();
    assert!(consume(&second, id, nonce, "security:connections", true).unwrap().is_none());
    assert!(consume(&first, id, nonce, "security:connections", true).unwrap().is_none());
    std::fs::remove_dir_all(first).unwrap();
    std::fs::remove_dir_all(second).unwrap();
}

#[test]
fn ticket_cannot_read_a_new_occurrence_of_the_same_incident() {
    let dir = isolated();
    let id = "mcp-pending:connections:req_reopened";
    publish(&dir, id);
    let issued = issue(&dir, id).unwrap();
    tray_notification_center::resolve(&dir, id).unwrap();
    publish(&dir, id);
    assert!(consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap().is_none());
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn completion_rechecks_revision_after_a_backend_await() {
    let dir = isolated();
    let id = "mcp-pending:connections:req_await";
    publish(&dir, id);
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap().unwrap();
    tray_notification_center::resolve(&dir, id).unwrap();
    tray_notification_center::perform(&dir, "reopen", Some(id)).unwrap();
    tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
    assert!(!complete(&dir, &ticket).unwrap());
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap().unwrap();
    assert!(complete(&dir, &ticket).unwrap());
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn explicit_mark_unread_and_expiry_cannot_be_overridden_by_late_completion() {
    let dir = isolated();
    let id = "mcp-pending:connections:req_unread";
    publish(&dir, id);
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap().unwrap();
    tray_notification_center::perform(&dir, "read", Some(id)).unwrap();
    tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
    assert!(!complete(&dir, &ticket).unwrap());
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap().unwrap();
    tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
    assert!(!complete(&dir, &ticket).unwrap());
    let issued = issue(&dir, id).unwrap();
    let mut ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap().unwrap();
    ticket.issued = Instant::now() - TTL;
    assert!(!complete(&dir, &ticket).unwrap());
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn malformed_nonce_and_corrupt_registry_do_not_read_or_disclose_the_profile() {
    let dir = isolated();
    let id = "mcp-pending:connections:req_corrupt";
    publish(&dir, id);
    assert!(consume(&dir, id, "../../private", "security:connections", true).unwrap().is_none());
    let issued = issue(&dir, id).unwrap();
    std::fs::write(dir.join("tray-notifications.json"), "invalid").unwrap();
    let error = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:connections", true).unwrap_err();
    assert!(!error.contains(dir.to_str().unwrap()));
    assert!(error.contains("invalid"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn reading_changes_the_navigation_revision_without_changing_occurrence_time() {
    let dir = isolated();
    publish(&dir, "incident_revision");
    let before = tray_notification_center::perform(&dir, "list", None).unwrap();
    let read = tray_notification_center::perform(&dir, "read", Some("incident_revision")).unwrap();
    assert_eq!(read["items"][0]["lastSeenAt"], before["items"][0]["lastSeenAt"]);
    assert_eq!(read["items"][0]["createdAt"], before["items"][0]["createdAt"]);
    assert_eq!(read["items"][0]["occurrences"], before["items"][0]["occurrences"]);
    assert_ne!(read["items"][0]["navigationRevision"], before["items"][0]["navigationRevision"]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn denial_receipts_do_not_echo_untrusted_routes_or_incident_paths() {
    let denied = receipt("C:/private/secret.txt", None, "NOT_DELIVERED");
    assert_eq!(denied["route"], Value::Null);
    assert_eq!(denied["incidentHash"].as_str().unwrap().len(), 64);
    assert!(!denied.to_string().contains("private"));
}

#[test]
fn legacy_ledger_gets_an_independent_revision_when_first_changed() {
    let dir = isolated();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("tray-notifications.json"), r#"{"version":1,"items":[{
        "id":"legacy_revision","source":"core","severity":"warning",
        "title":"Core","body":"Review","createdAt":1,"readAt":null,
        "archivedAt":null,"lastSeenAt":42}]}"#).unwrap();
    let target = tray_notification_center::navigation_target(&dir, "legacy_revision").unwrap().unwrap();
    let read = tray_notification_center::perform(&dir, "read", Some("legacy_revision")).unwrap();
    assert_eq!(read["items"][0]["lastSeenAt"], 42);
    assert!(Uuid::parse_str(read["items"][0]["navigationRevision"].as_str().unwrap()).is_ok());
    assert!(!tray_notification_center::mark_navigation_read(&dir, "legacy_revision", &target,
        Instant::now() + TTL).unwrap());
    std::fs::remove_dir_all(dir).unwrap();
}
