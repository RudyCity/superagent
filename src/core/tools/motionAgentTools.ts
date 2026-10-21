import type { Tool } from "./types.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt } from "../motion/director/directorService.js";
import { getMotionJob } from "../motion/jobs/motionJobs.js";
import { getMotionProject } from "../motion/motionService.js";
import { inspectMotionQuality } from "../motion/director/motionQuality.js";

const promptParameters = { type: "object", properties: {
  prompt: { type: "string", description: "Describe the short motion graphic in Indonesian or English. 1-2000 characters." },
  width: { type: "integer", description: "Output width in pixels (even number 160-1920, default 640)." },
  imageAssetId: { type: "string", description: "Optional ID of an already uploaded workspace Motion image/logo asset (asset-<sha256>)." },
  audioAssetId: { type: "string", description: "Optional ID of an already uploaded PCM16 WAV workspace asset (audio-<sha256>)." },
  audioGain: { type: "number", description: "Optional audio gain from 0 to 2, only with audioAssetId." },
}, required: ["prompt"] };

export const motionGenerateTool: Tool = {
  name: "motion_generate",
  description: "Create an editable Motion Studio scene and render MP4 from a normal natural-language prompt with the SuperAgent AI planner. No project ID, JSON, or manual supervisor required. Supports attached workspace image and WAV audio assets, but not automated image/music generation or TTS.",
  parameters: promptParameters,
  async execute(args, cwd, signal) {
    const result = await generateMotionFromPrompt(cwd, args.prompt as string,
      { width: args.width as number | undefined, signal,
        imageAssetId: args.imageAssetId as string | undefined,
        audioAssetId: args.audioAssetId as string | undefined,
        audioGain: args.audioGain as number | undefined });
    return JSON.stringify({ motionId: result.project.id, revision: result.project.revision,
      jobId: result.job.id, jobStatus: result.job.status, outline: result.outline,
      limitations: result.limitations,
      nextStep: "Inspect motion job status and return the MP4 artifact when completed. For revisions use motion_revise." });
  },
};
export const motionReviseTool: Tool = {
  name: "motion_revise",
  description: "Modify an existing Motion Studio project from a conversational change request, preserving unrelated scene content, then start its revised MP4 render. Requires Motion project ID from previous generation.",
  parameters: { type: "object", properties: {
    ...promptParameters.properties,
    motionId: { type: "string", description: "Existing editable Motion Studio project ID." },
  }, required: ["motionId", "prompt"] },
  async execute(args, cwd, signal) {
    const result = await reviseMotionFromPrompt(cwd, args.motionId as string, args.prompt as string,
      { width: args.width as number | undefined, signal,
        imageAssetId: args.imageAssetId as string | undefined,
        audioAssetId: args.audioAssetId as string | undefined,
        audioGain: args.audioGain as number | undefined });
    return JSON.stringify({ motionId: result.project.id, revision: result.project.revision,
      jobId: result.job.id, jobStatus: result.job.status, outline: result.outline, limitations: result.limitations });
  },
};

/** Query finished artifacts without shell commands or raw MCP arguments. */
export const motionStatusTool: Tool = {
  name: "motion_status",
  description: "Read Motion Studio render progress and final MP4 artifact path from a job ID returned by motion_generate or motion_revise. Read-only.",
  parameters: { type: "object", properties: {
    jobId: { type: "string", description: "Motion render job ID." },
  }, required: ["jobId"] },
  async execute(args, cwd) {
    const job = await getMotionJob(cwd, args.jobId as string);
    const current = await getMotionProject(cwd, job.projectId);
    return JSON.stringify({ status: job.status, motionId: job.projectId, revision: job.revision,
      progressFrames: job.framesCompleted, totalFrames: job.profile.frameCount,
      ...(job.artifact ? { artifact: job.artifact } : {}), ...(job.error ? { error: job.error } : {}),
      ...(current.revision === job.revision
        ? { quality: inspectMotionQuality(current) }
        : { qualityNote: "Job is pinned to an older revision; quality report requires the original snapshot" }),
    });
  },
};
