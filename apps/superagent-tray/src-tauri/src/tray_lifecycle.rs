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
            "controlPort":own.control_port,"ownerVerified":true,
            "webviewBundleDigest":option_env!("SUPERAGENT_TRAY_UI_DIGEST"),
            "sourceRevision":option_env!("SUPERAGENT_TRAY_SOURCE_REVISION")}).to_string());
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
    // An explicit runner PID is mandatory so a crashed Vitest worker cannot
    // leave a detached test Tray blocking the real native owner's upgrades.
    let runner_pid = std::env::var("SUPERAGENT_TRAY_SMOKE_PARENT_PID")
        .ok().and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0 && *pid != std::process::id())
        .ok_or("Private Tray smoke mode requires a test runner PID")?;
    let runner = Pid::from_u32(runner_pid);
    let mut system = System::new();
    system.refresh_processes();
    if system.process(runner).is_none() {
        return Err("Private Tray smoke runner is not alive".into());
    }
    install_with(dir,||std::process::exit(0))?;
    // The native owner still accepts its authenticated graceful-stop request.
    // Parent death exits within two seconds; the 5-minute cap also covers
    // exceptional cases such as PID reuse or a hung test runner.
    for _ in 0..150 {
        thread::sleep(Duration::from_secs(2));
        system.refresh_processes();
        if system.process(runner).is_none() { break; }
    }
    cleanup_if_owned();
    Ok(())
}

/// A second manual launch must get a user choice before Tauri's
/// single-instance plugin redirects it to the old UI. This preflight runs
/// ONLY in the new process, before initializing the plugin. Background
/// autostarts remain silent and never replace the active desktop owner.
#[cfg(windows)]
fn read_launch_owner(dir:&Path)->Result<Option<TrayOwner>,String>{
    let file=owner_path(dir);
    let meta=match fs::symlink_metadata(&file){
        Ok(meta)=>meta,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),
        Err(_)=>return Err("Cannot inspect the existing Tray owner record".into()),
    };
    if !meta.is_file()||meta.file_type().is_symlink()||meta.len()==0||meta.len()>2048 {
        return Err("Existing Tray owner record is unsafe; no process will be stopped".into());
    }
    let bytes=fs::read(&file).map_err(|_|"Cannot read existing Tray owner record")?;
    let owner:TrayOwner=serde_json::from_slice(&bytes)
        .map_err(|_|"Existing Tray owner record is invalid; no process will be stopped")?;
    if owner.version!=1||owner.pid==0||owner.control_port<1024||
        owner.instance_id.len()!=32||!owner.instance_id.bytes().all(|b|b.is_ascii_hexdigit())||
        owner.token.len()!=64||!owner.token.bytes().all(|b|b.is_ascii_hexdigit())||
        owner.executable_path.is_empty()||owner.executable_path.len()>2048 {
        return Err("Existing Tray owner identity is invalid; no process will be stopped".into());
    }
    Ok(Some(owner))
}

#[cfg(windows)]
fn same_tray_process(owner:&TrayOwner)->Result<Option<u64>,String>{
    let mut system=System::new();
    system.refresh_processes();
    let Some(process)=system.process(Pid::from_u32(owner.pid)) else{return Ok(None)};
    if owner.pid==std::process::id(){
        return Err("A Tray owner record points at this process".into());
    }
    let actual=process.exe().ok_or("Existing Tray process executable is not visible")?;
    let registered=fs::canonicalize(&owner.executable_path)
        .map_err(|_|"Existing Tray executable path is not verifiable")?;
    let observed=fs::canonicalize(actual)
        .map_err(|_|"Existing Tray process executable is not verifiable")?;
    let filename=observed.file_name().and_then(|s|s.to_str()).unwrap_or("");
    if !filename.eq_ignore_ascii_case("superagent-tray.exe")||
        !registered.to_string_lossy().eq_ignore_ascii_case(&observed.to_string_lossy()) {
        return Err("Existing Tray PID does not match its registered executable".into());
    }
    Ok(Some(process.start_time()))
}

