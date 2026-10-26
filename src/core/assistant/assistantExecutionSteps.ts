/** Durable, scope-bound observation of detached-agent tool steps.
 * This is NOT an executable checkpoint: no prompt, input, result, token,
 * raw tool-call identifier, or execution capability is serialized.
 * A missing matching end or any external observation is never replay-safe.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import type { AssistantTaskRecord } from "./assistantTaskStore.js";
import { getAssistantTaskDomain } from "./assistantTaskDomains.js";

export type StepEffect = "local_read" | "external_unverified" | "unknown";
export type StepPhase = "started" | "prepared" | "finished";
export type StepOutcome = "completed" | "failed" | "unverified";
export interface AssistantExecutionStep {
  seq: number; at: number; callRef: string; tool: string;
  phase: StepPhase; effect: StepEffect; outcome?: StepOutcome;
}
type Ledger = { schemaVersion: 1; taskId: string; nextSeq: number; events: AssistantExecutionStep[] };
const MAX_STEPS = 256;
const MAX_FILE_BYTES = 128 * 1024;
const CALL_REF = /^[0-9a-f]{24}$/;
const LOCAL_READS = new Set(["read", "glob", "grep", "ripgrep_search", "read_document", "git_status", "git_diff"]);
const EXTERNAL_READS = new Set(["web_search", "fetch_url"]);
const toolKey = (task: AssistantTaskRecord) =>
  createHash("sha256").update(task.ownerId + "\0" + task.workspaceId + "\0" + task.taskId).digest("hex");

function filename(task: AssistantTaskRecord, root: string) {
  return path.join(root, "assistant-execution-steps", toolKey(task) + ".json");
}
function validate(ledger: Ledger, task: AssistantTaskRecord) {
  const allowedLedgerKeys = new Set(["schemaVersion","taskId","nextSeq","events"]);
  const allowedEventKeys = new Set(["seq","at","callRef","tool","phase","effect","outcome"]);
  if (!ledger || typeof ledger !== "object" ||
      Object.keys(ledger).some(key => !allowedLedgerKeys.has(key)) ||
      ledger.schemaVersion !== 1 || ledger.taskId !== task.taskId ||
      !Number.isSafeInteger(ledger.nextSeq) || ledger.nextSeq < 1 ||
      !Array.isArray(ledger.events) || ledger.events.length > MAX_STEPS) {
    throw new Error("Execution step journal corrupted");
  }
  let prior = 0;
  const allowed = new Set(getAssistantTaskDomain(task.domain).toolNames);
  const lifecycle = new Map<string, AssistantExecutionStep>();
  for (const event of ledger.events) {
    if (!event || typeof event !== "object" ||
        Object.keys(event).some(key => !allowedEventKeys.has(key)) ||
        !Number.isSafeInteger(event.seq) || event.seq !== prior + 1 ||
        !Number.isSafeInteger(event.at) || event.at < 0 ||
        !CALL_REF.test(event.callRef) ||
        !(event.tool === "other" || allowed.has(event.tool)) ||
        !["started","prepared","finished"].includes(event.phase) ||
        !["local_read","external_unverified","unknown"].includes(event.effect) ||
        (event.outcome !== undefined && !["completed","failed","unverified"].includes(event.outcome)) ||
        (event.phase !== "finished" && event.outcome !== undefined) ||
        (event.phase === "finished" && event.outcome === undefined)) {
      throw new Error("Execution step journal event invalid");
    }
    const earlier = lifecycle.get(event.callRef);
    if ((event.phase === "started" && earlier) ||
        (event.phase === "prepared" && (earlier?.phase !== "started" ||
          earlier.tool !== event.tool || earlier.effect !== event.effect ||
          event.effect === "unknown")) ||
        (event.phase === "finished" && (!earlier ||
          !["started","prepared"].includes(earlier.phase) ||
          earlier.tool !== event.tool || earlier.effect !== event.effect))) {
      throw new Error("Execution step journal lifecycle mismatch");
    }
    lifecycle.set(event.callRef,event);
    prior = event.seq;
  }
  if (ledger.nextSeq !== prior + 1) throw new Error("Execution step journal sequence corrupt");
}
async function load(task: AssistantTaskRecord, root: string): Promise<Ledger> {
  const file = filename(task, root);
  let content: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
      throw new Error("Execution step journal unsafe");
    content = await fs.readFile(file, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return {schemaVersion:1,taskId:task.taskId,nextSeq:1,events:[]};
    throw error;
  }
  const ledger = JSON.parse(content) as Ledger;
  validate(ledger, task);
  return ledger;
}
async function update(task: AssistantTaskRecord, root: string,
  mutate: (ledger: Ledger) => void) {
  const file = filename(task, root);
  await fs.mkdir(path.dirname(file), {recursive:true,mode:0o700});
  const lockfile = file + ".lock";
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt=0;attempt<16;attempt++) {
    try { lock = await fs.open(lockfile,"wx",0o600); break; }
    catch (error:any) {
      if (error?.code !== "EEXIST" && !(process.platform === "win32" &&
          (error?.code === "EPERM" || error?.code === "EACCES"))) throw error;
      if (attempt === 15) throw Error("Execution checkpoint busy; manual review required");
      await new Promise(resolve=>setTimeout(resolve,10+attempt*3));
    }
  }
  if (!lock) throw Error("Execution checkpoint writer unavailable");
  try {
    const ledger = await load(task,root);
    mutate(ledger);
    validate(ledger,task);
    const serialized=JSON.stringify(ledger);
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw Error("Execution step journal full");
    const tmp=file+"."+randomUUID()+".tmp";
    try {
      const output=await fs.open(tmp,"wx",0o600);
      try {
        await output.writeFile(serialized);
        await output.sync();
      } finally {await output.close();}
      await fs.rename(tmp,file);
    } finally {await fs.rm(tmp,{force:true}).catch(()=>{});}
  } finally {
    await lock.close();
    await fs.rm(lockfile,{force:true}).catch(()=>{});
  }
}

export function executionCallRef(task: AssistantTaskRecord, rawCallId: string): string {
  if (!rawCallId || rawCallId.length > 512) throw Error("Invalid tool correlation ID");
  return createHash("sha256").update(toolKey(task)+"\0"+rawCallId).digest("hex").slice(0,24);
}
function effectOf(task: AssistantTaskRecord, tool: string): {tool:string;effect:StepEffect} {
  const permitted=new Set(getAssistantTaskDomain(task.domain).toolNames);
  if (!permitted.has(tool)) return {tool:"other",effect:"unknown"};
  return {tool,effect:LOCAL_READS.has(tool)?"local_read":
    EXTERNAL_READS.has(tool)?"external_unverified":"unknown"};
}
export async function recordExecutionStep(
  task: AssistantTaskRecord, step: {
    callId: string; tool: string; phase: StepPhase; isError?: boolean;
  }, root=getRootConfigDir(),
): Promise<AssistantExecutionStep> {
  const callRef=executionCallRef(task,step.callId);
  const {tool,effect}=effectOf(task,step.tool);
  let written!:AssistantExecutionStep;
  await update(task,root,ledger=>{
    if (ledger.events.length >= MAX_STEPS) throw Error("Execution step limit; manual review required");
    const last=ledger.events.filter(x=>x.callRef===callRef).at(-1);
    if (step.phase==="started" && last)
      throw Error("Duplicate tool call observation");
    if (step.phase==="prepared" &&
        (last?.phase !== "started" || last.tool !== tool || effect === "unknown"))
      throw Error("Pre-execution checkpoint missing or unapproved tool");
    if (step.phase==="finished" &&
        (!last || !["started","prepared"].includes(last.phase) || last.tool !== tool))
      throw Error("Unmatched tool completion; manual review required");
    written={seq:ledger.nextSeq++,at:Date.now(),callRef,tool,phase:step.phase,effect,
      ...(step.phase==="finished" ? {outcome:step.isError?"failed":
        effect==="local_read"?"completed":"unverified"} : {})};
    ledger.events.push(written);
  });
  return written;
}
export async function readExecutionCheckpoint(task: AssistantTaskRecord,
  root=getRootConfigDir()): Promise<{
    schemaVersion:1; taskId:string; steps:AssistantExecutionStep[];
    incomplete:number; externalUnverified:number; preparedCount:number;
    unpreparedCount:number; missingHistory:boolean; manualReviewRequired:boolean;
    executionResumptionSupported:false;
  }> {
  const ledger=await load(task,root);
  const unfinished=new Set<string>();
  const latest=new Map<string,StepPhase>();
  let externalUnverified=0;
  let unpreparedCount=0;
  for(const event of ledger.events) {
    const previous=latest.get(event.callRef);
    if(event.phase!=="finished") unfinished.add(event.callRef);
    else {
      unfinished.delete(event.callRef);
      if(previous!=="prepared") unpreparedCount++;
      if(event.outcome==="unverified") externalUnverified++;
    }
    latest.set(event.callRef,event.phase);
  }
  // Missing observations never certify previously active work.
  const missingHistory=ledger.events.length===0 &&
    (["planning","awaiting_approval","running","failed","interrupted",
      "reconcile_required"].includes(task.status) ||
      (task.status==="cancelled" && task.revision>2));
  const incomplete=unfinished.size;
  const preparedCount=ledger.events.filter(x=>x.phase==="prepared").length;
  return {schemaVersion:1,taskId:task.taskId,steps:ledger.events,
    incomplete,externalUnverified,preparedCount,unpreparedCount,missingHistory,
    manualReviewRequired:missingHistory || unpreparedCount>0 ||
      incomplete>0 || externalUnverified>0 ||
      ledger.events.some(x=>x.effect==="unknown" || x.outcome==="failed"),
    executionResumptionSupported:false};
}
