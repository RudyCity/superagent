/**
 * Core-managed file tool access. This enforces native host-owned file registry
 * for explicit file tools. It is NOT an OS sandbox for other applications.
 *
 * When any file rules are registered, unmediated shell/search/unrecognized
 * tools cannot safely promise exclusion of denied child files: fail closed.
 * Policy and executable identity revalidated on each tool execution.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readPermanentAccessRegistry } from "../desktopUi/permanentRegistryStore.js";
import { certifiedBrowserObservation } from "./browserFilePolicyCertification.js";
import { evaluatePersistentAccess, type ExecutableIdentity, type FileOperation, type PersistentAccessPolicy }
  from "../desktopUi/persistentAccessPolicy.js";

type Args = Record<string,unknown>;
export type FileToolCall = { name:string; args?:Args };
export type RegistryGuardOptions = {
  registry?: () => PersistentAccessPolicy | null;
  identity?: () => ExecutableIdentity | null;
};
const READ_TOOLS = new Set(["read","read_file","view_file","view","superagent_read_files","superagent_read_file"]);
const WRITE_TOOLS = new Set(["write","write_to_file","write_file","superagent_write_files",
  "superagent_write_file","edit","replace_file_content","multi_replace_file_content"]);
const PATCH_TOOLS = new Set(["apply_patch"]);
const READ_SEARCH = new Set(["glob","grep","ripgrep_search","list_directory","list_dir",
  "find_files","superagent_grep_search","superagent_find_files","superagent_list_files"]);
const BENIGN = new Set(["ask_question","get_workspace","superagent_get_workspace",
  "git_status","git_diff","get_git_diff","git_log",
  "inspect_port","find_process","get_remote_service_status",
  "superagent_tool_search","superagent_tool_describe","superagent_tool_status",
  "superagent_core_status","superagent_core_plan","superagent_server_health","get_current_time",
  "superagent_get_project","superagent_list_projects","superagent_list_project_access",
  "superagent_request_project_access",
  "superagent_discover_projects","superagent_get_token_usage","superagent_get_remote_status",
  "superagent_services_status",
  "superagent_delegate_doctor","superagent_delegate_list_chats",
  "superagent_delegate_read_chat","superagent_delegate_read_chat_full",
  "superagent_delegate_search_history","superagent_delegate_sync_history",
  "superagent_delegate_search_index","superagent_delegate_inspect_chat_config",
]);
const READ_ONLY_SERVICE_ACTIONS = new Set([
  "status","inventory","doctor","health","dashboard","logs","profile",
]);
const keyOf = (identity: ExecutableIdentity) => [identity.platform,identity.executablePath,identity.sha256].join(":");
let cachedSelf:{key:string,identity:ExecutableIdentity}|null=null;
export function identityOfSelf():ExecutableIdentity|null {
  const plat=process.platform;
  if(plat!=="win32" && plat!=="darwin" && plat!=="linux")return null;
  try {
    let binary=fs.realpathSync.native(process.execPath);
    if(plat==="win32")binary=binary.replace(/^\\\\\?\\/,"");
    const stat=fs.statSync(binary);
    if(!stat.isFile() || stat.size>2*1024*1024*1024)return null;
    const key=[binary,stat.dev,stat.ino,stat.size,stat.mtimeMs].join("|");
    if(cachedSelf?.key===key)return cachedSelf.identity;
    const hash=crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
    const identity:ExecutableIdentity={
      platform:plat==="win32"?"win32":plat==="darwin"?"darwin":"linux",
      executablePath:binary,sha256:hash,
    };
    cachedSelf={key,identity};
    return identity;
  }catch{return null;}
}
export function absoluteCanonical(raw:string,cwd:string):string|null {
  if(!raw || raw.length>2048 || raw.includes("\0") || /[\r\n]/.test(raw) || !path.isAbsolute(cwd))return null;
  try {
    const lex=path.resolve(cwd,raw);
    // Reject path traversal and non-canonical request spelling.
    if(raw.split(/[\\/]/).includes(".."))return null;
    let real:string;
    if(fs.existsSync(lex)){
      real=fs.realpathSync.native(lex);
    }else{
      let ancestor=lex;
      while(!fs.existsSync(ancestor)){
        const next=path.dirname(ancestor);
        if(next===ancestor)return null;
        ancestor=next;
      }
      const canonicalAncestor=fs.realpathSync.native(ancestor);
      real=path.resolve(canonicalAncestor,path.relative(ancestor,lex));
    }
    if(process.platform==="win32"){
      real=real.replace(/^\\\\\?\\/,"");
      const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
      if(!same(lex,real))return null; // reparse points/aliases fail closed
    }else if(real!==lex)return null;
    if(!path.isAbsolute(real))return null;
    return real;
  }catch{return null;}
}
function pathsIn(args:Args):string[]|null {
  const rawEntries=Array.isArray(args.filePaths)?args.filePaths:
    Array.isArray(args.files)?args.files:
    Array.isArray(args.edits)?args.edits:
    Array.isArray(args.patches)?args.patches:null;
  const rawPaths=rawEntries || [args.filePath ?? args.path ?? args.file ?? args.targetFile];
  if(!rawPaths.length || rawPaths.length>50)return null;
  const paths=rawPaths.map(v=>{
    if(typeof v==="string")return v;
    if(v && typeof v==="object" && !Array.isArray(v)){
      const entry=v as Record<string,unknown>;
      return entry.filePath ?? entry.TargetFile ?? entry.targetFile ?? entry.path ?? entry.file;
    }
    return null;
  });
  if(paths.some(p=>typeof p!=="string" || !p.trim()))return null;
  return paths as string[];
}
function getTarget(call:FileToolCall):FileToolCall {
  if(call.name==="superagent_tool_execute" &&
     call.args && typeof call.args.name==="string" &&
     call.args.arguments && typeof call.args.arguments==="object" &&
     !Array.isArray(call.args.arguments)){
    return {name:call.args.name,args:call.args.arguments as Args};
  }
  return call;
}
export function registeredFileToolGate(
  original:FileToolCall, workspace:string, options:RegistryGuardOptions={},
):string|null {
  const policy=(options.registry ?? readPermanentAccessRegistry)();
  // Before first-run v2 registration, preserve legacy behavior. Once the
  // native host initializes v2, defaultEffect=deny applies to Core file tools
  // even when only desktop rules exist. Corrupt policy parses as empty deny.
  if(!policy)return null;
  const call=getTarget(original);
  const identity=(options.identity ?? identityOfSelf)();
  if(!identity)return "Core executable identity could not be verified.";
  if(BENIGN.has(call.name))return null;
  // No blanket Chrome exemption: only side-effect-free, non-file inventory
  // operations qualify. All other browser/file-capable actions fail closed.
  if(certifiedBrowserObservation(call))return null;
  if(call.name === "superagent_manage_services" &&
     call.args && typeof call.args.action === "string" &&
     READ_ONLY_SERVICE_ACTIONS.has(call.args.action)) {
    return null;
  }
  if(READ_SEARCH.has(call.name))return "Unmediated discovery/search could expose explicitly blocked child files.";
  const operations:FileOperation[]=
    READ_TOOLS.has(call.name)?["read"]:
    WRITE_TOOLS.has(call.name)?["read","write"]:
    PATCH_TOOLS.has(call.name)?["read","write","delete"]:[];
  if(!operations.length)return "Tool is not certified for permanent file access restrictions.";
  const args=call.args??{};
  const entries=pathsIn(args);
  if(!entries)return "Explicit target file path(s) required by permanent file access policy.";
  if(!path.isAbsolute(workspace))return "Local absolute workspace required.";
  for(const raw of entries){
    const actual=absoluteCanonical(raw,workspace);
    if(!actual)return "Non-canonical, missing, symlinked, or traversal file target is denied.";
    for(const operation of operations){
      const decision=evaluatePersistentAccess(policy,{kind:"file",app:identity,path:actual,operation});
      if(decision.effect!=="allow"){
        return "Permanent file access denies "+operation+" for "+actual+".";
      }
    }
  }
  return null;
}
export function fileRulesRegistered(options:RegistryGuardOptions={}):boolean{
  const policy=(options.registry??readPermanentAccessRegistry)();
  return policy !== null;
}

export function isPathAllowedByPermanentRegistry(
  targetPath: string,
  operation: FileOperation = "read",
  options: RegistryGuardOptions = {}
): boolean {
  const policy = (options.registry ?? readPermanentAccessRegistry)();
  if (!policy) return false;
  const identity = (options.identity ?? identityOfSelf)();
  if (!identity) return false;
  const baseCwd = path.isAbsolute(targetPath) ? path.dirname(targetPath) : process.cwd();
  const canonical = absoluteCanonical(targetPath, baseCwd);
  if (!canonical) return false;
  const decision = evaluatePersistentAccess(policy, { kind: "file", app: identity, path: canonical, operation });
  return decision.effect === "allow";
}
