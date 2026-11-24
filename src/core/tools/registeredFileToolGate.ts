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
import { parseReadOnlyServiceArgs } from "../runtime/serviceReadPolicy.js";
import { certifiedBrowserObservation, certifiedDelegateWebAction, certifiedBrowserUpload, getCertifiedBrowserUploadSourcePath } from "./browserFilePolicyCertification.js";
import { certifiedExplicitGrepSearchArgs } from "./filePolicyArgumentCertification.js";
export { certifiedExplicitGrepSearchArgs } from "./filePolicyArgumentCertification.js";
import { evaluatePersistentAccess, type ExecutableIdentity, type FileOperation, type PersistentAccessPolicy }
  from "../desktopUi/persistentAccessPolicy.js";
import { formatUncertifiedFilePolicyMessage } from "./uncertifiedPolicySuggestion.js";
import { isSystemDestructiveCommand } from "../permissions.js";

type Args = Record<string,unknown>;
export type FileToolCall = { name:string; args?:Args };
export type RegistryGuardOptions = {
  registry?: () => PersistentAccessPolicy | null;
  identity?: () => ExecutableIdentity | null;
};
const READ_TOOLS = new Set(["read","read_file","view_file","view","superagent_read_files","superagent_read_file"]);
const WRITE_TOOLS = new Set(["write","write_to_file","write_file","superagent_write_files",
  "superagent_write_file","edit","replace_file_content","multi_replace_file_content",
  "superagent_replace_file_content"]);
const PATCH_TOOLS = new Set(["apply_patch","superagent_apply_patch","superagent_patch_file"]);
/**
 * Explicit-source document/media readers: only named input files are inspected.
 * Do not include render, edit, sign, media_plan or outputs that can touch
 * implicit/unbounded files. Their effects need separate output-path mediation.
 */
const EXPLICIT_INPUT_READERS: Record<string,readonly string[]> = {
  superagent_read_document: ["filePath","workspace","projectId"],
  superagent_muse_send_file: ["filePath","port","projectId"],
  superagent_telegram_send_file: ["filePath","caption","projectId"],
  superagent_unlock_file: ["filePath","workspace","projectId","action","force","reason","cwd","lineRange"],
  superagent_pdf_inspect: ["inputPath","workspace","projectId"],
  superagent_pdf_extract: ["inputPath","pages","maxChars","workspace","projectId"],
  superagent_pdf_ocr: ["inputPath","pages","engine","language","forceOcr","scale",
    "expectedInputSha256","maxChars","workspace","projectId"],
  superagent_pdf_verify: ["inputPath","expectedSha256","expectedPageCount","workspace","projectId"],
  superagent_media_inspect: ["inputPath","workspace","projectId"],
};
function certifiedInputReaderArguments(name:string,args:Args|undefined):boolean {
  if(!Object.prototype.hasOwnProperty.call(EXPLICIT_INPUT_READERS,name))return false;
  const allowed=EXPLICIT_INPUT_READERS[name]!;
  if(!args || typeof args!=="object" || Array.isArray(args))return false;
  if(Object.keys(args).some(key=>!allowed.includes(key)))return false;
  const selected=["superagent_read_document","superagent_muse_send_file",
    "superagent_telegram_send_file","superagent_unlock_file"].includes(name)
    ?args.filePath:args.inputPath;
  return typeof selected==="string" && selected.length>0;
}
/**
 * media_plan is non-mutating, but it checks destination existence and may
 * inspect up to 50 sources plus a watermark. Mediate every referenced file.
 */
function certifiedMediaPlanPaths(args:Args|undefined):string[]|null {
  if(!args||typeof args!=="object"||Array.isArray(args))return null;
  const allowed=["inputPath","inputPaths","outputPath","watermarkPath","mode","operation",
    "quality","targetBytes","targetKB","workspace","projectId"];
  if(Object.keys(args).some(key=>!allowed.includes(key)))return null;
  const inputs=args.inputPaths===undefined?[args.inputPath]:args.inputPaths;
  if(!Array.isArray(inputs)||inputs.length<1||inputs.length>50||
      inputs.some(item=>typeof item!=="string"||!item.trim()))return null;
  if(args.inputPaths!==undefined&&args.inputPath!==undefined)return null;
  if(typeof args.outputPath!=="string"||!args.outputPath.trim())return null;
  if(args.mode!==undefined&&!["convert","transform"].includes(String(args.mode)))return null;
  const operations=["resize","crop","convert","compress","rotate","flip_vertical",
    "flop_horizontal","grayscale","watermark","remove_background","upscale_ai"];
  if(args.operation!==undefined &&
      (typeof args.operation!=="string"||!operations.includes(args.operation)))return null;
  if(args.mode==="convert"&&args.operation!==undefined)return null;
  if(args.quality!==undefined &&
      (!Number.isSafeInteger(args.quality)||Number(args.quality)<1||Number(args.quality)>100))return null;
  if(args.targetBytes!==undefined &&
      (!Number.isSafeInteger(args.targetBytes)||Number(args.targetBytes)<1||
       Number(args.targetBytes)>209715200))return null;
  if(args.targetKB!==undefined &&
      (!Number.isSafeInteger(args.targetKB)||Number(args.targetKB)<1||
       Number(args.targetKB)>204800))return null;
  if(args.targetBytes!==undefined&&args.targetKB!==undefined)return null;
  const paths=[...inputs as string[],args.outputPath];
  if(args.operation==="watermark"){
    if(typeof args.watermarkPath!=="string"||!args.watermarkPath.trim())return null;
    paths.push(args.watermarkPath);
  }else if(args.watermarkPath!==undefined)return null;
  return paths;
}

