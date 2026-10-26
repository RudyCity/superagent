/**
 * Redirect URI validation shared by DCR, authorization and the OAuth Store.
 * A regex prefix check is insufficient: "localhost.attacker.example" is NOT
 * loopback and WHATWG URL normalization can hide separators or credentials.
 */
export function isAllowedOAuthRedirectUri(raw:string):boolean{
  if(typeof raw!=="string"||raw.length===0||raw.length>2048||
     raw!==raw.trim()||raw.includes("#")||raw.includes("\\")||
     /[\u0000-\u001f\u007f]/.test(raw))return false;
  try{
    const url=new URL(raw);
    if(url.username||url.password||!url.hostname)return false;
    if(url.protocol==="https:")return true;
    if(url.protocol!=="http:")return false;
    const hostname=url.hostname.toLowerCase();
    return hostname==="localhost"||hostname==="127.0.0.1"||
      hostname==="[::1]";
  }catch{return false;}
}
