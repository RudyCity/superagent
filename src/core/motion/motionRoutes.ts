import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject, applyCompoundPresetToProject } from "./motionService.js";
import { listMotionProjectHistory, restoreMotionProjectHistory } from "./project/projectStore.js";
import { getCompoundPreset, listCompoundPresets } from "./effects/compoundPresets.js";
import { getMotionJob, getMotionSchedulerStatus, inspectMotionJob, listMotionJobs, motionJobDir, requestMotionCancellation, startDetachedMotionJob, enqueueSupervisedMotionJob } from "./jobs/motionJobs.js";
import { MotionRevisionConflict } from "./project/revisions.js";
import { MotionValidationError } from "./schema/validation.js";
import type { MotionEdit } from "./schema/types.js";
import { MOTION_CAPABILITIES } from "./motionCapabilities.js";
import { motionStorageMaintenance } from "./jobs/storageMaintenance.js";
import { inspectMotionQueueRecovery } from "./jobs/queueRecovery.js";
import { inspectMotionSupervisor } from "./jobs/motionSupervisor.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt } from "./director/directorService.js";
import { inspectMotionQuality } from "./director/motionQuality.js";
import { renderMotionFrameSnapshot } from "./director/motionFrameSnapshot.js";
import { inspectMotionVision, autoRepairMotionVision, withMotionVisionLease } from "./director/motionVisionReview.js";
import { motionSceneSrt } from "./director/motionCaptions.js";
import { localVoiceoverReady } from "./director/localVoiceover.js";
import { importMotionAsset, readMotionAsset } from "./assets/motionAssets.js";
import { importMotionAudio, readMotionAudio } from "./assets/motionAudio.js";
import { decodeMotionMediaBase64 } from "./assets/motionInput.js";
import { summarizeMotionWav } from "./assets/motionWaveform.js";
import { effectRegistry, EFFECT_CATEGORIES, type EffectCategory } from "./effects/index.js";
import { changeMotionEffectStack, type MotionStackOperation } from "./effects/effectStack.js";
import { resizeMotionComposition, type MotionOutputAspect } from "./motionResize.js";

export interface MotionHttpContext {
  resolveWorkspacePath: (req: IncomingMessage) => string | null;
  sendJSON: (res: ServerResponse, status: number, data: unknown) => void;
}

function json(res: ServerResponse, context: MotionHttpContext, code: number, value: unknown): void {
  context.sendJSON(res, code, value);
}
async function readMotionJson(req: IncomingMessage, maxSize = 1_000_000): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > maxSize) throw Object.assign(new Error("Motion request body too large"), { statusCode: 413 });
    parts.push(buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object");
  return input as Record<string, unknown>;
}
function routeError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 409) return { status: 409, message };
  if (status === 413) return { status: 413, message };
  if (status === 503) return { status: 503, message };
  if (error instanceof MotionRevisionConflict) return { status: 409, message };
  if (error instanceof MotionValidationError || error instanceof RangeError || error instanceof SyntaxError) return { status: 400, message };
  if (/locked|already has an active|unreconciled render/.test(message)) return { status: 409, message };
  if (/ENOENT|not found/i.test(message)) return { status: 404, message: "Motion resource not found" };
  if (/Invalid Motion|invalid|unsupported|must be|must contain|requires|expected|outside|workspace|local only/i.test(message)) {
    return { status: 400, message };
  }
  return { status: 500, message: "Motion request failed" };
}

