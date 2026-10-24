import type { Tool } from "./types.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt } from "../motion/director/directorService.js";
import { getMotionJob } from "../motion/jobs/motionJobs.js";
import { getMotionProject, updateMotionProject } from "../motion/motionService.js";
import { inspectMotionQuality } from "../motion/director/motionQuality.js";
import { upscaleMotionComposition, upscaleMotionArtifact, getAvailableUpscaleTargets, type MotionUpscaleTarget, type MotionUpscaleMode } from "../motion/motionUpscale.js";

const promptParameters = { type: "object", properties: {
  prompt: { type: "string", description: "Describe the short motion graphic in Indonesian or English. 1-2000 characters." },
  width: { type: "integer", description: "Output width in pixels (even number 160-3840, default 640, supports 1080p, 2K, and 4K UHD)." },
  aspectRatio: { type: "string", enum: ["16:9", "1:1", "9:16"], description: "Optional landscape, square or portrait composition for new motions." },
  sceneImageAssetIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, description: "Optional one to three pre-uploaded image IDs, assigned in order to storyboard scenes. Cannot combine with imageAssetId." },
  audioLoop: { type: "boolean", description: "Repeat a selected WAV soundtrack to the video's end." },
  autoNarrateScenes: { type: "boolean", description: "Use offline Piper for a single combined voiceover based on validated storyboard narration; requires local model." },
  voiceoverText: { type: "string", description: "Optional 1–220 character spoken narration, only if local Piper voice engine is configured." },
  voiceoverGain: { type: "number", description: "Optional TTS volume gain 0-2, requires voiceoverText." },
  imageAssetId: { type: "string", description: "Optional ID of an already uploaded workspace Motion image/logo asset (asset-<sha256>)." },
  audioAssetId: { type: "string", description: "Optional ID of an already uploaded PCM16 WAV workspace asset (audio-<sha256>)." },
  audioGain: { type: "number", description: "Optional audio gain from 0 to 2, only with audioAssetId." },
}, required: ["prompt"] };

