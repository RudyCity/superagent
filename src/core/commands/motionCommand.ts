import type { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";

const help = [
  "Motion Studio (developer preview)",
  "  /motion generate <brief>",
  "  /motion revise <motion-id> <change request>",
  "  /motion new <title>",
  "  /motion list",
  "  /motion inspect <project-id>",
  "  /motion edit <project-id> <base-revision> <layer-id> <text>",
  '  /motion edit-json <project-id> <base-revision> [{"type":"set-property",...}]',
  "  /motion import-image <relative-file-path>",
  "  /motion import-audio <relative-file-path>",
  "  /motion frame <project-id> <frame>",
  "  /motion render <project-id> [even-output-width]",
  "  /motion jobs",
  "  /motion status <job-id>",
  "  /motion recovery <job-id> (read-only)",
  "  /motion cancel <job-id>",
  "  /motion storage [days] (read-only)",
  "  /motion queue-recovery (read-only)",
  "  /motion supervisor-status (read-only)",
  "  /motion queue <project-id> [even-output-width] (requires separate supervisor process)",
  "  /motion doctor",
  "Interactive renders are foreground; scriptable CLI supports detached rendering.",
].join("\n");

function emit(ctx: SlashCommandContext, content: string, error = false): void {
  ctx.addLine({ type: error ? "error" : "system", content, timestamp: Date.now() });
}

function parseInteger(input: string | undefined, name: string): number {
  const value = Number(input);
  if (input === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(name + " must be a nonnegative integer");
  }
  return value;
}

export const motionCommand: SlashCommand = {
  name: "motion",
  description: "Create, edit and render Motion Studio video previews in the active workspace",
  async execute(input, ctx) {
    const tokens = input.trim().split(/\s+/).filter(Boolean);
    const [action = "help", id, third, fourth, ...rest] = tokens;
    const workspace = ctx.agent?.workingDirectory || process.cwd();
    try {
      if (action === "help") {
        emit(ctx, help);
        return;
      }
      if (action === "storage") {
        const days = third === undefined ? (id === undefined ? 7 : parseInteger(id, "days")) : parseInteger(third, "days");
        const { motionStorageMaintenance } = await import("../motion/jobs/storageMaintenance.js");
        const status = await motionStorageMaintenance(workspace, { minAgeDays: days });
        emit(ctx, JSON.stringify(status, null, 2));
        return;
      }
      if (action === "queue-recovery") {
        const { inspectMotionQueueRecovery } = await import("../motion/jobs/queueRecovery.js");
        emit(ctx, JSON.stringify(await inspectMotionQueueRecovery(workspace), null, 2));
        return;
      }
      if (action === "supervisor-status") {
        const { inspectMotionSupervisor } = await import("../motion/jobs/motionSupervisor.js");
        emit(ctx, JSON.stringify(await inspectMotionSupervisor(workspace), null, 2)); return;
      }
      if (action === "queue") {
        if (!id) throw new Error("Usage: /motion queue <project-id> [even-output-width]");
        const width = third === undefined ? undefined : parseInteger(third, "width");
        const { enqueueSupervisedMotionJob } = await import("../motion/jobs/motionJobs.js");
        const job = await enqueueSupervisedMotionJob(workspace, id, { width });
        emit(ctx, "Motion job queued for FIFO supervisor: " + job.id + ". Start the CLI supervisor in a separate terminal."); return;
      }
      if (action === "generate") {
        const prompt = tokens.slice(1).join(" ").trim();
        if (!prompt) throw new Error("Usage: /motion generate <brief>");
        const { generateMotionFromPrompt } = await import("../motion/director/directorService.js");
        const result = await generateMotionFromPrompt(workspace, prompt);
        emit(ctx, "AI Motion " + result.project.id + " r" + result.project.revision +
          " rendering: " + result.job.id);
        return;
      }
      if (action === "revise") {
        const prompt = tokens.slice(2).join(" ").trim();
        if (!id || !prompt) throw new Error("Usage: /motion revise <motion-id> <change>");
        const { reviseMotionFromPrompt } = await import("../motion/director/directorService.js");
        const result = await reviseMotionFromPrompt(workspace, id, prompt);
        emit(ctx, "AI Motion " + result.project.id + " r" + result.project.revision +
          " rendering: " + result.job.id);
        return;
      }
      if (action === "doctor") {
        const { probeFfmpeg } = await import("../motion/render/ffmpegEncoder.js");
        const available = await probeFfmpeg();
        emit(ctx, "Motion Studio: " + (available ? "FFmpeg available; MP4 previews enabled" : "FFmpeg unavailable; SVG previews only"));
        return;
      }
      if (action === "import-image" || action === "import-audio") {
        const filename = tokens.slice(1).join(" ").trim();
        if (!filename) throw new Error("Usage: /motion " + action + " <relative-file-path>");
        const { readMotionWorkspaceInput } = await import("../motion/assets/motionInput.js");
        const data = await readMotionWorkspaceInput(workspace, filename, action === "import-image" ? 1024 * 1024 : 2 * 1024 * 1024);
        const result = action === "import-image"
          ? await (await import("../motion/assets/motionAssets.js")).importMotionAsset(workspace, data)
          : await (await import("../motion/assets/motionAudio.js")).importMotionAudio(workspace, data);
        emit(ctx, "Imported " + action + ": " + result.id + " (" + result.bytes + " bytes)");
        return;
      }
      if (action === "edit-json") {
        if (!id || !third || !fourth) throw new Error("Usage: /motion edit-json <project-id> <base-revision> <json-array>");
        const baseRevision = parseInteger(third, "base-revision");
        const raw = [fourth, ...rest].join(" ");
        if (raw.length > 256 * 1024) throw new Error("Motion JSON transaction exceeds 256 KB");
        const edits: unknown = JSON.parse(raw);
        if (!Array.isArray(edits) || edits.length < 1 || edits.length > 50) throw new Error("Motion edits must contain 1-50 items");
        const { updateMotionProject } = await import("../motion/motionService.js");
        const result = await updateMotionProject(workspace, id, baseRevision, edits);
        emit(ctx, "Updated motion project " + result.id + " to revision " + result.revision);
        return;
      }
      if (action === "list" || action === "new" || action === "inspect" || action === "edit" || action === "frame") {
        const service = await import("../motion/motionService.js");
        if (action === "new") {
          const name = tokens.slice(1).join(" ").trim();
          if (!name) throw new Error("Usage: /motion new <title>");
          const result = await service.createMotionProject(workspace, name);
          emit(ctx, "Created motion project " + result.id + " (revision " + result.revision + ")");
        } else if (action === "list") {
          const result = await service.listMotionProjects(workspace);
          emit(ctx, result.length ? result.map(item => item.id + " (r" + item.revision + ") " + item.name).join("\n") : "No motion projects in current workspace.");
        } else if (action === "inspect") {
          if (!id) throw new Error("Usage: /motion inspect <project-id>");
          const result = await service.getMotionProject(workspace, id);
          emit(ctx, JSON.stringify({ id: result.id, name: result.name, revision: result.revision, composition: result.composition }, null, 2));
        } else if (action === "frame") {
          if (!id) throw new Error("Usage: /motion frame <project-id> <frame>");
          const frame = parseInteger(third, "frame");
          const result = await service.writeMotionPreview(workspace, id, frame);
          emit(ctx, "Motion SVG preview: " + result.path + " (SHA-256 " + result.sha256 + ")");
        } else {
          if (!id || !fourth || !rest.length) throw new Error("Usage: /motion edit <project-id> <base-revision> <layer-id> <text>");
          const baseRevision = parseInteger(third, "base-revision");
          const result = await service.updateMotionProject(workspace, id, baseRevision, [
            { type: "set-text", layerId: fourth, text: rest.join(" ") },
          ]);
          emit(ctx, "Updated motion project " + result.id + " to revision " + result.revision);
        }
        return;
      }
      const jobs = await import("../motion/jobs/motionJobs.js");
      if (action === "jobs") {
        const result = await jobs.listMotionJobs(workspace);
        emit(ctx, result.length ? result.map(job => job.id + " " + job.status + " " + job.framesCompleted + "/" + job.profile.frameCount).join("\n") : "No motion render jobs.");
      } else if (action === "recovery") {
        if (!id) throw new Error("Usage: /motion recovery <job-id>");
        emit(ctx, JSON.stringify(await jobs.inspectMotionJob(workspace, id), null, 2));
      } else if (action === "status") {
        if (!id) throw new Error("Usage: /motion status <job-id>");
        const result = await jobs.getMotionJob(workspace, id);
        emit(ctx, JSON.stringify(result, null, 2));
      } else if (action === "cancel") {
        if (!id) throw new Error("Usage: /motion cancel <job-id>");
        const result = await jobs.requestMotionCancellation(workspace, id);
        emit(ctx, result.cancellationRequested ? "Cancellation requested for " + id : "Job already finished: " + id);
      } else if (action === "render") {
        if (!id) throw new Error("Usage: /motion render <project-id> [even-output-width]");
        const width = third === undefined ? undefined : parseInteger(third, "width");
        emit(ctx, "Starting local Motion MP4 render. This terminal command completes when encoding finishes.");
        const job = await jobs.renderMotionJob(workspace, id, { width });
        emit(ctx, "Motion render " + job.id + ": " + job.status + (job.artifact ? "\nOutput: " + job.artifact.path : job.error ? "\nError: " + job.error : ""), job.status !== "completed");
      } else {
        emit(ctx, help, true);
      }
    } catch (error) {
      emit(ctx, "Motion Studio: " + (error instanceof Error ? error.message : String(error)), true);
    }
  },
};

registry.register(motionCommand);
