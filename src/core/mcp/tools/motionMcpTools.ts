import {
  createMotionProject, getMotionProject, listMotionProjects, updateMotionProject,
} from "../../motion/motionService.js";
import {
  getMotionJob, inspectMotionJob, listMotionJobs, requestMotionCancellation, startDetachedMotionJob,
} from "../../motion/jobs/motionJobs.js";
import type { MotionEdit } from "../../motion/schema/types.js";
import type { McpToolResult } from "../types.js";

export const MOTION_MCP_TOOL_DEFS = [
  {
    name: "superagent_motion_list",
    description: "List Motion Studio projects in an authorized local workspace.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string", description: "Registered workspace project routing ID (not a Motion scene ID)." },
    } },
  },
  {
    name: "superagent_motion_inspect",
    description: "Inspect a Motion Studio scene revision by motionId within an authorized workspace.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      motionId: { type: "string" },
    }, required: ["motionId"] },
  },
  {
    name: "superagent_motion_create",
    description: "Create a Motion Studio project. Requires workspace write access and dangerous-tool opt-in.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      name: { type: "string" },
    }, required: ["name"] },
  },
  {
    name: "superagent_motion_edit",
    description: "Apply revision-guarded declarative scene edits (text, x, y, opacity, rotation or keyframe track). Requires write permission.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      motionId: { type: "string" }, baseRevision: { type: "integer", minimum: 1 },
      edits: { type: "array", minItems: 1, maxItems: 50, items: { type: "object" } },
    }, required: ["motionId", "baseRevision", "edits"] },
  },
  {
    name: "superagent_motion_render",
    description: "Start a detached H.264 Motion render job. Requires execute permission, output-write authorization, and dangerous-tool opt-in.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      motionId: { type: "string" }, width: { type: "integer", minimum: 160, maximum: 1280 },
    }, required: ["motionId"] },
  },
  {
    name: "superagent_motion_jobs",
    description: "List read-only Motion render job summaries for the selected local workspace.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
    } },
  },
  {
    name: "superagent_motion_status",
    description: "Inspect the saved state of an authorized Motion render job.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      jobId: { type: "string" },
    }, required: ["jobId"] },
  },
  {
    name: "superagent_motion_recovery",
    description: "Read-only Motion worker ownership and lock diagnostic. Never kills or reclaims worker processes.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      jobId: { type: "string" },
    }, required: ["jobId"] },
  },
  {
    name: "superagent_motion_cancel",
    description: "Request cooperative cancellation of a scoped Motion render job. Requires execute permission.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      jobId: { type: "string" },
    }, required: ["jobId"] },
  },
];

export const MOTION_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_motion_list: "safe",
  superagent_motion_inspect: "safe",
  superagent_motion_jobs: "safe",
  superagent_motion_status: "safe",
  superagent_motion_recovery: "safe",
  superagent_motion_create: "dangerous",
  superagent_motion_edit: "dangerous",
  superagent_motion_render: "dangerous",
  superagent_motion_cancel: "dangerous",
};

export const MOTION_MCP_TOOL_NAMES = new Set(Object.keys(MOTION_MCP_TOOL_CLASSIFICATIONS));

/**
 * Only called after MCP identity, registered project routing, dangerous-tool,
 * workspace scope and capability checks have succeeded in the server dispatcher.
 */
export async function dispatchMotionMcpTool(
  name: string, args: Record<string, unknown>, authorizedWorkspace: string,
): Promise<McpToolResult | null> {
  if (!MOTION_MCP_TOOL_NAMES.has(name)) return null;
  const motionId = typeof args.motionId === "string" ? args.motionId : "";
  const jobId = typeof args.jobId === "string" ? args.jobId : "";
  try {
    let result: unknown;
    switch (name) {
      case "superagent_motion_list":
        result = await listMotionProjects(authorizedWorkspace); break;
      case "superagent_motion_inspect":
        result = await getMotionProject(authorizedWorkspace, motionId); break;
      case "superagent_motion_create":
        result = await createMotionProject(authorizedWorkspace, String(args.name ?? "")); break;
      case "superagent_motion_edit":
        result = await updateMotionProject(authorizedWorkspace, motionId, Number(args.baseRevision), args.edits as MotionEdit[]); break;
      case "superagent_motion_render":
        result = await startDetachedMotionJob(authorizedWorkspace, motionId, {
          width: args.width === undefined ? undefined : Number(args.width),
        }); break;
      case "superagent_motion_jobs":
        result = await listMotionJobs(authorizedWorkspace); break;
      case "superagent_motion_status":
        result = await getMotionJob(authorizedWorkspace, jobId); break;
      case "superagent_motion_recovery":
        result = await inspectMotionJob(authorizedWorkspace, jobId); break;
      case "superagent_motion_cancel":
        result = await requestMotionCancellation(authorizedWorkspace, jobId); break;
      default: return null;
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: "Motion Studio: " + (error instanceof Error ? error.message : String(error)) }],
      isError: true,
    };
  }
}
