/** File-safe MCP Chrome metadata certification; all other browser operations remain denied. */
type BrowserCall = {name:string; args?:Record<string,unknown>};
const exact=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).every(k=>keys.includes(k));
export function certifiedBrowserObservation(call:BrowserCall):boolean{
 const a=call.args;
 if(!a||typeof a!=="object"||Array.isArray(a))return false;
 if(call.name==="superagent_list_running_chrome")return Object.keys(a).length===0;
 if(call.name==="superagent_browser_gateway")
   return a.action==="identity"&&exact(a,["action","agentId"]) ||
     a.action==="policy"&&exact(a,["action"]);
 if(call.name==="superagent_chrome_cdp"||call.name==="superagent_control_chrome_cdp"){
   if(a.command!=="list_targets"&&a.command!=="transport_status")return false;
   if(a.transport!==undefined&&a.transport!=="managed")return false;
   if(!exact(a,["command","transport","debug_port"]))return false;
   return a.debug_port===undefined ||
     (Number.isSafeInteger(a.debug_port)&&Number(a.debug_port)>=1024&&Number(a.debug_port)<=65535);
 }
 return false;
}
