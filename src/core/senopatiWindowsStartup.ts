/** Optional Windows per-user logon startup for the Senopati watchdog.
 *
 * This only writes an owner-managed .cmd to the current user's Startup
 * folder on explicit CLI install. Never changes registry, Task Scheduler,
 * service accounts, ACLs, global PATH, or other startup entries.
 */
import fs from "node:fs";
import path from "node:path";
import {getPackageRootDir} from "./config/paths.js";
export const SENOPATI_STARTUP_FILENAME="SuperAgent Senopati Shared.cmd";
function safeQuotedPath(value:string):string {
 if(!path.isAbsolute(value) ||
    /[\r\n"<>|&^%!]/.test(value)) {
  throw new Error("Refuse unsafe Windows startup executable/script path");
 }
 return '"'+value+'"';
}
export function windowsStartupPath(appData=process.env.APPDATA):string {
 if(process.platform!=="win32" || !appData || !path.isAbsolute(appData)){
  throw new Error("Windows per-user Startup directory unavailable");
 }
 return path.join(appData,"Microsoft","Windows","Start Menu","Programs",
   "Startup",SENOPATI_STARTUP_FILENAME);
}
export function makeSenopatiWindowsStartupScript(
 bunExecutable=process.execPath,
 startupScript=path.join(getPackageRootDir(),"scripts","senopati-login.ts"),
):string {
 const binary=safeQuotedPath(bunExecutable);
 const script=safeQuotedPath(startupScript);
 return [
  "@echo off",
  "rem Managed by SuperAgent Senopati lifecycle; current Windows user only",
  "start \"\" /min "+binary+" "+script,
  "",
 ].join("\r\n");
}
export function senopatiWindowsStartupStatus():{
 supported:boolean;installed:boolean;managed:boolean;file:string|null;
}{
 if(process.platform!=="win32"){
  return {supported:false,installed:false,managed:false,file:null};
 }
 try{
  const file=windowsStartupPath();
  if(!fs.existsSync(file)){
   return {supported:true,installed:false,managed:false,file};
  }
  const st=fs.lstatSync(file);
  if(!st.isFile() || st.isSymbolicLink() || st.size>4096){
   return {supported:true,installed:true,managed:false,file};
  }
  const actual=fs.readFileSync(file,"utf8");
  return {supported:true,installed:true,
    managed:actual===makeSenopatiWindowsStartupScript(),file};
 }catch{
  return {supported:true,installed:false,managed:false,file:null};
 }
}
export function installSenopatiWindowsStartup():string {
 const file=windowsStartupPath();
 const expected=makeSenopatiWindowsStartupScript();
 if(fs.existsSync(file)){
  const state=senopatiWindowsStartupStatus();
  if(state.installed && state.managed)return file;
  throw new Error("Existing Startup file differs; refusing overwrite");
 }
 if(!fs.existsSync(process.execPath))throw new Error("Bun executable missing");
 const launch=path.join(getPackageRootDir(),"scripts","senopati-login.ts");
 if(!fs.existsSync(launch))throw new Error("Login launcher script missing");
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,expected,{encoding:"utf8",flag:"wx",mode:0o600});
 return file;
}
export function uninstallSenopatiWindowsStartup():boolean {
 const state=senopatiWindowsStartupStatus();
 if(!state.installed)return false;
 if(!state.managed || !state.file) {
  throw new Error("Refuse removing an unrecognized Windows startup entry");
 }
 fs.unlinkSync(state.file);
 return true;
}
