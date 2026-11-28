use std::io::{Read, Write};
use std::net::TcpListener;
use std::{fs, path::{Path, PathBuf}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde_json::{json, Value};

struct Profile(PathBuf);
impl Profile {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("sa-core-startup-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Profile {
    fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); }
}

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

fn serve(listener: TcpListener, expected_token: String, status: u16, body: Value) -> std::thread::JoinHandle<()> {
    listener.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut socket = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                    std::thread::sleep(Duration::from_millis(10)),
                Err(error) => panic!("mock owner accept failed: {}", error),
            }
        };
        // Windows can inherit the listener's nonblocking mode. Wait for a
        // complete bounded HTTP header rather than racing the first packet.
        socket.set_nonblocking(false).unwrap();
        let read_deadline = Instant::now() + Duration::from_secs(3);
        let mut request = Vec::new();
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            assert!(Instant::now() < read_deadline, "mock owner request timed out");
            socket.set_read_timeout(Some(read_deadline.saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1)))).unwrap();
            let mut chunk = [0u8; 4096];
            let count = socket.read(&mut chunk).expect("mock owner request unavailable");
            assert!(count > 0, "mock owner request closed before its header");
            request.extend_from_slice(&chunk[..count]);
            assert!(request.len() <= 16384, "mock owner request too large");
        }
        let request = String::from_utf8_lossy(&request);
        assert!(request.contains(&format!("Bearer {}", expected_token)));
        let body = body.to_string();
        socket.write_all(format!("HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", status, body.len(), body).as_bytes()).unwrap();
    })
}

fn register(dir: &Path, port: u16, control_port: u16) {
    fs::write(dir.join(format!("server-info-{}.json", port)), json!({
        "port":port,"pid":std::process::id(),"startedAt":now(),"authToken":"a".repeat(48)
    }).to_string()).unwrap();
    fs::write(dir.join(format!("core-supervisor-{}.json", port)), json!({
        "publicPort":port,"supervisorPid":std::process::id(),"controlPort":control_port,"controlToken":"b".repeat(64)
    }).to_string()).unwrap();
}

fn private_status(port: u16) -> Value {
    json!({"supervisorPid":std::process::id(),"publicPort":port,
        "active":{"pid":std::process::id()},
        "ownerContract":{"version":1,"role":"core-supervisor","mcpLifecycle":"not-owned"}})
}

#[tokio::test]
async fn core_startup_rejects_unauthorized_listener_instead_of_reporting_started() {
    let profile = Profile::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let result = super::core_startup::preflight(&profile.0, port).await;
    assert!(result.is_err(), "An unauthenticated listener must not be reported as a running Core");
}

#[tokio::test]
async fn core_startup_preserves_all_registration_and_recovery_files_when_listener_is_unverified() {
    let profile = Profile::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let files = [format!("core-checkpoint-{}.json", port), format!("core-supervisor-{}.json", port),
        format!("server-info-{}.json", port), "server-info.json".into()];
    for name in &files { fs::write(profile.0.join(name), format!("preserve {}", name)).unwrap(); }
    let result = super::core_startup::preflight(&profile.0, port).await;
    assert!(result.unwrap_err().contains("occupied"));
    for name in &files { assert_eq!(fs::read_to_string(profile.0.join(name)).unwrap(), format!("preserve {}", name)); }
}

#[tokio::test]
async fn core_startup_only_allows_bootstrap_when_loopback_port_can_be_reserved() {
    let profile = Profile::new();
    assert!(super::core_startup::preflight(&profile.0, 0).await.is_err());
    // A released ephemeral port can be reused by an unrelated process before
    // the preflight bind. Retry with a fresh port instead of failing on that
    // race; the property under test is unchanged.
    for _ in 0..5 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        match super::core_startup::preflight(&profile.0, port).await {
            Ok(false) => return,
            Ok(true) => panic!("An unregistered port {} was reported as a verified owner", port),
            Err(error) if error.contains("occupied") => continue,
            Err(error) => panic!("Unexpected preflight failure: {}", error),
        }
    }
    panic!("No loopback port could be reserved for the bootstrap check");
}

#[test]
fn core_startup_never_uses_default_credentials_for_another_port() {
    let profile = Profile::new();
    fs::write(profile.0.join("server-info.json"), json!({
        "port":43001,"pid":std::process::id(),"startedAt":now(),"authToken":"a".repeat(48)
    }).to_string()).unwrap();
    assert!(super::runtime_detection::server_info_for_port(&profile.0, 43002).is_err());
    assert_eq!(super::runtime_detection::server_info_for_port(&profile.0, 43001).unwrap().port, 43001);
}

#[tokio::test]
async fn core_startup_requires_authenticated_public_readiness_even_with_a_verified_supervisor() {
    for (status, body, succeeds) in [
        (200, json!({"status":"online","version":"test"}), true),
        (401, json!({"error":"Unauthorized"}), false),
        (200, json!({"status":"online"}), false),
        (200, json!({"status":"online","version":"test","pid":u32::MAX}), false),
        (302, json!({"status":"online","version":"test"}), false),
    ] {
        let profile = Profile::new();
        let public = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = public.local_addr().unwrap().port();
        let private = TcpListener::bind("127.0.0.1:0").unwrap();
        register(&profile.0, port, private.local_addr().unwrap().port());
        let owner = serve(private, "b".repeat(64), 200, private_status(port));
        let api = serve(public, "a".repeat(48), status, body);
        let result = super::core_startup::verified_owner(&profile.0, port).await;
        owner.join().unwrap();
        api.join().unwrap();
        assert_eq!(result.is_ok(), succeeds, "Unexpected readiness result: {:?}", result);
    }
}

#[tokio::test]
async fn core_startup_rejects_private_owner_identity_mismatch_without_touching_public_api() {
    let profile = Profile::new();
    let public = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = public.local_addr().unwrap().port();
    let private = TcpListener::bind("127.0.0.1:0").unwrap();
    register(&profile.0, port, private.local_addr().unwrap().port());
    let mut body = private_status(port);
    body["supervisorPid"] = json!(u32::MAX);
    let owner = serve(private, "b".repeat(64), 200, body);
    assert!(super::core_startup::verified_owner(&profile.0, port).await.is_err());
    owner.join().unwrap();
    public.set_nonblocking(true).unwrap();
    assert!(public.accept().is_err());
}

#[tokio::test]
async fn core_startup_stop_preserves_a_live_listener_instead_of_killing_a_pid() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let error = super::stop_core_server_inner(port).await.unwrap_err();
    assert!(error.contains("verified drain"));
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok());
}

#[cfg(windows)]
#[test]
fn core_startup_kernel_listener_parser_requires_exact_loopback_port_and_pid() {
    let output = "  TCP    127.0.0.1:7888    0.0.0.0:0    LISTENING    1234\r\n  TCP    127.0.0.1:17888    0.0.0.0:0    LISTENING    5678\r\n  TCP    0.0.0.0:9000    0.0.0.0:0    LISTENING    1234";
    assert!(super::core_startup::listener_matches_output(output, 7888, 1234));
    assert!(!super::core_startup::listener_matches_output(output, 7888, 5678));
    assert!(!super::core_startup::listener_matches_output(output, 9000, 1234));
    assert!(!super::core_startup::listener_matches_output(&output.replace("LISTENING", "ESTABLISHED"), 7888, 1234));
}
