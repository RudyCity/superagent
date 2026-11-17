/**
 * Project-scoped archive inventory for the authenticated local Tray operator.
 * The path is explicitly selected by a human; never scan the SuperAgent tree,
 * follow symlinks, or serve video over HTTP/tunnels.
 */
import { lstat, realpath, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve } from "node:path";
import { getPackageRootDir, getRootConfigDir } from "../config/paths.js";
import { inspectCdpSessionArchiveDirectory, stopCdpSessionArchiveByOperator } from "./chromeCdpSessionArchive.js";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FILES = new Set(["video.mp4", "actions.json", "transcript.jsonl", "console.jsonl",
  "errors.jsonl", "network.jsonl", "diagnostics.jsonl", "manifest.json", "README.txt"]);

function inside(base: string, path: string): boolean {
  const diff=relative(base,path);
  return diff === "" || (diff !== ".." && !diff.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && !isAbsolute(diff));
}

async function recordingRoot(projectDirectory: string) {
  if (typeof projectDirectory !== "string" || projectDirectory.length > 1024 ||
      !isAbsolute(projectDirectory)) throw Error("Select one existing absolute project folder.");
  const project=await realpath(resolve(projectDirectory));
  if (project === parse(project).root) throw Error("Root directories are not project workspaces.");
  for (const unsafe of [getPackageRootDir(),getRootConfigDir()]) {
    const canonical=await realpath(unsafe).catch(()=>resolve(unsafe));
    if (inside(canonical,project))
      throw Error("Recording archives cannot be managed inside SuperAgent directories.");
  }
  const folders=[join(project,".superagent"),join(project,".superagent","recordings"),
    join(project,".superagent","recordings","cdp")];
  for (const folder of folders) {
    let info;
    try { info=await lstat(folder); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { root:folders[2], exists:false };
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw Error("Unsafe archive folder.");
  }
  return { root:folders[2], exists:true };
}
function recordingDirectory(root: string, recordingId: string): string {
  if (!ID.test(recordingId)) throw Error("Recording ID must be a UUID.");
  return join(root,recordingId);
}
async function safeDirectory(root: string, recordingId: string) {
  const directory=recordingDirectory(root,recordingId);
  const info=await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw Error("Unsafe recording directory.");
  return directory;
}
async function manifestOf(directory: string): Promise<Record<string,unknown> | null> {
  try {
    const file=join(directory,"manifest.json");
    const info=await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size>32_768)
      throw Error("Unsafe recording manifest.");
    const data: unknown=JSON.parse(await readFile(file,"utf8"));
    if (!data || typeof data!=="object" || Array.isArray(data)) return null;
    return data as Record<string,unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function smallNumber(value: unknown) {
  return typeof value==="number" && Number.isFinite(value) && value>=0 && value<=Number.MAX_SAFE_INTEGER
    ? value : 0;
}
export async function listProjectCdpRecordings(projectDirectory: string) {
  const {root,exists}=await recordingRoot(projectDirectory);
  if (!exists) return {recordings:[]};
  const entries=await readdir(root,{withFileTypes:true});
  const recordings=[];
  for (const entry of entries.slice(0,1000)) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    try {
      const directory=await safeDirectory(root,entry.name);
      const manifest=await manifestOf(directory);
      const live=inspectCdpSessionArchiveDirectory(directory);
      const startedAt=typeof manifest?.startedAt==="string" &&
        !Number.isNaN(Date.parse(manifest.startedAt)) ? manifest.startedAt :
        live?.startedAt || null;
      const status=live?.status === "recording" || live?.status === "stopping"
        ? live.status : ["saved","failed"].includes(String(manifest?.status))
          ? String(manifest?.status) : "interrupted";
      const source=["managed-cdp-exact-tab","delegate-cdp-exact-tab"].includes(String(manifest?.source))
        ? manifest?.source : "unknown";
      const video=join(directory,"video.mp4");
      let videoBytes=0;
      try {
        const info=await lstat(video);
        if (!info.isSymbolicLink() && info.isFile()) videoBytes=info.size;
      } catch {}
      recordings.push({
        recordingId:entry.name, status, source, startedAt, videoBytes,
        frameCount:live?.frameCount ?? smallNumber(manifest?.frameCount),
        droppedFrames:live?.droppedFrames ?? smallNumber(manifest?.droppedFrames),
        elapsedMs:live?.elapsedMs ?? smallNumber(manifest?.elapsedMs),
        hasVideo:status==="saved" && videoBytes>=256 && videoBytes<=160_000_000,
        hasManifest:manifest!==null,
      });
    } catch {
      // A corrupt or symlinked child never authorizes following it.
    }
  }
  recordings.sort((a,b)=>String(b.startedAt||"").localeCompare(String(a.startedAt||"")));
  return {recordings};
}
export async function locateProjectCdpRecording(
  projectDirectory: string, recordingId: string, kind: "video" | "folder",
) {
  const {root,exists}=await recordingRoot(projectDirectory);
  if (!exists) throw Error("Project contains no CDP recordings.");
  const directory=await safeDirectory(root,recordingId);
  if (kind==="folder") return {path:directory};
  const manifest=await manifestOf(directory);
  if (manifest?.status!=="saved" ||
      inspectCdpSessionArchiveDirectory(directory)?.status==="recording")
    throw Error("Only finalized recordings can be played.");
  const video=join(directory,"video.mp4");
  const info=await lstat(video);
  if (info.isSymbolicLink() || !info.isFile() || info.size<256 || info.size>160_000_000)
    throw Error("Video is missing or invalid.");
  const canonical=await realpath(video);
  if (!inside(directory,canonical)) throw Error("Unsafe video path.");
  return {path:canonical};
}
export async function stopProjectCdpRecording(projectDirectory: string, recordingId: string) {
  const {root,exists}=await recordingRoot(projectDirectory);
  if (!exists) throw Error("Recording unavailable.");
  const directory=await safeDirectory(root,recordingId);
  const live=inspectCdpSessionArchiveDirectory(directory);
  if (!live || !["recording","stopping"].includes(live.status))
    throw Error("Recording is no longer active.");
  return stopCdpSessionArchiveByOperator(directory);
}
export async function deleteProjectCdpRecording(
  projectDirectory: string, recordingId: string, confirmDelete: boolean,
) {
  if (confirmDelete!==true) throw Error("Explicit local operator approval required.");
  const {root,exists}=await recordingRoot(projectDirectory);
  if (!exists) throw Error("Recording unavailable.");
  const directory=await safeDirectory(root,recordingId);
  const active=inspectCdpSessionArchiveDirectory(directory);
  if (active && ["recording","stopping"].includes(active.status))
    throw Error("Stop and finalize an active recording before deleting it.");
  for (const child of await readdir(directory,{withFileTypes:true})) {
    if (!FILES.has(child.name) || child.isSymbolicLink() || !child.isFile())
      throw Error("Recording directory contains unmanaged content; delete denied.");
  }
  await rm(directory,{recursive:true,force:false,maxRetries:0});
  return {deleted:true,recordingId};
}
