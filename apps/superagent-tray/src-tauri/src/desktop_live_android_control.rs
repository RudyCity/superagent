//! Independent host-native Android mouse and keyboard approvals.
//! A viewer grant never authorizes input. Each input kind needs its own
//! attended OS dialog and HMAC-bound Core token. Tokens stay in Rust memory.
use std::collections::HashMap;
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
    active: HashMap<String, ControlLease>,
}

fn valid_kind(kind: &str) -> bool { kind == "mouse" || kind == "keyboard" }
fn valid_device_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i, c)| {
        if [8, 13, 18, 23].contains(&i) { c == b'-' }
        else { c.is_ascii_hexdigit() }
    })
}
fn valid_fingerprint(fp: &str) -> bool {
    fp.len() == 64 && fp.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())
}

impl AndroidControllerGate {
    /// Only after a native dialog for this exact kind and device succeeded.
    pub fn approve(&mut self, id: &str, fingerprint: &str, kind: &str,
        token: &str, now: Instant) -> Result<(), String> {
        if !valid_kind(kind) { return Err("ANDROID_CONTROLLER_INVALID_SCOPE".into()); }
        // A bad request can only revoke its own kind, never elevate another.
        self.active.remove(kind);
        if !valid_device_id(id) || !valid_fingerprint(fingerprint) || !valid_token(token) {
            return Err("ANDROID_CONTROLLER_TARGET_INVALID".into());
        }
        self.active.insert(kind.to_string(), ControlLease {
            device_id:id.to_string(),
            fingerprint:fingerprint.to_ascii_lowercase(),
            token:token.to_ascii_lowercase(),
            expires_at:now + Duration::from_secs(MAX_CONTROL_SECONDS),
        });
        Ok(())
    }

    pub fn check(&mut self, id: &str, fingerprint: &str, kind: &str,
        connected: bool, now: Instant) -> Result<u64, String> {
        if !valid_kind(kind) { return Err("ANDROID_CONTROLLER_INVALID_SCOPE".into()); }
        let Some(grant) = self.active.get(kind) else {
            return Err("ANDROID_CONTROLLER_NATIVE_APPROVAL_REQUIRED".into());
        };
        if !connected || !valid_device_id(id) || !valid_fingerprint(fingerprint) ||
            grant.device_id != id || grant.fingerprint != fingerprint.to_ascii_lowercase() {
            self.active.remove(kind);
            return Err("ANDROID_CONTROLLER_IDENTITY_CHANGED".into());
        }
        if now >= grant.expires_at {
            self.active.remove(kind);
            return Err("ANDROID_CONTROLLER_APPROVAL_EXPIRED".into());
        }
        Ok(grant.expires_at.duration_since(now).as_secs())
    }

    pub fn credential(&mut self, id: &str, fp: &str, kind: &str,
        connected: bool, now: Instant) -> Result<String, String> {
        self.check(id,fp,kind,connected,now)?;
        self.active.get(kind).map(|grant|grant.token.clone())
            .ok_or_else(||"ANDROID_CONTROLLER_NATIVE_APPROVAL_REQUIRED".into())
    }

    pub fn revoke(&mut self) { self.active.clear(); }
    pub fn revoke_kind(&mut self, id: &str, kind: &str) {
        if !valid_kind(kind) { return; }
        if self.active.get(kind).map(|g|g.device_id.as_str()) == Some(id) {
            self.active.remove(kind);
        }
    }
    pub fn revoke_device(&mut self, id: &str) {
        self.active.retain(|_,grant|grant.device_id != id);
    }
}

