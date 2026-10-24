import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject, writeMotionPreview } from "../motion/motionService.js";
import { MotionRevisionConflict } from "../motion/project/revisions.js";
import { MotionValidationError } from "../motion/schema/validation.js";
import { probeFfmpeg } from "../motion/render/ffmpegEncoder.js";
import { importMotionAsset, readMotionAsset } from "../motion/assets/motionAssets.js";
import { importMotionAudio } from "../motion/assets/motionAudio.js";
import { importMotionFont } from "../motion/assets/motionFonts.js";
import { importMotionVideo } from "../motion/assets/motionVideoClips.js";
import { readMotionWorkspaceInput } from "../motion/assets/motionInput.js";
import { MOTION_CAPABILITIES } from "../motion/motionCapabilities.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt } from "../motion/director/directorService.js";
import { motionStorageMaintenance } from "../motion/jobs/storageMaintenance.js";
import { inspectMotionSupervisor, runMotionSupervisorOnce, runMotionSupervisorWatch } from "../motion/jobs/motionSupervisor.js";
import { inspectMotionQueueRecovery, dispatchOrphanedMotionQueue } from "../motion/jobs/queueRecovery.js";
import type { MotionEdit } from "../motion/schema/types.js";
import { getMotionJob, getMotionSchedulerStatus, listMotionJobs, inspectMotionJob, renderMotionJob, startDetachedMotionJob, reconcileStaleMotionJob, requestMotionCancellation, enqueueSupervisedMotionJob } from "../motion/jobs/motionJobs.js";

const usage = `SuperAgent Studio (developer preview)
  superagent studio generate --prompt "Animated promo" [--wait] [--width 640] [--image-asset ASSET_ID | --scene-images ID1,ID2,ID3] [--audio-asset AUDIO_ID] [--audio-gain 1] [--audio-loop true] [--voiceover-text TEXT] [--workspace PATH] [--json]
  superagent studio revise MOTION_ID --prompt "Shorter title" [--wait] [--width 640] [--image-asset ASSET_ID | --scene-images ID1,ID2,ID3] [--audio-asset AUDIO_ID] [--audio-gain 1] [--audio-loop true] [--voiceover-text TEXT] [--workspace PATH] [--json]
  superagent studio new --name "Title" [--workspace PATH] [--json]
  superagent studio list [--workspace PATH] [--json]
  superagent studio inspect PROJECT_ID [--workspace PATH] [--json]
  superagent studio edit PROJECT_ID --base-revision N --layer LAYER_ID --text "Title"
  superagent studio edit PROJECT_ID --base-revision N --edits-json '[{"type":"set-property",...}]'
  superagent studio edit PROJECT_ID --base-revision N --edits-file workspace/path/edits.json
  superagent studio import-image --file workspace/path/image.png [--workspace PATH] [--json]
  superagent studio import-audio --file workspace/path/clip.wav [--workspace PATH] [--json]
  superagent studio import-font --file workspace/path/font.ttf --family "BrandFont" [--workspace PATH] [--json]
  superagent studio import-video --file workspace/path/clip.mp4 [--workspace PATH] [--json]
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
  superagent studio migrate [--workspace PATH] [--apply] [--json]
  superagent studio effects [--category CATEGORY] [--search QUERY] [--workspace PATH] [--json]
  superagent studio effect-info EFFECT_ID [--workspace PATH] [--json]
  superagent studio presets [--search QUERY] [--json]
  superagent studio preset-info PRESET_ID [--json]
  superagent studio apply-preset PROJECT_ID --base-revision N --preset PRESET_ID --layer TEXT_LAYER_ID [--start-frame N] [--duration-frames N] [--intensity 1] [--json]
  superagent studio apply-effect PROJECT_ID --base-revision N --effect EFFECT_ID [--layer LAYER_ID] [--params-json JSON] [--start-frame N] [--duration-frames N] [--workspace PATH] [--json]
  superagent studio templates [--json]
  superagent studio apply-template PROJECT_ID TEMPLATE_ID --base-revision N [--headline "H"] [--subtitle "S"] [--workspace PATH] [--json]
  superagent studio batch-variants PROJECT_ID --base-revision N [--ratios "16:9,9:16,1:1"] [--width 640] [--workspace PATH] [--json]
  superagent studio beat-sync PROJECT_ID --base-revision N --target-layer LAYER_ID [--audio-track 0] [--intensity 0.35] [--workspace PATH] [--json]
  superagent studio preview PROJECT_ID [--open] [--workspace PATH] [--json]
  superagent studio export-bundle PROJECT_ID [--workspace PATH] [--json]
  superagent studio trace-image --file workspace/path/logo.png [--mode silhouette|color|outline] [--threshold N] [--simplify N] [--smooth] [--workspace PATH] [--json]
  superagent studio vectorize PROJECT_ID --layer LAYER_ID [--mode silhouette|color|outline] [--workspace PATH] [--json]

MP4 preview uses installed FFmpeg. --detach launches a separate Bun worker;
recovery is diagnostic/read-only unless the operator explicitly runs recover --ack-stale.`;

