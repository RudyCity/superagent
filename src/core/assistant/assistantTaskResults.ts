/** Result artifacts are separate from the status journal; never include tool
 * output, API tokens, prompts or private results in GET /list or event streams.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import type { AssistantTaskRecord } from "./assistantTaskStore.js";

function filename(task: AssistantTaskRecord) {
  const id = createHash("sha256")
    .update(task.ownerId + "\0" + task.workspaceId + "\0" + task.taskId).digest("hex");
  return path.join(getRootConfigDir(), "assistant-task-results", id + ".txt");
}
export async function saveDetachedTaskResult(task: AssistantTaskRecord, result: string) {
  if (typeof result !== "string" || Buffer.byteLength(result, "utf8") > 65_536) {
    throw new Error("Invalid detached task result");
  }
  const file = filename(task);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const pending = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(pending, result, { flag: "wx", mode: 0o600 });
    await fs.rename(pending, file);
  } finally { await fs.rm(pending, { force: true }).catch(() => {}); }
}
export async function readDetachedTaskResult(task: AssistantTaskRecord): Promise<string | null> {
  if (task.status !== "completed") return null;
  const file = filename(task);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw Error("Result unavailable");
    return await fs.readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
