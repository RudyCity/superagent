import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject, writeMotionPreview } from "../motion/motionService.js";
import { MotionRevisionConflict } from "../motion/project/revisions.js";
import { MotionValidationError } from "../motion/schema/validation.js";
import { probeFfmpeg } from "../motion/render/ffmpegEncoder.js";
import { importMotionAsset } from "../motion/assets/motionAssets.js";
import { importMotionAudio } from "../motion/assets/motionAudio.js";
import { readMotionWorkspaceInput } from "../motion/assets/motionInput.js";
import { MOTION_CAPABILITIES } from "../motion/motionCapabilities.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt } from "../motion/director/directorService.js";
import { motionStorageMaintenance } from "../motion/jobs/storageMaintenance.js";
import { inspectMotionSupervisor, runMotionSupervisorOnce, runMotionSupervisorWatch } from "../motion/jobs/motionSupervisor.js";
import { inspectMotionQueueRecovery, dispatchOrphanedMotionQueue } from "../motion/jobs/queueRecovery.js";
import type { MotionEdit } from "../motion/schema/types.js";
import { getMotionJob, getMotionSchedulerStatus, listMotionJobs, inspectMotionJob, renderMotionJob, startDetachedMotionJob, reconcileStaleMotionJob, requestMotionCancellation, enqueueSupervisedMotionJob } from "../motion/jobs/motionJobs.js";

const usage = `SuperAgent Studio (developer preview)
  superagent studio generate --prompt "Animated promo" [--width 640] [--image-asset ASSET_ID | --scene-images ID1,ID2,ID3] [--audio-asset AUDIO_ID] [--audio-gain 1] [--audio-loop true] [--voiceover-text TEXT] [--workspace PATH] [--json]
  superagent studio revise MOTION_ID --prompt "Shorter title" [--width 640] [--image-asset ASSET_ID | --scene-images ID1,ID2,ID3] [--audio-asset AUDIO_ID] [--audio-gain 1] [--audio-loop true] [--voiceover-text TEXT] [--workspace PATH] [--json]
  superagent studio new --name "Title" [--workspace PATH] [--json]
  superagent studio list [--workspace PATH] [--json]
  superagent studio inspect PROJECT_ID [--workspace PATH] [--json]
  superagent studio edit PROJECT_ID --base-revision N --layer LAYER_ID --text "Title"
  superagent studio edit PROJECT_ID --base-revision N --edits-json '[{"type":"set-property",...}]'
  superagent studio edit PROJECT_ID --base-revision N --edits-file workspace/path/edits.json
  superagent studio import-image --file workspace/path/image.png [--workspace PATH] [--json]
  superagent studio import-audio --file workspace/path/clip.wav [--workspace PATH] [--json]
  superagent studio frame PROJECT_ID --frame N [--workspace PATH] [--json]
  superagent studio render PROJECT_ID [--width EVEN_NUMBER] [--detach] [--workspace PATH] [--json]
  superagent studio jobs [--workspace PATH] [--json]
  superagent studio scheduler [--workspace PATH] [--json]
  superagent studio render PROJECT_ID --width 640 --supervised [--workspace PATH] [--json]
  superagent studio supervisor-status [--workspace PATH] [--json]
  superagent studio supervisor --once [--workspace PATH] [--json]
  superagent studio supervisor --watch [--interval-ms 2000] [--workspace PATH] [--json]
  superagent studio queue-recovery [--min-age-seconds 30] [--workspace PATH] [--json]
  superagent studio dispatch-queue --apply [--min-age-seconds 30] [--limit 4] [--workspace PATH] [--json]
  superagent studio storage [--days 7] [--workspace PATH] [--json]
  superagent studio prune [--days 7] --apply [--workspace PATH] [--json]
  superagent studio status JOB_ID [--workspace PATH] [--json]
  superagent studio recovery JOB_ID [--workspace PATH] [--json]
  superagent studio recover JOB_ID --ack-stale [--workspace PATH] [--json]
  superagent studio cancel JOB_ID [--workspace PATH] [--json]
  superagent studio doctor [--json]
  superagent studio effects [--category CATEGORY] [--search QUERY] [--workspace PATH] [--json]
  superagent studio effect-info EFFECT_ID [--workspace PATH] [--json]
  superagent studio presets [--search QUERY] [--json]
  superagent studio preset-info PRESET_ID [--json]
  superagent studio apply-preset PROJECT_ID --base-revision N --preset PRESET_ID --layer TEXT_LAYER_ID [--start-frame N] [--duration-frames N] [--intensity 1] [--json]
  superagent studio apply-effect PROJECT_ID --base-revision N --effect EFFECT_ID [--layer LAYER_ID] [--params-json JSON] [--start-frame N] [--duration-frames N] [--workspace PATH] [--json]

MP4 preview uses installed FFmpeg. --detach launches a separate Bun worker;
recovery is diagnostic/read-only unless the operator explicitly runs recover --ack-stale.`;

