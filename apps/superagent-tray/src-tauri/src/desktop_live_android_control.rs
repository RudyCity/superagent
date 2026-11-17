//! Host-native Desktop Live controller gate for already paired Android clients.
//!
//! Viewer permission is never sufficient. A short-lived controller lease is
//! installed ONLY by the main Tray after an attended OS dialog and an exact
//! fingerprint/device check. The browser gets no token. Input/element actions
//! pass this native gate immediately before the authenticated Core call; the
//! Android client retains an independent per-command permission decision.
//! Nothing in this module starts a network listener or bypasses host policy.
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_CONTROL_SECONDS: u64 = 120;

#[derive(Clone)]
struct ControlLease {
    device_id: String,
    fingerprint: String,
    token: String,
    expires_at: Instant,
}

#[derive(Default)]
pub struct AndroidControllerGate {
    active: Option<ControlLease>,
}

fn valid_device_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) { c == b'-' }
        else { c.is_ascii_hexdigit() }
    })
}
fn valid_fingerprint(fp: &str) -> bool {
    fp.len() == 64 && fp.bytes().all(|b| b.is_ascii_hexdigit())
}

impl AndroidControllerGate {
    /// Caller must have already shown the attended native approval. Never call
    /// from a browser or from preview/display permission code.
    pub fn approve(&mut self, id: &str, fingerprint: &str, token: &str, now: Instant) -> Result<(), String> {
        self.active = None;
        if !valid_device_id(id) || !valid_fingerprint(fingerprint) ||
            token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("ANDROID_CONTROLLER_TARGET_INVALID".into());
        }
        self.active = Some(ControlLease {
            device_id: id.to_string(),
            fingerprint: fingerprint.to_ascii_lowercase(),
            token: token.to_ascii_lowercase(),
            expires_at: now + Duration::from_secs(MAX_CONTROL_SECONDS),
        });
        Ok(())
    }

    /// Reject stale/replaced devices, expired leases and empty viewer sessions.
    pub fn check(
        &mut self, id: &str, fingerprint: &str, connected: bool, now: Instant,
    ) -> Result<u64, String> {
        let Some(ref grant) = self.active else {
            return Err("ANDROID_CONTROLLER_NATIVE_APPROVAL_REQUIRED".into());
        };
        if !connected || !valid_device_id(id) || !valid_fingerprint(fingerprint) ||
            grant.device_id != id || grant.fingerprint != fingerprint.to_ascii_lowercase() {
            self.active = None;
            return Err("ANDROID_CONTROLLER_IDENTITY_CHANGED".into());
        }
        if now >= grant.expires_at {
            self.active = None;
            return Err("ANDROID_CONTROLLER_APPROVAL_EXPIRED".into());
        }
        Ok(grant.expires_at.duration_since(now).as_secs())
    }

    pub fn credential(
        &mut self, id: &str, fingerprint: &str, connected: bool, now: Instant,
    ) -> Result<String, String> {
        self.check(id, fingerprint, connected, now)?;
        self.active.as_ref().map(|grant| grant.token.clone())
            .ok_or_else(|| "ANDROID_CONTROLLER_NATIVE_APPROVAL_REQUIRED".to_string())
    }

    pub fn revoke(&mut self) { self.active = None; }

    pub fn revoke_device(&mut self, id: &str) {
        if self.active.as_ref().map(|g| g.device_id.as_str()) == Some(id) {
            self.revoke();
        }
    }
}
static GATE: OnceLock<Mutex<AndroidControllerGate>> = OnceLock::new();
fn gate() -> &'static Mutex<AndroidControllerGate> {
    GATE.get_or_init(|| Mutex::new(AndroidControllerGate::default()))
}
pub fn approve(id: &str, fp: &str, token: &str) -> Result<(), String> {
    gate().lock().map_err(|_| "ANDROID_CONTROLLER_GATE_UNAVAILABLE")?
        .approve(id, fp, token, Instant::now())
}
pub fn check(id: &str, fp: &str, connected: bool) -> Result<u64, String> {
    gate().lock().map_err(|_| "ANDROID_CONTROLLER_GATE_UNAVAILABLE")?
        .check(id, fp, connected, Instant::now())
}
pub fn credential(id: &str, fp: &str, connected: bool) -> Result<String, String> {
    gate().lock().map_err(|_| "ANDROID_CONTROLLER_GATE_UNAVAILABLE")?
        .credential(id, fp, connected, Instant::now())
}
pub fn revoke() {
    // A poisoned lock is a permanent deny until a trusted host restart.
    if let Ok(mut g) = gate().lock() { g.revoke(); }
}
pub fn revoke_device(id: &str) {
    if let Ok(mut g) = gate().lock() { g.revoke_device(id); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> &'static str { "123e4567-e89b-12d3-a456-426614174000" }
    fn fp() -> String { "af".repeat(32) }
    fn token() -> String { "ab".repeat(32) }

    #[test]
    fn viewing_does_not_enable_input_without_native_approval() {
        let mut g = AndroidControllerGate::default();
        assert!(g.check(id(), &fp(), true, Instant::now()).is_err());
    }

    #[test]
    fn binds_grant_to_exact_device_and_fingerprint() {
        let mut g = AndroidControllerGate::default();
        let now = Instant::now();
        g.approve(id(), &fp(), &token(), now).unwrap();
        assert!(g.check(id(), &fp(), true, now).is_ok());
        assert!(g.check("123e4567-e89b-12d3-a456-426614174111", &fp(), true, now).is_err());
        assert!(g.check(id(), &fp(), true, now).is_err());
    }

    #[test]
    fn denies_device_repair_or_disconnection_and_expires() {
        let mut g = AndroidControllerGate::default();
        let now = Instant::now();
        g.approve(id(), &fp(), &token(), now).unwrap();
        assert!(g.check(id(), &"bc".repeat(32), true, now).is_err());
        g.approve(id(), &fp(), &token(), now).unwrap();
        assert!(g.check(id(), &fp(), false, now).is_err());
        g.approve(id(), &fp(), &token(), now).unwrap();
        assert!(g.check(id(), &fp(), true,
            now + Duration::from_secs(MAX_CONTROL_SECONDS)).is_err());
    }

    #[test]
    fn only_revoke_matching_device() {
        let mut g = AndroidControllerGate::default();
        let now = Instant::now();
        g.approve(id(), &fp(), &token(), now).unwrap();
        g.revoke_device("123e4567-e89b-12d3-a456-426614174111");
        assert!(g.check(id(), &fp(), true, now).is_ok());
        g.revoke_device(id());
        assert!(g.check(id(), &fp(), true, now).is_err());
    }

    #[test]
    fn denies_invalid_target_and_approval_reset() {
        let mut g = AndroidControllerGate::default();
        let now = Instant::now();
        g.approve(id(), &fp(), &token(), now).unwrap();
        assert!(g.approve("not-an-id", &fp(), &token(), now).is_err());
        assert!(g.check(id(), &fp(), true, now).is_err());
    }
}