type ExplicitFileEffect = { raw:string; operations:FileOperation[] };
function explicitFileEffects(name:string,args:Args|undefined):ExplicitFileEffect[]|null {
  if(!args || typeof args!=="object" || Array.isArray(args))return null;
  const effects:ExplicitFileEffect[]=[];
  const add=(raw:unknown,operations:FileOperation[])=>{
    if(typeof raw!=="string"||!raw.trim()||raw.length>2048)return false;
    effects.push({raw,operations}); return true;
  };
  const addMany=(raw:unknown,operations:FileOperation[])=>{
    if(!Array.isArray(raw)||raw.length<1||raw.length>50)return false;
    for(const item of raw)if(!add(item,operations))return false;
    return true;
  };
  if(name==="superagent_media_convert"){
    const inputs=args.inputPaths===undefined?[args.inputPath]:args.inputPaths;
    if(!Array.isArray(inputs)||inputs.length<1||!addMany(inputs,["read"])||
       !add(args.outputPath,["write"]))return null;
    return effects;
  }
  if(name==="superagent_media_transform"){
    if(!add(args.inputPath,["read"])||!add(args.outputPath,["write"]))return null;
    if(args.operation==="watermark"&&!add(args.watermarkPath,["read"]))return null;
    return effects;
  }
  if(name==="superagent_media_batch"){
    if(!Array.isArray(args.jobs)||args.jobs.length<1||args.jobs.length>20)return null;
    for(const job of args.jobs){
      if(!job||typeof job!=="object"||Array.isArray(job))return null;
      const j=job as Args;
      const mode=String(j.mode??j.kind??j.tool??j.action??"");
      const target=mode.includes("transform")?"superagent_media_transform":"superagent_media_convert";
      const nested=explicitFileEffects(target,j);
      if(!nested)return null;
      effects.push(...nested);
    }
    return effects;
  }
  if(["superagent_pdf_edit_vector_exact","superagent_pdf_ocr_searchable",
      "superagent_pdf_redact_raster"].includes(name)){
    if(!add(args.inputPath,["read"])||!add(args.outputPath,["write"]))return null;
    return effects;
  }
  if(name==="superagent_pdf_sign"){
    if(!add(args.inputPath,["read"])||!add(args.certificatePath,["read"])||
       !add(args.outputPath,["write"]))return null;
    return effects;
  }
  if(name==="superagent_pdf_edit"){
    if(!add(args.inputPath,["read"])||!add(args.outputPath,["write"])||
       !Array.isArray(args.operations)||args.operations.length<1||args.operations.length>100)return null;
    for(const op of args.operations){
      if(!op||typeof op!=="object"||Array.isArray(op))return null;
      const item=op as Args;
      for(const key of ["sourcePath","imagePath","fontPath"])
        if(item[key]!==undefined&&!add(item[key],["read"]))return null;
    }
    return effects;
  }
  if(name==="superagent_pdf_verify_signature"){
    if(args.verifyTrustedChain===true||args.verifyOfflineCrl===true||
       args.verifyIndependentPades===true)return null;
    if(!add(args.inputPath,["read"]))return null;
    return effects;
  }
  if(name==="superagent_list_chrome_profiles"){
    if(typeof args.customUserDataPath!=="string"||!args.customUserDataPath.trim())return null;
    if(Object.keys(args).some(key=>!["customUserDataPath","workspace","projectId"].includes(key)))return null;
    if(!add(path.join(args.customUserDataPath,"Local State"),["read"]))return null;
    return effects;
  }
  if(name==="superagent_brain_publish"){
    const action=String(args.action??"");
    if(action==="confirm")return effects;
    if(action!=="prepare"||!add(args.destinationPath,["write"]))return null;
    return effects;
  }
  if(name==="superagent_use_skill"){
    if(!add(args.path,["read"]))return null;
    return effects;
  }
  if(name==="superagent_pdf_render"){
    if(!add(args.inputPath,["read"])||typeof args.outputPrefix!=="string"||!args.outputPrefix.trim()||
       !Array.isArray(args.pages)||args.pages.length<1||args.pages.length>20)return null;
    for(const pageNo of args.pages){
      if(!Number.isSafeInteger(pageNo)||Number(pageNo)<1)return null;
      if(!add(String(args.outputPrefix)+"-page-"+pageNo+".png",["write"]))return null;
    }
    return effects;
  }
  if(name==="superagent_pdf_split"){
    if(!add(args.inputPath,["read"])||typeof args.outputPrefix!=="string"||!args.outputPrefix.trim()||
       !Array.isArray(args.groups)||args.groups.length<1||args.groups.length>20)return null;
    for(let i=0;i<args.groups.length;i++)
      if(!add(String(args.outputPrefix)+"-part-"+(i+1)+".pdf",["write"]))return null;
    return effects;
  }
  return null;
}


function projectHealthEffects(workspace:string):ExplicitFileEffect[]|null {
  if(!path.isAbsolute(workspace))return null;
  return [".git","package.json","pyproject.toml","Cargo.toml","go.mod","composer.json",
    "Gemfile","pom.xml","build.gradle","Makefile"].map(raw=>({
      raw:path.join(workspace,raw),operations:["read"] as FileOperation[],
    }));
}
const FIXED_PLANNING_TOOLS = new Set([
  "superagent_get_current_task","superagent_get_plan_and_tasks",
  "superagent_manage_plan","superagent_manage_tasks","superagent_update_tasks",
]);
function fixedPlanningEffects(name:string,args:Args|undefined,workspace:string):ExplicitFileEffect[]|null {
  if(!FIXED_PLANNING_TOOLS.has(name)||!path.isAbsolute(workspace)||
     !args||typeof args!=="object"||Array.isArray(args))return null;
  if(["superagent_get_current_task","superagent_get_plan_and_tasks","superagent_update_tasks"].includes(name) &&
     ["superagentId","instanceId","id"].some(key=>args[key]!==undefined))return null;
  if((name==="superagent_manage_plan"||name==="superagent_manage_tasks") &&
     typeof args.sessionId==="string"&&args.sessionId.trim())return [];
  const effect=(file:string,operations:FileOperation[]):ExplicitFileEffect=>({
    raw:path.join(workspace,file),operations,
  });
  if(name==="superagent_get_current_task")
    return ["_task.md","task.md","tasks.md"].map(file=>effect(file,["read"]));
  if(name==="superagent_get_plan_and_tasks")
    return ["_task.md","task.md","tasks.md","_plan.md","plan.md",
      "_implementation_plan.md","implementation_plan.md"].map(file=>effect(file,["read"]));
  if(name==="superagent_manage_plan"){
    const action=String(args.action??"");
    if(!["create","edit","sync","get"].includes(action))return null;
    const ops:FileOperation[]=action==="get"?["read"]:["read","write"];
    return [effect("implementation_plan.md",ops),effect("task.md",ops)];
  }
  if(name==="superagent_manage_tasks"){
    const action=String(args.action??"");
    if(!["list","add","add_bulk","update","remove","update_bulk","remove_bulk"].includes(action))return null;
    return [effect("task.md",action==="list"?["read"]:["read","write"])];
  }
  if(name==="superagent_update_tasks"){
    const action=String(args.action??"");
    if(!["mark_completed","mark_in_progress","add_task","get_status","get_current_task"].includes(action))return null;
    return [effect("task.md",["read",...(action.startsWith("get_")?[]:["write"])] as FileOperation[])];
  }
  return null;
}

const EXPLICIT_EFFECT_TOOLS = new Set([
  "superagent_media_convert","superagent_media_transform","superagent_media_batch",
  "superagent_pdf_edit","superagent_pdf_edit_vector_exact","superagent_pdf_ocr_searchable",
  "superagent_pdf_redact_raster","superagent_pdf_sign","superagent_pdf_verify_signature",
  "superagent_pdf_render","superagent_pdf_split",
  "superagent_brain_publish","superagent_use_skill","superagent_list_chrome_profiles",
]);