function argumentsOf(args: string[]): { action: string; positionals: string[]; opts: Map<string, string | true> } {
  const opts = new Map<string, string | true>();
  const positionals: string[] = [];
  const boolean = new Set(["--json", "--detach", "--supervised", "--once", "--watch", "--ack-stale", "--apply", "--help", "-h"]);
  const valid = new Set(["--workspace", "-w", "--prompt", "--aspect-ratio", "--image-asset", "--scene-images", "--audio-asset", "--audio-gain", "--audio-loop", "--voiceover-text", "--voiceover-gain", "--auto-narrate", "--name", "--base-revision", "--layer", "--text", "--frame", "--width", "--file", "--edits-json", "--edits-file", "--days", "--min-age-seconds", "--limit", "--interval-ms", "--category", "--search", "--effect", "--preset", "--intensity", "--params-json", "--start-frame", "--duration-frames", ...boolean]);
  for (let i = 1; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith("-")) { positionals.push(value); continue; }
    if (!valid.has(value)) throw new Error("Unknown argument: " + value);
    if (opts.has(value)) throw new Error("Duplicate argument: " + value);
    if (boolean.has(value)) opts.set(value, true);
    else {
      const next = args[++i];
      if (!next || next.startsWith("--")) throw new Error("Missing value for " + value);
      opts.set(value, next);
    }
  }
  return { action: args[0]?.toLowerCase() ?? "help", positionals, opts };
}
function opt(opts: Map<string, string | true>, name: string): string | undefined {
  const value = opts.get(name);
  return typeof value === "string" ? value : undefined;
}
function optionalBoolean(raw: string | undefined, description: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "true" && raw !== "false") throw new Error(description + " must be true or false");
  return raw === "true";
}
function nonnegativeInteger(raw: string | undefined, description: string): number {
  const n = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(n) || n < 0) throw new Error(description + " must be a nonnegative integer");
  return n;
}
function emit(result: unknown, json: boolean): void {
  if (json || typeof result !== "string") console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}
