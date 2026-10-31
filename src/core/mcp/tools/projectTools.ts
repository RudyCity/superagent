import {
  getProject,
  listProjects,
  registerProject,
  removeProject,
  updateProject,
  type RegisterProjectInput,
  type UpdateProjectInput,
  type RegisteredProject,
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
import {
  queryWorkspaceCatalog,
  getWorkspaceCatalogEntry,
} from "../../project/workspaceCatalog.js";

export const PROJECT_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_list_projects: "safe",
  superagent_get_project: "safe",
  superagent_discover_projects: "safe",
  superagent_import_discovered_project: "dangerous",
  superagent_sync_projects: "dangerous",
  superagent_register_project: "dangerous",
  superagent_update_project: "dangerous",
  superagent_remove_project: "dangerous",
  superagent_list_project_access: "safe",
  superagent_check_project_health: "safe",
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
    name: "superagent_discover_projects",
    description: "Discover candidate projects from the Workspace Catalog (historical sessions, trusted directories, active sessions, and registered projects). Read-only; does not modify project registry and does not grant capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        classification: { type: "string", enum: ["project", "nested-project", "worktree", "temporary", "test-fixture", "missing", "unsafe", "unknown"], description: "Optional filter by classification." },
        registered: { type: "boolean", description: "Filter by whether project is already registered in MCP projects.json." },
        available: { type: "boolean", description: "Filter by whether directory exists on disk." },
        trusted: { type: "boolean", description: "Filter by trusted directory status." },
        active: { type: "boolean", description: "Filter by currently active server sessions." },
        type: { type: "string", enum: ["local", "ssh", "chain"], description: "Filter by project type." },
        source: { type: "string", enum: ["registry", "history", "trusted", "active", "chain"], description: "Filter by originating source." },
        importableOnly: { type: "boolean", description: "Return only candidates eligible to be imported as MCP projects." },
        query: { type: "string", maxLength: 100, description: "Text search filter matching name, target path, catalogId, or projectId." },
        limit: { type: "number", minimum: 1, maximum: 200, description: "Maximum number of projects to return (default 50)." },
        offset: { type: "number", minimum: 0, description: "Number of projects to skip." },
      },
    },
  },
  {
    name: "superagent_import_discovered_project",
    description: "Import a discovered candidate project from the Workspace Catalog into the explicit MCP project registry. Requires dangerous-tool permission. Registration creates registry metadata only and NEVER grants capabilities (registration != authorization).",
    inputSchema: {
      type: "object",
      properties: {
        catalogId: { type: "string", description: "Stable catalogId returned by superagent_discover_projects." },
        target: { type: "string", description: "Alternative to catalogId: canonical target path, sanitized SSH target, or chain ID." },
        projectId: { type: "string", minLength: 1, maxLength: 63, description: "Optional custom project ID for MCP registry." },
        name: { type: "string", minLength: 1, maxLength: 120, description: "Optional custom display name for MCP registry." },
        description: { type: "string", maxLength: 500, description: "Optional description." },
        tags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 40 }, description: "Optional project tags." },
        dryRun: { type: "boolean", description: "If true, validates registration without modifying registry." },
      },
    },
  },
  {
    name: "superagent_sync_projects",
    description: "Reconcile or bulk-import discovered projects from the Workspace Catalog into the explicit MCP project registry. Mode 'dry-run' lists importable candidates; mode 'apply' registers the specified catalogIds. Never grants capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["dry-run", "apply"], description: "Sync mode: 'dry-run' inspects candidates without changes; 'apply' imports the specified catalogIds." },
        catalogIds: { type: "array", items: { type: "string" }, description: "Explicit list of catalogIds to import (required when mode=apply)." },
      },
      required: ["mode"],
    },
  },
  {
    name: "superagent_check_project_health",
    description: "Run bounded, read-only health checks against an enabled registered local or SSH project. Requires the read capability; registration alone does not grant access. Does not install dependencies, write files, or execute project scripts. Manifest presence is informational only; this is not a security scan and does not prove the application runs. Workspace Chain health is reported as unsupported until chain-specific diagnostics are integrated.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", minLength: 1, maxLength: 63, description: "Stable ID of the registered local or SSH project." },
        timeoutMs: { type: "number", minimum: 1000, maximum: 15000, description: "Optional check deadline in milliseconds (clamped to 1-15 seconds)." },
      },
      required: ["projectId"],
    },
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
      case "superagent_discover_projects": {
        const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 200) : 50;
        const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;
        const result = queryWorkspaceCatalog({
          classification: typeof args.classification === "string" ? (args.classification as any) : undefined,
          registered: typeof args.registered === "boolean" ? args.registered : undefined,
          available: typeof args.available === "boolean" ? args.available : undefined,
          trusted: typeof args.trusted === "boolean" ? args.trusted : undefined,
          active: typeof args.active === "boolean" ? args.active : undefined,
          type: typeof args.type === "string" ? (args.type as any) : undefined,
          source: typeof args.source === "string" ? (args.source as any) : undefined,
          importableOnly: typeof args.importableOnly === "boolean" ? args.importableOnly : undefined,
          query: typeof args.query === "string" ? args.query : undefined,
          limit,
          offset,
        });

        const projects = result.entries.map((entry) => ({
          catalogId: entry.catalogId,
          name: entry.displayName,
          type: entry.type,
          target: entry.canonicalTarget,
          registered: entry.registered,
          registeredProjectId: entry.registeredProjectId,
          trusted: entry.trusted,
          active: entry.active,
          available: entry.available,
          sessionCount: entry.sessionCount,
          firstSeenAt: entry.firstSeenAt,
          lastUsedAt: entry.lastUsedAt,
          classification: entry.classification,
          importable: entry.importable,
          rejectionReasons: entry.rejectionReasons,
          requiresManualProfile: entry.requiresManualProfile,
        }));

        return textResult({
          projects,
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        });
      }
      case "superagent_import_discovered_project": {
        const targetRef =
          (typeof args.catalogId === "string" && args.catalogId.trim()) ||
          (typeof args.target === "string" && args.target.trim()) ||
          "";
        if (!targetRef) throw new Error("Either catalogId or target is required to import a project.");

        const entry = getWorkspaceCatalogEntry(targetRef);
        if (!entry) throw new Error(`Catalog entry not found: ${targetRef}`);

        if (entry.registered) {
          throw new Error(`Project is already registered in MCP registry with ID: ${entry.registeredProjectId}`);
        }
        if (!entry.available) {
          throw new Error(`Cannot import unavailable workspace: ${entry.rejectionReasons.join("; ") || "Target not available"}`);
        }
        if (!entry.importable) {
          throw new Error(`Cannot import ${entry.classification}: ${entry.rejectionReasons.join("; ") || "Not importable"}`);
        }

        const candidateInput: RegisterProjectInput = {
          id: typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : undefined,
          name: typeof args.name === "string" && args.name.trim() ? args.name.trim() : entry.displayName,
          type: entry.type,
          root: entry.type === "local" ? entry.canonicalTarget : undefined,
          target: entry.type !== "local" ? entry.canonicalTarget : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : ["catalog", "imported"],
        };

        if (args.dryRun === true) {
          return textResult({
            dryRun: true,
            wouldRegister: candidateInput,
            catalogId: entry.catalogId,
            canonicalTarget: entry.canonicalTarget,
            capabilitiesGranted: false,
          });
        }

        const registered = registerProject(candidateInput);
        return textResult({
          imported: registered,
          catalogId: entry.catalogId,
          capabilitiesGranted: false,
          message: "Project successfully registered in MCP registry. Explicit capability grants remain required before MCP operations can be performed.",
        });
      }
      case "superagent_sync_projects": {
        const mode = typeof args.mode === "string" ? args.mode.trim().toLowerCase() : "";
        if (mode !== "dry-run" && mode !== "apply") {
          throw new Error("mode must be either 'dry-run' or 'apply'.");
        }

        if (mode === "dry-run") {
          const importableResult = queryWorkspaceCatalog({ importableOnly: true });
          const candidates = importableResult.entries.map((entry) => ({
            catalogId: entry.catalogId,
            name: entry.displayName,
            type: entry.type,
            target: entry.canonicalTarget,
            classification: entry.classification,
            sessionCount: entry.sessionCount,
            lastUsedAt: entry.lastUsedAt,
          }));
          return textResult({
            mode: "dry-run",
            totalImportable: candidates.length,
            candidates,
            message: "Dry run completed. To import, call superagent_sync_projects with mode='apply' and explicit catalogIds, or use superagent_import_discovered_project for individual projects.",
          });
        }

        // mode === "apply"
        const rawCatalogIds = Array.isArray(args.catalogIds) ? args.catalogIds : [];
        const uniqueCatalogIds = Array.from(
          new Set(rawCatalogIds.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)),
        );
        if (uniqueCatalogIds.length === 0) {
          throw new Error("mode 'apply' requires a non-empty array of catalogIds.");
        }
        if (uniqueCatalogIds.length > 100) {
          throw new Error("Too many catalogIds in a single request (maximum 100).");
        }
        const catalogIds = uniqueCatalogIds;

        const imported: RegisteredProject[] = [];
        const errors: Array<{ catalogId: string; error: string }> = [];

        for (const rawId of catalogIds) {
          const id = typeof rawId === "string" ? rawId.trim() : "";
          if (!id) continue;
          try {
            const entry = getWorkspaceCatalogEntry(id);
            if (!entry) throw new Error("Catalog entry not found.");
            if (entry.registered) throw new Error(`Already registered as ${entry.registeredProjectId}`);
            if (!entry.importable || !entry.available) throw new Error(`Not importable: ${entry.rejectionReasons.join("; ")}`);

            const reg = registerProject({
              name: entry.displayName,
              type: entry.type,
              root: entry.type === "local" ? entry.canonicalTarget : undefined,
              target: entry.type !== "local" ? entry.canonicalTarget : undefined,
              tags: ["catalog", "sync"],
            });
            imported.push(reg);
          } catch (err) {
            errors.push({ catalogId: id, error: err instanceof Error ? err.message : String(err) });
          }
        }

        return textResult({
          mode: "apply",
          importedCount: imported.length,
          imported,
          errorsCount: errors.length,
          errors,
          capabilitiesGranted: false,
          message: "Controlled sync completed. No permissions or capabilities were auto-granted.",
        });
      }
      case "superagent_register_project": {
        const input = {
          id: typeof args.projectId === "string" ? args.projectId : undefined,
          name: typeof args.name === "string" ? args.name : "",
          type: args.type,
          root: typeof args.root === "string" ? args.root : undefined,
          target: typeof args.target === "string" ? args.target : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
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
        const targetChanged = Boolean(
          before &&
            ((updates.root && updates.root !== before.root) ||
              (updates.target && updates.target !== before.target)),
        );
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
        if (!isFullYoloMode())
          throw new Error("Granting access outside the current workspace requires Full YOLO to be enabled locally.");
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
