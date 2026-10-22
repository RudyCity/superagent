/**
 * Task-scoped, one-time-issued capability credentials for remotely operating
 * a logical Brain agent. Owner OAuth authenticates the tenant; this separate
 * capability proves authorization to act as one member of one specific task.
 * Operator-owned CLI/T-Line do not consume these MCP-only bearer capabilities.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectBrainSession } from "./brainWorkspace.js";
import { inspectBrainTask } from "./brainTasks.js";
import { assertNoSymlink } from "./brainStorageManager.js";
import { withBrainSessionLock } from "./brainSessionLock.js";

const TASK = /^task_[a-f0-9]{20}$/;
type CredentialRecord = { schemaVersion: 1; agentHashes: Record<string,string>; createdAt: string };
function location(owner: string, sessionId: string, taskId: string) {
  if (!TASK.test(taskId)) throw new Error("Invalid Brain task.");
  const dir = inspectBrainSession(owner, sessionId).path;
  const filename = path.join(dir, ".tasks", taskId + ".capabilities.json");
  assertNoSymlink(dir, filename);
  return { dir, filename };
}
export function issueBrainTaskAgentCredentials(owner: string, sessionId: string, taskId: string) {
  const { dir, filename } = location(owner, sessionId, taskId);
  return withBrainSessionLock(dir, () => {
    const task = inspectBrainTask(owner, sessionId, taskId);
    const credentials:Record<string,string> = {};
    const hashes:Record<string,string> = {};
    for (const agent of task.agents) {
      const credential = "bag_" + crypto.randomBytes(32).toString("hex");
      credentials[agent] = credential;
      hashes[agent] = crypto.createHash("sha256").update(credential).digest("hex");
    }
    const data:CredentialRecord = { schemaVersion:1, agentHashes:hashes, createdAt:new Date().toISOString() };
    // No overwrite: issue once to the authenticated creator, never read secrets back.
    fs.writeFileSync(filename, JSON.stringify(data), { flag: "wx", mode:0o600 });
    return credentials;
  });
}
export function authorizeBrainTaskAgent(owner:string,sessionId:string,taskId:string,agentId:string,credential:unknown) {
  if(typeof agentId!=="string"||typeof credential!=="string"||!/^bag_[a-f0-9]{64}$/.test(credential)) {
    throw new Error("Brain task agent capability is required.");
  }
  const { filename } = location(owner,sessionId,taskId);
  if(!fs.existsSync(filename)) throw new Error("Brain task has no MCP agent capabilities; use local operator controls.");
  const stat=fs.lstatSync(filename);
  if(!stat.isFile()||stat.nlink!==1||stat.size>8192)throw new Error("Invalid Brain capability store.");
  const entry=JSON.parse(fs.readFileSync(filename,"utf8")) as CredentialRecord;
  if(entry.schemaVersion!==1||!entry.agentHashes || typeof entry.agentHashes!=="object")throw new Error("Invalid Brain capability records.");
  const expected=entry.agentHashes[agentId];
  if(typeof expected!=="string" || !/^[a-f0-9]{64}$/.test(expected))throw new Error("Brain task agent is not authorized.");
  const actual=crypto.createHash("sha256").update(credential).digest("hex");
  if(!crypto.timingSafeEqual(Buffer.from(actual,"hex"),Buffer.from(expected,"hex"))) {
    throw new Error("Brain task agent capability mismatch.");
  }
  return true;
}
