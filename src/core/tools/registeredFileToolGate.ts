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
/**
 * Explicit-source document/media readers: only named input files are inspected.
 * Do not include render, edit, sign, media_plan or outputs that can touch
 * implicit/unbounded files. Their effects need separate output-path mediation.
 */
const EXPLICIT_INPUT_READERS: Record<string,readonly string[]> = {
  superagent_read_document: ["filePath","workspace","projectId"],
  superagent_pdf_inspect: ["inputPath","workspace","projectId"],
  superagent_pdf_extract: ["inputPath","pages","maxChars","workspace","projectId"],
  superagent_pdf_ocr: ["inputPath","pages","engine","language","forceOcr","scale",
    "expectedInputSha256","maxChars","workspace","projectId"],
  superagent_pdf_verify: ["inputPath","expectedSha256","expectedPageCount","workspace","projectId"],
  superagent_media_inspect: ["inputPath","workspace","projectId"],
};
function certifiedInputReaderArguments(name:string,args:Args|undefined):boolean {
  const allowed=EXPLICIT_INPUT_READERS[name];
  if(!allowed || !args || typeof args!=="object" || Array.isArray(args))return false;
  if(Object.keys(args).some(key=>!allowed.includes(key)))return false;
  const selected=name==="superagent_read_document"?args.filePath:args.inputPath;
  return typeof selected==="string" && selected.length>0;
}
const READ_SEARCH = new Set(["glob","grep","ripgrep_search","list_directory","list_dir",
  "find_files","superagent_grep_search","superagent_find_files","superagent_list_files"]);
const BENIGN = new Set(["ask_question","get_workspace","superagent_get_workspace",
  "git_status", // Git diffs/logs may expose denied source-file contents.
  "inspect_port","find_process","get_remote_service_status",
  "superagent_tool_search","superagent_tool_describe","superagent_tool_status",
  "superagent_core_status","superagent_core_plan","superagent_server_health","get_current_time",
  "superagent_get_project","superagent_list_projects","superagent_list_project_access",
  "superagent_request_project_access",
  "superagent_discover_projects","superagent_get_token_usage","superagent_get_remote_status",
  "superagent_services_status",
  "superagent_delegate_doctor","superagent_delegate_list_chats",
  "superagent_delegate_read_chat","superagent_delegate_read_chat_full",
  "superagent_delegate_search_history",
  "superagent_delegate_search_index","superagent_delegate_inspect_chat_config",
  "superagent_process_pool_status","superagent_lan_capabilities",
  "superagent_media_capabilities",
]);
const READ_ONLY_SERVICE_ACTIONS = new Set([
  "status","inventory","doctor","health","dashboard","logs","profile",
]);
const CERTIFIED_DESKTOP_DISCOVERY = new Set([
  "probe","list_windows","get_active_window","find_window",
  "list_installed_apps","live_inventory","inspect_security_prompts",
]);
/**
 * Metadata-only desktop commands cannot target a window session, return
 * screenshot content or send input. All control/snapshot/open commands remain
 * gated off until native host file-policy-aware mediation can prove safety.
 */
function certifiedDesktopDiscovery(args:Args|undefined):boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const cmd = typeof args.command === "string" ? args.command :
    typeof args.action === "string" ? args.action : "";
  if (!CERTIFIED_DESKTOP_DISCOVERY.has(cmd)) return false;
  if (args.command !== undefined && args.action !== undefined && args.action !== cmd) return false;
  const common=["command","action"];
  const allowed = cmd === "list_windows" || cmd === "list_installed_apps"
    ? [...common,"limit"]
    : cmd === "find_window" ? [...common,"limit","query","pid"] : common;
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (args.limit !== undefined &&
      (!Number.isSafeInteger(args.limit)||Number(args.limit)<1||Number(args.limit)>100)) return false;
  if (args.pid !== undefined && (!Number.isSafeInteger(args.pid)||Number(args.pid)<1)) return false;
  if (args.query !== undefined && (typeof args.query !== "string" ||
      args.query.length<1 || args.query.length>256)) return false;
  return true;
}
const CERTIFIED_LAN_INVENTORY = new Set([
  "superagent_lan_list_devices", "superagent_device_list",
  "superagent_device_tunnel_list",
]);
const CERTIFIED_PAIR_STATUS = new Set([
  "superagent_lan_pair_status", "superagent_device_pair_status",
]);
const CERTIFIED_CORE_LIFECYCLE_MUTATIONS = new Set([
  "superagent_core_restart", "superagent_core_rollback", "superagent_core_drain",
]);
const OPAQUE_UUID = /^[a-f0-9-]{36}$/i;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
function certifiedLanInventory(name:string, args:Args|undefined):boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (CERTIFIED_LAN_INVENTORY.has(name)) return Object.keys(args).length === 0;
  return CERTIFIED_PAIR_STATUS.has(name) && Object.keys(args).length === 1 &&
    typeof args.requestId === "string" && OPAQUE_UUID.test(args.requestId);
}
/**
 * Lifecycle's command/port/hash contract contains no user-selectable file,
 * shell, or executable path. Runtime still requires the independent MCP
 * Connection Controls grant, confirmation, and authenticated supervisor plan.
 */
