//! Cloudflare Named Tunnel settings for SuperAgent Tray.
//! These are desired-state metadata ONLY: never store token bytes or activate
//! a connector/MCP owner as a side effect of loading or saving preferences.
//! An isolated token-file / credentials-file remains external to this record.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedTunnelSettings {
    pub version: u8,
    pub connector_mode: String,
    pub tunnel_id: String,
    pub hostname: String,
    pub anchor_port: u16,
    pub owner_port: u16,
    pub token_file_path: String,
    pub credentials_file_path: String,
    pub cloudflared_path: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTunnelView {
    pub settings: NamedTunnelSettings,
    pub configured: bool,
    pub credential_file_present: bool,
    pub cloudflared_present: bool,
    pub connection_verified: bool,
    pub dns_verified: bool,
    pub activated: bool,
    pub activation_requires_review: bool,
    pub status: &'static str,
}

impl Default for NamedTunnelSettings {
    fn default() -> Self {
        Self {
            version: 1,
            connector_mode: "remote-managed".to_string(),
            tunnel_id: String::new(),
            hostname: String::new(),
            anchor_port: 19320,
            owner_port: 19321,
            token_file_path: String::new(),
            credentials_file_path: String::new(),
            cloudflared_path: String::new(),
        }
    }
}
fn uuid_valid(value: &str) -> bool {
    if value.len()!=36{return false;}
    value.chars().enumerate().all(|(i,c)| {
        if [8,13,18,23].contains(&i){c=='-'}else{c.is_ascii_hexdigit() && !c.is_ascii_uppercase()}
    }) && matches!(value.as_bytes()[14],b'1'..=b'8') &&
        matches!(value.as_bytes()[19],b'8'|b'9'|b'a'|b'b')
}
fn hostname_valid(value: &str) -> bool {
    value.len()>=4 && value.len()<=253 && value == value.to_ascii_lowercase()
        && !value.ends_with(".trycloudflare.com")
        && !value.ends_with(".cfargotunnel.com")
        && value.split('.').count()>=3
        && value.split('.').all(|label| {
            label.len()<=63 && !label.is_empty() &&
            label.as_bytes()[0].is_ascii_alphanumeric() &&
            label.as_bytes()[label.len()-1].is_ascii_alphanumeric() &&
            label.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-')
        })
}
fn credential_path_ok(raw:&str)->bool{
    !raw.is_empty() && raw.len()<=512 && Path::new(raw).is_absolute() &&
        // Reject UNC/network shares and extended device paths for credentials.
        (!cfg!(windows) || (raw.as_bytes().len()>=3 &&
            raw.as_bytes()[0].is_ascii_alphabetic() && raw.as_bytes()[1]==b':' &&
            matches!(raw.as_bytes()[2], b'\\' | b'/'))) &&
        !raw.bytes().any(|b|b==0||b==b'\n'||b==b'\r'||b==b'"'||b==b'\'')
}
fn safe_regular_file(path:&str,max:u64)->bool{
    if !credential_path_ok(path){return false;}
    fs::symlink_metadata(path).map(|m|
        m.file_type().is_file() && m.len()>0 && m.len()<=max
    ).unwrap_or(false)
}
impl NamedTunnelSettings {
    pub fn validate(&self)->Result<(),String>{
        if self.version!=1{return Err("Unsupported Named Tunnel settings version".into());}
        if !matches!(self.connector_mode.as_str(),"remote-managed"|"local-managed"){
            return Err("Unsupported Named Tunnel connector mode".into());
        }
        if self.anchor_port<1024||self.owner_port<1024||
            [9227,7888,6759,6789,9877].contains(&self.anchor_port)||
            [9227,7888,6759,6789,9877].contains(&self.owner_port)||
            self.anchor_port==self.owner_port{
            return Err("Named Tunnel ports must be unique and not use protected services".into());
        }
        let initial=self.tunnel_id.is_empty() && self.hostname.is_empty() &&
            self.token_file_path.is_empty() && self.credentials_file_path.is_empty() &&
            self.cloudflared_path.is_empty();
        if initial{return Ok(());}
        if !uuid_valid(&self.tunnel_id){return Err("Invalid Cloudflare tunnel UUID".into());}
        if !hostname_valid(&self.hostname){return Err("Invalid operator-owned hostname".into());}
        if !self.token_file_path.is_empty() && !credential_path_ok(&self.token_file_path){
            return Err("Token file path must be an absolute local file path".into());
        }
        if !self.credentials_file_path.is_empty() && !credential_path_ok(&self.credentials_file_path){
            return Err("Credentials file path must be absolute".into());
        }
        if !self.cloudflared_path.is_empty() &&
            (!credential_path_ok(&self.cloudflared_path) ||
            !matches!(Path::new(&self.cloudflared_path).file_name().and_then(|x|x.to_str()),
                Some("cloudflared.exe"|"cloudflared"))){
            return Err("cloudflared must be an absolute executable path".into());
        }
        if self.connector_mode=="remote-managed"&&!self.credentials_file_path.is_empty()||
           self.connector_mode=="local-managed"&&!self.token_file_path.is_empty(){
            return Err("Remote token-file and locally managed credentials cannot be mixed".into());
        }
        Ok(())
    }
    pub fn configured(&self)->bool{
        uuid_valid(&self.tunnel_id)&&hostname_valid(&self.hostname)
    }
    pub fn inspect(&self)->NamedTunnelView{
        let path=if self.connector_mode=="remote-managed"{
            &self.token_file_path
        }else{&self.credentials_file_path};
        let credential_file_present=safe_regular_file(path,8192);
        let cloudflared_present=safe_regular_file(&self.cloudflared_path,300_000_000);
        NamedTunnelView{
            settings:self.clone(),configured:self.configured(),
            credential_file_present,cloudflared_present,
            connection_verified:false,dns_verified:false,activated:false,
            activation_requires_review:true,
            status:if !self.configured(){"not_configured"}
                   else if !credential_file_present{"credential_file_missing"}
                   else if !cloudflared_present{"cloudflared_missing"}
                   else{"configured_not_connected"},
        }
    }
}
fn settings_file(dir:&Path)->PathBuf{dir.join("mcp-named-tunnel-settings.json")}
pub fn load(dir:&Path)->Result<NamedTunnelSettings,String>{
    let f=settings_file(dir);
    let m=match fs::symlink_metadata(&f){
        Ok(m)=>m,
        Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(NamedTunnelSettings::default()),
        Err(_)=>return Err("Cannot inspect Named Tunnel settings".into()),
    };
    if !m.file_type().is_file()||m.len()>8192{
        return Err("Named Tunnel settings must be a regular bounded file".into());
    }
    let v:NamedTunnelSettings=serde_json::from_slice(&fs::read(f)
        .map_err(|_|"Cannot read Named Tunnel settings")?)
        .map_err(|_|"Named Tunnel settings are invalid")?;
    v.validate()?;Ok(v)
}
pub fn save(dir:&Path,v:&NamedTunnelSettings)->Result<(),String>{
    v.validate()?;
    fs::create_dir_all(dir).map_err(|_|"Named Tunnel settings directory unavailable")?;
    if fs::symlink_metadata(dir).map_err(|_|"Cannot inspect settings directory")?
        .file_type().is_symlink(){
        return Err("Settings directory must not be a symlink".into());
    }
    let file=settings_file(dir);
    if let Ok(meta)=fs::symlink_metadata(&file){
        if !meta.file_type().is_file(){return Err("Settings file is not regular".into());}
    }
    let bytes=serde_json::to_vec_pretty(v).map_err(|_|"Cannot serialize Named Tunnel settings")?;
    let n=SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_|"System clock unavailable")?.as_nanos();
    let tmp=dir.join(format!("mcp-named-settings-{}-{n}.tmp",std::process::id()));
    {
        let mut output=OpenOptions::new().write(true).create_new(true).open(&tmp)
            .map_err(|_|"Cannot prepare Named Tunnel settings write")?;
        if output.write_all(&bytes).and_then(|_|output.sync_all()).is_err(){
            let _=fs::remove_file(&tmp);
            return Err("Cannot persist Named Tunnel settings".into());
        }
    }
    if fs::rename(&tmp,file).is_err(){
        let _=fs::remove_file(&tmp);
        return Err("Cannot atomically replace Named Tunnel settings".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests{
    use super::*;
    fn tempdir()->PathBuf{
        std::env::temp_dir().join(format!("superagent-named-cf-test-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()))
    }
    #[test]
    fn named_settings_roundtrip_without_token_or_runtime_mutation(){
        let dir=tempdir();
        let mut s=load(&dir).unwrap();
        assert_eq!(s.inspect().status,"not_configured");
        s.tunnel_id="b2e8c6d9-9317-4d9e-b381-826af22e1778".into();
        s.hostname="mcp.rcity.web.id".into();
        s.token_file_path=dir.join("connector.token").to_string_lossy().into();
        save(&dir,&s).unwrap();
        assert_eq!(load(&dir).unwrap(),s);
        // Saving again must be safe on Windows, without changing other files.
        save(&dir,&s).unwrap();
        assert_eq!(load(&dir).unwrap(),s);
        assert_eq!(s.inspect().status,"credential_file_missing");
        assert!(!dir.join("mcp-owner-9227.json").exists());
        assert!(!dir.join("tunnel-state.json").exists());
        let _=fs::remove_dir_all(dir);
    }
    #[test]
    fn invalid_or_mixed_credentials_are_rejected(){
        let mut s=NamedTunnelSettings::default();
        s.tunnel_id="b2e8c6d9-9317-4d9e-b381-826af22e1778".into();
        s.hostname="mcp.rcity.web.id".into();
        assert!(s.validate().is_ok());
        s.hostname="mcp.trycloudflare.com".into();
        assert!(s.validate().is_err());
        s.hostname="mcp.rcity.web.id".into();
        s.token_file_path="eyJhIjoiTokenHere".into();
        assert!(s.validate().is_err());
        s.token_file_path="/tmp/token.file".into();
        s.credentials_file_path="/tmp/other.json".into();
        assert!(s.validate().is_err());
        s.credentials_file_path.clear();
        s.owner_port=s.anchor_port;
        assert!(s.validate().is_err());
    }
}
