import { runMemoryRetentionSweep } from "../memoryRetentionSweep.js";

export async function handleMemorySweepCliCommand(args: string[]): Promise<number> {
  const subcommand = args[0]?.toLowerCase();
  if (subcommand !== "sweep") {
    console.error("Usage: superagent memory sweep [--apply] [--workspace <path>] [--limit <n>]");
    return 2;
  }
  const apply = args.includes("--apply");
  const workspaceIndex = args.findIndex((arg) => arg === "--workspace" || arg === "-w");
  const projectPath = workspaceIndex >= 0 && args[workspaceIndex + 1]
    ? args[workspaceIndex + 1]
    : process.cwd();
  const limitIndex = args.indexOf("--limit");
  const parsedLimit = limitIndex >= 0 && args[limitIndex + 1] ? Number(args[limitIndex + 1]) : undefined;
  if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500)) {
    console.error("--limit must be an integer from 1 to 500.");
    return 2;
  }
  try {
    const result = await runMemoryRetentionSweep({
      projectPath,
      apply,
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return (result.failed ?? 0) > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Memory retention sweep failed: " + message);
    return 1;
  }
}
