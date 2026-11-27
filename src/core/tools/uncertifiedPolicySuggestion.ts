import {
  describeBoundedBrowserObservePermission,
  describeBoundedDesktopPermission,
} from "../mcp/mcpPermissionDecision.js";

type SuggestionSpec = {
  tool: string;
  capabilities: readonly string[];
  schema: Record<string, unknown>;
};

const DESKTOP_DISCOVERY_COMMANDS = [
  "probe",
  "stats",
  "list_windows",
  "get_active_window",
  "find_window",
  "list_installed_apps",
  "live_inventory",
  "inspect_security_prompts",
] as const;

const SUGGESTION_CATALOG: Record<string, SuggestionSpec> = {
  superagent_exec_command: {
    tool: "superagent_exec_command",
    capabilities: ["execute", "read"],
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Version diagnostic only (e.g. 'bun --version'); arbitrary shell commands are not certified." },
        cwd: { type: "string" },
        workspace: { type: "string" },
        projectId: { type: "string" },
        timeoutMs: { type: "number" },
      },
      required: ["command"],
    },
  },
  superagent_patch_file: {
    tool: "superagent_patch_file",
    capabilities: ["write", "read"],
    schema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Target file path inside authorized workspace." },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["replace_block", "insert_before", "insert_after"] },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
              line: { type: "integer", minimum: 0 },
              expectedSnippet: { type: "string" },
              expectedLineSnippet: { type: "string" },
              replacement: { type: "string" },
              content: { type: "string" },
            },
            required: ["kind"],
          },
        },
        workspace: { type: "string" },
        cwd: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["filePath", "operations"],
    },
  },
  superagent_cli_bridge: {
    tool: "superagent_cli_bridge",
    capabilities: ["execute", "read"],
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "profile.list", "role.list", "delegate.jobs", "delegate.agents", "delegate.slots", "delegate.health", "session.list"],
        },
        projectId: { type: "string" },
        workspace: { type: "string" },
      },
      required: ["action"],
    },
  },
  superagent_git_action: {
    tool: "superagent_git_action",
    capabilities: ["read", "git"],
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["log", "status", "diff", "add", "commit", "restore", "clean"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
        message: { type: "string", minLength: 1, maxLength: 500 },
        workspace: { type: "string" },
        projectId: { type: "string" },
      },
      required: ["action"],
    },
  },
  superagent_desktop_ui: {
    tool: "superagent_desktop_ui",
    capabilities: ["read", "execute"],
    schema: {
      type: "object",
      properties: {
        command: { type: "string", enum: [...DESKTOP_DISCOVERY_COMMANDS] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        query: { type: "string", maxLength: 256 },
        pid: { type: "integer", minimum: 1 },
      },
      required: ["command"],
    },
  },
  superagent_manage_services: {
    tool: "superagent_manage_services",
    capabilities: ["execute", "read"],
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "inventory", "owner_status", "doctor", "health", "dashboard", "logs", "profile", "plan", "reload"] },
        service: { type: "string", enum: ["mcp"] },
        port: { type: "integer", minimum: 1024, maximum: 65535 },
        targetAction: { type: "string", enum: ["reload"] },
        confirm: { type: "boolean" },
        operationId: { type: "string" },
        expectedOwnerPid: { type: "integer", minimum: 1 },
        expectedPublicUrl: { type: "string" },
      },
      required: ["action"],
    },
  },
};

function resolvePermissionSummary(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === "superagent_chrome_cdp_observe") {
    return describeBoundedBrowserObservePermission(args, true, true);
  }
  if (toolName === "superagent_desktop_ui") {
    return describeBoundedDesktopPermission({
      oauthAllowed: true,
      projectDecision: "approval_required",
      filePolicyActive: true,
      hostBlock: "Tool is not certified for permanent file access restrictions.",
    });
  }
  return {
    oauthScope: "mcp:tools:write (for write/execute tools) or mcp:tools",
    hostFilePolicy: "blocked",
    grantRequestTool: "superagent_request_project_access",
  };
}

export function formatUncertifiedFilePolicyMessage(
  toolName: string,
  args: Record<string, unknown> = {},
): string {
  const baseMessage = "Access denied by host permanent file policy: Tool is not certified for permanent file access restrictions.";
  const spec = SUGGESTION_CATALOG[toolName] ?? {
    tool: toolName,
    capabilities: ["read"],
    schema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        workspace: { type: "string" },
      },
    },
  };

  const requestGrantSchema = {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Registered project ID (e.g. 'superagent')." },
      capabilities: {
        type: "array",
        items: { type: "string", enum: ["read", "write", "execute", "git", "worktree", "planning", "chain"] },
        minItems: 1,
      },
      reason: { type: "string", minLength: 5, maxLength: 500 },
    },
    required: ["capabilities", "reason"],
  };

  const payload = {
    toolPermissionSuggestion: {
      requestedTool: toolName,
      suggestedGrantTool: "superagent_request_project_access",
      suggestedGrantInput: {
        projectId: typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : "superagent",
        capabilities: spec.capabilities,
        reason: `Requesting project access for ${toolName} after host permanent file policy notice.`,
      },
      suggestedGrantSchema: requestGrantSchema,
      certifiedAlternativeTool: spec.tool,
      certifiedAlternativeSchema: spec.schema,
      permissionContext: resolvePermissionSummary(toolName, args),
    },
  };

  return `${baseMessage}\n${JSON.stringify(payload, null, 2)}`;
}
