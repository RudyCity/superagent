/**
 * R2 Windows CurrentUser DPAPI envelope for new-issuer local secrets.
 *
 * No insecure cross-platform fallback. All secret bytes cross process only
 * through anonymous stdin and stdout; never put plaintext into argv, logs,
 * env vars, process titles or reported status.
 *
 * This is USER-scoped encryption, not protection from malicious software
 * already running under the same Windows user. For production, ACL and
 * hardened service account certification remain separate release gates.
 */
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";

const ENTROPY="SuperAgent:IndependentMcpOAuthKey:v1";
const MAX_KEY=4096;
const MAX_BLOB=16_384;
function runDpapi(operation:"protect"|"unprotect",value:Buffer):Buffer{
  if(process.platform!=="win32")
    throw new Error("DPAPI CurrentUser is available only on Windows");
  if(value.length===0||value.length>(operation==="protect"?MAX_KEY:MAX_BLOB))
    throw new Error("Invalid DPAPI material size");
  const script=[
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$encoded=[Console]::In.ReadToEnd().Trim()",
    "$data=[Convert]::FromBase64String($encoded)",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('"+ENTROPY+"')",
    "$scope=[Security.Cryptography.DataProtectionScope]::CurrentUser",
    "$result=[Security.Cryptography.ProtectedData]::"+(
      operation==="protect"?"Protect":"Unprotect")+"($data,$entropy,$scope)",
    "[Console]::Out.Write([Convert]::ToBase64String($result))",
  ].join(";");
  const r=spawnSync("powershell.exe",[
    "-NoProfile","-NonInteractive","-Command",script,
  ],{
    input:value.toString("base64"),encoding:"utf8",
    windowsHide:true,timeout:8000,maxBuffer:64*1024,
    stdio:["pipe","pipe","pipe"],
  });
  if(r.error||r.status!==0)
    throw new Error("DPAPI "+operation+" refused: OS identity unavailable or key corrupted");
  const result=r.stdout?.trim()??"";
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(result)||result.length>32_768)
    throw new Error("DPAPI returned malformed output");
  return Buffer.from(result,"base64");
}
export interface ProtectedIssuerKey {
  version:1;scope:"WindowsCurrentUser";scheme:"DPAPI-SHA256-v1";
  data:string;
}
export function protectNewIssuerKey(key:Buffer):ProtectedIssuerKey{
  if(!Buffer.isBuffer(key)||key.length!==32)
    throw new Error("OAuth issuer requires exactly 32 random key bytes");
  const encrypted=runDpapi("protect",key);
  return {version:1,scope:"WindowsCurrentUser",
    scheme:"DPAPI-SHA256-v1",data:encrypted.toString("base64")};
}
export function unprotectNewIssuerKey(envelope:ProtectedIssuerKey):Buffer{
  if(!envelope||envelope.version!==1||
     envelope.scope!=="WindowsCurrentUser"||
     envelope.scheme!=="DPAPI-SHA256-v1"||
     typeof envelope.data!=="string"||
     envelope.data.length>32_768||
     !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.data))
    throw new Error("Untrusted OAuth issuer protected-key format");
  const key=runDpapi("unprotect",Buffer.from(envelope.data,"base64"));
  if(key.length!==32)throw new Error("Invalid decrypted issuer key length");
  return key;
}
export function createNewIssuerDpapiKey():ProtectedIssuerKey{
  return protectNewIssuerKey(crypto.randomBytes(32));
}
