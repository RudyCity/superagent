//! Authenticated, owner-scoped desktop lifecycle control.
//! The only remote mutation is *this* Tray instance gracefully exiting.
//! Core, MCP, Muse, cloudflared, and the user's other processes are untouched.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::OnceLock,
    thread,
    time::Duration,
};
use sysinfo::{Pid, System};
use tauri::AppHandle;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrayOwner {
    version: u8,
    pid: u32,
    instance_id: String,
    token: String,
    control_port: u16,
    executable_path: String,
}
static OWNED: OnceLock<(PathBuf, TrayOwner)> = OnceLock::new();
const FILE: &str = "tray-lifecycle-owner.json";

fn owner_path(dir: &Path) -> PathBuf { dir.join(FILE) }
fn private_random_hex() -> String {
    // UUIDv4 is generated from OS cryptographic randomness; we join two
    // independent random IDs for a 256-bit bearer, never a timestamp or PID.
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}
fn eq_secret(a: &str, b: &str) -> bool {
    if a.len() != b.len() { return false; }
    a.bytes().zip(b.bytes()).fold(0_u8, |acc, (x,y)| acc | (x^y)) == 0
}
fn write_owner(dir: &Path, owner: &TrayOwner) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create Tray profile: {e}"))?;
    let meta=fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !meta.is_dir()||meta.file_type().is_symlink() {
        return Err("Tray owner directory is unsafe".into());
    }
    let file=owner_path(dir);
    if file.exists() {
        if let Ok(bytes) = fs::read(&file) {
            if let Ok(existing) = serde_json::from_slice::<TrayOwner>(&bytes) {
                let mut system = System::new();
                system.refresh_processes();
                if system.process(Pid::from_u32(existing.pid)).is_none() {
                    let _ = fs::remove_file(&file);
                }
            } else {
                let _ = fs::remove_file(&file);
            }
        }
    }
    let mut handle=OpenOptions::new().create_new(true).write(true)
        .open(&file).map_err(|_| "Existing Tray owner record: never overwrite or adopt another process".to_string())?;
    let encoded=serde_json::to_vec(owner).map_err(|e| e.to_string())?;
    handle.write_all(&encoded).map_err(|e| e.to_string())?;
    handle.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}
fn cleanup_if_owned() {
    if let Some((file, own))=OWNED.get() {
        if let Ok(meta)=fs::symlink_metadata(file) {
            if !meta.is_file()||meta.file_type().is_symlink()||meta.len()>2048 {return;}
            if let Ok(bytes)=fs::read(file) {
                if let Ok(current)=serde_json::from_slice::<TrayOwner>(&bytes) {
                    if current==*own {let _=fs::remove_file(file);}
                }
            }
        }
    }
}
pub fn cleanup(){cleanup_if_owned();}

