import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createMotionProject, getMotionProject, listMotionProjects, updateMotionProject } from "./motionService.js";
import { getMotionJob, getMotionSchedulerStatus, inspectMotionJob, listMotionJobs, motionJobDir, requestMotionCancellation, startDetachedMotionJob } from "./jobs/motionJobs.js";
import { MotionRevisionConflict } from "./project/revisions.js";
import { MotionValidationError } from "./schema/validation.js";
import type { MotionEdit } from "./schema/types.js";
import { MOTION_CAPABILITIES } from "./motionCapabilities.js";
import { importMotionAsset, readMotionAsset } from "./assets/motionAssets.js";
import { importMotionAudio, readMotionAudio } from "./assets/motionAudio.js";
import { decodeMotionMediaBase64 } from "./assets/motionInput.js";
import { summarizeMotionWav } from "./assets/motionWaveform.js";

export interface MotionHttpContext {
  resolveWorkspacePath: (req: IncomingMessage) => string | null;
  sendJSON: (res: ServerResponse, status: number, data: unknown) => void;
}

function json(res: ServerResponse, context: MotionHttpContext, code: number, value: unknown): void {
  context.sendJSON(res, code, value);
}
async function readMotionJson(req: IncomingMessage, maxSize = 1_000_000): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > maxSize) throw Object.assign(new Error("Motion request body too large"), { statusCode: 413 });
    parts.push(buffer);
  }
  const input: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected a JSON object");
  return input as Record<string, unknown>;
}
function routeError(error: unknown): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { statusCode?: number })?.statusCode;
  if (status === 413) return { status: 413, message };
  if (error instanceof MotionRevisionConflict) return { status: 409, message };
  if (error instanceof MotionValidationError || error instanceof RangeError || error instanceof SyntaxError) return { status: 400, message };
  if (/locked|already has an active|unreconciled render/.test(message)) return { status: 409, message };
  if (/ENOENT|not found/i.test(message)) return { status: 404, message: "Motion resource not found" };
  if (/Invalid Motion|invalid|unsupported|must be|requires|expected|outside|workspace|local only/i.test(message)) {
    return { status: 400, message };
  }
  return { status: 500, message: "Motion request failed" };
}