/** No recursive traversal or regular expressions: search only granted file paths. */
function certifiedRegistryAwareDiscovery(name:string,args:Args|undefined):boolean{
  if(!args||typeof args!=="object"||Array.isArray(args))return false;
  if(name==="superagent_list_files"){
    return Object.keys(args).every(key=>["dirPath","workspace","cwd","projectId"].includes(key)) &&
      (args.dirPath===undefined||typeof args.dirPath==="string");
  }
  if(name==="superagent_find_files"){
    if(Object.keys(args).some(key=>!["pattern","query","name","path","extension","maxDepth",
      "workspace","cwd","projectId"].includes(key)))return false;
    if(args.maxDepth!==undefined&&(!Number.isSafeInteger(args.maxDepth)||Number(args.maxDepth)<0||Number(args.maxDepth)>32))
      return false;
    return ["pattern","query","name","path","extension","workspace","cwd","projectId"].every(key=>
      args[key]===undefined||typeof args[key]==="string");
  }
  return false;
}
const READ_SEARCH = new Set(["glob","grep","ripgrep_search","list_directory","list_dir",
  "find_files","superagent_grep_search","superagent_find_files","superagent_list_files"]);
const BENIGN = new Set(["ask_question","get_workspace","superagent_get_workspace",
  // git_status is intentionally excluded: Git can execute configured fsmonitor
  // helpers and inspect blocked paths. An unmediated status is not file-safe.
  "inspect_port","find_process","get_remote_service_status",
  "superagent_tool_search","superagent_tool_describe","superagent_tool_status",
  "superagent_tool_preflight","superagent_tool_doctor",
  "superagent_core_status","superagent_core_plan","superagent_server_health","get_current_time",
  "superagent_get_project","superagent_list_projects","superagent_list_project_access",
  "superagent_request_project_access","superagent_request_file_access",
  "superagent_request_application_access",
  "superagent_discover_projects","superagent_get_token_usage","superagent_get_remote_status",
  "superagent_delegate_doctor","superagent_delegate_list_chats",
  "superagent_delegate_read_chat","superagent_delegate_read_chat_full",
  "superagent_delegate_search_history",
  "superagent_delegate_search_index","superagent_delegate_inspect_chat_config",
  "superagent_process_pool_status","superagent_lan_capabilities",
  "superagent_media_capabilities",
]);
export const READ_ONLY_SERVICE_ACTIONS = new Set([
  "status","inventory","owner_status","doctor","health","dashboard","logs","profile",
]);
/** Read-only service inspection cannot carry restart/upgrade/file arguments. */
export function certifiedServiceInspection(args:Args|undefined):boolean {
  return parseReadOnlyServiceArgs(args)!==null;
}
export const CERTIFIED_DESKTOP_DISCOVERY = new Set([
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
/**
 * Only a URL-preserving, owner-attested MCP backend swap is certified here.
 * This does not certify generic service mutations, owner termination, tunnel
 * recreation or caller-supplied executable/file paths.
 * Runtime checks OAuth, project Execute, owner lease, URL and operation ledger.
 */
export function certifiedMcpBackendReloadArgs(args:Args|undefined):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args)||args.service!=="mcp")
    return false;
  if(!Number.isSafeInteger(args.port)||Number(args.port)<1024||Number(args.port)>65535)
    return false;
  if(args.action==="plan"){
    return args.targetAction==="reload" &&
      Object.keys(args).every(key=>["action","service","port","targetAction"].includes(key));
  }
  if(args.action!=="reload" ||
     Object.keys(args).some(key=>!["action","service","port","confirm","operationId","expectedOwnerPid","expectedPublicUrl"].includes(key)))
    return false;
  if(args.confirm!==true || typeof args.operationId!=="string" ||
     !OPERATION_ID.test(args.operationId) ||
     !Number.isSafeInteger(args.expectedOwnerPid)||Number(args.expectedOwnerPid)<1 ||
     typeof args.expectedPublicUrl!=="string"||args.expectedPublicUrl.length>2048)
    return false;
  try {
    const url=new URL(args.expectedPublicUrl);
    return url.protocol==="https:" && Boolean(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname==="/mcp" && url.toString()===args.expectedPublicUrl;
  }catch{return false;}
}
const BROWSER_OBSERVATION_TOOLS = new Set([
  "superagent_browser_gateway", "superagent_chrome_cdp",
  "superagent_chrome_cdp_observe", "superagent_chrome_cdp_web",
  "superagent_control_chrome_cdp", "superagent_list_running_chrome",
]);

const CERTIFIED_APP_STORAGE_TOOLS = new Set([
  "superagent_memory_search", "superagent_memory_save", "superagent_get_config",
  "superagent_switch_preset", "superagent_switch_provider", "superagent_query_history",
  "superagent_export_session", "superagent_compact_context",
  "superagent_lifecycle_status", "superagent_lifecycle",
  "superagent_daemon_status", "superagent_daemon_inspect_run",
  "superagent_get_logs", "superagent_get_status", "superagent_search_journal",
  "superagent_list_workspace_chains", "superagent_muse_chat_status",
  "superagent_muse_tunnel_start", "superagent_muse_tunnel_restart",
  "superagent_motion_list", "superagent_motion_status", "superagent_motion_inspect",
  "superagent_motion_jobs", "superagent_motion_storage", "superagent_motion_recovery",
  "superagent_motion_supervisor", "superagent_motion_queue_recovery",
  "superagent_studio_list", "superagent_studio_status", "superagent_studio_inspect",
  "superagent_studio_jobs", "superagent_studio_storage", "superagent_studio_recovery",
  "superagent_studio_supervisor", "superagent_studio_queue_recovery",
  "superagent_synthesize_skill",
  "superagent_motion_cancel", "superagent_motion_create", "superagent_motion_edit",
  "superagent_motion_generate", "superagent_motion_import_audio",
  "superagent_motion_import_image", "superagent_motion_render", "superagent_motion_revise",
  "superagent_studio_cancel", "superagent_studio_create", "superagent_studio_edit",
  "superagent_studio_generate", "superagent_studio_import_audio",
  "superagent_studio_import_image", "superagent_studio_render", "superagent_studio_revise",
]);

/**
 * These tools have no MCP-host filesystem effect. They can still mutate remote
 * state or processes, so all normal OAuth/project/MCP/native approvals remain
 * mandatory. Permanent FILE policy is intentionally not a catch-all capability
 * blocker for unrelated browser, network, device, process or registry actions.
 */
