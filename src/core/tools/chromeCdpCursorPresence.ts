/**
 * Cross-process browser cursor presence. Durable action data is never stored:
 * only latest sanitized viewport position/kind is written to a short-lived
 * private metadata file, bound to a live CDP lease generation.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cdpGatewayRoot, type CdpPublicSession } from "./chromeCdpSessionManager.js";

export type CdpCursorKind = "move" | "click" | "scroll" | "drag" | "type";
export type CdpCursorPresence = Readonly<{
  port: number; targetId: string; actorId: string; generation: string;
  kind: CdpCursorKind; at: number; x?: number; y?: number;
}>;
const types = new Set<CdpCursorKind>(["move", "click", "scroll", "drag", "type"]);
const dir = () => join(cdpGatewayRoot(), "cursor-presence");
const filename = (port: number, targetId: string, actorId: string) =>
  join(dir(), createHash("sha256").update(port + ":" + targetId + ":" + actorId).digest("hex") + ".json");
const validId = (id: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,95}$/.test(id);
const validCoord = (coord: unknown): coord is number =>
  typeof coord === "number" && Number.isFinite(coord) && Math.abs(coord) <= 100000;
const valid = (event: CdpCursorPresence): boolean =>
  Number.isInteger(event.port) && event.port >= 1024 && event.port <= 65535 &&
  typeof event.targetId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event.targetId) &&
  validId(event.actorId) && typeof event.generation === "string" &&
  /^[0-9a-f-]{36}$/i.test(event.generation) && types.has(event.kind) &&
  Number.isSafeInteger(event.at) && event.at >= 0 &&
  (event.x === undefined || validCoord(event.x)) &&
  (event.y === undefined || validCoord(event.y));

export async function publishCdpCursorPresence(event: CdpCursorPresence): Promise<void> {
  if (!valid(event)) throw new Error("Invalid cursor presence metadata.");
  await mkdir(dir(), { recursive:true, mode:0o700 });
  const path=filename(event.port,event.targetId,event.actorId);
  const temp=path+"."+randomUUID()+".tmp";
  const data={ port:event.port,targetId:event.targetId,actorId:event.actorId,
    generation:event.generation,kind:event.kind,at:event.at,
    ...(event.x !== undefined && event.y !== undefined ? {x:event.x,y:event.y} : {}) };
  try {
    await writeFile(temp,JSON.stringify(data),{flag:"wx",mode:0o600});
    await rename(temp,path);
  } finally { await rm(temp,{force:true}).catch(()=>{}); }
}

export async function readCdpCursorPresence(sessions: CdpPublicSession[], now=Date.now()):
  Promise<CdpCursorPresence[]> {
  const found:CdpCursorPresence[]=[];
  for (const session of sessions.slice(0,128)) {
    for (const actor of session.participants.slice(0,24)) {
      let record: CdpCursorPresence;
      try {
        const raw=await readFile(filename(session.port,session.targetId,actor.agentId),"utf8");
        if (raw.length > 1024) continue;
        record=JSON.parse(raw);
      } catch (error:any) {
        if (error?.code === "ENOENT") continue;
        // Another process can replace a file while it is being read.
        throw new Error("Cursor presence metadata unavailable or invalid.");
      }
      if (!record || !valid(record) || record.port!==session.port ||
          record.targetId!==session.targetId || record.actorId!==actor.agentId ||
          record.generation!==session.generation || record.at > now+10000 ||
          record.at < now-30000) continue;
      found.push({port:record.port,targetId:record.targetId,actorId:record.actorId,
        generation:record.generation,kind:record.kind,at:record.at,
        ...(record.x!==undefined && record.y!==undefined ? {x:record.x,y:record.y} : {})});
    }
  }
  return found;
}
export async function removeCdpCursorPresence(port:number,targetId:string,actorId:string):Promise<void> {
  if (!Number.isInteger(port) || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId) ||
      !validId(actorId)) throw new Error("Invalid cursor cleanup target.");
  await rm(filename(port,targetId,actorId),{force:true});
}