/** The global /api auth gate and workspace allowlist run before this handler. */
export async function handleMotionHttpRoute(
  req: IncomingMessage, res: ServerResponse, pathname: string, _url: URL, ctx: MotionHttpContext,
): Promise<boolean> {
  if (!(pathname === "/api/motion" || pathname.startsWith("/api/motion/"))) return false;
  const workspace = ctx.resolveWorkspacePath(req);
  if (!workspace || /^(ssh|chain):/i.test(workspace)) {
    json(res, ctx, 403, { error: "Motion Studio requires an authorized local workspace" });
    return true;
  }
  const method = req.method ?? "GET";
  const project = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})$/);
  const edits = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/edits$/);
  const quality = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/quality$/);
  const visionReview = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/vision-review$/);
  const visionRepair = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/vision-repair$/);
  const captions = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/captions\.srt$/);
  const frameSnapshot = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/frames\/(\d{1,6})\.png$/);
  const render = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/render$/);
  const job = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})$/);
  const cancel = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})\/cancel$/);
  const recovery = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})\/recovery$/);
  const artifact = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})\/artifact$/);
  const asset = pathname.match(/^\/api\/motion\/assets\/(asset-[a-f0-9]{64})$/);
  const audio = pathname.match(/^\/api\/motion\/audio\/(audio-[a-f0-9]{64})$/);
  const waveform = pathname.match(/^\/api\/motion\/audio\/(audio-[a-f0-9]{64})\/waveform$/);
  const compoundPresetsList = pathname === "/api/motion/presets";
  const compoundPresetItem = pathname.match(/^\/api\/motion\/presets\/([a-z][a-z0-9-]{1,63})$/);
  const projectCompoundPresets = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/presets$/);
  const previewCompoundPreset = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/presets\/preview$/);
  const effectsList = pathname === "/api/motion/effects";
  const effectItem = pathname.match(/^\/api\/motion\/effects\/([a-z][a-z0-9-]{1,63})$/);
  const projectEffects = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/effects$/);
  const previewEffect = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/effects\/preview$/);
  const stackRoute = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/effect-stack(?:\/(preview))?$/);
  const resizeRoute = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/resize(?:\/(preview))?$/);
  const projectHistory = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/history$/);
  const restoreHistory = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/history\/restore$/);

  try {
    if (pathname === "/api/motion" && method === "GET") {
      json(res, ctx, 200, { apiVersion: 1, video: "h264-mp4", detachedJobs: true, studio: false, capabilities: { ...MOTION_CAPABILITIES, localVoiceoverConfigured: await localVoiceoverReady() } });
    } else if (pathname === "/api/motion/assets" && method === "POST") {
      const body = await readMotionJson(req, 1_600_000);
      json(res, ctx, 201, await importMotionAsset(workspace, decodeMotionMediaBase64(body.base64, 1024 * 1024)));
    } else if (asset && (method === "GET" || method === "HEAD")) {
      const bytes = await readMotionAsset(workspace, asset[1]);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "ETag": '"' + asset[1].slice(6) + '"',
      });
      res.end(method === "HEAD" ? undefined : bytes);
    } else if (pathname === "/api/motion/audio" && method === "POST") {
      const body = await readMotionJson(req, 3_000_000);
      json(res, ctx, 201, await importMotionAudio(workspace, decodeMotionMediaBase64(body.base64, 2 * 1024 * 1024)));
    } else if (waveform && method === "GET") {
      json(res, ctx, 200, summarizeMotionWav(await readMotionAudio(workspace, waveform[1])));
    } else if (audio && (method === "GET" || method === "HEAD")) {
      const bytes = await readMotionAudio(workspace, audio[1]);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "ETag": '"' + audio[1].slice(6) + '"',
      });
      res.end(method === "HEAD" ? undefined : bytes);
    } else if (compoundPresetsList && method === "GET") {
      const query = _url.searchParams.get("q") ?? undefined;
      if (query && query.length > 120) throw new Error("Invalid compound preset query length");
      const items = listCompoundPresets(query);
      json(res, ctx, 200, { presets: items, count: items.length });
    } else if (compoundPresetItem && method === "GET") {
      const preset = getCompoundPreset(compoundPresetItem[1]);
      if (!preset) json(res, ctx, 404, { error: "Compound preset not found" });
      else json(res, ctx, 200, preset);
    } else if (effectsList && method === "GET") {
      const category = _url.searchParams.get("category");
      const query = _url.searchParams.get("q") ?? _url.searchParams.get("query") ?? undefined;
      const targetKind = _url.searchParams.get("targetKind");
      const tag = _url.searchParams.get("tag") ?? undefined;
      if (category && !EFFECT_CATEGORIES.includes(category as EffectCategory)) throw new Error("Invalid Motion effect category");
      if (targetKind && !["text", "rect", "image", "scene"].includes(targetKind)) throw new Error("Invalid Motion targetKind");
      if ((query && query.length > 120) || (tag && tag.length > 64)) throw new Error("Motion effect filter too long");
      const pageNumber = (key: string, fallback: number, max: number): number => {
        const value = _url.searchParams.get(key);
        if (value === null) return fallback;
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0 || n > max || (key === "limit" && n === 0)) {
          throw new Error("Invalid Motion effect " + key);
        }
        return n;
      };
      const offset = pageNumber("offset", 0, 1_000_000);
      const limit = pageNumber("limit", 100, 100);
      const filtered = effectRegistry.getCatalog({
        category: category as EffectCategory | undefined,
        query,
        targetKind: targetKind as "text" | "rect" | "image" | "scene" | undefined,
        tag,
      });
      const page = filtered.slice(offset, offset + limit);
      json(res, ctx, 200, {
        effects: page,
        count: page.length,
        total: effectRegistry.count(),
        filteredTotal: filtered.length,
        offset,
        limit,
        hasMore: offset + limit < filtered.length,
        categories: EFFECT_CATEGORIES,
      });
    } else if (effectItem && method === "GET") {
      const eff = effectRegistry.get(effectItem[1]);
      if (!eff) {
        json(res, ctx, 404, { error: "Effect not found" });
      } else {
        const item = effectRegistry.getCatalog().find(e => e.id === effectItem[1]);
        json(res, ctx, 200, item);
      }
    } else if (pathname === "/api/motion/generate" && method === "POST") {
      const body = await readMotionJson(req, 12_000);
      const result = await generateMotionFromPrompt(workspace, body.prompt as string, {
        width: body.width as number | undefined,
        aspectRatio: body.aspectRatio as "16:9" | "1:1" | "9:16" | undefined,
        imageAssetId: body.imageAssetId as string | undefined,
        sceneImageAssetIds: body.sceneImageAssetIds as string[] | undefined,
        audioAssetId: body.audioAssetId as string | undefined,
        audioGain: body.audioGain as number | undefined,
        audioLoop: body.audioLoop as boolean | undefined,
        autoNarrateScenes: body.autoNarrateScenes as boolean | undefined,
        voiceoverText: body.voiceoverText as string | undefined,
        voiceoverGain: body.voiceoverGain as number | undefined,
      });
      json(res, ctx, 202, result);
    } else if (pathname.match(/^\/api\/motion\/projects\/motion-[a-f0-9]{20}\/revise$/) && method === "POST") {
      const body = await readMotionJson(req, 12_000);
      const motionId = pathname.split("/")[4];
      const result = await reviseMotionFromPrompt(workspace, motionId, body.prompt as string, {
        width: body.width as number | undefined,
        imageAssetId: body.imageAssetId as string | undefined,
        sceneImageAssetIds: body.sceneImageAssetIds as string[] | undefined,
        audioAssetId: body.audioAssetId as string | undefined,
        audioGain: body.audioGain as number | undefined,
        audioLoop: body.audioLoop as boolean | undefined,
        voiceoverText: body.voiceoverText as string | undefined,
        voiceoverGain: body.voiceoverGain as number | undefined,
      });
      json(res, ctx, 202, result);
    } else if (pathname === "/api/motion/projects" && method === "GET") {
      json(res, ctx, 200, await listMotionProjects(workspace));
    } else if (pathname === "/api/motion/projects" && method === "POST") {
      const body = await readMotionJson(req);
      if (typeof body.name !== "string") throw new Error("name must be a string");
      json(res, ctx, 201, await createMotionProject(workspace, body.name));
    } else if (projectHistory && method === "GET") {
      json(res, ctx, 200, { snapshots: await listMotionProjectHistory(workspace, projectHistory[1]) });
    } else if (restoreHistory && method === "POST") {
      const body = await readMotionJson(req, 2000);
      if (!Number.isSafeInteger(body.baseRevision) || !Number.isSafeInteger(body.revision))
        throw new MotionValidationError(["baseRevision and revision must be integers"]);
      json(res, ctx, 200, await restoreMotionProjectHistory(workspace, restoreHistory[1],
        body.baseRevision as number, body.revision as number));
    } else if (project && method === "GET") {
      json(res, ctx, 200, await getMotionProject(workspace, project[1]));
    } else if (previewCompoundPreset && method === "POST") {
      const body = await readMotionJson(req, 5_000);
      if (typeof body.presetId !== "string" || typeof body.targetLayerId !== "string")
        throw new Error("presetId and targetLayerId must be strings");
      if (!Number.isSafeInteger(body.baseRevision)) throw new Error("baseRevision must be a safe integer");
      if (body.startFrame !== undefined && !Number.isSafeInteger(body.startFrame))
        throw new Error("startFrame must be a safe integer");
      if (body.durationFrames !== undefined && !Number.isSafeInteger(body.durationFrames))
        throw new Error("durationFrames must be a safe integer");
      if (body.intensity !== undefined && (typeof body.intensity !== "number" ||
          !Number.isFinite(body.intensity))) throw new Error("Invalid preset intensity");
      const current = await getMotionProject(workspace, previewCompoundPreset[1]);
      if (current.revision !== body.baseRevision) {
        json(res, ctx, 409, { error: "Motion revision conflict; reload project before preview" });
      } else {
        const { applyCompoundPreset } = await import("./effects/compoundPresets.js");
        const preview = applyCompoundPreset(current, {
          presetId: body.presetId, targetLayerId: body.targetLayerId,
          startFrame: body.startFrame as number | undefined,
          durationFrames: body.durationFrames as number | undefined,
          intensity: body.intensity as number | undefined,
        });
        json(res, ctx, 200, preview);
      }
    } else if (projectCompoundPresets && method === "POST") {
      const body = await readMotionJson(req, 5_000);
      if (typeof body.presetId !== "string" || typeof body.targetLayerId !== "string")
        throw new Error("presetId and targetLayerId must be strings");
      if (!Number.isSafeInteger(body.baseRevision)) throw new Error("baseRevision must be a safe integer");
      if (body.startFrame !== undefined && !Number.isSafeInteger(body.startFrame))
        throw new Error("startFrame must be a safe integer");
      if (body.durationFrames !== undefined && !Number.isSafeInteger(body.durationFrames))
        throw new Error("durationFrames must be a safe integer");
      if (body.intensity !== undefined && (typeof body.intensity !== "number" ||
          !Number.isFinite(body.intensity))) throw new Error("Invalid preset intensity");
      const updated = await applyCompoundPresetToProject(workspace, projectCompoundPresets[1],
        body.baseRevision as number, {
          presetId: body.presetId, targetLayerId: body.targetLayerId,
          startFrame: body.startFrame as number | undefined,
          durationFrames: body.durationFrames as number | undefined,
          intensity: body.intensity as number | undefined,
        });
      json(res, ctx, 200, updated);
    } else if (resizeRoute && method === "POST") {
      const body = await readMotionJson(req, 2000);
      if (!Number.isSafeInteger(body.baseRevision) ||
          !["16:9", "1:1", "9:16"].includes(String(body.aspectRatio)) ||
          (body.width !== undefined && !Number.isSafeInteger(body.width)))
        throw new MotionValidationError(["Invalid Motion resize request"]);
      const current = await getMotionProject(workspace, resizeRoute[1]);
      if (current.revision !== body.baseRevision) {
        json(res, ctx, 409, { error: "Motion revision conflict; reload before resizing" });
      } else {
        const composition = resizeMotionComposition(current, body.aspectRatio as MotionOutputAspect,
          body.width as number | undefined);
        if (resizeRoute[2] === "preview") json(res, ctx, 200, { ...current, composition });
        else json(res, ctx, 200, await updateMotionProject(workspace, resizeRoute[1],
          body.baseRevision as number, [{ type: "replace-composition", composition }]));
      }
    } else if (stackRoute && method === "POST") {
      const body = await readMotionJson(req, 10_000);
      if (!Number.isSafeInteger(body.baseRevision)) throw new MotionValidationError(["baseRevision is required"]);
      const action = body.action;
      const raw = body.operation;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !["add", "remove", "toggle", "move", "update"].includes(String(action))) {
        throw new MotionValidationError(["Invalid effect stack operation"]);
      }
      const op = { ...raw, type: action } as MotionStackOperation;
      const current = await getMotionProject(workspace, stackRoute[1]);
      if (current.revision !== body.baseRevision) {
        json(res, ctx, 409, { error: "Motion revision conflict; reload project before editing the stack" });
      } else {
        const composition = changeMotionEffectStack(current, op);
        if (stackRoute[2] === "preview") json(res, ctx, 200, { ...current, composition });
        else json(res, ctx, 200, await updateMotionProject(workspace, stackRoute[1],
          body.baseRevision as number, [{ type: "replace-composition", composition }]));
      }
    } else if (previewEffect && method === "POST") {
      const body = await readMotionJson(req, 5_000);
      if (typeof body.effectId !== "string") throw new Error("effectId is required");
      if (!Number.isSafeInteger(body.baseRevision)) throw new Error("baseRevision must be a safe integer");
      if (body.targetLayerId !== undefined && typeof body.targetLayerId !== "string")
        throw new Error("targetLayerId must be a string");
      if (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params)))
        throw new Error("Effect params must be an object");
      if (body.startFrame !== undefined && !Number.isSafeInteger(body.startFrame))
        throw new Error("Effect startFrame must be an integer");
      if (body.durationFrames !== undefined && !Number.isSafeInteger(body.durationFrames))
        throw new Error("Effect durationFrames must be an integer");
      const current = await getMotionProject(workspace, previewEffect[1]);
      if (current.revision !== body.baseRevision) {
        json(res, ctx, 409, { error: "Motion revision conflict; reload before preview" });
      } else {
        const preview = effectRegistry.applyToProject(current, {
          effectId: body.effectId, targetLayerId: body.targetLayerId as string | undefined,
          params: body.params as Record<string, unknown> | undefined,
          startFrame: body.startFrame as number | undefined,
          durationFrames: body.durationFrames as number | undefined,
        });
        json(res, ctx, 200, preview);
      }
    } else if (projectEffects && method === "POST") {
      const body = await readMotionJson(req);
      if (typeof body.effectId !== "string") throw new Error("effectId is required");
      if (!Number.isSafeInteger(body.baseRevision)) throw new Error("baseRevision is required");
      if (body.targetLayerId !== undefined && typeof body.targetLayerId !== "string")
        throw new Error("targetLayerId must be a string");
      if (body.params !== undefined && (!body.params || typeof body.params !== "object" || Array.isArray(body.params)))
        throw new Error("Effect params must be a JSON object");
      if (body.startFrame !== undefined && !Number.isSafeInteger(body.startFrame))
        throw new Error("Effect startFrame must be an integer");
      if (body.durationFrames !== undefined && !Number.isSafeInteger(body.durationFrames))
        throw new Error("Effect durationFrames must be an integer");
      const current = await getMotionProject(workspace, projectEffects[1]);
      const updatedProject = effectRegistry.applyToProject(current, {
        effectId: body.effectId,
        targetLayerId: typeof body.targetLayerId === "string" ? body.targetLayerId : undefined,
        params: typeof body.params === "object" && body.params ? (body.params as Record<string, unknown>) : undefined,
        startFrame: Number.isSafeInteger(body.startFrame) ? (body.startFrame as number) : undefined,
        durationFrames: Number.isSafeInteger(body.durationFrames) ? (body.durationFrames as number) : undefined,
      });
      const updated = await updateMotionProject(workspace, projectEffects[1], body.baseRevision as number, [
        { type: "replace-composition", composition: updatedProject.composition },
      ]);
      json(res, ctx, 200, updated);
    } else if (frameSnapshot && method === "GET") {
      const projectSnapshot = await getMotionProject(workspace, frameSnapshot[1]);
      const image = await renderMotionFrameSnapshot(workspace, projectSnapshot, Number(frameSnapshot[2]));
      res.writeHead(200, {
        "Content-Type": "image/png", "Content-Length": String(image.length),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      });
      res.end(image);
    } else if (captions && method === "GET") {
      const body = Buffer.from(motionSceneSrt(await getMotionProject(workspace, captions[1])), "utf8");
      res.writeHead(200, {
        "Content-Type": "application/x-subrip; charset=utf-8",
        "Content-Length": String(body.length),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Disposition": 'attachment; filename="motion-captions.srt"',
      });
      res.end(body);
    } else if (visionReview && method === "POST") {
      await readMotionJson(req, 1024);
      const response = await withMotionVisionLease(workspace, visionReview[1], async () =>
        inspectMotionVision(workspace, await getMotionProject(workspace, visionReview[1])));
      json(res, ctx, 200, response);
    } else if (visionRepair && method === "POST") {
      const body = await readMotionJson(req, 1024);
      if (body.width !== undefined && !Number.isSafeInteger(body.width)) throw new Error("Invalid Motion render width");
      if (!Number.isSafeInteger(body.baseRevision)) throw new Error("Invalid Motion expected revision");
      const response = await withMotionVisionLease(workspace, visionRepair[1], () =>
        autoRepairMotionVision(workspace, visionRepair[1], {
          baseRevision: body.baseRevision as number, width: body.width as number | undefined,
        }));
      json(res, ctx, response.changed ? 202 : 200, response);
    } else if (quality && method === "GET") {
      json(res, ctx, 200, inspectMotionQuality(await getMotionProject(workspace, quality[1])));
    } else if (edits && method === "POST") {
      const body = await readMotionJson(req);
      if (!Number.isSafeInteger(body.baseRevision) || !Array.isArray(body.edits)) throw new Error("baseRevision and edits are required");
      json(res, ctx, 200, await updateMotionProject(workspace, edits[1], body.baseRevision as number, body.edits as MotionEdit[]));
    } else if (render && method === "POST") {
      const body = await readMotionJson(req);
      if (body.width !== undefined && !Number.isSafeInteger(body.width)) throw new Error("width must be an integer");
      if (body.supervised !== undefined && typeof body.supervised !== "boolean") throw new Error("supervised must be boolean");
      const started = body.supervised === true
        ? await enqueueSupervisedMotionJob(workspace, render[1], { width: body.width as number | undefined })
        : await startDetachedMotionJob(workspace, render[1], { width: body.width as number | undefined });
      json(res, ctx, started.status === "failed" ? 503 : 202, started);
    } else if (pathname === "/api/motion/supervisor" && method === "GET") {
      json(res, ctx, 200, await inspectMotionSupervisor(workspace));
    } else if (pathname === "/api/motion/scheduler" && method === "GET") {
      json(res, ctx, 200, await getMotionSchedulerStatus(workspace));
    } else if (pathname === "/api/motion/queue-recovery" && method === "GET") {
      json(res, ctx, 200, await inspectMotionQueueRecovery(workspace));
    } else if (pathname === "/api/motion/storage" && method === "GET") {
      json(res, ctx, 200, await motionStorageMaintenance(workspace));
    } else if (pathname === "/api/motion/jobs" && method === "GET") {
      json(res, ctx, 200, await listMotionJobs(workspace));
    } else if (job && method === "GET") {
      json(res, ctx, 200, await getMotionJob(workspace, job[1]));
    } else if (recovery && method === "GET") {
      json(res, ctx, 200, await inspectMotionJob(workspace, recovery[1]));
    } else if (cancel && method === "POST") {
      json(res, ctx, 202, await requestMotionCancellation(workspace, cancel[1]));
    } else if (artifact && (method === "GET" || method === "HEAD")) {
      await streamMotionArtifact(req, res, workspace, artifact[1]);
    } else {
      json(res, ctx, 404, { error: "Motion endpoint not found" });
    }
  } catch (error) {
    if (!res.headersSent) {
      const failure = routeError(error);
      json(res, ctx, failure.status, { error: failure.message });
    } else {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return true;
}

function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function streamMotionArtifact(
  req: IncomingMessage, res: ServerResponse, workspace: string, jobId: string,
): Promise<void> {
  const job = await getMotionJob(workspace, jobId);
  if (job.status !== "completed" || !job.artifact) {
    res.writeHead(404, { "Cache-Control": "no-store" }); res.end(); return;
  }
  const dir = await motionJobDir(workspace, "renders");
  const file = path.join(dir, jobId + ".mp4");
  if (job.artifact.path !== file) throw new Error("Invalid Motion artifact ownership");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.artifact.bytes) {
    throw new Error("Invalid Motion artifact file");
  }
  // Hash the artifact with bounded memory rather than loading an entire video.
  const digest = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const fileHash = digest.digest("hex");
  if (fileHash !== job.artifact.sha256) throw new Error("Invalid Motion artifact checksum");
  const common: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "ETag": '"' + job.artifact.sha256 + '"',
  };
  const rawRange = req.headers.range;
  const range = typeof rawRange === "string" ? parseRange(rawRange, stat.size) : undefined;
  if (rawRange !== undefined && !range) {
    res.writeHead(416, { ...common, "Content-Range": "bytes */" + stat.size });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const headers = {
    ...common, "Content-Length": String(end - start + 1),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
  };
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  const disconnect = () => stream.destroy();
  res.on("close", disconnect);
  stream.on("error", error => res.destroy(error));
  stream.on("end", () => res.off("close", disconnect));
  stream.pipe(res);
}
