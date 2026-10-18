import {
  getProject,
  listProjects,
  registerProject,
  removeProject,
  updateProject,
  type RegisterProjectInput,
  type UpdateProjectInput,
} from "../../project/projectRegistry.js";
import { isFullYoloMode } from "../../permissions.js";
import { standaloneSshProjectProvider } from "./standaloneSshProjectTools.js";
import {
  PROJECT_ACCESS_CAPABILITIES,
  grantProjectAccess,
  listProjectAccess,
  revokeProjectAccess,
  revokeAllProjectAccess,
  type ProjectAccessCapability,
  type ProjectAccessIdentity,
} from "../../project/projectAccessPolicy.js";

export const PROJECT_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_list_projects: "safe",
  superagent_get_project: "safe",
  superagent_register_project: "dangerous",
  superagent_update_project: "dangerous",
  superagent_remove_project: "dangerous",
  superagent_list_project_access: "safe",
  superagent_grant_project_access: "dangerous",
  superagent_revoke_project_access: "dangerous",
};

export const PROJECT_MCP_TOOL_DEFS = [
  {
    name: "superagent_list_projects",
    description: "List explicitly registered MCP projects and their enabled state. Project registration does not grant path permissions by itself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "superagent_get_project",
    description: "Inspect a registered project by its stable projectId.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 63 } }, required: ["projectId"] },
  },
  {
    name: "superagent_register_project",
    description: "Register a project explicitly. Local roots must already exist. Registration does not auto-trust paths or grant filesystem permissions. SSH targets must not contain credentials.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 63 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        type: { type: "string", enum: ["local", "ssh", "chain"] },
        root: { type: "string", description: "Existing local project directory; required for type=local." },
        target: { type: "string", description: "Credential-free ssh:// target or chain:<id>; required for remote types." },
        description: { type: "string", maxLength: 500 },
        tags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 40 } },
        enabled: { type: "boolean" },
      },
      required: ["name", "type"],
    },
  },
  {
    name: "superagent_update_project",
    description: "Update metadata, root/target, tags, or enabled state for a registered project selected by stable projectId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 63 },
        name: { type: "string", minLength: 1, maxLength: 120 },
        root: { type: "string" },
        target: { type: "string" },
        description: { type: "string", maxLength: 500 },
        tags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 40 } },
        enabled: { type: "boolean" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "superagent_remove_project",
    description: "Remove a registered project by stable projectId. This removes only registry metadata, not project files or git history.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 63 } }, required: ["projectId"] },
  },
  {
    name: "superagent_list_project_access",
    description: "List project access grants for the authenticated MCP identity. Does not reveal grants belonging to other identities.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "superagent_grant_project_access",
    description: "Grant the authenticated MCP identity explicit capabilities on an enabled registered project. Requires Full YOLO and dangerous-tool permission. Registration alone does not grant access. Capabilities replace any existing grant for this project: read, write, execute, git, worktree, planning, chain.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 63 },
        capabilities: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: [...PROJECT_ACCESS_CAPABILITIES] } },
      },
      required: ["projectId", "capabilities"],
    },
  },
  {
    name: "superagent_revoke_project_access",
    description: "Revoke the authenticated MCP identity's grant for one registered project. Requires dangerous-tool permission.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", minLength: 1, maxLength: 63 } }, required: ["projectId"] },
  },
] as const;

function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export async function dispatchProjectMcpTool(
  name: string,
  args: Record<string, unknown>,
  identity?: ProjectAccessIdentity | null,
): Promise<any | null> {
  if (!Object.prototype.hasOwnProperty.call(PROJECT_MCP_TOOL_CLASSIFICATIONS, name)) return null;
  try {
    switch (name) {
      case "superagent_list_projects":
        return textResult({ projects: listProjects() });
      case "superagent_get_project": {
        const id = typeof args.projectId === "string" ? args.projectId.trim() : "";
        if (!id) throw new Error("projectId is required.");
        const project = getProject(id);
        if (!project) throw new Error(`Project not found: ${id}`);
        return textResult({ project });
      }
      case "superagent_register_project": {
        const input = {
          id: typeof args.projectId === "string" ? args.projectId : undefined,
          name: typeof args.name === "string" ? args.name : "",
          type: args.type,
          root: typeof args.root === "string" ? args.root : undefined,
          target: typeof args.target === "string" ? args.target : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          tags: Array.isArray(args.tags) ? args.tags as string[] : undefined,
          enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
        } as RegisterProjectInput;
        return textResult({ registered: registerProject(input) });
      }
      case "superagent_update_project": {
        const id = typeof args.projectId === "string" ? args.projectId.trim() : "";
        if (!id) throw new Error("projectId is required.");
        const updates: UpdateProjectInput = {};
        if (typeof args.name === "string") updates.name = args.name;
        if (typeof args.root === "string") updates.root = args.root;
        if (typeof args.target === "string") updates.target = args.target;
        if (typeof args.description === "string") updates.description = args.description;
        if (Array.isArray(args.tags)) updates.tags = args.tags as string[];
        if (typeof args.enabled === "boolean") updates.enabled = args.enabled;
        const before = getProject(id);
        const updated = updateProject(id, updates);
        const targetChanged = Boolean(before && ((updates.root && updates.root !== before.root) || (updates.target && updates.target !== before.target)));
        const disabled = updates.enabled === false;
        if (targetChanged || disabled) {
          revokeAllProjectAccess(id);
          await standaloneSshProjectProvider.closeProject(id);
        }
        return textResult({ updated, previousAccessGrantsRevoked: targetChanged || disabled });
      }
      case "superagent_remove_project": {
        const id = typeof args.projectId === "string" ? args.projectId.trim() : "";
        if (!id) throw new Error("projectId is required.");
        if (!getProject(id)) throw new Error(`Project not found: ${id}`);
        await standaloneSshProjectProvider.closeProject(id);
        if (!removeProject(id)) throw new Error(`Project not found: ${id}`);
        const revokedGrants = revokeAllProjectAccess(id);
        return textResult({ removed: id, filesDeleted: false, revokedGrants });
      }
      case "superagent_list_project_access": {
        if (!identity) throw new Error("Project access grants require an authenticated MCP identity.");
        return textResult({ grants: listProjectAccess(identity), capabilities: PROJECT_ACCESS_CAPABILITIES });
      }
      case "superagent_grant_project_access": {
        if (!identity) throw new Error("Project access grants require an authenticated MCP identity.");
        const id = typeof args.projectId === "string" ? args.projectId.trim() : "";
        const project = getProject(id);
        if (!project) throw new Error(`Project not found: ${id}`);
        if (!project.enabled) throw new Error(`Project is disabled: ${id}`);
        if (!isFullYoloMode()) throw new Error("Granting access outside the current workspace requires Full YOLO to be enabled locally.");
        if (!Array.isArray(args.capabilities)) throw new Error("capabilities must be a non-empty array.");
        return textResult({ grant: grantProjectAccess(identity, id, args.capabilities as ProjectAccessCapability[]) });
      }
      case "superagent_revoke_project_access": {
        if (!identity) throw new Error("Project access grants require an authenticated MCP identity.");
        const id = typeof args.projectId === "string" ? args.projectId.trim() : "";
        if (!id) throw new Error("projectId is required.");
        return textResult({ projectId: id, revoked: revokeProjectAccess(identity, id) });
      }
      default:
        return null;
    }
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
}
