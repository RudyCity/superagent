import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject, writeMotionPreview } from "../motion/motionService.js";
import { MotionRevisionConflict } from "../motion/project/revisions.js";
import { MotionValidationError } from "../motion/schema/validation.js";

const usage = `Motion Studio (foundation preview)
  superagent motion new --name "Title" [--workspace PATH] [--json]
  superagent motion list [--workspace PATH] [--json]
  superagent motion inspect PROJECT_ID [--workspace PATH] [--json]
  superagent motion edit PROJECT_ID --base-revision N --layer LAYER_ID --text "Title"
  superagent motion frame PROJECT_ID --frame N [--workspace PATH] [--json]
  superagent motion doctor [--json]

Exports isolated declarative SVG frames. Video/MP4 export and T-Line editor are not implemented yet.`;

function argumentsOf(args: string[]): { action: string; positionals: string[]; opts: Map<string, string | true> } {
  const opts = new Map<string, string | true>();
  const positionals: string[] = [];
  const boolean = new Set(["--json", "--help", "-h"]);
  const valid = new Set(["--workspace", "-w", "--name", "--base-revision", "--layer", "--text", "--frame", ...boolean]);
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
      emit({ stage: "foundation", localSchema: true, deterministicSvg: true, mp4: false, desktopEditor: false, renderJobs: false }, json);
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
    if (positionals.length !== 1) throw new Error(action + " requires exactly one PROJECT_ID");
    const projectId = positionals[0];
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
      if (!layerId || newText === undefined) throw new Error("edit requires --layer and --text");
      const result = await updateMotionProject(workspace, projectId, baseRevision, [{ type: "set-text", layerId, text: newText }]);
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
