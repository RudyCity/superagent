//! Import a remote-managed tunnel token directly from the OS clipboard.
//! Explicit native approval and a bounded, fixed OS clipboard reader. Token
//! bytes never enter the WebView, terminal command line, logs or process args.
use crate::{
    named_tunnel_connector::install_token_bytes,
    named_tunnel_settings::{self,NamedTunnelView},
};
use std::{
    io::Read,
    process::{Command,Stdio},
};
use tauri_plugin_dialog::{DialogExt,MessageDialogButtons};

const MAX_CLIPBOARD_BYTES:usize=16*1024;

fn token_character(b:u8)->bool{
    b.is_ascii_alphanumeric()||b==b'-'||b==b'_'||b==b'='
}
fn extract_clipboard_token(input:&[u8])->Result<Vec<u8>,String>{
    if input.is_empty()||input.len()>MAX_CLIPBOARD_BYTES{
        return Err("Clipboard text is empty or too large".into());
    }
    let mut candidates=Vec::new();
    for i in 0..input.len().saturating_sub(2){
        let cli_token_equals=i>=8&&input[..i].ends_with(b"--token=");
        if &input[i..i+3]!=b"eyJ"||
            (i>0&&token_character(input[i-1])&&!cli_token_equals){
            continue;
        }
        let mut end=i;
        while end<input.len()&&token_character(input[end]){end+=1;}
        if end-i>=70&&end-i<=4096{
            candidates.push(input[i..end].to_vec());
        }
    }
    if candidates.len()!=1{
        return Err("Copy exactly one Cloudflare tunnel token or install command".into());
    }
    Ok(candidates.remove(0))
}
fn read_bounded_process_output(binary:&str,args:&[&str])->Result<Vec<u8>,String>{
    let mut command=Command::new(binary);
    command.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]{
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child=command.spawn()
        .map_err(|_|"No supported native text clipboard reader was found")?;
    let mut bytes=Vec::new();
    let stdout=child.stdout.take()
        .ok_or("Clipboard reader did not return a text stream")?;
    let read=stdout.take((MAX_CLIPBOARD_BYTES+1) as u64).read_to_end(&mut bytes);
    if read.is_err()||bytes.len()>MAX_CLIPBOARD_BYTES{
        let _=child.kill();
        let _=child.wait();
        return Err("Clipboard text could not be read safely".into());
    }
    if !child.wait().map_err(|_|"Clipboard reader failed")?.success(){
        return Err("Clipboard does not contain accessible text".into());
    }
    Ok(bytes)
}
#[cfg(windows)]
fn read_native_clipboard()->Result<Vec<u8>,String>{
    // Built-in Windows PowerShell, no credential bytes in process arguments.
    read_bounded_process_output("powershell.exe",
        &["-NoLogo","-NoProfile","-NonInteractive","-Command","Get-Clipboard -Raw"])
}
#[cfg(target_os="macos")]
fn read_native_clipboard()->Result<Vec<u8>,String>{
    read_bounded_process_output("pbpaste",&[])
}
#[cfg(target_os="linux")]
fn read_native_clipboard()->Result<Vec<u8>,String>{
    read_bounded_process_output("wl-paste",&["--no-newline","--type","text/plain"])
        .or_else(|_|read_bounded_process_output("xclip",&["-selection","clipboard","-o"]))
}
#[cfg(not(any(windows,target_os="macos",target_os="linux")))]
fn read_native_clipboard()->Result<Vec<u8>,String>{
    Err("Named Tunnel clipboard import is unsupported on this OS".into())
}

#[tauri::command]
pub async fn import_named_tunnel_clipboard(
    app:tauri::AppHandle,
    window:tauri::WebviewWindow,
)->Result<NamedTunnelView,String>{
    if window.label()!="main"||!window.is_visible().unwrap_or(false)||
        window.is_minimized().unwrap_or(true){
        return Err("Clipboard import requires the visible main native Tray".into());
    }
    let dir=super::config_dir()?;
    let settings=named_tunnel_settings::load(&dir)?;
    if settings.connector_mode!="remote-managed"||!settings.configured(){
        return Err("Save the Remote-managed Cloudflare tunnel identity first".into());
    }
    let prompt=format!(
        "Import the Cloudflare token for {}?\n\nCopy the single token or the full Cloudflare install command to the clipboard first.\n\nThe token is verified against tunnel {} and stored as a private file. It never appears in this screen, logs, or process arguments. This does not start the connector or change Gemini.",
        settings.hostname,settings.tunnel_id,
    );
    let approved=tauri::async_runtime::spawn_blocking(move||{
        app.dialog().message(prompt).buttons(
            MessageDialogButtons::OkCancelCustom(
                "Import from clipboard".to_string(),"Cancel".to_string()
            )
        ).blocking_show()
    }).await.map_err(|_|"Native clipboard approval failed")?;
    if !approved{
        return Err("Clipboard token import was cancelled".into());
    }
    tauri::async_runtime::spawn_blocking(move||{
        let mut clipboard=read_native_clipboard()?;
        let candidate=extract_clipboard_token(&clipboard);
        clipboard.fill(0);
        let mut token=candidate?;
        // install_token_bytes rejects mismatched UUID/secret and any live
        // connector lease before it stores anything in the private profile.
        let outcome=install_token_bytes(&dir,&settings,&token);
        token.fill(0);
        outcome
    }).await.map_err(|_|"Native clipboard import task failed")?
}

#[cfg(test)]
mod tests{
    use super::*;
    use base64::{engine::general_purpose,Engine as _};
    fn sample()->String{
        general_purpose::URL_SAFE_NO_PAD.encode(
            r#"{"a":"account-abcdef","t":"b2e8c6d9-9317-4d9e-b381-826af22e1778","s":"secret-abcdef123456"}"#)
    }
    #[test]
    fn extracts_only_one_token_from_cloudflare_install_command(){
        let token=sample();
        let command=format!("cloudflared.exe service install \"{token}\"\r\n");
        assert_eq!(extract_clipboard_token(command.as_bytes()).unwrap(),token.as_bytes());
        assert_eq!(extract_clipboard_token(token.as_bytes()).unwrap(),token.as_bytes());
        let command=format!("cloudflared tunnel run --token={token}");
        assert_eq!(extract_clipboard_token(command.as_bytes()).unwrap(),token.as_bytes());
    }
    #[test]
    fn rejects_empty_oversized_ambiguous_and_unrelated_clipboards(){
        let token=sample();
        assert!(extract_clipboard_token(&[]).is_err());
        assert!(extract_clipboard_token(&vec![b'x';MAX_CLIPBOARD_BYTES+1]).is_err());
        assert!(extract_clipboard_token(b"hello there").is_err());
        assert!(extract_clipboard_token(format!("{token} {token}").as_bytes()).is_err());
    }
}