function certifiedSupervisedCoreMutation(name:string, args:Args|undefined):boolean {
  if (!CERTIFIED_CORE_LIFECYCLE_MUTATIONS.has(name) ||
      !args || typeof args !== "object" || Array.isArray(args)) return false;
  if (Object.keys(args).some(key =>
      !["port","confirm","operationId","expectedBuildDigest"].includes(key))) return false;
  if (args.port !== undefined &&
      (!Number.isSafeInteger(args.port) || Number(args.port)<1024 || Number(args.port)>65535)) return false;
  return args.confirm === true && typeof args.operationId === "string" &&
    OPERATION_ID.test(args.operationId) && typeof args.expectedBuildDigest === "string" &&
    /^[a-f0-9]{64}$/.test(args.expectedBuildDigest);
}
const BROWSER_OBSERVATION_TOOLS = new Set([
  "superagent_browser_gateway", "superagent_chrome_cdp",
  "superagent_control_chrome_cdp", "superagent_list_running_chrome",
]);
/**
 * The Delegate history sync writes only its app-owned SQLite mirror. It is NOT
 * a read-only operation and still requires MCP write scope + Security Approval.
 * No workspace/filePath or other caller-selected filesystem argument is allowed.
 */
function certifiedDelegateHistorySync(args: Args | undefined): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (Object.keys(args).some(key => !["clientId","maxChats","refreshRecent","force"].includes(key))) return false;
  if (args.clientId !== undefined &&
      (typeof args.clientId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(args.clientId))) return false;
  if (args.maxChats !== undefined &&
      (!Number.isSafeInteger(args.maxChats) || Number(args.maxChats) < 1 || Number(args.maxChats) > 500)) return false;
  if (args.refreshRecent !== undefined &&
      (!Number.isSafeInteger(args.refreshRecent) || Number(args.refreshRecent) < 0 || Number(args.refreshRecent) > 100)) return false;
  return args.force === undefined || typeof args.force === "boolean";
}
export type PermanentFileToolReadiness = "certified_metadata" | "certified_app_storage" |
  "requires_explicit_files" | "action_dependent" | "uncertified";
/**
 * This describes ONLY the host file-policy gate, never the final authorization.
 * OAuth, principal grants, workspace scope and native approvals still apply.
 * A tool may have a permitted action even when its generic classification is
 * 'action_dependent'; this function deliberately does not guess its arguments.
 */
export function getPermanentFileToolReadiness(name: string): PermanentFileToolReadiness {
  if (BENIGN.has(name)) return "certified_metadata";
  if (name === "superagent_delegate_sync_history") return "certified_app_storage";
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name) || PATCH_TOOLS.has(name) ||
      Object.prototype.hasOwnProperty.call(EXPLICIT_INPUT_READERS,name))
    return "requires_explicit_files";
  if (BROWSER_OBSERVATION_TOOLS.has(name) || name === "superagent_manage_services" ||
      name === "superagent_tool_execute" ||
      CERTIFIED_LAN_INVENTORY.has(name) || CERTIFIED_PAIR_STATUS.has(name) ||
      CERTIFIED_CORE_LIFECYCLE_MUTATIONS.has(name) || name === "superagent_desktop_ui")
    return "action_dependent";
  return "uncertified";
}
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
  const rawPaths=rawEntries || [args.filePath ?? args.inputPath ?? args.path ?? args.file ?? args.targetFile];
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
  if (call.name === "superagent_delegate_sync_history" && certifiedDelegateHistorySync(call.args))
    return null; // App-owned index only; never a general file write exemption.
  // No blanket Chrome exemption: only side-effect-free, non-file inventory
  // operations qualify. All other browser/file-capable actions fail closed.
  if(certifiedBrowserObservation(call))return null;
  if(certifiedLanInventory(call.name,call.args))return null;
  if(certifiedSupervisedCoreMutation(call.name,call.args))return null;
  if(call.name === "superagent_desktop_ui" && certifiedDesktopDiscovery(call.args))return null;
  if(call.name === "superagent_manage_services" &&
     call.args && typeof call.args.action === "string" &&
     READ_ONLY_SERVICE_ACTIONS.has(call.args.action)) {
    return null;
  }
  if(READ_SEARCH.has(call.name))return "Unmediated discovery/search could expose explicitly blocked child files.";
  if(Object.prototype.hasOwnProperty.call(EXPLICIT_INPUT_READERS,call.name) &&
      !certifiedInputReaderArguments(call.name,call.args))
    return "Document/media reader requires exactly one explicit input path and certified argument keys.";
  const operations:FileOperation[]=
    READ_TOOLS.has(call.name) || certifiedInputReaderArguments(call.name,call.args)?["read"]:
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