const CERTIFIED_NON_FILE_TOOLS = new Set([
  "superagent_delegate_run_until_done", "superagent_delegate_configure_chat",
  "superagent_delegate_create_chat", "superagent_delegate_send_message",
  "superagent_delegate_stop_generation",
  "superagent_inspect_port", "superagent_find_process", "superagent_free_port",
  "superagent_kill_process",
  "superagent_import_discovered_project", "superagent_sync_projects",
  "superagent_register_project", "superagent_update_project",
  "superagent_remove_project", "superagent_grant_project_access",
  "superagent_revoke_project_access",
  "superagent_fetch_url", "superagent_web_search",
  "superagent_list_active", "superagent_get_process_status",
  "superagent_close_chrome_window", "superagent_close_chrome_profile",
  "superagent_muse_chat", "superagent_telegram_send_to_muse",
  "superagent_lan_discover", "superagent_lan_pair_request",
  "superagent_lan_pair_cancel", "superagent_lan_pair",
  "superagent_lan_session_open", "superagent_lan_session_close",
  "superagent_lan_revoke_device", "superagent_lan_device_exec",
  "superagent_lan_terminal_exec", "superagent_lan_terminal_fleet_open",
  "superagent_lan_terminal_fleet_close", "superagent_lan_terminal_fleet_start",
  "superagent_lan_terminal_fleet_read", "superagent_lan_terminal_fleet_input",
  "superagent_lan_terminal_fleet_key", "superagent_lan_terminal_fleet_resize",
  "superagent_lan_terminal_fleet_stop", "superagent_lan_terminal_start",
  "superagent_lan_terminal_read", "superagent_lan_terminal_input",
  "superagent_lan_terminal_resize", "superagent_lan_terminal_key",
  "superagent_lan_terminal_stop", "superagent_lan_android_diagnostic",
  "superagent_lan_android_shell", "superagent_lan_android_ui_schema",
  "superagent_lan_android_ui_click", "superagent_lan_android_screen",
  "superagent_lan_android_input",
  "superagent_device_tunnel_pair_request", "superagent_device_tunnel_tv_approve",
  "superagent_device_tunnel_qr_approve", "superagent_device_tunnel_revoke",
  "superagent_device_pair_cancel", "superagent_device_revoke",
  "superagent_device_session_open", "superagent_device_session_close",
  "superagent_device_exec", "superagent_device_terminal_fleet_open",
  "superagent_device_terminal_fleet_close", "superagent_device_terminal_fleet_start",
  "superagent_device_terminal_fleet_read", "superagent_device_terminal_fleet_input",
  "superagent_device_terminal_fleet_key", "superagent_device_terminal_fleet_resize",
  "superagent_device_terminal_fleet_stop", "superagent_device_terminal_start",
  "superagent_device_terminal_read", "superagent_device_terminal_input",
  "superagent_device_terminal_resize", "superagent_device_terminal_key",
  "superagent_device_terminal_stop", "superagent_device_android_diagnostic",
  "superagent_device_android_shell", "superagent_device_android_ui_schema",
  "superagent_device_android_ui_click", "superagent_device_android_screen",
  "superagent_device_android_input",
  "superagent_lan_file_offer", "superagent_lan_file_put", "superagent_lan_file_get",
  "superagent_lan_file_finish", "superagent_lan_file_abort",
  "superagent_device_file_offer", "superagent_device_file_put", "superagent_device_file_get",
  "superagent_device_file_finish", "superagent_device_file_abort",
  "superagent_device_capabilities", "superagent_muse_file_status",
  "superagent_muse_file_cancel", "superagent_switch_workspace",
]);
/**
 * The Delegate history sync writes only its app-owned SQLite mirror. It is NOT
 * a read-only operation and still requires MCP write scope + Security Approval.
 * No workspace/filePath or other caller-selected filesystem argument is allowed.
 */



function splitQuotedCommand(raw:string):string[]|null {
  if(!raw.trim()||raw.length>12000||/[\0\r\n]/.test(raw))return null;
  const parts=raw.match(/(?:[^\s"']+|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')+/g)||[];
  if(!parts.length||parts.length>200)return null;
  return parts.map(part=>{
    if((part.startsWith('"')&&part.endsWith('"'))||(part.startsWith("'")&&part.endsWith("'")))
      return part.slice(1,-1);
    return part;
  });
}
function officeCliEffects(args:Args|undefined):ExplicitFileEffect[]|null {
  if(!args||typeof args!=="object"||Array.isArray(args)||
     Object.keys(args).some(key=>!["command","workspace","projectId"].includes(key))||
     typeof args.command!=="string")return null;
  const parts=splitQuotedCommand(args.command);
  if(!parts)return null;
  const action=parts[0]!.toLowerCase();
  if(["help","--help","-h","version","--version","-v"].includes(action))return [];
  const supported=new Set(["view","inspect","get","create","set","convert"]);
  if(!supported.has(action))return null;
  const fileTokens=parts.slice(1).filter(token=>/\.(?:docx?|xlsx?|pptx?|pdf)$/i.test(token));
  if(!fileTokens.length)return null;
  // Reject command-line path-like tokens that are not recognized document files.
  // Office object selectors such as /Sheet1/A1 are explicitly allowed.
  for(const token of parts.slice(1)){
    if(fileTokens.includes(token)||token.startsWith("-")||/^\/[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)+$/.test(token))
      continue;
    if(/^[A-Za-z]:[\\/]|^\.\.?[\\/]|[\\]/.test(token))return null;
  }
  const effects:ExplicitFileEffect[]=[];
  const push=(raw:string,operations:FileOperation[])=>effects.push({raw,operations});
  if(["view","inspect","get"].includes(action))fileTokens.forEach(file=>push(file,["read"]));
  else if(action==="create")fileTokens.forEach((file,i)=>push(file,i===0?["write"]:["read"]));
  else if(action==="set")fileTokens.forEach(file=>push(file,["read","write"]));
  else if(action==="convert"){
    if(fileTokens.length<2)return null;
    push(fileTokens[0]!,["read"]);
    for(const file of fileTokens.slice(1))push(file,["write"]);
  }
  return effects;
}
const MIXED_ACTION_TOOLS = new Set([
  "superagent_brain","superagent_cli_bridge","superagent_git_action","superagent_exec_command",
  "superagent_chrome_vision","superagent_manage_workspace_chain",
  "superagent_cross_workspace_exec",
]);

function certifiedDiagnosticCommand(args:Args|undefined):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args)||
     Object.keys(args).some(key=>!["command","cwd","workspace","projectId","timeoutMs"].includes(key))||
     typeof args.command!=="string")return false;
  const parts=splitQuotedCommand(args.command);
  if(!parts||parts.length!==2)return false;
  const binary=parts[0]!.toLowerCase();
  const flag=parts[1]!.toLowerCase();
  if(!["--version","-v","-version"].includes(flag))return false;
  return new Set(["bun","node","npm","pnpm","yarn","deno","git","gh","python","python3",
    "rustc","cargo","go","java","javac"]).has(binary);
}
function certifiedMixedAction(name:string,args:Args|undefined):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args))return false;
  if(name==="superagent_git_action")
    return args.action==="log" &&
      Object.keys(args).every(key=>["action","limit","workspace","projectId"].includes(key)) &&
      (args.limit===undefined ||
        (Number.isSafeInteger(args.limit) && Number(args.limit)>=1 && Number(args.limit)<=50));
  if(name==="superagent_chrome_vision")
    return args.command==="status" &&
      Object.keys(args).every(key=>["command"].includes(key));
  if(name==="superagent_manage_workspace_chain"){
    const action=String(args.action??"");
    if(!["create","list","activate","deactivate","delete","add-node","remove-node","status","topology","update"].includes(action))
      return false;
    // Config mutations store path strings but do not open those paths. SSH/file use
    // happens later through independently authorized chain operations.
    return true;
  }
  if(name==="superagent_cross_workspace_exec")
    return ["disconnect","switch-node"].includes(String(args.operation??""));
  if(name==="superagent_cli_bridge"){
    const action=String(args.action??"");
    return ["list","profile.list","role.list","delegate.jobs","delegate.agents",
      "delegate.slots","delegate.health","session.list"].includes(action);
  }
  if(name==="superagent_exec_command")return certifiedDiagnosticCommand(args);
  if(name==="superagent_brain"){
    const action=String(args.action??"");
    const executionActions=new Set(["delegate.start","task.delegate.start","task.autostart","task.retry"]);
    return action.length>0&&!executionActions.has(action);
  }
  return false;
}
/** Git may traverse every tracked path and update the index. Certify only
 * when the native registry grants recursive access to the entire workspace
 * for each required effect and has no overlapping explicit deny for this
 * executable. This does NOT elevate the independent MCP Git capability.
 */
