import {
  createMotionProject, getMotionProject, listMotionProjects, updateMotionProject,
} from "../../motion/motionService.js";
import {
  getMotionJob, inspectMotionJob, listMotionJobs, requestMotionCancellation, startDetachedMotionJob, enqueueSupervisedMotionJob,
} from "../../motion/jobs/motionJobs.js";
import type { MotionEdit } from "../../motion/schema/types.js";
import { importMotionAsset } from "../../motion/assets/motionAssets.js";
import { importMotionAudio } from "../../motion/assets/motionAudio.js";
import { decodeMotionMediaBase64 } from "../../motion/assets/motionInput.js";
import { motionStorageMaintenance } from "../../motion/jobs/storageMaintenance.js";
import { inspectMotionQueueRecovery } from "../../motion/jobs/queueRecovery.js";
import { inspectMotionSupervisor } from "../../motion/jobs/motionSupervisor.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt } from "../../motion/director/directorService.js";
import type { McpToolResult } from "../types.js";

export const MOTION_MCP_TOOL_DEFS = [
  {
    name: "superagent_motion_generate",
    description: "Generate a short editable motion scene and MP4 render from a natural-language prompt through SuperAgent AI Motion Director. Dangerous workspace write+execute action.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      prompt: { type: "string" }, width: { type: "integer", minimum: 160, maximum: 1920 },
    }, required: ["prompt"] },
  },
  {
    name: "superagent_motion_revise",
    description: "Semantically revise an existing Motion scene by conversational prompt, then render new MP4. Dangerous workspace write+execute action.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" }, motionId: { type: "string" },
      prompt: { type: "string" }, width: { type: "integer", minimum: 160, maximum: 1920 },
    }, required: ["prompt", "motionId"] },
  },
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
    name: "superagent_motion_import_image",
    description: "Import a bounded PNG, JPEG or WebP image to the authorized workspace; returns an immutable asset ID. Requires write permission and dangerous-tool opt-in. No file paths or remote URLs.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      base64: { type: "string", description: "Canonical base64-encoded image, max 1 MiB decoded." },
    }, required: ["base64"] },
  },
  {
    name: "superagent_motion_import_audio",
    description: "Import a bounded canonical PCM16 WAV clip to the authorized workspace; returns an immutable audio ID. Requires write permission and dangerous-tool opt-in.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      base64: { type: "string", description: "Canonical base64-encoded PCM16 WAV, max 2 MiB decoded." },
    }, required: ["base64"] },
  },
  {
    name: "superagent_motion_render",
    description: "Start a detached H.264 Motion render job. Requires execute permission, output-write authorization, and dangerous-tool opt-in.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      motionId: { type: "string" }, width: { type: "integer", minimum: 160, maximum: 1920 },
      supervised: { type: "boolean", description: "Queue for the separately running FIFO supervisor instead of spawning a worker immediately." },
    }, required: ["motionId"] },
  },
  {
    name: "superagent_motion_supervisor",
    description: "Read-only workspace FIFO supervisor status and queue occupancy. Never spawns or recovers workers.",
    inputSchema: { type: "object", properties: { workspace: { type: "string" }, projectId: { type: "string" } } },
  },
  {
    name: "superagent_motion_queue_recovery",
    description: "Read-only diagnosis of persisted queued render jobs eligible for operator-approved redispatch. Never starts, kills or takes over a worker.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      minAgeSeconds: { type: "integer", minimum: 10, maximum: 86400 },
    } },
  },
  {
    name: "superagent_motion_storage",
    description: "Read-only per-workspace Motion render storage, renderer slots, old failed-job maintenance preview and blocked claims. Never deletes records.",
    inputSchema: { type: "object", properties: {
      workspace: { type: "string" }, projectId: { type: "string" },
      minAgeDays: { type: "integer", minimum: 1, maximum: 3650 },
    } },
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
  superagent_motion_generate: "dangerous",
  superagent_motion_revise: "dangerous",
  superagent_motion_list: "safe",
  superagent_motion_inspect: "safe",
  superagent_motion_jobs: "safe",
  superagent_motion_storage: "safe",
  superagent_motion_queue_recovery: "safe",
  superagent_motion_supervisor: "safe",
  superagent_motion_status: "safe",
  superagent_motion_recovery: "safe",
  superagent_motion_create: "dangerous",
  superagent_motion_edit: "dangerous",
  superagent_motion_import_image: "dangerous",
  superagent_motion_import_audio: "dangerous",
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
      case "superagent_motion_generate":
        result = await generateMotionFromPrompt(authorizedWorkspace, String(args.prompt ?? ""), {
          width: args.width === undefined ? undefined : Number(args.width),
        }); break;
      case "superagent_motion_revise":
        result = await reviseMotionFromPrompt(authorizedWorkspace, motionId, String(args.prompt ?? ""), {
          width: args.width === undefined ? undefined : Number(args.width),
        }); break;
      case "superagent_motion_list":
        result = await listMotionProjects(authorizedWorkspace); break;
      case "superagent_motion_inspect":
        result = await getMotionProject(authorizedWorkspace, motionId); break;
      case "superagent_motion_create":
        result = await createMotionProject(authorizedWorkspace, String(args.name ?? "")); break;
      case "superagent_motion_edit":
        result = await updateMotionProject(authorizedWorkspace, motionId, Number(args.baseRevision), args.edits as MotionEdit[]); break;
      case "superagent_motion_import_image":
        result = await importMotionAsset(authorizedWorkspace, decodeMotionMediaBase64(args.base64, 1024 * 1024)); break;
      case "superagent_motion_import_audio":
        result = await importMotionAudio(authorizedWorkspace, decodeMotionMediaBase64(args.base64, 2 * 1024 * 1024)); break;
      case "superagent_motion_render":
        if (args.supervised !== undefined && typeof args.supervised !== "boolean") throw new Error("supervised must be boolean");
        result = await (args.supervised === true ? enqueueSupervisedMotionJob : startDetachedMotionJob)(
          authorizedWorkspace, motionId, { width: args.width === undefined ? undefined : Number(args.width) },
        ); break;
      case "superagent_motion_jobs":
        result = await listMotionJobs(authorizedWorkspace); break;
      case "superagent_motion_supervisor":
        result = await inspectMotionSupervisor(authorizedWorkspace); break;
      case "superagent_motion_queue_recovery":
        result = await inspectMotionQueueRecovery(authorizedWorkspace, { minAgeSeconds: args.minAgeSeconds === undefined ? 30 : Number(args.minAgeSeconds) }); break;
      case "superagent_motion_storage":
        result = await motionStorageMaintenance(authorizedWorkspace, { minAgeDays: args.minAgeDays === undefined ? 7 : Number(args.minAgeDays) }); break;
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
