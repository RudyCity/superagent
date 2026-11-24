/**
 * R1 owner-scoped MCP capability ceiling. This is intentionally narrower than
 * getDefaultSafeTools(): even "read-only" global config/project inspection
 * must not silently escape the managed owner's private workspace.
 */
import path from "node:path";
import { assertPathWithinProject } from "../project/projectRouter.js";
import {
  isValidActiveFileAccessRequestInput,
  isValidActiveApplicationAccessRequestInput,
} from "../desktopUi/activeFileAccessRequestStore.js";

export const R1_OWNER_TOOLS: readonly string[] = Object.freeze([
  "superagent_tool_search",
  "superagent_tool_describe",
  "superagent_tool_execute",
  "superagent_tool_status",
  "superagent_tool_preflight",
  "superagent_tool_doctor",
  "superagent_read_files",
  "superagent_list_files",
  "superagent_grep_search",
  "superagent_find_files",
  "superagent_get_workspace",
  "superagent_server_health",
  "superagent_request_file_access",
  "superagent_request_application_access",
]);

export function canUnlockMcpDangerousTools(input: {
  lockSafeTools: boolean;
  allowDangerous?: boolean;
}): boolean {
  // Discovery is separate from authorization. Execution still requires the
  // authenticated principal's Security Approval grant and OAuth scopes.
  return !input.lockSafeTools;
}

export function isR1OwnerToolCallAllowed(
  toolName: string,
  args: Record<string,unknown>,
  root: string,
): boolean {
  if(!R1_OWNER_TOOLS.includes(toolName)) return false;
  if(typeof args.projectId === "string" && args.projectId.length > 0) return false;
  if(toolName === "superagent_request_file_access") {
    if(!isValidActiveFileAccessRequestInput(args)) return false;
    const request = args as unknown as { operations: string[]; recursive?: boolean };
    // The SAFE-only owner may request one exact read grant, never write/delete
    // or recursive directory authority. Approval remains a separate human act.
    return request.operations.length === 1 && request.operations[0] === "read" &&
      request.recursive !== true;
  }
  if(toolName === "superagent_request_application_access") {
    if(!isValidActiveApplicationAccessRequestInput(args)) return false;
    const request = args as unknown as { operations: string[] };
    // SAFE-only owners may request viewing, not interactive application input.
    // Tray native approval remains mandatory for both types of access.
    return request.operations.length === 1 && request.operations[0] === "view";
  }

  const pathKeys = ["cwd","workspace","worktreePath","path","dirPath","filePath","file"];
  const candidates: string[] = [];
  for(const key of pathKeys) {
    const v = args[key];
    if(typeof v === "string" && v.trim()) candidates.push(v);
    else if(v !== undefined && v !== null && v !== "") return false;
  }
  if(toolName === "superagent_read_files") {
    const entries=args.files??args.filePaths;
    if(!Array.isArray(entries)||entries.length===0||entries.length>50)return false;
    for(const entry of entries) {
      const candidate=typeof entry==="string"?entry:
        entry && typeof entry==="object" && !Array.isArray(entry)?
        ((entry as Record<string,unknown>).filePath??(entry as Record<string,unknown>).path):null;
      if(typeof candidate!=="string"||!candidate.trim())return false;
      candidates.push(candidate);
    }
  }
  // The gateway itself has no path operands. Its nested target is checked
  // by the same guard again on recursive dispatch.
  if(toolName.startsWith("superagent_tool_")||toolName==="superagent_server_health") {
    return candidates.length===0;
  }
  const workspace = path.resolve(root);
  const current = typeof args.workspace==="string" && args.workspace.trim()?
    args.workspace:typeof args.cwd==="string"&&args.cwd.trim()?args.cwd:workspace;
  try{
    const actualWorkspace=assertPathWithinProject(current,workspace);
    for(const candidate of candidates) {
      assertPathWithinProject(path.resolve(actualWorkspace,candidate),workspace);
    }
    return true;
  }catch{return false;}
}
