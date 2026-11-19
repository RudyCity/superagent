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
    assert!(consume(&second, id, nonce, "security:mcp", true).unwrap().is_none());
    assert!(consume(&first, id, nonce, "security:mcp", true).unwrap().is_none());
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
        "security:mcp", true).unwrap().is_none());
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
        "security:mcp", true).unwrap().unwrap();
    tray_notification_center::resolve(&dir, id).unwrap();
    publish(&dir, id);
    tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
    assert!(!complete(&dir, &ticket).unwrap());
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:mcp", true).unwrap().unwrap();
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
        "security:mcp", true).unwrap().unwrap();
    tray_notification_center::perform(&dir, "read", Some(id)).unwrap();
    tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
    assert!(!complete(&dir, &ticket).unwrap());
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:mcp", true).unwrap().unwrap();
    tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
    assert!(!complete(&dir, &ticket).unwrap());
    let issued = issue(&dir, id).unwrap();
    let mut ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:mcp", true).unwrap().unwrap();
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
    assert!(consume(&dir, id, "../../private", "security:mcp", true).unwrap().is_none());
    let issued = issue(&dir, id).unwrap();
    std::fs::write(dir.join("tray-notifications.json"), "invalid").unwrap();
    let error = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:mcp", true).unwrap_err();
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

#[test]
fn lifecycle_and_snooze_transitions_invalidate_older_read_receipts() {
    let dir = isolated();
    let id = "incident_lifecycle";
    publish(&dir, id);
    for action in ["in-progress", "pause-work", "snooze-15m", "unsnooze"] {
        tray_notification_center::perform(&dir, "unread", Some(id)).unwrap();
        let issued = issue(&dir, id).unwrap();
        let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
            "security", true).unwrap().unwrap();
        let snapshot = tray_notification_center::perform(&dir, action, Some(id)).unwrap();
        assert_eq!(snapshot["history"][0]["action"], action);
        assert!(!complete(&dir, &ticket).unwrap(), "{action} must invalidate the older receipt");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn verified_expiry_invalidates_receipts_and_cannot_be_reopened_by_the_webview() {
    let dir = isolated();
    let id = "mcp-pending:connections:req_verified_expiry";
    publish(&dir, id);
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security:mcp", true).unwrap().unwrap();
    assert!(tray_notification_center::expire_verified(&dir, id).unwrap());
    let snapshot = tray_notification_center::perform(&dir, "list", None).unwrap();
    assert_eq!(snapshot["items"][0]["actionStatus"], "expired");
    assert_eq!(snapshot["history"][0]["action"], "expired_verified");
    assert!(!complete(&dir, &ticket).unwrap());
    assert!(issue(&dir, id).is_err());
    assert!(tray_notification_center::perform(&dir, "reopen", Some(id)).is_err());
    publish(&dir, id);
    assert!(issue(&dir, id).is_ok());
    assert!(!complete(&dir, &ticket).unwrap());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_durable_digest_does_not_replace_an_incident_but_native_open_is_audited() {
    let dir = isolated();
    let id = "incident_digest";
    publish(&dir, id);
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security", true).unwrap().unwrap();
    let mut preferences = tray_notification_center::NotificationPreferences::default();
    preferences.digest_enabled = true;
    preferences.digest_next_at = Some(0);
    tray_notification_center::save_preferences(&dir, preferences).unwrap();
    assert!(tray_notification_center::take_daily_digest(&dir).unwrap().is_some());
    assert!(tray_notification_center::take_daily_digest(&dir).unwrap().is_none());
    assert!(complete(&dir, &ticket).unwrap());
    let snapshot = tray_notification_center::perform(&dir, "list", None).unwrap();
    assert_eq!(snapshot["history"][0]["action"], "read");
    assert_eq!(snapshot["history"][0]["itemId"], id);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_incident_device_identity_change_invalidates_its_ticket() {
    let dir = isolated();
    let id = "incident_device";
    tray_notification_center::publish_for_device(&dir, "security", "critical", id,
        "Pending", "Review", "device_a").unwrap();
    let issued = issue(&dir, id).unwrap();
    let ledger_file = dir.join("tray-notifications.json");
    let mut ledger: Value = serde_json::from_slice(&std::fs::read(&ledger_file).unwrap()).unwrap();
    ledger["items"][0]["deviceId"] = json!("device_b");
    std::fs::write(&ledger_file, serde_json::to_vec(&ledger).unwrap()).unwrap();
    assert!(consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security", true).unwrap().is_none());
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn scheduled_digest_and_snapshot_both_count_a_recently_reopened_old_incident() {
    let dir = isolated();
    let id = "incident_reopened_digest";
    publish(&dir, id);
    tray_notification_center::resolve(&dir, id).unwrap();
    let ledger_file = dir.join("tray-notifications.json");
    let mut ledger: Value = serde_json::from_slice(&std::fs::read(&ledger_file).unwrap()).unwrap();
    ledger["items"][0]["createdAt"] = json!(1);
    ledger["items"][0]["resolvedAt"] = json!(1);
    ledger["items"][0]["lastSeenAt"] = Value::Null;
    std::fs::write(&ledger_file, serde_json::to_vec(&ledger).unwrap()).unwrap();
    publish(&dir, id);
    let snapshot = tray_notification_center::perform(&dir, "list", None).unwrap();
    assert_eq!(snapshot["items"][0]["createdAt"], 1);
    assert_eq!(snapshot["items"][0]["occurrences"], 2);
    assert_eq!(snapshot["digest"]["last24hAction"], 1);
    let mut preferences = tray_notification_center::NotificationPreferences::default();
    preferences.digest_enabled = true;
    preferences.digest_next_at = Some(0);
    tray_notification_center::save_preferences(&dir, preferences).unwrap();
    assert_eq!(tray_notification_center::take_daily_digest(&dir).unwrap(), Some((1, 0)));
    assert_eq!(tray_notification_center::take_daily_digest(&dir).unwrap(), None);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn denied_or_bulk_archive_never_hides_an_unresolved_action_or_invalidates_its_receipt() {
    let dir = isolated();
    let id = "incident_archive_guard";
    publish(&dir, id);
    let issued = issue(&dir, id).unwrap();
    assert!(tray_notification_center::perform(&dir, "archive", Some(id)).is_err());
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security", true).unwrap().unwrap();
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    assert!(complete(&dir, &ticket).unwrap());
    let issued = issue(&dir, id).unwrap();
    let ticket = consume(&dir, id, issued["nonce"].as_str().unwrap(),
        "security", true).unwrap().unwrap();
    let snapshot = tray_notification_center::perform(&dir, "archive-read", None).unwrap();
    assert!(snapshot["items"][0]["archivedAt"].is_null());
    assert_eq!(snapshot["actionCount"], 1);
    assert!(complete(&dir, &ticket).unwrap());
    std::fs::remove_dir_all(dir).unwrap();
}