const GIT_WORKSPACE_EFFECTS:Record<string,FileOperation[]> = {
  status:["read"],diff:["read"],
  add:["read","write"],commit:["read","write"],
  restore:["read","write","delete"],clean:["read","write","delete"],
};
function sameGitApp(a:ExecutableIdentity,b:ExecutableIdentity):boolean {
  const norm=(value:string)=>a.platform==="win32"?value.toLowerCase():value;
  return a.platform===b.platform && norm(a.executablePath)===norm(b.executablePath) &&
    a.sha256.toLowerCase()===b.sha256.toLowerCase();
}
function gitPathWithin(parent:string,child:string,platform:ExecutableIdentity["platform"]):boolean {
  const lib=platform==="win32"?path.win32:path.posix;
  const norm=(value:string)=>platform==="win32"?lib.normalize(value).toLowerCase():lib.normalize(value);
  const root=norm(parent),candidate=norm(child);
  return candidate===root || candidate.startsWith(root.endsWith(lib.sep)?root:root+lib.sep);
}
function certifiedGitWorkspaceAction(
  args:Args|undefined,workspace:string,policy:PersistentAccessPolicy,identity:ExecutableIdentity,
):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args))return false;
  const action=typeof args.action==="string"?args.action:"";
  const operations=Object.prototype.hasOwnProperty.call(GIT_WORKSPACE_EFFECTS,action)
    ? GIT_WORKSPACE_EFFECTS[action] : undefined;
  if(!operations || !path.isAbsolute(workspace))return false;
  const allKeys=["action","workspace","projectId","files","message"];
  if(Object.keys(args).some(key=>!allKeys.includes(key)))return false;
  if(action==="commit" && (typeof args.message!=="string" || !args.message.trim() ||
      args.message.length>500))return false;
  if(action!=="commit" && args.message!==undefined)return false;
  const isTargeted=["add","restore","clean"].includes(action);
  if(isTargeted) {
    if(!Array.isArray(args.files)||args.files.length<1||args.files.length>50)return false;
  }else if(args.files!==undefined)return false;
  const root=absoluteCanonical(".",workspace);
  if(!root)return false;
  // A linked worktree's .git file may redirect index writes outside the
  // authorized workspace. Certify only repositories whose .git metadata
  // directory is located inside the exact registered root.
  try {
    const metadata=fs.lstatSync(path.join(root,".git"));
    if(!metadata.isDirectory()||metadata.isSymbolicLink())return false;
  }catch{return false;}
  // Git commands can traverse the entire working tree, so a per-file grant
  // alone is never sufficient for workspace-wide status/diff/index actions.
  const allowed=operations.every(operation=>policy.rules.some(rule=>
    rule.kind==="file" && rule.effect==="allow" && sameGitApp(rule.app,identity) &&
    rule.scope.recursive && rule.operations.includes(operation) &&
    gitPathWithin(rule.scope.path,root,identity.platform)));
  if(!allowed)return false;
  const overlapsDenied=policy.rules.some(rule=>rule.kind==="file" &&
    rule.effect==="deny" && sameGitApp(rule.app,identity) &&
    rule.operations.some(op=>operations.includes(op)) &&
    (gitPathWithin(root,rule.scope.path,identity.platform) ||
     gitPathWithin(rule.scope.path,root,identity.platform)));
  if(overlapsDenied)return false;
  if(!isTargeted)return true;
  for(const file of args.files as unknown[]) {
    if(typeof file!=="string"||!file.trim()||file.length>2048 ||
       path.isAbsolute(file) || /[*?\[\]!:]/.test(file) ||
       file.split(/[\\/]/).some(part=>part==="."||part===".."||part===".git"))return false;
    const target=absoluteCanonical(file,root);
    if(!target||target===root||!gitPathWithin(root,target,identity.platform))return false;
    // Directory pathspecs and symlink targets are not certified: they can
    // represent an unbounded collection or escape the selected project.
    try { if(fs.existsSync(target)&&!fs.lstatSync(target).isFile())return false; }
    catch { return false; }
    for(const operation of operations) {
      if(evaluatePersistentAccess(policy,{kind:"file",app:identity,path:target,operation}).effect!=="allow")
        return false;
    }
  }
  return true;
}
function certifiedExecCommandWorkspaceAction(
  args: Args | undefined,
  workspace: string,
  policy: PersistentAccessPolicy,
  identity: ExecutableIdentity,
): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;

  if (typeof args.commandId === "string" && args.commandId.trim()) {
    if (!path.isAbsolute(workspace)) return false;
    const root = absoluteCanonical(".", workspace);
    if (!root) return false;
    const allowed = policy.rules.some(rule =>
      rule.kind === "file" && rule.effect === "allow" && sameGitApp(rule.app, identity) &&
      rule.scope.recursive && rule.operations.includes("read") &&
      gitPathWithin(rule.scope.path, root, identity.platform)
    );
    if (!allowed) return false;
    const overlapsDenied = policy.rules.some(rule =>
      rule.kind === "file" && rule.effect === "deny" && sameGitApp(rule.app, identity) &&
      rule.operations.includes("read") &&
      (gitPathWithin(root, rule.scope.path, identity.platform) ||
       gitPathWithin(rule.scope.path, root, identity.platform))
    );
    return !overlapsDenied;
  }

  const rawCmd = typeof args.command === "string" ? args.command
    : typeof args.cmd === "string" ? args.cmd
    : typeof args.commandLine === "string" ? args.commandLine
    : "";
  if (!rawCmd.trim()) return false;
  if (isSystemDestructiveCommand(rawCmd)) return false;

  const targetDirRaw = typeof args.cwd === "string" && args.cwd
    ? args.cwd
    : typeof args.workspace === "string" && args.workspace
      ? args.workspace
      : workspace;

  if (!path.isAbsolute(targetDirRaw) && !path.isAbsolute(workspace)) return false;
  const root = path.isAbsolute(targetDirRaw)
    ? absoluteCanonical(".", targetDirRaw)
    : absoluteCanonical(targetDirRaw, workspace);
  if (!root) return false;

  const allowed = policy.rules.some(rule =>
    rule.kind === "file" && rule.effect === "allow" && sameGitApp(rule.app, identity) &&
    rule.scope.recursive &&
    rule.operations.includes("read") && rule.operations.includes("write") &&
    gitPathWithin(rule.scope.path, root, identity.platform)
  );
  if (!allowed) return false;

  const overlapsDenied = policy.rules.some(rule =>
    rule.kind === "file" && rule.effect === "deny" && sameGitApp(rule.app, identity) &&
    (gitPathWithin(root, rule.scope.path, identity.platform) ||
     gitPathWithin(rule.scope.path, root, identity.platform))
  );
  if (overlapsDenied) return false;

  return true;
}

