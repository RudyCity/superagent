//! Remote-managed Cloudflare connector. Never accepts token bytes from the WebView.
//! All mutations require a verified tunnel identity and explicit review.
//! The remote-managed connector is independent of the MCP Quick Tunnel owner.
use crate::named_tunnel_settings::{self, NamedTunnelSettings, NamedTunnelView};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use sysinfo::{Pid, System};
use tauri_plugin_dialog::DialogExt;

const MAX_TOKEN_BYTES: usize = 4096;
const KIND: &str = "cloudflare_named_remote_connector";
static CONNECTOR_ACTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorLease {
    pub version: u8,
    pub kind: String,
    pub pid: u32,
    pub process_start_seconds: u64,
    pub tunnel_id: String,
    pub hostname: String,
    pub token_file_path: String,
    pub cloudflared_path: String,
    pub anchor_port: u16,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub tunnel_id: String,
    pub hostname: String,
    pub token_verified: bool,
    pub running: bool,
    pub owned: bool,
    pub pid: Option<u32>,
    pub status: &'static str,
    pub auto_restart: bool,
    pub quick_tunnel_untouched: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorActionResult {
    pub action: String,
    pub status: ConnectorStatus,
    pub reviewed: bool,
    pub no_quick_tunnel_mutation: bool,
}

fn read_token(data: &[u8], tunnel_id: &str) -> Result<(), String> {
    let text = std::str::from_utf8(data)
        .map_err(|_|"Cloudflare token is not UTF-8")?.trim();
    if text.len()<70 || text.len()>MAX_TOKEN_BYTES ||
        !text.bytes().all(|b|b.is_ascii_alphanumeric()||b=='-' as u8||b=='_' as u8||b=='=' as u8) {
        return Err("Cloudflare token has an unsupported format".into());
    }
    let decoded=general_purpose::URL_SAFE_NO_PAD.decode(text)
        .or_else(|_|general_purpose::STANDARD.decode(text))
        .map_err(|_|"Cloudflare token cannot be decoded")?;
    if decoded.len()>4096{return Err("Cloudflare token payload is oversized".into());}
    let value:Value=serde_json::from_slice(&decoded)
        .map_err(|_|"Cloudflare token payload is not JSON")?;
    let id=value.get("t").or_else(||value.get("TunnelID"))
        .and_then(Value::as_str).unwrap_or("");
    if id!=tunnel_id{return Err("Cloudflare token belongs to a different tunnel".into());}
    // A token cannot be used to recover/rotate the tunnel unless the Cloudflare
    // account and secret fields are present. Never return those fields.
    let account=value.get("a").or_else(||value.get("AccountTag"))
        .and_then(Value::as_str).unwrap_or("");
    let secret=value.get("s").or_else(||value.get("TunnelSecret"))
        .and_then(Value::as_str).unwrap_or("");
    if account.len()<8||secret.len()<8{
        return Err("Cloudflare token is missing required fields".into());
    }
    Ok(())
}
fn token_file(path:&str,tunnel_id:&str)->Result<(),String>{
    let file=Path::new(path);
    if !file.is_absolute(){return Err("Cloudflare token file must be absolute".into());}
    let meta=fs::symlink_metadata(file)
        .map_err(|_|"Cloudflare token file does not exist")?;
    if !meta.file_type().is_file()||meta.len()==0||meta.len()>MAX_TOKEN_BYTES as u64{
        return Err("Cloudflare token file is unsafe".into());
    }
    read_token(&fs::read(file).map_err(|_|"Cannot read Cloudflare token file")?,tunnel_id)
}
fn lease_file(dir:&Path,tunnel_id:&str)->PathBuf{
    dir.join(format!("mcp-named-connector-{tunnel_id}.json"))
}
pub fn lease_present(dir:&Path,tunnel_id:&str)->bool{
    !tunnel_id.is_empty() && fs::symlink_metadata(lease_file(dir,tunnel_id)).is_ok()
}
fn read_lease(dir:&Path,tunnel_id:&str)->Result<Option<ConnectorLease>,String>{
    let path=lease_file(dir,tunnel_id);
    let meta=match fs::symlink_metadata(&path){
        Ok(m)=>m,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),
        Err(_)=>return Err("Connector lease could not be inspected".into()),
    };
    if !meta.file_type().is_file()||meta.len()>4096||meta.len()<50{
        return Err("Unsafe connector lease".into());
    }
    let lease:ConnectorLease=serde_json::from_slice(&fs::read(&path)
        .map_err(|_|"Cannot read connector lease")?)
        .map_err(|_|"Invalid connector lease")?;
    if lease.version!=1||lease.kind!=KIND||lease.tunnel_id!=tunnel_id||
       lease.pid==0||lease.process_start_seconds==0{
        return Err("Connector lease identity mismatch".into());
    }
    Ok(Some(lease))
}
fn verified_process(lease:&ConnectorLease)->bool{
    let mut system=System::new();
    system.refresh_processes();
    let Some(proc)=system.process(Pid::from_u32(lease.pid)) else{return false;};
    if proc.start_time()!=lease.process_start_seconds{return false;}
    if proc.name().to_ascii_lowercase()!=
        (if cfg!(windows){"cloudflared.exe"}else{"cloudflared"}){
        return false;
    }
    let actual=proc.exe().and_then(|p|p.canonicalize().ok());
    let expected=Path::new(&lease.cloudflared_path).canonicalize().ok();
    if actual.is_none()||actual!=expected{return false;}
    let args:Vec<String>=proc.cmd().iter().map(|x|x.to_string()).collect();
    let has_token=args.windows(2).any(|x|
        x[0]=="--token-file"&&x[1]==lease.token_file_path);
    let has_run=args.windows(2).any(|x|x[0]=="tunnel"&&x[1]=="run");
    let leaks=args.iter().any(|x|
        x=="--token"||x=="--url"||x=="--credentials-contents");
    has_token&&has_run&&!leaks
}
fn private_token_file(dir:&Path,s:&NamedTunnelSettings)->Result<(),String>{
    let expected=dir.join("private").join("cloudflare-named")
        .join(format!("{}.token",s.tunnel_id));
    if s.token_file_path!=expected.to_string_lossy(){
        return Err("Import the Cloudflare token using the native file picker first".into());
    }
    let folder=fs::symlink_metadata(expected.parent().unwrap())
        .map_err(|_|"Private token directory is unavailable")?;
    if !folder.file_type().is_dir(){return Err("Private token directory is unsafe".into());}
    token_file(&s.token_file_path,&s.tunnel_id)
}
pub fn status(dir:&Path,s:&NamedTunnelSettings)->ConnectorStatus{
    let mut result=ConnectorStatus{
        tunnel_id:s.tunnel_id.clone(),hostname:s.hostname.clone(),
        token_verified:false,running:false,owned:false,pid:None,
        status:"not_configured",auto_restart:false,quick_tunnel_untouched:true,
    };
    if !s.configured(){return result;}
    if s.connector_mode!="remote-managed"{
        result.status="local_managed_outside_connector_control";return result;
    }
    result.token_verified=private_token_file(dir,s).is_ok();
    if !result.token_verified{
        result.status="token_missing_or_invalid";return result;
    }
    let lease=match read_lease(dir,&s.tunnel_id){
        Ok(x)=>x,
        Err(_)=>{result.status="lease_unverified";return result;},
    };
    let Some(lease)=lease else{result.status="not_started";return result};
    if lease.hostname!=s.hostname||lease.anchor_port!=s.anchor_port||
       lease.token_file_path!=s.token_file_path||
       lease.cloudflared_path!=s.cloudflared_path{
        result.status="lease_mismatch";return result;
    }
    if !verified_process(&lease){
        result.status="process_unverified";return result;
    }
    result.running=true;result.owned=true;result.pid=Some(lease.pid);
    result.status="verified_local_only";result
}
#[cfg(windows)]
fn restrict_acl(path:&Path,is_directory:bool)->Result<(),String>{
    let who=Command::new("whoami.exe").args(["/user","/fo","csv","/nh"])
        .output().map_err(|_|"Cannot verify current Windows user SID")?;
    if !who.status.success(){return Err("Cannot verify Windows user SID".into());}
    let data=String::from_utf8_lossy(&who.stdout);
    let sid=data.split(',').nth(1).unwrap_or("").trim()
        .trim_matches('"').trim();
    if !sid.starts_with("S-1-")||!sid.chars().all(|c|c.is_ascii_alphanumeric()||c=='-'){
        return Err("Windows user SID could not be parsed".into());
    }
    let rule=if is_directory{format!("*{sid}:(OI)(CI)F")}else{format!("*{sid}:F")};
    let status=Command::new("icacls.exe").arg(path)
        .args(["/inheritance:r","/grant:r",&rule])
        .stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|_|"Cannot set private Windows ACL")?;
    if !status.success(){return Err("Private Windows ACL was rejected".into());}
    Ok(())
}
#[cfg(not(windows))]
fn restrict_acl(path:&Path,is_directory:bool)->Result<(),String>{
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path,fs::Permissions::from_mode(if is_directory{0o700}else{0o600}))
        .map_err(|_|"Cannot set private file permissions".into())
}
fn install_token(dir:&Path,s:&NamedTunnelSettings,source:&Path)->Result<NamedTunnelView,String>{
    if s.connector_mode!="remote-managed"||!s.configured(){
        return Err("Configure a remote-managed Named Tunnel first".into());
    }
    let meta=fs::symlink_metadata(source).map_err(|_|"Selected token file does not exist")?;
    if !meta.file_type().is_file()||meta.len()==0||meta.len()>MAX_TOKEN_BYTES as u64{
        return Err("Selected token file is unsafe".into());
    }
    let bytes=fs::read(source).map_err(|_|"Cannot read selected token file")?;
    read_token(&bytes,&s.tunnel_id)?;
    if status(dir,s).running{return Err("Cannot replace token while connector is running".into());}
    let secret_dir=dir.join("private").join("cloudflare-named");
    fs::create_dir_all(&secret_dir).map_err(|_|"Cannot create private credentials directory")?;
    if fs::symlink_metadata(&secret_dir).map_err(|_|"Cannot inspect credentials directory")?
        .file_type().is_symlink(){
        return Err("Credentials directory is not private".into());
    }
    restrict_acl(&secret_dir,true)?;
    let destination=secret_dir.join(format!("{}.token",s.tunnel_id));
    if let Ok(m)=fs::symlink_metadata(&destination){
        if !m.file_type().is_file(){return Err("Existing credentials path is unsafe".into());}
        if fs::read(&destination).map_err(|_|"Cannot inspect installed token")?!=bytes{
            return Err("A different token is already installed; rotate it with an explicit separate operation".into());
        }
    }else{
        let mut out=OpenOptions::new().write(true).create_new(true).open(&destination)
            .map_err(|_|"Cannot create private token file")?;
        if out.write_all(&bytes).and_then(|_|out.sync_all()).is_err(){
            let _=fs::remove_file(&destination);
            return Err("Cannot write private token file".into());
        }
    }
    if let Err(e)=restrict_acl(&destination,false){
        let _=fs::remove_file(&destination);
        return Err(e);
    }
    let mut updated=s.clone();
    updated.token_file_path=destination.to_string_lossy().into_owned();
    named_tunnel_settings::save(dir,&updated)?;
    Ok(updated.inspect())
}
#[tauri::command]
pub async fn pick_named_tunnel_token(
    app:tauri::AppHandle,
    window:tauri::WebviewWindow,
)->Result<Option<NamedTunnelView>,String>{
    if window.label()!="main"{return Err("Named Tunnel setup requires the main Tray window".into());}
    let source=tauri::async_runtime::spawn_blocking(move||{
        app.dialog().file()
            .add_filter("Cloudflare token", &["token","txt"])
            .add_filter("All files",&["*"]).blocking_pick_file()
    }).await.map_err(|_|"Native token file picker failed")?;
    let Some(source)=source else{return Ok(None)};
    let path=source.into_path().map_err(|_|"Only local token files are supported")?;
    let dir=super::config_dir()?;
    let settings=named_tunnel_settings::load(&dir)?;
    let result=tauri::async_runtime::spawn_blocking(move||
        install_token(&dir,&settings,&path))
        .await.map_err(|_|"Token import task failed")??;
    Ok(Some(result))
}
pub fn plan(dir:&Path,s:&NamedTunnelSettings)->Result<ConnectorActionResult,String>{
    s.validate()?;
    if s.connector_mode!="remote-managed"{
        return Err("Connector lifecycle supports only remote-managed tunnels".into());
    }
    if !s.configured(){return Err("Named Tunnel identity is incomplete".into());}
    private_token_file(dir,s)?;
    let binary=fs::symlink_metadata(&s.cloudflared_path)
        .map_err(|_|"cloudflared is not installed at the configured path")?;
    if !binary.file_type().is_file()||binary.len()<1024{
        return Err("cloudflared executable is invalid".into());
    }
    let stat=status(dir,s);
    if matches!(stat.status,"lease_unverified"|"lease_mismatch"|"process_unverified"){
        return Err("Connector identity is ambiguous; operator reconciliation required".into());
    }
    Ok(ConnectorActionResult{
        action:"plan".into(),status:stat,reviewed:false,
        no_quick_tunnel_mutation:true,
    })
}
pub fn action(dir:&Path,s:&NamedTunnelSettings,action:&str,expected_tunnel_id:&str,reviewed:bool)
    ->Result<ConnectorActionResult,String>{
    if !matches!(action,"start"|"stop")||!reviewed||expected_tunnel_id!=s.tunnel_id{
        return Err("Connector action requires exact tunnel ID and explicit review".into());
    }
    let _guard=CONNECTOR_ACTION_LOCK.lock()
        .map_err(|_|"Another Named Tunnel lifecycle action is in progress")?;
    let preflight=plan(dir,s)?;
    if action=="start"{
        if preflight.status.running{
            return Err("Named connector is already running".into());
        }
        if read_lease(dir,&s.tunnel_id)?.is_some(){
            return Err("Existing connector lease requires operator reconciliation".into());
        }
        let mut child=Command::new(&s.cloudflared_path);
        child.args(["tunnel","run","--token-file",&s.token_file_path])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // Never carry credentials from inherited environment.
        for key in ["TUNNEL_TOKEN","TUNNEL_CRED_CONTENTS","TUNNEL_TOKEN_FILE"] {
            child.env_remove(key);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x0800_0000);
        }
        let mut process=child.spawn().map_err(|_|"Could not start Cloudflare named connector")?;
        let pid=process.id();
        let mut system=System::new();
        let mut born=0;
        for _ in 0..12{
            system.refresh_processes();
            if let Some(p)=system.process(Pid::from_u32(pid)){born=p.start_time();if born>0{break;}}
            std::thread::sleep(Duration::from_millis(100));
        }
        if born==0{
            // Only terminate this exact freshly spawned Child, not a guessed
            // PID or a pre-existing Quick Tunnel/cloudflared service.
            let _=process.kill();
            let _=process.wait();
            return Err("Connector start failed OS identity verification".into());
        }
        if process.try_wait().map_err(|_|"Cannot inspect new connector process")?.is_some(){
            return Err("cloudflared exited before connector registration".into());
        }
        let lease=ConnectorLease{version:1,kind:KIND.into(),pid,
            process_start_seconds:born,tunnel_id:s.tunnel_id.clone(),
            hostname:s.hostname.clone(),anchor_port:s.anchor_port,
            token_file_path:s.token_file_path.clone(),
            cloudflared_path:s.cloudflared_path.clone()};
        fs::create_dir_all(dir).map_err(|_|"Cannot create connector registration directory")?;
        let path=lease_file(dir,&s.tunnel_id);
        // A lease creation error must never leave an unregistered connector.
        let write_result=(||->Result<(),String>{
            let mut out=OpenOptions::new().create_new(true).write(true).open(&path)
                .map_err(|_|"Connector lease creation failed")?;
            out.write_all(&serde_json::to_vec(&lease)
                .map_err(|_|"Cannot serialize connector identity")?)
                .and_then(|_|out.sync_all())
                .map_err(|_|"Cannot persist connector owner lease")?;
            Ok(())
        })();
        if let Err(error)=write_result{
            let _=process.kill();
            let _=process.wait();
            return Err(error);
        }
    }else{
        let lease=read_lease(dir,&s.tunnel_id)?
            .ok_or("Named connector has no owned registration")?;
        if !verified_process(&lease)||lease.hostname!=s.hostname||
            lease.cloudflared_path!=s.cloudflared_path||
            lease.token_file_path!=s.token_file_path{
            return Err("Refusing to terminate an unverified connector PID".into());
        }
        let mut system=System::new();
        system.refresh_processes();
        let proc=system.process(Pid::from_u32(lease.pid))
            .ok_or("Owned connector process disappeared")?;
        if proc.start_time()!=lease.process_start_seconds||!proc.kill(){
            return Err("Could not stop the exact verified Named Tunnel process".into());
        }
        fs::remove_file(lease_file(dir,&s.tunnel_id))
            .map_err(|_|"Could not remove connector owner registration")?;
    }
    Ok(ConnectorActionResult{action:action.into(),status:status(dir,s),
        reviewed:true,no_quick_tunnel_mutation:true})
}
#[cfg(test)]
mod tests{
    use super::*;
    fn sample()->NamedTunnelSettings{
        let mut s=NamedTunnelSettings::default();
        s.tunnel_id="b2e8c6d9-9317-4d9e-b381-826af22e1778".into();
        s.hostname="mcp.rcity.web.id".into();s
    }
    fn fixture()->Vec<u8>{
        let v=serde_json::json!({"a":"sample-account","t":"b2e8c6d9-9317-4d9e-b381-826af22e1778","s":"sample-secret-123"});
        general_purpose::URL_SAFE_NO_PAD.encode(v.to_string()).into_bytes()
    }
    #[test]
    fn verifies_token_identity_without_exposing_secret(){
        assert!(read_token(&fixture(),&sample().tunnel_id).is_ok());
        assert!(read_token(&fixture(),"b2e8c6d9-9317-4d9e-b381-826af22e1779").is_err());
        assert!(read_token(b"not-a-token",&sample().tunnel_id).is_err());
    }
    #[test]
    fn blocks_connector_action_without_explicit_review(){
        let s=sample();
        let dir=std::env::temp_dir();
        assert!(action(&dir,&s,"start",&s.tunnel_id,false).is_err());
        assert!(action(&dir,&s,"stop","wrong-id",true).is_err());
        assert!(action(&dir,&s,"restart",&s.tunnel_id,true).is_err());
    }
    #[test]
    fn imports_verified_token_into_private_profile_without_exposing_its_content(){
        let base=std::env::temp_dir().join(format!(
            "mcp-named-token-import-{}-{}",
            std::process::id(),std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&base).unwrap();
        let source=base.join("source.txt");
        fs::write(&source,fixture()).unwrap();
        let s=sample();
        let mut untrusted=s.clone();
        untrusted.token_file_path=source.to_string_lossy().into_owned();
        assert!(!status(&base,&untrusted).token_verified);
        assert!(plan(&base,&untrusted).is_err());
        let imported=install_token(&base,&s,&source).expect("Private token import");
        assert!(imported.credential_file_present);
        assert!(!imported.connection_verified);
        assert!(!imported.activated);
        let saved=named_tunnel_settings::load(&base).unwrap();
        assert!(!saved.token_file_path.is_empty());
        assert_ne!(saved.token_file_path,source.to_string_lossy());
        assert_eq!(fs::read(&saved.token_file_path).unwrap(),fixture());
        let prefs=fs::read_to_string(base.join("mcp-named-tunnel-settings.json")).unwrap();
        assert!(!prefs.contains("sample-secret-123"));
        assert!(install_token(&base,&s,&source).is_ok());
        let _=fs::remove_dir_all(&base);
    }
    #[test]
    fn refuses_missing_credentials_before_starting_binary(){
        let s=sample();
        let dir=std::env::temp_dir();
        assert!(plan(&dir,&s).is_err());
    }
}