#[cfg(windows)]
fn tray_private_request(owner:&TrayOwner,method:&str,body:Option<&str>)
    ->Result<serde_json::Value,String>{
    use std::net::{SocketAddr,IpAddr,Ipv4Addr};
    let endpoint=SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST),owner.control_port);
    let mut stream=TcpStream::connect_timeout(&endpoint,Duration::from_secs(2))
        .map_err(|_|"Existing Tray private control endpoint did not respond")?;
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(3))).ok();
    let path=if method=="GET"{"/tray/health"}else{"/tray/control"};
    let data=body.unwrap_or("");
    let request=format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        owner.control_port,owner.token,data.len(),data
    );
    stream.write_all(request.as_bytes())
        .map_err(|_|"Existing Tray private request could not be sent")?;
    let mut response=Vec::new();
    stream.take(8193).read_to_end(&mut response)
        .map_err(|_|"Existing Tray private response timed out")?;
    if response.len()>8192{return Err("Existing Tray response exceeded limit".into());}
    let text=std::str::from_utf8(&response)
        .map_err(|_|"Existing Tray response is not UTF-8")?;
    let (headers,payload)=text.split_once("\r\n\r\n")
        .ok_or("Existing Tray response has invalid framing")?;
    if !headers.starts_with("HTTP/1.1 200 "){
        return Err("Existing Tray refused the private owner request".into());
    }
    serde_json::from_str(payload).map_err(|_|"Existing Tray response is invalid JSON".into())
}

#[cfg(windows)]
fn verify_launch_owner(owner:&TrayOwner)->Result<Option<u64>,String>{
    let Some(birth)=same_tray_process(owner)? else {return Ok(None)};
    let health=tray_private_request(owner,"GET",None)?;
    if health.get("service").and_then(|v|v.as_str())!=Some("superagent-tray")||
        health.get("pid").and_then(|v|v.as_u64())!=Some(owner.pid as u64)||
        health.get("instanceId").and_then(|v|v.as_str())!=Some(owner.instance_id.as_str())||
        health.get("controlPort").and_then(|v|v.as_u64())!=Some(owner.control_port as u64)||
        health.get("ownerVerified").and_then(|v|v.as_bool())!=Some(true){
        return Err("Existing Tray private owner identity could not be authenticated".into());
    }
    if same_tray_process(owner)?!=Some(birth){
        return Err("Existing Tray PID changed during owner verification".into());
    }
    Ok(Some(birth))
}

#[cfg(windows)]
fn request_graceful_replacement(owner:&TrayOwner)->Result<(),String>{
    let body=json!({"action":"stop","instanceId":owner.instance_id}).to_string();
    let result=tray_private_request(owner,"POST",Some(&body))?;
    if result.get("ok").and_then(|v|v.as_bool())!=Some(true)||
        result.get("stopping").and_then(|v|v.as_bool())!=Some(true)||
        result.get("coreUnaffected").and_then(|v|v.as_bool())!=Some(true){
        return Err("Existing Tray did not acknowledge a Tray-only shutdown".into());
    }
    Ok(())
}