static GATE: OnceLock<Mutex<AndroidControllerGate>> = OnceLock::new();
fn gate() -> &'static Mutex<AndroidControllerGate> {
    GATE.get_or_init(||Mutex::new(AndroidControllerGate::default()))
}
pub fn approve(id: &str, fp: &str, kind: &str, token: &str) -> Result<(), String> {
    gate().lock().map_err(|_|"ANDROID_CONTROLLER_GATE_UNAVAILABLE")?
        .approve(id,fp,kind,token,Instant::now())
}
pub fn credential(id: &str, fp: &str, kind: &str, connected: bool) -> Result<String, String> {
    gate().lock().map_err(|_|"ANDROID_CONTROLLER_GATE_UNAVAILABLE")?
        .credential(id,fp,kind,connected,Instant::now())
}
pub fn revoke() {
    if let Ok(mut gate) = gate().lock() { gate.revoke(); }
}
pub fn revoke_kind(id: &str, kind: &str) {
    if let Ok(mut gate) = gate().lock() { gate.revoke_kind(id,kind); }
}
pub fn revoke_device(id: &str) {
    if let Ok(mut gate) = gate().lock() { gate.revoke_device(id); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> &'static str {"123e4567-e89b-12d3-a456-426614174000"}
    fn fp() -> String {"af".repeat(32)}
    fn token() -> String {"ab".repeat(32)}

    #[test]
    fn watching_never_permits_either_input_kind() {
        let mut g=AndroidControllerGate::default();
        assert!(g.check(id(),&fp(),"mouse",true,Instant::now()).is_err());
        assert!(g.check(id(),&fp(),"keyboard",true,Instant::now()).is_err());
    }
    #[test]
    fn mouse_never_promotes_to_keyboard() {
        let mut g=AndroidControllerGate::default();
        let now=Instant::now();
        g.approve(id(),&fp(),"mouse",&token(),now).unwrap();
        assert!(g.check(id(),&fp(),"mouse",true,now).is_ok());
        assert!(g.check(id(),&fp(),"keyboard",true,now).is_err());
        assert!(g.credential(id(),&fp(),"keyboard",true,now).is_err());
    }
    #[test]
    fn keyboard_grant_is_independent_and_revocable() {
        let mut g=AndroidControllerGate::default();
        let now=Instant::now();
        g.approve(id(),&fp(),"mouse",&token(),now).unwrap();
        g.approve(id(),&fp(),"keyboard",&"cd".repeat(32),now).unwrap();
        assert!(g.check(id(),&fp(),"keyboard",true,now).is_ok());
        g.revoke_kind(id(),"keyboard");
        assert!(g.check(id(),&fp(),"keyboard",true,now).is_err());
        assert!(g.check(id(),&fp(),"mouse",true,now).is_ok());
    }
    #[test]
    fn denies_identity_changes_and_expired_lease() {
        let mut g=AndroidControllerGate::default();
        let now=Instant::now();
        g.approve(id(),&fp(),"mouse",&token(),now).unwrap();
        assert!(g.check("123e4567-e89b-12d3-a456-426614174111",&fp(),"mouse",true,now).is_err());
        assert!(g.check(id(),&fp(),"mouse",true,now).is_err());
        g.approve(id(),&fp(),"keyboard",&token(),now).unwrap();
        assert!(g.check(id(),&fp(),"keyboard",false,now).is_err());
        g.approve(id(),&fp(),"keyboard",&token(),now).unwrap();
        assert!(g.check(id(),&fp(),"keyboard",true,now+
            Duration::from_secs(MAX_CONTROL_SECONDS)).is_err());
    }
    #[test]
    fn invalid_kind_is_always_rejected() {
        let mut g=AndroidControllerGate::default();
        let now=Instant::now();
        assert!(g.approve(id(),&fp(),"all",&token(),now).is_err());
        g.approve(id(),&fp(),"mouse",&token(),now).unwrap();
        assert!(g.credential(id(),&fp(),"all",true,now).is_err());
        g.revoke_kind(id(),"all");
        assert!(g.check(id(),&fp(),"mouse",true,now).is_ok());
    }
    #[test]
    fn revoke_device_and_revoke_all_clear_both() {
        let mut g=AndroidControllerGate::default();
        let now=Instant::now();
        g.approve(id(),&fp(),"mouse",&token(),now).unwrap();
        g.approve(id(),&fp(),"keyboard",&"cd".repeat(32),now).unwrap();
        g.revoke_device("123e4567-e89b-12d3-a456-426614174111");
        assert!(g.check(id(),&fp(),"mouse",true,now).is_ok());
        g.revoke_device(id());
        assert!(g.check(id(),&fp(),"mouse",true,now).is_err());
        assert!(g.check(id(),&fp(),"keyboard",true,now).is_err());
        g.approve(id(),&fp(),"mouse",&token(),now).unwrap();
        g.revoke();
        assert!(g.check(id(),&fp(),"mouse",true,now).is_err());
    }
}