export const motionGenerateTool: Tool = {
  name: "motion_generate",
  description: "Create an editable SuperAgent Studio scene and render MP4 from a normal natural-language prompt with the SuperAgent AI planner. No project ID, JSON, or manual supervisor required. Supports attached workspace image and WAV audio assets, but not automated image/music generation or TTS.",
  parameters: promptParameters,
  async execute(args, cwd, signal) {
    const result = await generateMotionFromPrompt(cwd, args.prompt as string,
      { width: args.width as number | undefined, signal,
        aspectRatio: args.aspectRatio as "16:9" | "1:1" | "9:16" | undefined,
        imageAssetId: args.imageAssetId as string | undefined,
        sceneImageAssetIds: args.sceneImageAssetIds as string[] | undefined,
        audioLoop: args.audioLoop as boolean | undefined,
        autoNarrateScenes: args.autoNarrateScenes as boolean | undefined,
        voiceoverText: args.voiceoverText as string | undefined,
        voiceoverGain: args.voiceoverGain as number | undefined,
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
  description: "Modify an existing SuperAgent Studio project from a conversational change request, preserving unrelated scene content, then start its revised MP4 render. Requires Motion project ID from previous generation.",
  parameters: { type: "object", properties: {
    ...promptParameters.properties,
    motionId: { type: "string", description: "Existing editable SuperAgent Studio project ID." },
  }, required: ["motionId", "prompt"] },
  async execute(args, cwd, signal) {
    const result = await reviseMotionFromPrompt(cwd, args.motionId as string, args.prompt as string,
      { width: args.width as number | undefined, signal,
        imageAssetId: args.imageAssetId as string | undefined,
        sceneImageAssetIds: args.sceneImageAssetIds as string[] | undefined,
        audioLoop: args.audioLoop as boolean | undefined,
        voiceoverText: args.voiceoverText as string | undefined,
        voiceoverGain: args.voiceoverGain as number | undefined,
        audioAssetId: args.audioAssetId as string | undefined,
        audioGain: args.audioGain as number | undefined });
    return JSON.stringify({ motionId: result.project.id, revision: result.project.revision,
      jobId: result.job.id, jobStatus: result.job.status, outline: result.outline, limitations: result.limitations });
  },
};

/** Query finished artifacts without shell commands or raw MCP arguments. */
export const motionStatusTool: Tool = {
  name: "motion_status",
  description: "Read SuperAgent Studio render progress and final MP4 artifact path from a job ID returned by motion_generate or motion_revise. Read-only.",
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

/** Canonical Studio agent tools, retaining historical motion_* aliases. */
export const studioGenerateTool: Tool = {
  ...motionGenerateTool,
  name: "studio_generate",
  description: motionGenerateTool.description.replace("motion", "Studio"),
  async execute(args, cwd, signal) {
    const raw = await motionGenerateTool.execute(args, cwd, signal);
    const result = JSON.parse(String(raw));
    return JSON.stringify({ ...result, studioId: result.motionId,
      nextStep: "Inspect with studio_status; revise with studio_revise" });
  },
};

export const studioReviseTool: Tool = {
  ...motionReviseTool,
  name: "studio_revise",
  parameters: {
    ...motionReviseTool.parameters,
    properties: {
      ...promptParameters.properties,
      studioId: { type: "string", description: "Existing SuperAgent Studio project ID" },
    },
    required: ["studioId", "prompt"],
  },
  async execute(args, cwd, signal) {
    return motionReviseTool.execute({ ...args, motionId: args.studioId }, cwd, signal);
  },
};

export const studioStatusTool: Tool = {
  ...motionStatusTool,
  name: "studio_status",
  description: "Read SuperAgent Studio render progress and final video artifact for a Studio job",
  async execute(args, cwd, signal) {
    const raw = await motionStatusTool.execute(args, cwd, signal);
    const result = JSON.parse(String(raw));
    return JSON.stringify({ ...result, studioId: result.motionId });
  },
};

export const motionUpscaleTool: Tool = {
  name: "motion_upscale",
  description: "Upscale a SuperAgent Studio motion project or rendered video artifact to higher resolutions (1080p, 2K, 4K UHD, or 2x-4x factor) with vector coordinate scaling or FFmpeg Lanczos/sharp filtering.",
  parameters: {
    type: "object",
    properties: {
      motionId: { type: "string", description: "Optional project ID to upscale vector composition and keyframe coordinates." },
      jobId: { type: "string", description: "Optional completed render job ID to upscale the resulting MP4 video artifact." },
      scale: { type: "number", description: "Optional scaling factor (e.g. 1.5, 2, 4)." },
      target: { type: "string", enum: ["1080p", "2k", "4k"], description: "Standard resolution target preset (1080p FHD, 2K QHD, 4K UHD)." },
      targetWidth: { type: "integer", description: "Custom output width (even number 160-3840)." },
      mode: { type: "string", enum: ["vector", "lanczos", "sharp", "spline", "superres"], description: "Upscale algorithm/mode (default: sharp for video, vector for project)." },
    },
  },
  async execute(args, cwd) {
    const motionId = (args.motionId || args.studioId) as string | undefined;
    const jobId = args.jobId as string | undefined;

    if (!motionId && !jobId) {
      throw new Error("Either motionId (to upscale scene composition) or jobId (to upscale rendered video artifact) must be provided.");
    }

    const results: Record<string, unknown> = {};

    if (motionId) {
      const current = await getMotionProject(cwd, motionId);
      const composition = upscaleMotionComposition(current, {
        scale: typeof args.scale === "number" ? args.scale : undefined,
        target: typeof args.target === "string" ? args.target as MotionUpscaleTarget : undefined,
        targetWidth: typeof args.targetWidth === "number" ? args.targetWidth : undefined,
      });
      const updated = await updateMotionProject(cwd, motionId, current.revision, [{ type: "replace-composition", composition }]);
      results.project = {
        motionId,
        previousDimensions: { width: current.composition.width, height: current.composition.height },
        upscaledDimensions: { width: composition.width, height: composition.height },
        revision: updated.revision,
      };
    }

    if (jobId) {
      const artifactResult = await upscaleMotionArtifact(cwd, jobId, {
        scale: typeof args.scale === "number" ? args.scale : undefined,
        target: typeof args.target === "string" ? args.target as MotionUpscaleTarget : undefined,
        mode: typeof args.mode === "string" ? args.mode as MotionUpscaleMode : undefined,
      });
      results.artifact = artifactResult;
    }

    return JSON.stringify(results);
  },
};

export const studioUpscaleTool: Tool = {
  ...motionUpscaleTool,
  name: "studio_upscale",
  description: motionUpscaleTool.description.replace("motion", "Studio"),
  async execute(args, cwd, signal) {
    const raw = await motionUpscaleTool.execute(args, cwd, signal);
    const parsed = JSON.parse(String(raw));
    if (parsed.project) parsed.project.studioId = parsed.project.motionId;
    return JSON.stringify(parsed);
  },
};
