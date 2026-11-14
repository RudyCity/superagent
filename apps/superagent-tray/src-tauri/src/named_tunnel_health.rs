//! Read-only Cloudflare Named Tunnel diagnosis. Remote requests never contain
//! MCP credentials or Cloudflare tokens. A healthy local connector is not proof
//! of valid OAuth, a reachable edge, or a safe client cutover.
use crate::{named_tunnel_connector, named_tunnel_settings::NamedTunnelSettings};
use reqwest::{Client, redirect::Policy};
use serde::Serialize;
use serde_json::Value;
use std::{fs,path::Path,time::Duration};
use sysinfo::{Pid,System};
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub struct NamedTunnelHealth {
    pub hostname:String,
    pub tunnel_id:String,
    pub connector_status:String,
    pub connector_pid:Option<u32>,
    pub token_verified:bool,
    pub anchor_status:String,
    pub owner_status:String,
    pub edge_http_status:Option<u16>,
    pub edge_observed:bool,
    pub mcp_auth_challenge_observed:bool,
    pub ready_for_cutover:bool,
    pub quick_tunnel_untouched:bool,
    pub reason:String,
}
fn birth_verified(pid:u32,created_at:u64)->bool{
    if pid==0||created_at==0{return false;}
    let mut sys=System::new();
    sys.refresh_processes();
    sys.process(Pid::from_u32(pid)).map_or(false,|p|{
        p.start_time().saturating_mul(1000)<=created_at.saturating_add(5000)
        && p.start_time().saturating_mul(1000).saturating_add(5000)>=created_at
    })
}
fn read_json(dir:&Path,name:&str,max:u64)->Result<Value,String>{
    let path=dir.join(name);
    let meta=fs::symlink_metadata(&path)
        .map_err(|_|"Private owner lease unavailable")?;
    if !meta.file_type().is_file()||meta.len()==0||meta.len()>max{
        return Err("Private owner lease unsafe".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|_|"Private owner lease unreadable")?)
        .map_err(|_|"Private owner lease malformed".into())
}
async fn authenticated_status(client:&Client,port:u16,nonce:&str,resource:&str)
    ->Result<Value,String>{
    if nonce.len()!=64||!nonce.bytes().all(|b|b.is_ascii_hexdigit()){
        return Err("Private control token invalid".into());
    }
    let response=client.get(format!("http://127.0.0.1:{port}{resource}"))
        .header(reqwest::header::HOST,format!("127.0.0.1:{port}"))
        .bearer_auth(nonce)
        .send().await.map_err(|_|"Private loopback status unavailable")?;
    if response.status()!=reqwest::StatusCode::OK{
        return Err("Private loopback authentication failed".into());
    }
    let bytes=response.bytes().await.map_err(|_|"Invalid private status response")?;
    if bytes.len()>8192{return Err("Private status response too large".into());}
    serde_json::from_slice(&bytes).map_err(|_|"Private status response invalid".to_string())
}
pub async fn inspect(dir:&Path,s:&NamedTunnelSettings)->Result<NamedTunnelHealth,String>{
    s.validate()?;
    let connector=named_tunnel_connector::status(dir,s);
    let mut health=NamedTunnelHealth{
        hostname:s.hostname.clone(),tunnel_id:s.tunnel_id.clone(),
        connector_status:connector.status.into(),connector_pid:connector.pid,
        token_verified:connector.token_verified,
        anchor_status:"not_verified".into(),owner_status:"not_verified".into(),
        edge_http_status:None,edge_observed:false,mcp_auth_challenge_observed:false,
        ready_for_cutover:false,quick_tunnel_untouched:true,
        reason:"Independent connector, Anchor, MCP OAuth and client authorization require verification".into(),
    };
    if !s.configured(){
        health.reason="Configure an operator-owned Named Tunnel first".into();
        return Ok(health);
    }
    let client=Client::builder().timeout(Duration::from_secs(4))
        .redirect(Policy::none()).build()
        .map_err(|_|"Cannot create secure health observer")?;
    let anchor=read_json(dir,&format!("mcp-tunnel-anchor-{}.json",s.anchor_port),4096);
    if let Ok(a)=anchor{
        let id_ok=a["version"]==1&&a["kind"]=="mcp_tunnel_anchor"&&
            a["port"]==s.anchor_port&&a["tunnelMode"]=="named-external"&&
            a["publicUrl"]==format!("https://{}/mcp",s.hostname);
        let pid=a["pid"].as_u64().and_then(|p|u32::try_from(p).ok()).unwrap_or(0);
        let born=a["createdAt"].as_u64().unwrap_or(0);
        if id_ok&&birth_verified(pid,born){
            if let Some(nonce)=a["nonce"].as_str(){
                if let Ok(status)=authenticated_status(&client,s.anchor_port,nonce,
                    "/_internal/anchor/status").await{
                    let attested=status["kind"]=="mcp_tunnel_anchor"&&
                        status["pid"]==pid&&status["port"]==s.anchor_port&&
                        status["startedAt"]==born&&
                        status["tunnelMode"]=="named-external"&&
                        status["publicUrl"]==format!("https://{}/mcp",s.hostname);
                    if attested{
                        health.anchor_status="verified_local".into();
                        let owner_pid=status["currentOwnerPid"].as_u64()
                            .and_then(|p|u32::try_from(p).ok()).unwrap_or(0);
                        if owner_pid>0&&status["currentOwnerPort"]==s.owner_port &&
                            status["ready"]==true{
                            if let Ok(o)=read_json(dir,
                                &format!("mcp-owner-{}.json",s.owner_port),4096){
                                let started=o["createdAt"].as_u64().unwrap_or(0);
                                if o["kind"]=="managed_mcp_tunnel_owner"&&
                                    o["pid"]==owner_pid&&o["port"]==s.owner_port&&
                                    birth_verified(owner_pid,started){
                                    if let Some(owner_nonce)=o["nonce"].as_str(){
                                        if let Ok(os)=authenticated_status(&client,s.owner_port,
                                            owner_nonce,"/_internal/owner/status").await{
                                            if os["kind"]=="private_mcp_owner"&&
                                                os["pid"]==owner_pid&&
                                                os["startedAt"]==started&&
                                                os["publicUrl"]==format!("https://{}/mcp",s.hostname)&&
                                                os["ingressMode"]=="external-anchor"&&
                                                os["backendHealthy"]==true&&os["draining"]==false {
                                                health.owner_status="verified_local".into();
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    // Fixed user-approved hostname only. Do not send any authorization,
    // cookies, or Cloudflare credentials to this externally reachable URL.
    if let Ok(response)=client.head(format!("https://{}/mcp",s.hostname)).send().await{
        let status=response.status().as_u16();
        health.edge_http_status=Some(status);
        health.edge_observed=![502,503,520,521,522,523,524,525,526,530].contains(&status);
        let challenge=response.headers().get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|h|h.to_str().ok()).unwrap_or("");
        health.mcp_auth_challenge_observed=
            status==401&&challenge.to_ascii_lowercase().contains("bearer");
    }
    health.reason=if health.connector_status!="verified_local_only" {
        "Connector not verified; do not attempt client cutover".into()
    }else if health.anchor_status!="verified_local"{
        "Independent Named Tunnel Anchor not verified".into()
    }else if health.owner_status!="verified_local"{
        "Private MCP owner not attached or not healthy".into()
    }else if !health.mcp_auth_challenge_observed{
        "Public MCP OAuth challenge not verified end to end".into()
    }else{
        "Local/edge evidence available; Gemini PKCE, tools and client authorization still need explicit validation".into()
    };
    // A HEAD challenge, Cloudflare TLS and a local owner never prove Gemini
    // authorization. Only an owner-approved end-to-end client test/cutover
    // may change the active MCP URL.
    health.ready_for_cutover=false;
    Ok(health)
}
#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn birth_verification_refuses_missing_and_stale_processes(){
        assert!(!birth_verified(0,1));
        assert!(!birth_verified(u32::MAX,123));
    }
    #[test]
    fn named_health_has_no_mutating_action_or_token_field(){
        let mut s=NamedTunnelSettings::default();
        s.tunnel_id="b2e8c6d9-9317-4d9e-b381-826af22e1778".into();
        s.hostname="mcp.rcity.web.id".into();
        let empty=named_tunnel_connector::status(std::env::temp_dir().as_path(),&s);
        assert!(!empty.running);
        assert!(!empty.token_verified);
    }
}
