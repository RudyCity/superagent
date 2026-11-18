use super::*;

fn isolated() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("sa-os-security-{}", Uuid::new_v4()))
}

fn publish(dir: &Path, id: &str) {
    tray_notification_center::publish(dir, "core", "critical", id, "Core offline", "Review").unwrap();
}

#[test]
fn os_click_cannot_move_to_another_native_profile() {
    let _guard = TEST_ACTIVATION_LOCK.lock().unwrap();
    let first = isolated();
    let second = isolated();
    let incident = "health:core";
    publish(&first, incident);
    publish(&second, incident);
    let id = issue(&first, incident).unwrap();
    assert!(!activate(&second, id));
    assert!(!activate(&first, id));
    std::fs::remove_dir_all(first).unwrap();
    std::fs::remove_dir_all(second).unwrap();
}

#[test]
fn an_os_banner_from_an_old_occurrence_cannot_open_a_replacement() {
    let _guard = TEST_ACTIVATION_LOCK.lock().unwrap();
    let dir = isolated();
    let incident = "health:core";
    publish(&dir, incident);
    let id = issue(&dir, incident).unwrap();
    tray_notification_center::resolve(&dir, incident).unwrap();
    publish(&dir, incident);
    assert!(!activate(&dir, id));
    assert_eq!(tray_notification_center::perform(&dir, "list", None).unwrap()["unreadCount"], 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_expired_os_banner_cannot_activate() {
    let _guard = TEST_ACTIVATION_LOCK.lock().unwrap();
    let dir = isolated();
    publish(&dir, "health:core");
    let id = issue(&dir, "health:core").unwrap();
    tickets().lock().unwrap().get_mut(&id).unwrap().issued = Instant::now() - TTL;
    assert!(!activate(&dir, id));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn queued_os_activation_rechecks_revision_and_preserves_the_original_deadline() {
    let _guard = TEST_ACTIVATION_LOCK.lock().unwrap();
    let dir = isolated();
    let incident = "health:core";
    publish(&dir, incident);
    let id = issue(&dir, incident).unwrap();
    let issued = Instant::now() - TTL + Duration::from_secs(10);
    tickets().lock().unwrap().get_mut(&id).unwrap().issued = issued;
    assert!(activate(&dir, id));
    assert_eq!(activation().lock().unwrap().as_ref().unwrap().issued, issued);
    tray_notification_center::perform(&dir, "unread", Some(incident)).unwrap();
    assert_eq!(take(&dir)["status"], "EXPIRED");
    assert_eq!(take(&dir)["status"], "NONE");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn queued_os_activation_cannot_be_taken_by_another_profile() {
    let _guard = TEST_ACTIVATION_LOCK.lock().unwrap();
    let first = isolated();
    let second = isolated();
    publish(&first, "health:core");
    publish(&second, "health:core");
    let id = issue(&first, "health:core").unwrap();
    assert!(activate(&first, id));
    assert_eq!(take(&second)["status"], "EXPIRED");
    assert_eq!(take(&first)["status"], "NONE");
    std::fs::remove_dir_all(first).unwrap();
    std::fs::remove_dir_all(second).unwrap();
}

#[test]
fn activation_cannot_queue_after_its_deadline_while_waiting_for_native_state() {
    let _guard = TEST_ACTIVATION_LOCK.lock().unwrap();
    let dir = isolated();
    publish(&dir, "health:core");
    let id = issue(&dir, "health:core").unwrap();
    let expires_at = Instant::now() + Duration::from_millis(200);
    tickets().lock().unwrap().get_mut(&id).unwrap().issued = expires_at - TTL;
    let mut slot = activation().lock().unwrap();
    slot.take();
    let worker_dir = dir.clone();
    let worker = std::thread::spawn(move || activate(&worker_dir, id));
    // Wait for the actual ticket-consumption boundary, not a scheduling delay.
    while tickets().lock().unwrap().contains_key(&id) {
        assert!(Instant::now() < expires_at, "activation did not consume its ticket before expiry");
        std::thread::yield_now();
    }
    while Instant::now() < expires_at { std::thread::yield_now(); }
    drop(slot);
    assert!(!worker.join().unwrap());
    assert_eq!(take(&dir)["status"], "NONE");
    std::fs::remove_dir_all(dir).unwrap();
}