/** The global /api auth gate and workspace allowlist run before this handler. */
export async function handleMotionHttpRoute(
  req: IncomingMessage, res: ServerResponse, pathname: string, _url: URL, ctx: MotionHttpContext,
): Promise<boolean> {
  if (!(pathname === "/api/motion" || pathname.startsWith("/api/motion/"))) return false;
  const workspace = ctx.resolveWorkspacePath(req);
  if (!workspace || /^(ssh|chain):/i.test(workspace)) {
    json(res, ctx, 403, { error: "Motion Studio requires an authorized local workspace" });
    return true;
  }
  const method = req.method ?? "GET";
  const project = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})$/);
  const edits = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/edits$/);
  const render = pathname.match(/^\/api\/motion\/projects\/(motion-[a-f0-9]{20})\/render$/);
  const job = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})$/);
  const cancel = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})\/cancel$/);
  const recovery = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})\/recovery$/);
  const artifact = pathname.match(/^\/api\/motion\/jobs\/(motionjob-[a-f0-9]{24})\/artifact$/);
  const asset = pathname.match(/^\/api\/motion\/assets\/(asset-[a-f0-9]{64})$/);
  const audio = pathname.match(/^\/api\/motion\/audio\/(audio-[a-f0-9]{64})$/);
  const waveform = pathname.match(/^\/api\/motion\/audio\/(audio-[a-f0-9]{64})\/waveform$/);
  try {
    if (pathname === "/api/motion" && method === "GET") {
      json(res, ctx, 200, { apiVersion: 1, video: "h264-mp4", detachedJobs: true, studio: false, capabilities: MOTION_CAPABILITIES });
    } else if (pathname === "/api/motion/assets" && method === "POST") {
      const body = await readMotionJson(req, 1_600_000);
      json(res, ctx, 201, await importMotionAsset(workspace, decodeMotionMediaBase64(body.base64, 1024 * 1024)));
    } else if (asset && (method === "GET" || method === "HEAD")) {
      const bytes = await readMotionAsset(workspace, asset[1]);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "ETag": '"' + asset[1].slice(6) + '"',
      });
      res.end(method === "HEAD" ? undefined : bytes);
    } else if (pathname === "/api/motion/audio" && method === "POST") {
      const body = await readMotionJson(req, 3_000_000);
      json(res, ctx, 201, await importMotionAudio(workspace, decodeMotionMediaBase64(body.base64, 2 * 1024 * 1024)));
    } else if (waveform && method === "GET") {
      json(res, ctx, 200, summarizeMotionWav(await readMotionAudio(workspace, waveform[1])));
    } else if (audio && (method === "GET" || method === "HEAD")) {
      const bytes = await readMotionAudio(workspace, audio[1]);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "ETag": '"' + audio[1].slice(6) + '"',
      });
      res.end(method === "HEAD" ? undefined : bytes);
    } else if (pathname === "/api/motion/projects" && method === "GET") {
      json(res, ctx, 200, await listMotionProjects(workspace));
    } else if (pathname === "/api/motion/projects" && method === "POST") {
      const body = await readMotionJson(req);
      if (typeof body.name !== "string") throw new Error("name must be a string");
      json(res, ctx, 201, await createMotionProject(workspace, body.name));
    } else if (project && method === "GET") {
      json(res, ctx, 200, await getMotionProject(workspace, project[1]));
    } else if (edits && method === "POST") {
      const body = await readMotionJson(req);
      if (!Number.isSafeInteger(body.baseRevision) || !Array.isArray(body.edits)) throw new Error("baseRevision and edits are required");
      json(res, ctx, 200, await updateMotionProject(workspace, edits[1], body.baseRevision as number, body.edits as MotionEdit[]));
    } else if (render && method === "POST") {
      const body = await readMotionJson(req);
      if (body.width !== undefined && !Number.isSafeInteger(body.width)) throw new Error("width must be an integer");
      const started = await startDetachedMotionJob(workspace, render[1], { width: body.width as number | undefined });
      json(res, ctx, started.status === "failed" ? 503 : 202, started);
    } else if (pathname === "/api/motion/scheduler" && method === "GET") {
      json(res, ctx, 200, await getMotionSchedulerStatus(workspace));
    } else if (pathname === "/api/motion/jobs" && method === "GET") {
      json(res, ctx, 200, await listMotionJobs(workspace));
    } else if (job && method === "GET") {
      json(res, ctx, 200, await getMotionJob(workspace, job[1]));
    } else if (recovery && method === "GET") {
      json(res, ctx, 200, await inspectMotionJob(workspace, recovery[1]));
    } else if (cancel && method === "POST") {
      json(res, ctx, 202, await requestMotionCancellation(workspace, cancel[1]));
    } else if (artifact && (method === "GET" || method === "HEAD")) {
      await streamMotionArtifact(req, res, workspace, artifact[1]);
    } else {
      json(res, ctx, 404, { error: "Motion endpoint not found" });
    }
  } catch (error) {
    if (!res.headersSent) {
      const failure = routeError(error);
      json(res, ctx, failure.status, { error: failure.message });
    } else {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return true;
}

function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function streamMotionArtifact(
  req: IncomingMessage, res: ServerResponse, workspace: string, jobId: string,
): Promise<void> {
  const job = await getMotionJob(workspace, jobId);
  if (job.status !== "completed" || !job.artifact) {
    res.writeHead(404, { "Cache-Control": "no-store" }); res.end(); return;
  }
  const dir = await motionJobDir(workspace, "renders");
  const file = path.join(dir, jobId + ".mp4");
  if (job.artifact.path !== file) throw new Error("Invalid Motion artifact ownership");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.artifact.bytes) {
    throw new Error("Invalid Motion artifact file");
  }
  // Hash the artifact with bounded memory rather than loading an entire video.
  const digest = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const fileHash = digest.digest("hex");
  if (fileHash !== job.artifact.sha256) throw new Error("Invalid Motion artifact checksum");
  const common: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "ETag": '"' + job.artifact.sha256 + '"',
  };
  const rawRange = req.headers.range;
  const range = typeof rawRange === "string" ? parseRange(rawRange, stat.size) : undefined;
  if (rawRange !== undefined && !range) {
    res.writeHead(416, { ...common, "Content-Range": "bytes */" + stat.size });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  const headers = {
    ...common, "Content-Length": String(end - start + 1),
    ...(range ? { "Content-Range": `bytes ${start}-${end}/${stat.size}` } : {}),
  };
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") { res.end(); return; }
  const stream = createReadStream(file, { start, end });
  const disconnect = () => stream.destroy();
  res.on("close", disconnect);
  stream.on("error", error => res.destroy(error));
  stream.on("end", () => res.off("close", disconnect));
  stream.pipe(res);
}
