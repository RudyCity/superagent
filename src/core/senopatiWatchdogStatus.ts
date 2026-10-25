/** Read-only Senopati watchdog registry; never discloses its owner nonce. */
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "./config/paths.js";

export type SenopatiWatchdogHealth={
 pid:number; alive:boolean; heartbeatFresh:boolean;
 modelPid:number|null; healthy:boolean; updatedAt:number;
};
export function readSenopatiWatchdogStatus(
 registry=path.join(getRootConfigDir(),"ipc","senopati-watchdog.json"),
 now=Date.now(),
):SenopatiWatchdogHealth|null {
 try{
  const st=fs.lstatSync(registry);
  if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1 ||
     st.size<50 || st.size>8192)return null;
  const data=JSON.parse(fs.readFileSync(registry,"utf8"));
  if(data?.version!==1 || !Number.isSafeInteger(data.pid) || data.pid<1 ||
     !/^[a-f0-9]{32}$/.test(data.nonce||"") ||
     !Number.isFinite(data.updatedAt) ||
     data.updatedAt>now+60_000)return null;
  let alive=false;
  try{process.kill(data.pid,0);alive=true;}
  catch(error:any){alive=error?.code==="EPERM";}
  const heartbeatFresh=(now-data.updatedAt)>=-1_000 && (now-data.updatedAt)<=12_000;
  return {
   pid:data.pid,alive:alive&&heartbeatFresh,heartbeatFresh,
   modelPid:Number.isSafeInteger(data.modelPid)&&data.modelPid>0?data.modelPid:null,
   healthy:data.healthy===true && alive && heartbeatFresh,updatedAt:data.updatedAt,
  };
 }catch{return null;}
}
