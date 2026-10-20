import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject, writeMotionPreview } from "../motion/motionService.js";
import { MotionRevisionConflict } from "../motion/project/revisions.js";
import { MotionValidationError } from "../motion/schema/validation.js";
import { probeFfmpeg } from "../motion/render/ffmpegEncoder.js";
import { importMotionAsset } from "../motion/assets/motionAssets.js";
import { importMotionAudio } from "../motion/assets/motionAudio.js";
import { readMotionWorkspaceInput } from "../motion/assets/motionInput.js";
import { MOTION_CAPABILITIES } from "../motion/motionCapabilities.js";
import { motionStorageMaintenance } from "../motion/jobs/storageMaintenance.js";
import { inspectMotionQueueRecovery, dispatchOrphanedMotionQueue } from "../motion/jobs/queueRecovery.js";
import type { MotionEdit } from "../motion/schema/types.js";
import { getMotionJob, getMotionSchedulerStatus, listMotionJobs, inspectMotionJob, renderMotionJob, startDetachedMotionJob, reconcileStaleMotionJob, requestMotionCancellation } from "../motion/jobs/motionJobs.js";

const usage = `Motion Studio (developer preview)
  superagent motion new --name "Title" [--workspace PATH] [--json]
  superagent motion list [--workspace PATH] [--json]
  superagent motion inspect PROJECT_ID [--workspace PATH] [--json]
  superagent motion edit PROJECT_ID --base-revision N --layer LAYER_ID --text "Title"
  superagent motion edit PROJECT_ID --base-revision N --edits-json '[{"type":"set-property",...}]'
  superagent motion edit PROJECT_ID --base-revision N --edits-file workspace/path/edits.json
  superagent motion import-image --file workspace/path/image.png [--workspace PATH] [--json]
  superagent motion import-audio --file workspace/path/clip.wav [--workspace PATH] [--json]
  superagent motion frame PROJECT_ID --frame N [--workspace PATH] [--json]
  superagent motion render PROJECT_ID [--width EVEN_NUMBER] [--detach] [--workspace PATH] [--json]
  superagent motion jobs [--workspace PATH] [--json]
  superagent motion scheduler [--workspace PATH] [--json]
  superagent motion queue-recovery [--min-age-seconds 30] [--workspace PATH] [--json]
  superagent motion dispatch-queue --apply [--min-age-seconds 30] [--limit 4] [--workspace PATH] [--json]
  superagent motion storage [--days 7] [--workspace PATH] [--json]
  superagent motion prune [--days 7] --apply [--workspace PATH] [--json]
  superagent motion status JOB_ID [--workspace PATH] [--json]
  superagent motion recovery JOB_ID [--workspace PATH] [--json]
  superagent motion recover JOB_ID --ack-stale [--workspace PATH] [--json]
  superagent motion cancel JOB_ID [--workspace PATH] [--json]
  superagent motion doctor [--json]

MP4 preview uses installed FFmpeg. --detach launches a separate Node worker;
recovery is diagnostic/read-only unless the operator explicitly runs recover --ack-stale.`;

function argumentsOf(args: string[]): { action: string; positionals: string[]; opts: Map<string, string | true> } {
  const opts = new Map<string, string | true>();
  const positionals: string[] = [];
  const boolean = new Set(["--json", "--detach", "--ack-stale", "--apply", "--help", "-h"]);
  const valid = new Set(["--workspace", "-w", "--name", "--base-revision", "--layer", "--text", "--frame", "--width", "--file", "--edits-json", "--edits-file", "--days", "--min-age-seconds", "--limit", ...boolean]);
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
    else console.error("Motion Studio: " + message);
    if (error instanceof MotionRevisionConflict) return 3;
    if (error instanceof MotionValidationError || error instanceof RangeError || error instanceof Error) return 2;
    return 1;
  }
}