#[cfg(windows)]
fn wait_for_tray_exit(owner:&TrayOwner,birth:u64)->bool{
    for _ in 0..40{
        // Observe one consistent PID/birth snapshot per iteration.
        match same_tray_process(owner){
            Ok(None)=>return true,
            Ok(Some(now)) if now!=birth=>return true,
            Ok(Some(_))=>{},
            Err(_)=>return false,
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

#[cfg(windows)]
fn native_launch_question(title:&str,message:&str)->bool{
    use std::ffi::c_void;
    #[link(name="user32")]
    extern "system" {
        fn MessageBoxW(hwnd:*mut c_void,text:*const u16,caption:*const u16,flags:u32)->i32;
    }
    let title:Vec<u16>=title.encode_utf16().chain(std::iter::once(0)).collect();
    let message:Vec<u16>=message.encode_utf16().chain(std::iter::once(0)).collect();
    // YES/NO + question icon + foreground/topmost. No webview or shell required.
    let choice=unsafe {MessageBoxW(std::ptr::null_mut(),message.as_ptr(),title.as_ptr(),
        0x0000_0004|0x0000_0020|0x0001_0000|0x0004_0000)};
    choice==6
}

#[cfg(windows)]
pub fn launch_error_dialog(message:&str){
    use std::ffi::c_void;
    #[link(name="user32")]
    extern "system" {
        fn MessageBoxW(hwnd:*mut c_void,text:*const u16,caption:*const u16,flags:u32)->i32;
    }
    let title:Vec<u16>="SuperAgent Tray — Replacement blocked".encode_utf16()
        .chain(std::iter::once(0)).collect();
    let text:Vec<u16>=message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {MessageBoxW(std::ptr::null_mut(),text.as_ptr(),title.as_ptr(),
        0x0000_0010|0x0001_0000|0x0004_0000);}
}

/// Returns false when the new manual launch was cancelled. Only a verified
/// owner may be replaced; no Core/MCP/foreign PID is ever a stop target.
/// A still-running verified Tray gets a second prompt before any force stop.
#[cfg(windows)]
pub fn replace_existing_on_manual_launch(dir:&Path,background:bool)->Result<bool,String>{
    if background{return Ok(true);}
    let Some(owner)=read_launch_owner(dir)? else{return Ok(true)};
    let Some(birth)=verify_launch_owner(&owner)? else{return Ok(true)};
    if !native_launch_question("SuperAgent Tray is already running",
        &format!("SuperAgent Tray (PID {}) is already running.\n\nReplace it with this new launch?\n\nYes: close only the existing Tray and start the new version.\nNo: keep the existing Tray running.\n\nCore, MCP, tunnels and agent sessions are not affected.",owner.pid)){
        return Ok(false);
    }
    if read_launch_owner(dir)?!=Some(owner.clone())||
        verify_launch_owner(&owner)?!=Some(birth){
        return Err("The running Tray owner changed after approval".into());
    }
    let graceful=request_graceful_replacement(&owner);
    if graceful.is_ok()&&wait_for_tray_exit(&owner,birth){return Ok(true);}
    // An unreachable private stop endpoint or a timed-out graceful shutdown
    // is NOT permission to kill a PID. Ask AGAIN and verify from scratch.
    // The ordinary shutdown timed out. Ask AGAIN before any OS process kill.
    // A PID, owner record, authenticated health AND OS creation time must all
    // still agree. Never kill an unverified or reused PID.
    if !native_launch_question("SuperAgent Tray is not responding",
        &format!("The verified Tray (PID {}) did not finish its private shutdown request.\n\nForce close ONLY this Tray and continue startup?\n\nNo other SuperAgent service will be stopped.",owner.pid)){
        return Ok(false);
    }
    if read_launch_owner(dir)?!=Some(owner.clone())||
        verify_launch_owner(&owner)?!=Some(birth){
        return Err("Tray owner changed before the force-close request".into());
    }
    let mut system=System::new();
    system.refresh_processes();
    let process=system.process(Pid::from_u32(owner.pid))
        .ok_or("Original Tray PID is no longer present")?;
    if process.start_time()!=birth||!process.kill(){
        return Err("Verified Tray could not be stopped; original instance is unchanged".into());
    }
    if wait_for_tray_exit(&owner,birth){return Ok(true);}
    Err("Old Tray did not exit after confirmed force close; new startup was cancelled".into())
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

    #[cfg(windows)]
    #[test]
    fn second_launch_refuses_corrupt_or_unverified_owner_without_killing_processes(){
        let temp=std::env::temp_dir().join(format!(
            "tray-second-launch-{}",uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&temp).unwrap();
        assert!(read_launch_owner(&temp).unwrap().is_none());
        // A background autostart is always a no-op, even with a broken
        // existing owner record: it must not display a blocking native dialog.
        fs::write(owner_path(&temp),b"{}").unwrap();
        assert!(read_launch_owner(&temp).is_err());
        assert!(replace_existing_on_manual_launch(&temp,true).unwrap());
        assert!(replace_existing_on_manual_launch(&temp,false).is_err());
        // A self-referential owner is not eligible for replacement.
        let own=TrayOwner{version:1,pid:std::process::id(),
            instance_id:uuid::Uuid::new_v4().simple().to_string(),
            token:private_random_hex(),control_port:58999,
            executable_path:std::env::current_exe().unwrap().to_string_lossy().into_owned()};
        fs::write(owner_path(&temp),serde_json::to_vec(&own).unwrap()).unwrap();
        assert!(verify_launch_owner(&own).is_err());
        assert!(replace_existing_on_manual_launch(&temp,false).is_err());
        fs::remove_dir_all(temp).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn replacement_uses_private_authenticated_health_and_tray_only_stop(){
        // An isolated fake native owner; never attaches to or stops a real
        // installed SuperAgent Tray, Core, MCP, or Cloudflare process.
        let listener=TcpListener::bind(("127.0.0.1",0)).unwrap();
        let port=listener.local_addr().unwrap().port();
        let owner=TrayOwner{version:1,pid:std::process::id(),
            instance_id:uuid::Uuid::new_v4().simple().to_string(),
            token:private_random_hex(),control_port:port,
            executable_path:"isolated-test".into()};
        let server_owner=owner.clone();
        let server=thread::spawn(move||{
            let mut stopped=false;
            for _ in 0..3{
                let (stream,_)=listener.accept().unwrap();
                stopped=handle(stream,&server_owner);
            }
            stopped
        });
        let health=tray_private_request(&owner,"GET",None).unwrap();
        assert_eq!(health["service"].as_str(),Some("superagent-tray"));
        assert_eq!(health["pid"].as_u64(),Some(owner.pid as u64));
        assert_eq!(health["instanceId"].as_str(),Some(owner.instance_id.as_str()));
        let mut wrong_token=owner.clone();
        wrong_token.token=private_random_hex();
        assert!(tray_private_request(&wrong_token,"GET",None).is_err());
        assert!(request_graceful_replacement(&owner).is_ok());
        assert!(server.join().unwrap());
    }
}
