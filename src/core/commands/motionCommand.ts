import type { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";

const help = [
  "Motion Studio (MP4 preview foundation)",
  "  /motion new <title>",
  "  /motion list",
  "  /motion inspect <project-id>",
  "  /motion edit <project-id> <base-revision> <layer-id> <text>",
  "  /motion frame <project-id> <frame>",
  "  /motion render <project-id> [even-output-width]",
  "  /motion jobs",
  "  /motion status <job-id>",
  "  /motion recovery <job-id> (read-only)",
  "  /motion cancel <job-id>",
  "  /motion doctor",
  "Renders currently run in this terminal process; job records persist for inspection.",
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
      if (action === "doctor") {
        const { probeFfmpeg } = await import("../motion/render/ffmpegEncoder.js");
        const available = await probeFfmpeg();
        emit(ctx, "Motion Studio: " + (available ? "FFmpeg available; MP4 previews enabled" : "FFmpeg unavailable; SVG previews only"));
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
