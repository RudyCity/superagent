import type { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";

const help = [
  "SuperAgent Studio (developer preview)",
  "  /studio generate <brief>",
  "  /studio revise <motion-id> <change request>",
  "  /studio new <title>",
  "  /studio list",
  "  /studio inspect <project-id>",
  "  /studio edit <project-id> <base-revision> <layer-id> <text>",
  '  /studio edit-json <project-id> <base-revision> [{"type":"set-property",...}]',
  "  /studio import-image <relative-file-path>",
  "  /studio import-audio <relative-file-path>",
  "  /studio frame <project-id> <frame>",
  "  /studio render <project-id> [even-output-width]",
  "  /studio jobs",
  "  /studio status <job-id>",
  "  /studio recovery <job-id> (read-only)",
  "  /studio cancel <job-id>",
  "  /studio storage [days] (read-only)",
  "  /studio queue-recovery (read-only)",
  "  /studio supervisor-status (read-only)",
  "  /studio queue <project-id> [even-output-width] (requires separate supervisor process)",
  "  /studio doctor",
  "  /studio effects [category]",
  "  /studio effect <effect-id>",
  "  /studio presets [search]",
  "  /studio preset <preset-id>",
  "  /studio apply-preset <project-id> <base-revision> <preset-id> <text-layer-id>",
  "  /studio apply-effect <project-id> <base-revision> <effect-id> [layer-id] [params-json]",
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
  name: "studio",
  description: "Create, edit and render SuperAgent Studio visuals in the active workspace",
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
        if (!id) throw new Error("Usage: /studio queue <project-id> [even-output-width]");
        const width = third === undefined ? undefined : parseInteger(third, "width");
        const { enqueueSupervisedMotionJob } = await import("../motion/jobs/motionJobs.js");
        const job = await enqueueSupervisedMotionJob(workspace, id, { width });
        emit(ctx, "Motion job queued for FIFO supervisor: " + job.id + ". Start the CLI supervisor in a separate terminal."); return;
      }
      if (action === "generate") {
        const prompt = tokens.slice(1).join(" ").trim();
        if (!prompt) throw new Error("Usage: /studio generate <brief>");
        const { generateMotionFromPrompt } = await import("../motion/director/directorService.js");
        const result = await generateMotionFromPrompt(workspace, prompt);
        emit(ctx, "AI Motion " + result.project.id + " r" + result.project.revision +
          " rendering: " + result.job.id);
        return;
      }
      if (action === "revise") {
        const prompt = tokens.slice(2).join(" ").trim();
        if (!id || !prompt) throw new Error("Usage: /studio revise <motion-id> <change>");
        const { reviseMotionFromPrompt } = await import("../motion/director/directorService.js");
        const result = await reviseMotionFromPrompt(workspace, id, prompt);
        emit(ctx, "AI Motion " + result.project.id + " r" + result.project.revision +
          " rendering: " + result.job.id);
        return;
      }
      if (action === "effects") {
        const { effectRegistry } = await import("../motion/effects/index.js");
        const category = id as any;
        const items = effectRegistry.getCatalog({ category });
        emit(ctx, items.length ? items.map(e => `[${e.category}] ${e.id} - ${e.name}`).join("\n") + `\n\nTotal: ${items.length} effects` : "No effects found.");
        return;
      }
      if (action === "effect") {
        if (!id) throw new Error("Usage: /studio effect <effect-id>");
        const { effectRegistry } = await import("../motion/effects/index.js");
        const item = effectRegistry.getCatalog().find(e => e.id === id);
        if (!item) throw new Error("Effect not found: " + id);
        emit(ctx, JSON.stringify(item, null, 2));
        return;
      }
      if (action === "presets") {
        const { listCompoundPresets } = await import("../motion/effects/compoundPresets.js");
        const items = listCompoundPresets(tokens.slice(1).join(" "));
        emit(ctx, items.length ? items.map(item => item.id + " - " + item.name).join("\n") : "No matching compound presets.");
        return;
      }
      if (action === "preset") {
        if (!id) throw new Error("Usage: /studio preset <preset-id>");
        const { getCompoundPreset } = await import("../motion/effects/compoundPresets.js");
        const preset = getCompoundPreset(id);
        if (!preset) throw new Error("Unknown compound preset: " + id);
        emit(ctx, JSON.stringify(preset, null, 2));
        return;
      }
      if (action === "apply-preset") {
        if (!id || !third || !fourth || !rest[0])
          throw new Error("Usage: /studio apply-preset <project-id> <base-revision> <preset-id> <text-layer-id>");
        const baseRevision = parseInteger(third, "base-revision");
        const { applyCompoundPresetToProject } = await import("../motion/motionService.js");
        const result = await applyCompoundPresetToProject(workspace, id, baseRevision, {
          presetId: fourth, targetLayerId: rest[0],
        });
        emit(ctx, "Applied compound preset " + fourth + " to " + result.id + " (revision " + result.revision + ")");
        return;
      }
      if (action === "apply-effect") {
        if (!id || !third || !fourth) throw new Error("Usage: /studio apply-effect <project-id> <base-revision> <effect-id> [layer-id] [params-json]");
        const baseRevision = parseInteger(third, "base-revision");
        const effectId = fourth;
        const targetLayerId = rest[0];
        const paramsJson = rest.slice(1).join(" ");
        let params: Record<string, unknown> | undefined;
        if (paramsJson) {
          params = JSON.parse(paramsJson);
        }
        const service = await import("../motion/motionService.js");
        const current = await service.getMotionProject(workspace, id);
        const { effectRegistry } = await import("../motion/effects/index.js");
        const updated = effectRegistry.applyToProject(current, { effectId, targetLayerId, params });
        const result = await service.updateMotionProject(workspace, id, baseRevision, [
          { type: "replace-composition", composition: updated.composition },
        ]);
        emit(ctx, "Applied effect " + effectId + " to project " + result.id + " (revision " + result.revision + ")");
        return;
      }
      if (action === "doctor") {
        const { probeFfmpeg } = await import("../motion/render/ffmpegEncoder.js");
        const available = await probeFfmpeg();
        emit(ctx, "SuperAgent Studio: " + (available ? "FFmpeg available; MP4 previews enabled" : "FFmpeg unavailable; SVG previews only"));
        return;
      }
      if (action === "import-image" || action === "import-audio") {
        const filename = tokens.slice(1).join(" ").trim();
        if (!filename) throw new Error("Usage: /studio " + action + " <relative-file-path>");
        const { readMotionWorkspaceInput } = await import("../motion/assets/motionInput.js");
        const data = await readMotionWorkspaceInput(workspace, filename, action === "import-image" ? 1024 * 1024 : 2 * 1024 * 1024);
        const result = action === "import-image"
          ? await (await import("../motion/assets/motionAssets.js")).importMotionAsset(workspace, data)
          : await (await import("../motion/assets/motionAudio.js")).importMotionAudio(workspace, data);
        emit(ctx, "Imported " + action + ": " + result.id + " (" + result.bytes + " bytes)");
        return;
      }
      if (action === "edit-json") {
        if (!id || !third || !fourth) throw new Error("Usage: /studio edit-json <project-id> <base-revision> <json-array>");
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
          if (!name) throw new Error("Usage: /studio new <title>");
          const result = await service.createMotionProject(workspace, name);
          emit(ctx, "Created motion project " + result.id + " (revision " + result.revision + ")");
        } else if (action === "list") {
          const result = await service.listMotionProjects(workspace);
          emit(ctx, result.length ? result.map(item => item.id + " (r" + item.revision + ") " + item.name).join("\n") : "No motion projects in current workspace.");
        } else if (action === "inspect") {
          if (!id) throw new Error("Usage: /studio inspect <project-id>");
          const result = await service.getMotionProject(workspace, id);
          emit(ctx, JSON.stringify({ id: result.id, name: result.name, revision: result.revision, composition: result.composition }, null, 2));
        } else if (action === "frame") {
          if (!id) throw new Error("Usage: /studio frame <project-id> <frame>");
          const frame = parseInteger(third, "frame");
          const result = await service.writeMotionPreview(workspace, id, frame);
          emit(ctx, "Motion SVG preview: " + result.path + " (SHA-256 " + result.sha256 + ")");
        } else {
          if (!id || !fourth || !rest.length) throw new Error("Usage: /studio edit <project-id> <base-revision> <layer-id> <text>");
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
        if (!id) throw new Error("Usage: /studio recovery <job-id>");
        emit(ctx, JSON.stringify(await jobs.inspectMotionJob(workspace, id), null, 2));
      } else if (action === "status") {
        if (!id) throw new Error("Usage: /studio status <job-id>");
        const result = await jobs.getMotionJob(workspace, id);
        emit(ctx, JSON.stringify(result, null, 2));
      } else if (action === "cancel") {
        if (!id) throw new Error("Usage: /studio cancel <job-id>");
        const result = await jobs.requestMotionCancellation(workspace, id);
        emit(ctx, result.cancellationRequested ? "Cancellation requested for " + id : "Job already finished: " + id);
      } else if (action === "render") {
        if (!id) throw new Error("Usage: /studio render <project-id> [even-output-width]");
        const width = third === undefined ? undefined : parseInteger(third, "width");
        emit(ctx, "Starting local Motion MP4 render. This terminal command completes when encoding finishes.");
        const job = await jobs.renderMotionJob(workspace, id, { width });
        emit(ctx, "Motion render " + job.id + ": " + job.status + (job.artifact ? "\nOutput: " + job.artifact.path : job.error ? "\nError: " + job.error : ""), job.status !== "completed");
      } else {
        emit(ctx, help, true);
      }
    } catch (error) {
      emit(ctx, "SuperAgent Studio: " + (error instanceof Error ? error.message : String(error)), true);
    }
  },
};

registry.register(motionCommand);