fn reply(stream:&mut TcpStream,code:u16,body:&str){
    let reason=match code {200=>"OK",400=>"Bad Request",401=>"Unauthorized",
        404=>"Not Found",409=>"Conflict",413=>"Payload Too Large",_=>"Error"};
    let data=format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
    let _=stream.write_all(data.as_bytes());
    let _=stream.flush();
}
fn handle(mut stream:TcpStream,own:&TrayOwner)->bool {
    let _=stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _=stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.peer_addr().map(|a|!a.ip().is_loopback()).unwrap_or(true) {
        reply(&mut stream,401,r#"{"ok":false}"#);return false;
    }
    let mut reader=BufReader::new(&mut stream);
    let mut first=String::new();
    if reader.read_line(&mut first).is_err()||first.len()>256 {return false;}
    let mut header_bytes=first.len();
    let mut auth=String::new();
    let mut length=0_usize;
    let mut has_length=false;
    let mut valid=true;
    for _ in 0..24 {
        let mut line=String::new();
        if reader.read_line(&mut line).is_err(){valid=false;break;}
        header_bytes+=line.len();
        if header_bytes>3072 {valid=false;break;}
        if line=="\r\n" {break;}
        if let Some((key,value))=line.trim_end().split_once(':') {
            let name=key.trim();
            if name.eq_ignore_ascii_case("authorization") {auth=value.trim().to_owned();}
            if name.eq_ignore_ascii_case("content-length") {
                if has_length {valid=false;break;}
                has_length=true;
                length=value.trim().parse().unwrap_or(usize::MAX);
            }
        }
    }
    if !valid||length>256 {reply(&mut stream,413,r#"{"ok":false}"#);return false;}
    let mut body=vec![0u8;length];
    if length>0&&reader.read_exact(&mut body).is_err(){return false;}
    drop(reader);
    if !eq_secret(&auth,&format!("Bearer {}",own.token)) {
        reply(&mut stream,401,r#"{"ok":false}"#);return false;
    }
    if first=="GET /tray/health HTTP/1.1\r\n" {
        reply(&mut stream,200,&json!({"service":"superagent-tray",
            "version":1,"pid":own.pid,"instanceId":own.instance_id,
            "controlPort":own.control_port,"ownerVerified":true}).to_string());
        return false;
    }
    if first!="POST /tray/control HTTP/1.1\r\n" {
        reply(&mut stream,404,r#"{"ok":false}"#);return false;
    }
    let value:serde_json::Value=match serde_json::from_slice(&body){
        Ok(v)=>v,Err(_)=>{reply(&mut stream,400,r#"{"ok":false}"#);return false;}
    };
    // Reject extra fields or arbitrary commands, including "kill-core".
    let expected=json!({"action":"stop","instanceId":own.instance_id});
    if value!=expected {reply(&mut stream,400,r#"{"ok":false}"#);return false;}
    reply(&mut stream,200,r#"{"ok":true,"stopping":true,"coreUnaffected":true}"#);
    true
}
fn install_with<F:Fn()+Send+'static>(dir:&Path,on_stop:F)->Result<(),String>{
    let socket=TcpListener::bind(("127.0.0.1",0))
        .map_err(|e| format!("Tray local lifecycle listener failed: {e}"))?;
    let port=socket.local_addr().map_err(|e|e.to_string())?.port();
    let executable=std::env::current_exe()
        .and_then(fs::canonicalize).map_err(|e|e.to_string())?;
    let own=TrayOwner{version:1,pid:std::process::id(),
        instance_id:uuid::Uuid::new_v4().simple().to_string(),
        token:private_random_hex(),control_port:port,
        executable_path:executable.to_string_lossy().into_owned()};
    write_owner(dir,&own)?;
    if OWNED.set((owner_path(dir),own.clone())).is_err() {
        return Err("Tray lifecycle already initialized".into());
    }
    thread::Builder::new().name("tray-private-lifecycle".into())
        .spawn(move||{
            for stream in socket.incoming() {
                let Ok(stream)=stream else {break;};
                if handle(stream,&own) {
                    cleanup_if_owned();
                    on_stop();
                    break;
                }
            }
        }).map_err(|e|format!("Tray lifecycle worker could not start: {e}"))?;
    Ok(())
}

pub fn install(app:AppHandle,dir:&Path)->Result<(),String>{
    install_with(dir,move||app.exit(0))
}
/// Debug-only headless integration host. Uses the exact same listener and
/// owner protocol but cannot create a window or change other services.
#[cfg(debug_assertions)]
pub fn run_headless_smoke(dir:&Path)->Result<(),String>{
    if std::env::var("SUPERAGENT_TRAY_LIFECYCLE_TEST").as_deref()!=Ok("1"){
        return Err("Private Tray smoke mode requires explicit test-only environment".into());
    }
    install_with(dir,||std::process::exit(0))?;
    loop {thread::park();}
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn owner_token_is_cryptographically_sized_and_comparison_rejects_variants(){
        let x=private_random_hex();
        assert_eq!(x.len(),64);
        assert!(x.chars().all(|c|c.is_ascii_hexdigit()));
        assert!(eq_secret(&x,&x));
        assert!(!eq_secret(&x, &format!("{}x",x)));
        assert!(!eq_secret(&x,&"a".repeat(64)));
    }

    #[test]
    fn cleans_up_stale_owner_from_dead_pid() {
        let temp = std::env::temp_dir().join(format!("tray-stale-test-{}", uuid::Uuid::new_v4().simple()));
        let _ = fs::create_dir_all(&temp);
        let stale = TrayOwner {
            version: 1,
            pid: 4294967290,
            instance_id: "dead-instance".into(),
            token: private_random_hex(),
            control_port: 59999,
            executable_path: "fake".into(),
        };
        let file = owner_path(&temp);
        let _ = fs::write(&file, serde_json::to_vec(&stale).unwrap());
        assert!(file.exists());

        let new_owner = TrayOwner {
            version: 1,
            pid: std::process::id(),
            instance_id: "live-instance".into(),
            token: private_random_hex(),
            control_port: 59998,
            executable_path: "live".into(),
        };
        assert!(write_owner(&temp, &new_owner).is_ok());
        let _ = fs::remove_dir_all(&temp);
    }
}
