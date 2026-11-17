/** MCP ingress for outbound ChatGPT-to-ChatGPT workflow handoffs.
 * No internal SuperAgent agent lifecycle operations are exposed here.
 */
import type { McpToolResult } from "../types.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import { lifecycleAction } from "../../lifecycle/externalLifecycle.js";

const schema = (properties: Record<string, unknown>) => ({
  type: "object" as const, properties, additionalProperties: false,
});
export const LIFECYCLE_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_lifecycle: "dangerous",
  superagent_lifecycle_status: "safe",
};
export const LIFECYCLE_MCP_TOOL_DEFS = [
  {
    name: "superagent_lifecycle_status",
    description: "Read-only counts of scheduled external ChatGPT worker workflows in the authorized workspace; never accesses internal SuperAgent agents.",
    inputSchema: schema({
      projectId: { type: "string" },
      workspace: { type: "string" },
    }),
  },
  {
    name: "superagent_lifecycle",
    description: "Manage scheduled outbound tasks between opt-in MCP client agents. An MCP worker must poll/claim; this DOES NOT awaken a closed ChatGPT.com conversation, access internal SuperAgent agents, or grant worker tool permissions. All mutations require explicit MCP project execute approval.",
    inputSchema: schema({
      action: { type: "string", enum: [
        "create", "list", "workers", "worker.register", "worker.resume", "worker.heartbeat",
        "worker.claim", "worker.renew", "worker.complete", "run.now", "pause", "resume", "cancel",
      ] },
      projectId: { type: "string" },
      workspace: { type: "string" },
      name: { type: "string" },
      cronExpression: { type: "string" },
      prompt: { type: "string" },
      steps: { type: "array", maxItems: 12, items: {
        type: "object", required: ["id", "prompt"], properties: {
          id: { type: "string" }, prompt: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          targetWorkerId: { type: "string" },
        }, additionalProperties: false,
      } },
      maxRuns: { type: "integer", minimum: 1 },
      enabled: { type: "boolean" },
      workflowId: { type: "string" },
      runId: { type: "string" },
      stepId: { type: "string" },
      workerId: { type: "string" },
      label: { type: "string" },
      capabilities: { type: "array", items: { type: "string" }, maxItems: 12 },
      resumeToken: { type: "string" },
      leaseToken: { type: "string" },
      result: { type: "string" },
      outcome: { type: "string", enum: ["completed", "failed"] },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }),
  },
] as const;
export async function dispatchLifecycleMcpTool(
  name: string, args: Record<string, unknown>,
  verified: { actor: string; principal: string },
): Promise<McpToolResult | null> {
  if (name !== "superagent_lifecycle" && name !== "superagent_lifecycle_status") return null;
  try {
    const result = lifecycleAction(
      name === "superagent_lifecycle_status" ? "status" : String(args.action ?? ""),
      args, { workspace: getMcpWorkspacePath(), ...verified },
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : "Lifecycle action failed." }],
      isError: true,
    };
  }
}