function certifiedWorkspaceGrepAction(
  args: Args | undefined,
  workspace: string,
  policy: PersistentAccessPolicy,
  identity: ExecutableIdentity,
): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (Array.isArray(args.filePaths)) return false;

  const query = typeof args.query === "string" ? args.query
    : typeof args.pattern === "string" ? args.pattern
    : typeof args.search === "string" ? args.search : "";
  if (!query.trim()) return false;

  const targetDirRaw = typeof args.path === "string" && args.path
    ? (path.isAbsolute(args.path) ? args.path : path.resolve(workspace, args.path))
    : typeof args.cwd === "string" && args.cwd
      ? (path.isAbsolute(args.cwd) ? args.cwd : path.resolve(workspace, args.cwd))
      : typeof args.workspace === "string" && args.workspace
        ? (path.isAbsolute(args.workspace) ? args.workspace : path.resolve(workspace, args.workspace))
        : workspace;

  if (!path.isAbsolute(targetDirRaw) && !path.isAbsolute(workspace)) return false;
  const root = path.isAbsolute(targetDirRaw)
    ? absoluteCanonical(".", targetDirRaw)
    : absoluteCanonical(targetDirRaw, workspace);
  if (!root) return false;

  const allowed = policy.rules.some(rule =>
    rule.kind === "file" && rule.effect === "allow" && sameGitApp(rule.app, identity) &&
    rule.scope.recursive &&
    rule.operations.includes("read") &&
    gitPathWithin(rule.scope.path, root, identity.platform)
  );
  if (!allowed) return false;

  const overlapsDenied = policy.rules.some(rule =>
    rule.kind === "file" && rule.effect === "deny" && sameGitApp(rule.app, identity) &&
    rule.operations.includes("read") &&
    (gitPathWithin(root, rule.scope.path, identity.platform) ||
     gitPathWithin(rule.scope.path, root, identity.platform))
  );
  if (overlapsDenied) return false;

  return true;
}

function certifiedCliBridgeWorkspaceAction(
  args: Args | undefined,
  workspace: string,
  policy: PersistentAccessPolicy,
  identity: ExecutableIdentity,
): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;

  const targetDirRaw = typeof args.cwd === "string" && args.cwd
    ? args.cwd
    : typeof args.workspace === "string" && args.workspace
      ? args.workspace
      : workspace;

  if (!path.isAbsolute(targetDirRaw) && !path.isAbsolute(workspace)) return false;
  const root = path.isAbsolute(targetDirRaw)
    ? absoluteCanonical(".", targetDirRaw)
    : absoluteCanonical(targetDirRaw, workspace);
  if (!root) return false;

  const allowed = policy.rules.some(rule =>
    rule.kind === "file" && rule.effect === "allow" && sameGitApp(rule.app, identity) &&
    rule.scope.recursive &&
    rule.operations.includes("read") && rule.operations.includes("write") &&
    gitPathWithin(rule.scope.path, root, identity.platform)
  );
  if (!allowed) return false;

  const overlapsDenied = policy.rules.some(rule =>
    rule.kind === "file" && rule.effect === "deny" && sameGitApp(rule.app, identity) &&
    (gitPathWithin(root, rule.scope.path, identity.platform) ||
     gitPathWithin(rule.scope.path, root, identity.platform))
  );
  if (overlapsDenied) return false;

  return true;
}
function certifiedSkillAccess(name:string,args:Args|undefined):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args))return false;
  if(name==="superagent_get_skills")
    return Object.keys(args).every(key=>key==="query") &&
      (args.query===undefined||typeof args.query==="string");
  if(name!=="superagent_use_skill")return false;
  if(Object.keys(args).some(key=>!["skillName","path"].includes(key)))return false;
  return typeof args.skillName==="string"&&args.skillName.trim().length>0&&args.path===undefined;
}

function certifiedManagedChromeLaunch(args:Args|undefined):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args))return false;
  if(args.userDataDir!==undefined||args.isolated===false)return false;
  const managed=args.managedCdp===true||args.remoteDebuggingPort!==undefined;
  if(!managed)return false;
  if(args.url!==undefined){
    if(typeof args.url!=="string")return false;
    try { const u=new URL(args.url); if(!["http:","https:"].includes(u.protocol))return false; }
    catch{return false;}
  }
  return Object.keys(args).every(key=>["profileName","url","managedCdp",
    "remoteDebuggingPort","isolated","mode"].includes(key));
}
function certifiedWorktreeMetadata(args:Args|undefined):boolean {
  if(!args||typeof args!=="object"||Array.isArray(args))return false;
  if(args.action!=="list")return false;
  return Object.keys(args).every(key=>["action","workspace","projectId"].includes(key));
}
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
export type PermanentFileToolReadiness = "certified_metadata" | "certified_non_file" |
  "certified_app_storage" | "requires_explicit_files" | "action_dependent" | "uncertified";
/**
 * This describes ONLY the host file-policy gate, never the final authorization.
 * OAuth, principal grants, workspace scope and native approvals still apply.
 * A tool may have a permitted action even when its generic classification is
 * 'action_dependent'; this function deliberately does not guess its arguments.
 */