function argumentsOf(args: string[]): { action: string; positionals: string[]; opts: Map<string, string | true> } {
  const opts = new Map<string, string | true>();
  const positionals: string[] = [];
  const boolean = new Set(["--json", "--detach", "--supervised", "--once", "--watch", "--ack-stale", "--apply", "--wait", "--burn-captions", "--auto-narrate", "--open", "--smooth", "--invert", "--kinetic", "--help", "-h"]);
  const valid = new Set(["--workspace", "-w", "--prompt", "--aspect-ratio", "--image-asset", "--scene-images", "--audio-asset", "--audio-gain", "--audio-loop", "--voiceover-text", "--voiceover-gain", "--auto-narrate", "--burn-captions", "--name", "--base-revision", "--layer", "--text", "--frame", "--width", "--file", "--edits-json", "--edits-file", "--days", "--min-age-seconds", "--limit", "--interval-ms", "--category", "--search", "--family", "--effect", "--preset", "--intensity", "--params-json", "--start-frame", "--duration-frames", "--ratios", "--target-layer", "--audio-track", "--headline", "--subtitle", "--mode", "--threshold", "--simplify", "--min-area", "--fill", "--stroke", "--stroke-width", "--fit-width", "--fit-height", ...boolean]);
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
    if (action === "migrate") {
      const { inspectStudioStorageMigration, migrateStudioStorage } =
        await import("../motion/project/projectStore.js");
      const before = await inspectStudioStorageMigration(workspace);
      if (opts.has("--apply")) {
        const result = await migrateStudioStorage(workspace);
        emit({ ...result, preview: before }, json);
      } else {
        emit({ ...before, dryRun: true, applyInstruction: "superagent studio migrate --apply --workspace PATH" }, json);
      }
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
    if (action === "templates") {
      if (positionals.length) throw new Error("templates does not accept positional arguments");
      const { listMotionTemplates } = await import("../motion/motionTemplates.js");
      emit(listMotionTemplates(), json);
      return 0;
    }
    if (action === "apply-template") {
      if (positionals.length !== 2) throw new Error("apply-template requires PROJECT_ID and TEMPLATE_ID");
      const [projectId, templateId] = positionals;
      const baseRevText = opt(opts, "--base-revision");
      if (!baseRevText) throw new Error("apply-template requires --base-revision N");
      const baseRevision = nonnegativeInteger(baseRevText, "--base-revision");
      const { compileMotionTemplate } = await import("../motion/motionTemplates.js");
      const { getMotionBrandKit } = await import("../motion/motionBrandKit.js");
      const project = await getMotionProject(workspace, projectId);
      const brand = await getMotionBrandKit(workspace);
      const composition = compileMotionTemplate(project, brand, {
        templateId,
        headline: opt(opts, "--headline"),
        subtitle: opt(opts, "--subtitle"),
      });
      const updated = await updateMotionProject(workspace, projectId, baseRevision, [
        { type: "replace-composition", composition },
      ]);
      emit({ id: updated.id, revision: updated.revision, templateApplied: templateId }, json);
      return 0;
    }
    if (action === "batch-variants") {
      if (positionals.length !== 1) throw new Error("batch-variants requires exactly one project ID");
      const baseRevText = opt(opts, "--base-revision");
      if (!baseRevText) throw new Error("batch-variants requires --base-revision N");
      const baseRevision = nonnegativeInteger(baseRevText, "--base-revision");
      const ratiosText = opt(opts, "--ratios") || "16:9,9:16,1:1";
      const aspectRatios = ratiosText.split(",").map(r => r.trim() as any);
      const width = opt(opts, "--width") === undefined ? undefined : nonnegativeInteger(opt(opts, "--width"), "--width");
      const { createMotionBatchVariants } = await import("../motion/motionBatchVariants.js");
      const result = await createMotionBatchVariants(workspace, positionals[0], baseRevision, aspectRatios, { width });
      emit(result, json);
      return 0;
    }
    if (action === "beat-sync") {
      if (positionals.length !== 1) throw new Error("beat-sync requires exactly one project ID");
      const baseRevText = opt(opts, "--base-revision");
      if (!baseRevText) throw new Error("beat-sync requires --base-revision N");
      const baseRevision = nonnegativeInteger(baseRevText, "--base-revision");
      const targetLayerId = opt(opts, "--target-layer");
      if (!targetLayerId) throw new Error("beat-sync requires --target-layer LAYER_ID");
      const audioTrack = opt(opts, "--audio-track") === undefined ? undefined : nonnegativeInteger(opt(opts, "--audio-track"), "--audio-track");
      const intensity = opt(opts, "--intensity") === undefined ? undefined : Number(opt(opts, "--intensity"));
      const { compileMotionBeatSync } = await import("../motion/motionBeatSync.js");
      const project = await getMotionProject(workspace, positionals[0]);
      const { edits, onsetFrames, analysis } = await compileMotionBeatSync(workspace, project, {
        targetLayerId,
        audioTrackIndex: audioTrack,
        intensity,
      });
      const updated = await updateMotionProject(workspace, project.id, baseRevision, edits);
      emit({ id: updated.id, revision: updated.revision, onsetFrames, analysis }, json);
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
    if (action === "import-image" || action === "import-audio" || action === "import-font" || action === "import-video") {
      if (action === "import-video") {
        const filename = opt(opts, "--file");
        if (!filename) throw new Error("import-video requires --file inside the authorized workspace");
        const data = await readMotionWorkspaceInput(workspace, filename, 50 * 1024 * 1024);
        emit(await importMotionVideo(workspace, data), json);
        return 0;
      }
      if (action === "import-font") {
        const filename = opt(opts, "--file");
        const family = opt(opts, "--family");
        if (!filename) throw new Error("import-font requires --file inside the authorized workspace");
        if (!family) throw new Error("import-font requires --family <FontFamilyName>");
        const data = await readMotionWorkspaceInput(workspace, filename, 5 * 1024 * 1024);
        emit(await importMotionFont(workspace, family, data), json);
        return 0;
      }
      if (positionals.length) throw new Error(action + " requires --file and no positional arguments");
      const filename = opt(opts, "--file");
      if (!filename) throw new Error(action + " requires --file inside the authorized workspace");
      const data = await readMotionWorkspaceInput(workspace, filename, action === "import-image" ? 1024 * 1024 : 2 * 1024 * 1024);
      emit(action === "import-image" ? await importMotionAsset(workspace, data) : await importMotionAudio(workspace, data), json);
      return 0;
    }
    if (action === "trace-image") {
      const filename = opt(opts, "--file");
      if (!filename || positionals.length) throw new Error("trace-image requires --file and no positional arguments");
      const data = await readMotionWorkspaceInput(workspace, filename, 4 * 1024 * 1024);
      const { traceImageBuffer } = await import("../motion/vector/imageTracer.js");
      const mode = opt(opts, "--mode") as "silhouette" | "color" | "outline" | undefined;
      const threshold = opt(opts, "--threshold") !== undefined ? Number(opt(opts, "--threshold")) : undefined;
      const simplify = opt(opts, "--simplify") !== undefined ? Number(opt(opts, "--simplify")) : undefined;
      const minArea = opt(opts, "--min-area") !== undefined ? Number(opt(opts, "--min-area")) : undefined;
      const smooth = opts.has("--smooth") ? true : undefined;
      const invert = opts.has("--invert") ? true : undefined;
      const fill = opt(opts, "--fill");
      const stroke = opt(opts, "--stroke");
      const strokeWidth = opt(opts, "--stroke-width") !== undefined ? Number(opt(opts, "--stroke-width")) : undefined;
      const fitWidth = opt(opts, "--fit-width") !== undefined ? Number(opt(opts, "--fit-width")) : undefined;
      const fitHeight = opt(opts, "--fit-height") !== undefined ? Number(opt(opts, "--fit-height")) : undefined;
      const result = await traceImageBuffer(data, {
        mode, threshold, simplify, minArea, smooth, invert, fill, stroke, strokeWidth, fitWidth, fitHeight,
      });
      emit(result, json);
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
      const result = await generateMotionFromPrompt(workspace, prompt, { width,
        aspectRatio: opt(opts, "--aspect-ratio") as "16:9" | "1:1" | "9:16" | undefined,
        burnCaptions: opts.has("--burn-captions") ? true : undefined,
        imageAssetId: opt(opts, "--image-asset"),
        sceneImageAssetIds: opt(opts, "--scene-images")?.split(",").map(item => item.trim()),
        audioLoop: optionalBoolean(opt(opts, "--audio-loop"), "--audio-loop"),
        autoNarrateScenes: opts.has("--auto-narrate") ? true : optionalBoolean(opt(opts, "--auto-narrate"), "--auto-narrate"),
        voiceoverText: opt(opts, "--voiceover-text"),
        voiceoverGain: opt(opts, "--voiceover-gain") === undefined ? undefined : Number(opt(opts, "--voiceover-gain")),
        audioAssetId: opt(opts, "--audio-asset"),
        audioGain: opt(opts, "--audio-gain") === undefined ? undefined : Number(opt(opts, "--audio-gain")) });
      if (opts.has("--wait")) {
        const timeoutMs = 120_000;
        const start = Date.now();
        let job = result.job;
        while (!["completed", "failed", "cancelled", "interrupted"].includes(job.status)) {
          if (Date.now() - start > timeoutMs) throw new Error("Motion video render timed out");
          await new Promise(resolve => setTimeout(resolve, 200));
          job = await getMotionJob(workspace, result.job.id);
        }
        result.job = job;
      }
      emit(result, json);
      return result.job.status === "failed" ? 1 : 0;
    }
    if (action === "revise") {
      const prompt = opt(opts, "--prompt");
      if (!prompt || positionals.length !== 1) throw new Error("revise requires MOTION_ID and --prompt");
      const width = opt(opts, "--width") === undefined ? undefined : nonnegativeInteger(opt(opts, "--width"), "--width");
      const result = await reviseMotionFromPrompt(workspace, positionals[0], prompt, { width,
        burnCaptions: opts.has("--burn-captions") ? true : undefined,
        imageAssetId: opt(opts, "--image-asset"),
        sceneImageAssetIds: opt(opts, "--scene-images")?.split(",").map(item => item.trim()),
        audioLoop: optionalBoolean(opt(opts, "--audio-loop"), "--audio-loop"),
        voiceoverText: opt(opts, "--voiceover-text"),
        voiceoverGain: opt(opts, "--voiceover-gain") === undefined ? undefined : Number(opt(opts, "--voiceover-gain")),
        audioAssetId: opt(opts, "--audio-asset"),
        audioGain: opt(opts, "--audio-gain") === undefined ? undefined : Number(opt(opts, "--audio-gain")) });
      if (opts.has("--wait")) {
        const timeoutMs = 120_000;
        const start = Date.now();
        let job = result.job;
        while (!["completed", "failed", "cancelled", "interrupted"].includes(job.status)) {
          if (Date.now() - start > timeoutMs) throw new Error("Motion video render timed out");
          await new Promise(resolve => setTimeout(resolve, 200));
          job = await getMotionJob(workspace, result.job.id);
        }
        result.job = job;
      }
      emit(result, json);
      return result.job.status === "failed" ? 1 : 0;
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
    if (action === "preview") {
      const project = await getMotionProject(workspace, projectId);
      const allJobs = await listMotionJobs(workspace);
      const projectJobs = allJobs.filter(j => j.projectId === project.id && j.status === "completed");
      const latestJob = projectJobs[0];
      const { renderMotionPlayerHtml } = await import("../motion/render/motionPreviewHtml.js");
      const html = renderMotionPlayerHtml(project, latestJob);

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const { studioStorageRoot } = await import("../motion/project/projectStore.js");
      const storageRoot = await studioStorageRoot(workspace, true);
      const previewDir = path.join(storageRoot, "previews");
      await fs.mkdir(previewDir, { recursive: true });
      const previewFilePath = path.join(previewDir, `preview-${project.id}.html`);
      await fs.writeFile(previewFilePath, html, "utf8");

      let opened = false;
      if (opts.has("--open")) {
        try {
          const { execa } = await import("execa");
          const openTarget = `file://${path.resolve(previewFilePath).replace(/\\/g, "/")}`;
          if (process.platform === "win32") {
            await execa("cmd", ["/c", "start", "", openTarget], { stdio: "ignore", detached: true });
          } else if (process.platform === "darwin") {
            await execa("open", [openTarget], { stdio: "ignore", detached: true });
          } else {
            await execa("xdg-open", [openTarget], { stdio: "ignore", detached: true });
          }
          opened = true;
        } catch {
          // Non-fatal if browser launcher fails in headless/test environment
        }
      }

      emit({
        status: "ready",
        projectId: project.id,
        previewFile: previewFilePath,
        opened,
        hasRenderedVideo: Boolean(latestJob?.status === "completed"),
      }, json);
      return 0;
    }
    if (action === "export-bundle") {
      const { exportMotionDeliverablesBundle } = await import("../motion/motionBundleExport.js");
      const manifest = await exportMotionDeliverablesBundle(workspace, projectId);
      emit(manifest, json);
      return 0;
    }
    if (action === "vectorize") {
      const layerId = opt(opts, "--layer") ?? opt(opts, "--target-layer");
      if (!layerId) throw new Error("vectorize requires --layer <id>");
      const project = await getMotionProject(workspace, projectId);
      const targetLayer = project.composition.layers.find(l => l.id === layerId);
      if (!targetLayer) throw new Error(`Layer "${layerId}" not found in project`);
      let imageBuffer: Buffer;
      if (targetLayer.kind === "image") {
        imageBuffer = await readMotionAsset(workspace, targetLayer.assetId);
      } else {
        const file = opt(opts, "--file");
        if (!file) throw new Error("vectorize non-image layer requires --file <image>");
        imageBuffer = await readMotionWorkspaceInput(workspace, file, 4 * 1024 * 1024);
      }
      const { vectorizeProjectLayer } = await import("../motion/vector/imageTracer.js");
      const mode = opt(opts, "--mode") as "silhouette" | "color" | "outline" | undefined;
      const threshold = opt(opts, "--threshold") !== undefined ? Number(opt(opts, "--threshold")) : undefined;
      const simplify = opt(opts, "--simplify") !== undefined ? Number(opt(opts, "--simplify")) : undefined;
      const fill = opt(opts, "--fill");
      const stroke = opt(opts, "--stroke");
      const strokeWidth = opt(opts, "--stroke-width") !== undefined ? Number(opt(opts, "--stroke-width")) : undefined;
      const smooth = opts.has("--smooth") ? true : undefined;
      const { project: updated, newLayers } = await vectorizeProjectLayer(project, layerId, imageBuffer, {
        mode, threshold, simplify, fill, stroke, strokeWidth, smooth,
      });
      const saved = await updateMotionProject(workspace, project.id, project.revision, [
        { type: "replace-composition", composition: updated.composition },
      ]);
      emit({ id: saved.id, projectId: saved.id, revision: saved.revision, newLayers: newLayers.map(l => l.id) }, json);
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