export async function handleMotionCliCommand(args: string[]): Promise<number> {
  let json = false;
  try {
    const parsed = argumentsOf(args);
    const { action, positionals, opts } = parsed;
    json = opts.has("--json");
    const workspace = opt(opts, "--workspace") ?? opt(opts, "-w") ?? process.cwd();
    if (opts.has("--help") || opts.has("-h") || action === "help" || !action) {
      console.log(usage);
      return 0;
    }
    if (action === "doctor") {
      const available = await probeFfmpeg();
      emit({ ...MOTION_CAPABILITIES, mp4: available, ffmpegAvailable: available, renderJobs: "foreground-and-detached-local" }, json);
      return 0;
    }
    if (action === "effects") {
      const { effectRegistry, EFFECT_CATEGORIES } = await import("../motion/effects/index.js");
      const category = opt(opts, "--category");
      const search = opt(opts, "--search");
      const items = effectRegistry.getCatalog({ category: category as any, query: search });
      if (json) {
        emit({ count: items.length, total: effectRegistry.count(), categories: EFFECT_CATEGORIES, effects: items }, true);
      } else {
        const lines = items.map(e => `[${e.category}] ${e.id} - ${e.name}`);
        emit(items.length ? `${lines.join("\n")}\n\nTotal: ${items.length} effects` : "No effects found.", false);
      }
      return 0;
    }
    if (action === "presets") {
      const { listCompoundPresets } = await import("../motion/effects/compoundPresets.js");
      const items = listCompoundPresets(opt(opts, "--search"));
      emit(json ? { count: items.length, presets: items } : items.map(item =>
        item.id + " - " + item.name + ": " + item.description).join("\n"), json);
      return 0;
    }
    if (action === "preset-info") {
      if (positionals.length !== 1) throw new Error("preset-info requires PRESET_ID");
      const { getCompoundPreset } = await import("../motion/effects/compoundPresets.js");
      const preset = getCompoundPreset(positionals[0]);
      if (!preset) throw new Error("Unknown compound preset: " + positionals[0]);
      emit(preset, json);
      return 0;
    }
    if (action === "apply-preset") {
      if (positionals.length !== 1) throw new Error("apply-preset requires PROJECT_ID");
      const baseRevision = nonnegativeInteger(opt(opts, "--base-revision"), "--base-revision");
      const presetId = opt(opts, "--preset");
      const targetLayerId = opt(opts, "--layer");
      if (!presetId || !targetLayerId) throw new Error("apply-preset requires --preset and --layer");
      const parseOptional = (name: string) => opt(opts, name) === undefined ? undefined :
        nonnegativeInteger(opt(opts, name), name);
      const intensityRaw = opt(opts, "--intensity");
      const intensity = intensityRaw === undefined ? undefined : Number(intensityRaw);
      if (intensityRaw !== undefined && !Number.isFinite(intensity)) throw new Error("Invalid --intensity");
      const { applyCompoundPresetToProject } = await import("../motion/motionService.js");
      const updated = await applyCompoundPresetToProject(workspace, positionals[0], baseRevision, {
        presetId, targetLayerId, startFrame: parseOptional("--start-frame"),
        durationFrames: parseOptional("--duration-frames"), intensity,
      });
      emit({ id: updated.id, revision: updated.revision, presetApplied: presetId }, json);
      return 0;
    }
    if (action === "effect-info") {
      if (positionals.length !== 1) throw new Error("effect-info requires EFFECT_ID");
      const effectId = positionals[0];
      const { effectRegistry } = await import("../motion/effects/index.js");
      const eff = effectRegistry.get(effectId);
      if (!eff) throw new Error("Effect not found: " + effectId);
      const catalogItem = effectRegistry.getCatalog().find(e => e.id === effectId);
      emit(catalogItem ?? eff, json);
      return 0;
    }
    if (action === "apply-effect") {
      if (positionals.length !== 1) throw new Error("apply-effect requires PROJECT_ID");
      const projectId = positionals[0];
      const baseRevision = nonnegativeInteger(opt(opts, "--base-revision"), "--base-revision");
      const effectId = opt(opts, "--effect");
      if (!effectId) throw new Error("apply-effect requires --effect EFFECT_ID");
      const targetLayerId = opt(opts, "--layer");
      const paramsJson = opt(opts, "--params-json");
      let params: Record<string, unknown> | undefined;
      if (paramsJson) {
        const parsed = JSON.parse(paramsJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("--params-json must be a JSON object");
        }
        params = parsed as Record<string, unknown>;
      }
      const startFrame = opt(opts, "--start-frame") === undefined ? undefined : nonnegativeInteger(opt(opts, "--start-frame"), "--start-frame");
      const durationFrames = opt(opts, "--duration-frames") === undefined ? undefined : nonnegativeInteger(opt(opts, "--duration-frames"), "--duration-frames");
      const { applyEffectToProject } = await import("../motion/motionService.js");
      const updated = await applyEffectToProject(workspace, projectId, baseRevision, {
        effectId,
        targetLayerId,
        params,
        startFrame,
        durationFrames,
      });
      emit({ id: updated.id, revision: updated.revision, effectApplied: effectId }, json);
      return 0;
    }
    if (action === "supervisor-status") {
      if (positionals.length || opts.has("--once") || opts.has("--watch")) throw new Error("supervisor-status is read-only and accepts no positional arguments");
      emit(await inspectMotionSupervisor(workspace), json); return 0;
    }
    if (action === "supervisor") {
      if (positionals.length || Number(opts.has("--once")) + Number(opts.has("--watch")) !== 1) {
        throw new Error("supervisor requires exactly one of --once or --watch");
      }
      if (opts.has("--once")) {
        if (opts.has("--interval-ms")) throw new Error("--interval-ms is only valid with --watch");
        emit(await runMotionSupervisorOnce(workspace), json); return 0;
      }
      const intervalMs = opt(opts, "--interval-ms") === undefined ? 2000 : nonnegativeInteger(opt(opts, "--interval-ms"), "--interval-ms");
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      try {
        emit({ status: "watching", workspace, intervalMs, note: "Ctrl+C stops the supervisor; no stale locks are stolen" }, json);
        emit(await runMotionSupervisorWatch(workspace, { intervalMs, signal: controller.signal }), json);
        return 0;
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    }
    if (action === "import-image" || action === "import-audio") {
      if (positionals.length) throw new Error(action + " requires --file and no positional arguments");
      const filename = opt(opts, "--file");
      if (!filename) throw new Error(action + " requires --file inside the authorized workspace");
      const data = await readMotionWorkspaceInput(workspace, filename, action === "import-image" ? 1024 * 1024 : 2 * 1024 * 1024);
      emit(action === "import-image" ? await importMotionAsset(workspace, data) : await importMotionAudio(workspace, data), json);
      return 0;
    }
    if (action === "queue-recovery" || action === "dispatch-queue") {
      if (positionals.length) throw new Error(action + " does not accept positional arguments");
      const age = opt(opts, "--min-age-seconds") === undefined ? 30 : nonnegativeInteger(opt(opts, "--min-age-seconds"), "--min-age-seconds");
      if (action === "queue-recovery") {
        if (opts.has("--apply") || opts.has("--limit")) throw new Error("queue-recovery is read-only; use dispatch-queue --apply");
        emit(await inspectMotionQueueRecovery(workspace, { minAgeSeconds: age }), json);
      } else {
        if (!opts.has("--apply")) throw new Error("dispatch-queue requires explicit --apply confirmation");
        const limit = opt(opts, "--limit") === undefined ? 4 : nonnegativeInteger(opt(opts, "--limit"), "--limit");
        emit(await dispatchOrphanedMotionQueue(workspace, { minAgeSeconds: age, limit, apply: true }), json);
      }
      return 0;
    }
    if (action === "storage" || action === "prune") {
      if (positionals.length) throw new Error(action + " does not accept positional arguments");
      if (action === "prune" && !opts.has("--apply")) throw new Error("Motion prune requires explicit --apply; run motion storage for a safe preview");
      if (action === "storage" && opts.has("--apply")) throw new Error("Use motion prune --apply for destructive maintenance");
      const days = opt(opts, "--days") === undefined ? 7 : nonnegativeInteger(opt(opts, "--days"), "--days");
      emit(await motionStorageMaintenance(workspace, { minAgeDays: days, apply: action === "prune" }), json);
      return 0;
    }
    if (action === "generate") {
      const prompt = opt(opts, "--prompt");
      if (!prompt || positionals.length) throw new Error("generate requires --prompt and no project ID");
      const width = opt(opts, "--width") === undefined ? undefined : nonnegativeInteger(opt(opts, "--width"), "--width");
      emit(await generateMotionFromPrompt(workspace, prompt, { width,
        aspectRatio: opt(opts, "--aspect-ratio") as "16:9" | "1:1" | "9:16" | undefined,
        imageAssetId: opt(opts, "--image-asset"),
        sceneImageAssetIds: opt(opts, "--scene-images")?.split(",").map(item => item.trim()),
        audioLoop: optionalBoolean(opt(opts, "--audio-loop"), "--audio-loop"),
        autoNarrateScenes: optionalBoolean(opt(opts, "--auto-narrate"), "--auto-narrate"),
        voiceoverText: opt(opts, "--voiceover-text"),
        voiceoverGain: opt(opts, "--voiceover-gain") === undefined ? undefined : Number(opt(opts, "--voiceover-gain")),
        audioAssetId: opt(opts, "--audio-asset"),
        audioGain: opt(opts, "--audio-gain") === undefined ? undefined : Number(opt(opts, "--audio-gain")) }), json); return 0;
    }
    if (action === "revise") {
      const prompt = opt(opts, "--prompt");
      if (!prompt || positionals.length !== 1) throw new Error("revise requires MOTION_ID and --prompt");
      const width = opt(opts, "--width") === undefined ? undefined : nonnegativeInteger(opt(opts, "--width"), "--width");
      emit(await reviseMotionFromPrompt(workspace, positionals[0], prompt, { width,
        imageAssetId: opt(opts, "--image-asset"),
        sceneImageAssetIds: opt(opts, "--scene-images")?.split(",").map(item => item.trim()),
        audioLoop: optionalBoolean(opt(opts, "--audio-loop"), "--audio-loop"),
        voiceoverText: opt(opts, "--voiceover-text"),
        voiceoverGain: opt(opts, "--voiceover-gain") === undefined ? undefined : Number(opt(opts, "--voiceover-gain")),
        audioAssetId: opt(opts, "--audio-asset"),
        audioGain: opt(opts, "--audio-gain") === undefined ? undefined : Number(opt(opts, "--audio-gain")) }), json); return 0;
    }
    if (action === "new") {
      const name = opt(opts, "--name");
      if (!name || positionals.length) throw new Error("new requires --name and no positional arguments");
      const project = await createMotionProject(workspace, name);
      emit({ id: project.id, name: project.name, revision: project.revision }, json);
      return 0;
    }
    if (action === "list") {
      if (positionals.length) throw new Error("list does not accept positional arguments");
      emit(await listMotionProjects(workspace), json);
      return 0;
    }
    if (action === "jobs") {
      if (positionals.length) throw new Error("jobs does not accept positional arguments");
      emit(await listMotionJobs(workspace), json);
      return 0;
    }
    if (action === "scheduler") {
      if (positionals.length) throw new Error("scheduler does not accept positional arguments");
      emit(await getMotionSchedulerStatus(workspace), json);
      return 0;
    }
    if (positionals.length !== 1) throw new Error(action + " requires exactly one project or job ID");
    const projectId = positionals[0];
    if (action === "recovery") {
      emit(await inspectMotionJob(workspace, projectId), json);
      return 0;
    }
    if (action === "recover") {
      if (!opts.has("--ack-stale")) throw new Error("recover requires --ack-stale after verifying the worker has stopped");
      emit(await reconcileStaleMotionJob(workspace, projectId), json);
      return 0;
    }
    if (action === "status") {
      emit(await getMotionJob(workspace, projectId), json);
      return 0;
    }
    if (action === "cancel") {
      emit(await requestMotionCancellation(workspace, projectId), json);
      return 0;
    }
    if (action === "render") {
      const widthText = opt(opts, "--width");
      const width = widthText === undefined ? undefined : nonnegativeInteger(widthText, "--width");
      if (opts.has("--supervised")) {
        if (opts.has("--detach")) throw new Error("--supervised queues a job without starting a worker; do not combine with --detach");
        emit(await enqueueSupervisedMotionJob(workspace, projectId, { width }), json);
        return 0;
      }
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const job = opts.has("--detach")
          ? await startDetachedMotionJob(workspace, projectId, { width })
          : await renderMotionJob(workspace, projectId, { width, signal: controller.signal });
        emit(job, json);
        return job.status === "queued" || job.status === "completed" ? 0 : job.status === "cancelled" ? 130 : 1;
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    if (action === "inspect") {
      emit(await getMotionProject(workspace, projectId), json);
      return 0;
    }
    if (action === "frame") {
      const frame = nonnegativeInteger(opt(opts, "--frame"), "--frame");
      emit(await writeMotionPreview(workspace, projectId, frame), json);
      return 0;
    }
    if (action === "edit") {
      const baseRevision = nonnegativeInteger(opt(opts, "--base-revision"), "--base-revision");
      const layerId = opt(opts, "--layer");
      const newText = opt(opts, "--text");
      const editsJson = opt(opts, "--edits-json");
      const editsFile = opt(opts, "--edits-file");
      const textMode = layerId !== undefined || newText !== undefined;
      const modes = Number(textMode) + Number(editsJson !== undefined) + Number(editsFile !== undefined);
      if (modes !== 1) throw new Error("edit requires exactly one of --layer/--text, --edits-json or --edits-file");
      let edits: MotionEdit[];
      if (textMode) {
        if (!layerId || newText === undefined) throw new Error("edit text requires --layer and --text");
        edits = [{ type: "set-text", layerId, text: newText }];
      } else {
        const input = editsFile === undefined
          ? editsJson!
          : (await readMotionWorkspaceInput(workspace, editsFile, 256 * 1024)).toString("utf8");
        if (input.length > 256 * 1024) throw new Error("Motion edits JSON exceeds 256 KB");
        const value: unknown = JSON.parse(input);
        if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
          throw new Error("Motion edits must be a JSON array with 1-50 transactions");
        }
        edits = value as MotionEdit[];
      }
      const result = await updateMotionProject(workspace, projectId, baseRevision, edits);
      emit({ id: result.id, revision: result.revision }, json);
      return 0;
    }
    throw new Error("Unsupported motion action: " + action);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) emit({ error: message }, true);
    else console.error("SuperAgent Studio: " + message);
    if (error instanceof MotionRevisionConflict) return 3;
    if (error instanceof MotionValidationError || error instanceof RangeError || error instanceof Error) return 2;
    return 1;
  }
}