export function describePermanentFileToolReadiness(name:string):string {
  if(name==="superagent_tool_execute")
    return "Depends on the exact nested target and its arguments; the target is reauthorized independently.";
  if(name==="superagent_desktop_ui")
    return "Only probe, get_active_window, bounded list_windows/find_window/list_installed_apps, live_inventory, and inspect_security_prompts (without extra arguments) are certified. inspect_window returns UI content even without an image; open, snapshot, focus_window and input remain blocked under v2 until host-native file-aware mediation is implemented. MCP Execute approval is separate.";
  if(name==="superagent_chrome_cdp_observe")
    return "Only list_targets or transport_status with exact managed/Delegate arguments; HTTP(S) tab metadata is filtered, with no DOM read, navigation, evaluate, upload, or file:// access.";
  if(name==="superagent_chrome_cdp_web")
    return "Only exact certified Delegate web workflow commands on an explicit qualified HTTP(S) tab; write scope, separate human MCP approval, verified principal, tab lease and revision still required. No raw evaluation, files, terminal, screenshot or upload.";
  if(name==="superagent_chrome_cdp"||name==="superagent_control_chrome_cdp")
    return "Only exact certified browser metadata and leased public Delegate web actions are permitted. A single-file upload_file action is also certified only with transport=delegate, an exact qualified target and active lease, expectedRevision, confirmUpload:true, one explicit absolute filePath, and matching native host read approval. When read is denied, an agent may call superagent_request_file_access with that exact path and operations:[read]; the human must approve it in Tray Active Rules before retrying. Core stages the source in isolated ingress and verifies MIME and SHA-256 before CDP transfer. Managed uploads, arbitrary paths, unmediated file access, no evaluate, cookies and terminal commands remain blocked.";

  if(BROWSER_OBSERVATION_TOOLS.has(name))
    return "Only certified managed/Delegate HTTP(S) target metadata, local Chrome process inventory, or browser gateway identity/policy actions; no navigation, no evaluate, no upload, or file:// browsing.";
  if(CERTIFIED_CORE_LIFECYCLE_MUTATIONS.has(name))
    return "Requires exact port, confirm:true, operationId and expectedBuildDigest; MCP Connection Controls and authenticated Core supervisor still required.";
  if(CERTIFIED_LAN_INVENTORY.has(name) || CERTIFIED_PAIR_STATUS.has(name))
    return "Read-only Core-owned device inventory or opaque pairing status only; device shell, input, screenshots and file transfer remain restricted.";
  if(name==="superagent_grep_search")
    return "Explicit filePaths search is certified; recursive grep requires an authorized project workspace with active permanent read access rules.";
  if(name==="superagent_list_files"||name==="superagent_find_files")
    return "Directory discovery is performed by a registry-aware traversal that filters denied children and never reads file contents.";
  if(name==="superagent_manage_services")
    return "Read-only inspections and a strict owner-verified MCP backend reload (plan then confirm with exact owner PID, operation ID and public HTTPS URL) are certified; all other lifecycle mutations remain restricted.";
  if(name==="superagent_use_skill")
    return "Skill-name lookup is app-owned storage; an explicit path requires permanent read permission.";
  if(name==="superagent_manage_worktrees")
    return "List is certified metadata; recursive worktree removal remains blocked until every child file is mediated.";
  if(name==="superagent_launch_chrome")
    return "Only Managed CDP launches using SuperAgent-owned isolated profile storage and HTTP(S) URLs are certified.";
  if(name==="superagent_exec_command")
    return "Strict toolchain version diagnostics are non-file certified; workspace shell commands require active permanent file rules and an authorized project with execute capability.";
  if(name==="superagent_cli_bridge")
    return "Metadata inspection is certified; execution actions require an authorized project workspace with active permanent file access rules (read/write).";
  if(name==="superagent_git_action")
    return "Git log (1-50) is certified. Status/diff and targeted add/commit/restore/clean require recursive native host read/write/delete grants appropriate to the action, with no denied child files. Add/restore/clean require exact file paths. MCP project Git/OAuth approvals remain separate.";
  if(name==="superagent_office_cli")
    return "Recognized Office CLI document commands are parsed into explicit read/write file effects; unknown commands remain blocked.";
  if(MIXED_ACTION_TOOLS.has(name))
    return "Only non-file sub-actions are certified; shell/file/content-capable actions remain independently blocked.";
  if(FIXED_PLANNING_TOOLS.has(name))
    return "Current-workspace task/plan actions are mediated against fixed plan/task filenames; cross-instance targets remain blocked.";
  if(name==="superagent_check_project_health")
    return "Local project health reads only bounded root metadata, .git marker and common manifest names; SSH health remains separately restricted.";
  const readiness=getPermanentFileToolReadiness(name);
  if(readiness==="requires_explicit_files")
    return "Supply each canonical input/target file path inside the authorized project, with matching permanent host file rules; implicit outputs are not certified.";
  if(readiness==="certified_non_file")
    return "No MCP-host filesystem effect. OAuth, project/MCP approval, target identity and native consent still apply.";
  if(readiness==="certified_app_storage")
    return "Bounded app-owned Delegate index synchronization only; no caller-selected file paths. MCP write scope and independent connection approval still required.";
  if(readiness==="certified_metadata")
    return "Narrow metadata/control-plane request; no file content grant implied.";
  return "Not certified for permanent file policy v2: use an explicitly mediated operation rather than bypassing host restrictions.";
}
export function getPermanentFileToolReadiness(name: string): PermanentFileToolReadiness {
  if (name === "superagent_services_status") return "certified_metadata";
  if (BENIGN.has(name)) return "certified_metadata";
  if (name === "superagent_chrome_cdp_observe") return "certified_metadata";
  if (name === "superagent_chrome_cdp_web") return "action_dependent";
  if (name === "superagent_delegate_sync_history" || CERTIFIED_APP_STORAGE_TOOLS.has(name) ||
      name==="superagent_get_skills")
    return "certified_app_storage";
  if (CERTIFIED_NON_FILE_TOOLS.has(name)) return "certified_non_file";
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name) || PATCH_TOOLS.has(name) ||
      Object.prototype.hasOwnProperty.call(EXPLICIT_INPUT_READERS,name) ||
      EXPLICIT_EFFECT_TOOLS.has(name) || name==="superagent_media_plan")
    return "requires_explicit_files";
  if (BROWSER_OBSERVATION_TOOLS.has(name) || name === "superagent_manage_services" ||
      name === "superagent_tool_execute" || name === "superagent_grep_search" ||
      CERTIFIED_LAN_INVENTORY.has(name) || CERTIFIED_PAIR_STATUS.has(name) ||
      CERTIFIED_CORE_LIFECYCLE_MUTATIONS.has(name) || name === "superagent_desktop_ui" ||
      name==="superagent_use_skill" || name==="superagent_manage_worktrees" ||
      FIXED_PLANNING_TOOLS.has(name) || MIXED_ACTION_TOOLS.has(name) ||
      name==="superagent_check_project_health" || name==="superagent_launch_chrome" ||
      name==="superagent_list_files" || name==="superagent_find_files" ||
      name==="superagent_office_cli")
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
  if(CERTIFIED_NON_FILE_TOOLS.has(call.name))return null;
  if(CERTIFIED_APP_STORAGE_TOOLS.has(call.name))return null;
  if(call.name==="superagent_get_skills"&&certifiedSkillAccess(call.name,call.args))return null;
  if(call.name==="superagent_use_skill"&&certifiedSkillAccess(call.name,call.args))return null;
  if((call.name==="superagent_list_files"||call.name==="superagent_find_files") &&
     certifiedRegistryAwareDiscovery(call.name,call.args))return null;
  if(call.name==="superagent_manage_worktrees"&&certifiedWorktreeMetadata(call.args))return null;
  if(call.name==="superagent_launch_chrome"&&certifiedManagedChromeLaunch(call.args))return null;
  if(MIXED_ACTION_TOOLS.has(call.name)&&certifiedMixedAction(call.name,call.args))return null;
  if(call.name==="superagent_git_action"){
    // Bounded log is certified above; a malformed log request should not be
    // reported as a missing recursive workspace permission.
    if(call.args?.action==="log")
      return "Git log arguments are not certified: use only action, limit (1-50), workspace and projectId.";
    if(certifiedGitWorkspaceAction(call.args,workspace,policy,identity))return null;
    return "Git action requires an exact project workspace with recursive native file grants for the action, no protected child paths, and explicit file targets for add/restore/clean. Project Git approval alone is insufficient.";
  }
  if(call.name==="superagent_exec_command"){
    if(certifiedExecCommandWorkspaceAction(call.args,workspace,policy,identity))return null;
    return "Command execution is not certified: requires an authorized project workspace with active permanent file access rules (read/write), and must not be a system-destructive command or target unapproved paths.";
  }
  if(call.name==="superagent_cli_bridge"){
    if(certifiedCliBridgeWorkspaceAction(call.args,workspace,policy,identity))return null;
    return "CLI bridge execution is not certified: requires an authorized project workspace with active permanent file access rules (read/write), and must not target unapproved paths.";
  }
  if(call.name==="superagent_grep_search" && !Array.isArray(call.args?.filePaths)){
    if(certifiedWorkspaceGrepAction(call.args,workspace,policy,identity))return null;
    return "Recursive grep is not certified: requires an authorized project workspace with active permanent read access rules, and no overlapping deny rules.";
  }
  const officeEffects=call.name==="superagent_office_cli"?officeCliEffects(call.args):null;
  const planningEffects=FIXED_PLANNING_TOOLS.has(call.name)
    ?fixedPlanningEffects(call.name,call.args,workspace)
    :call.name==="superagent_check_project_health"?projectHealthEffects(workspace)
    :officeEffects;
  if(FIXED_PLANNING_TOOLS.has(call.name)&&planningEffects?.length===0)return null;
  if (call.name === "superagent_delegate_sync_history" && certifiedDelegateHistorySync(call.args))
    return null; // App-owned index only; never a general file write exemption.
  // No blanket Chrome exemption: only side-effect-free, non-file inventory
  // operations qualify. All other browser/file-capable actions fail closed.
  if(certifiedBrowserObservation(call))return null;
  if(certifiedDelegateWebAction(call))return null;
  if(certifiedBrowserUpload(call)){
    const sourcePath=getCertifiedBrowserUploadSourcePath(call);
    if(!sourcePath)return null; // Receipt-backed transfer or pathless, lease-bound verification.
    const actual=absoluteCanonical(sourcePath,path.dirname(sourcePath));
    if(!actual)return "Browser upload source must be an existing canonical local file.";
    const decision=evaluatePersistentAccess(policy,{kind:"file",app:identity,path:actual,operation:"read"});
    if(decision.effect!=="allow")return "Permanent file access denies read for the selected upload source. Request a native rule with superagent_request_file_access (the exact filePath and operations:[read]), then retry only after human approval in Tray > Access Manager > Requests > Active Rules.";
    return null;
  }
  if(certifiedLanInventory(call.name,call.args))return null;
  if(certifiedSupervisedCoreMutation(call.name,call.args))return null;
  if(call.name === "superagent_desktop_ui"){
    if(certifiedDesktopDiscovery(call.args))return null;
    // A human-granted MCP Execute capability cannot override the independent
    // host permanent-file policy. Distinguish a malformed metadata command
    // from an inherently uncertified content/input command without echoing
    // potentially sensitive caller arguments or paths.
    const command=call.args && typeof call.args.command==="string"
      ? call.args.command : call.args && typeof call.args.action==="string"
        ? call.args.action : "";
    if(CERTIFIED_DESKTOP_DISCOVERY.has(command))
      return "Desktop UI metadata command has unsupported arguments for permanent file-policy certification; use only the documented fields.";
    return "Desktop UI window content, session, lifecycle and input commands are not certified for permanent file access restrictions; MCP Execute approval does not replace host-native file-aware mediation.";
  }
  if(call.name === "superagent_services_status" || call.name === "superagent_manage_services"){
    const args=call.args??{};
    if(certifiedServiceInspection(args) &&
       (call.name==="superagent_services_status" || args.action!==undefined))return null;
    if(call.name==="superagent_manage_services"&&certifiedMcpBackendReloadArgs(args))return null;
    return call.name==="superagent_manage_services"
      ? "Service management is not certified with unsupported arguments: only read-only service inspection or exact owner-bound MCP backend reload (plan then confirm) is certified; other service lifecycle mutations remain restricted."
      : "Service inspection is not certified with unsupported arguments; use only the documented read-only fields.";
  }
  if(READ_SEARCH.has(call.name) &&
      !(call.name==="superagent_grep_search"&&certifiedExplicitGrepSearchArgs(call.args)) &&
      !((call.name==="superagent_list_files"||call.name==="superagent_find_files") &&
        certifiedRegistryAwareDiscovery(call.name,call.args)))
    return "Unmediated discovery/search could expose explicitly blocked child files.";
  if(Object.prototype.hasOwnProperty.call(EXPLICIT_INPUT_READERS,call.name) &&
      !certifiedInputReaderArguments(call.name,call.args))
    return "Document/media reader requires exactly one explicit input path and certified argument keys.";
  const explicitEffects=EXPLICIT_EFFECT_TOOLS.has(call.name)
    ? explicitFileEffects(call.name,call.args)
    : planningEffects;
  if((EXPLICIT_EFFECT_TOOLS.has(call.name)||FIXED_PLANNING_TOOLS.has(call.name)||
      call.name==="superagent_check_project_health"||call.name==="superagent_office_cli") && !explicitEffects)
    return "Tool requires explicit certified file effects for the selected action.";
  const mediaPlanPaths=call.name==="superagent_media_plan"
    ? certifiedMediaPlanPaths(call.args) : null;
  if(call.name==="superagent_media_plan" && !mediaPlanPaths)
    return "Media planner requires all explicit input, output and watermark paths with certified argument keys.";
  const operations:FileOperation[]=
    READ_TOOLS.has(call.name) || certifiedInputReaderArguments(call.name,call.args) ||
    (call.name==="superagent_grep_search"&&certifiedExplicitGrepSearchArgs(call.args)) ||
    mediaPlanPaths!==null?["read"]:
    WRITE_TOOLS.has(call.name)?["read","write"]:
    PATCH_TOOLS.has(call.name)?["read","write","delete"]:[];
  if(!operations.length&&!explicitEffects)
    return formatUncertifiedFilePolicyMessage(call.name, call.args);
  const args=call.args??{};
  const legacyEntries=mediaPlanPaths ?? (explicitEffects?null:pathsIn(args));
  if(!explicitEffects&&!legacyEntries)
    return "Explicit target file path(s) required by permanent file access policy.";
  if(!path.isAbsolute(workspace))return "Local absolute workspace required.";
  const effects:ExplicitFileEffect[]=explicitEffects ??
    (legacyEntries??[]).map(raw=>({raw,operations}));
  for(const effect of effects){
    const actual=absoluteCanonical(effect.raw,workspace);
    if(!actual)return "Non-canonical, missing, symlinked, or traversal file target is denied.";
    for(const operation of effect.operations){
      const decision=evaluatePersistentAccess(policy,{kind:"file",app:identity,path:actual,operation});
      if(decision.effect!=="allow"){
        return "Permanent file access denies "+operation+" for the selected target.";
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
