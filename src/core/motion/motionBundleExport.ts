import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getMotionProject, studioStorageRoot } from "./project/projectStore.js";
import { listMotionJobs, getMotionJob } from "./jobs/motionJobs.js";
import { convertMotionJobArtifact } from "./motionExportFormats.js";
import { motionSceneSrt } from "./director/motionCaptions.js";
import { emitMotionStudioEvent } from "./motionEvents.js";
import type { MotionProject } from "./schema/types.js";

export interface BundleFileEntry {
  fileName: string;
  path: string;
  bytes: number;
  sha256: string;
  mimeType: string;
}

export interface MotionDeliverablesBundleManifest {
  bundleVersion: 1;
  projectId: string;
  projectName: string;
  jobId: string;
  createdAt: string;
  bundleDir: string;
  composition: {
    width: number;
    height: number;
    aspectRatio: string;
    fps: number;
    durationFrames: number;
    durationSeconds: number;
    layersCount: number;
  };
  files: {
    mp4: BundleFileEntry;
    webm: BundleFileEntry;
    gif: BundleFileEntry;
    srt: BundleFileEntry;
  };
}

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export async function exportMotionDeliverablesBundle(
  workspace: string,
  projectId: string,
): Promise<MotionDeliverablesBundleManifest> {
  const project = await getMotionProject(workspace, projectId);
  const jobs = await listMotionJobs(workspace);
  const completedJobs = jobs.filter(j => j.projectId === project.id && j.status === "completed" && j.artifact);
  if (!completedJobs.length) {
    throw new Error("Deliverables bundle requires a completed render job for project " + projectId);
  }
  const job = completedJobs[0];

  // Read MP4 artifact
  const mp4Bytes = await fs.readFile(job.artifact!.path);
  const mp4Sha = sha256(mp4Bytes);

  // Convert WebM & GIF sequentially to honor the single transcode lock per job
  const webmBytes = await convertMotionJobArtifact(workspace, job.id, "webm");
  const gifBytes = await convertMotionJobArtifact(workspace, job.id, "gif");

  // Generate SRT captions
  const srtContent = motionSceneSrt(project);
  const srtBytes = Buffer.from(srtContent, "utf8");

  // Prepare bundle directory
  const root = await studioStorageRoot(workspace, true);
  const bundleDir = path.join(root, "bundles", project.id);
  await fs.mkdir(bundleDir, { recursive: true });

  // Write all files
  const mp4Path = path.join(bundleDir, "video.mp4");
  const webmPath = path.join(bundleDir, "video.webm");
  const gifPath = path.join(bundleDir, "preview.gif");
  const srtPath = path.join(bundleDir, "captions.srt");

  await Promise.all([
    fs.writeFile(mp4Path, mp4Bytes),
    fs.writeFile(webmPath, webmBytes),
    fs.writeFile(gifPath, gifBytes),
    fs.writeFile(srtPath, srtBytes),
  ]);

  const c = project.composition;
  const fps = c.fps.numerator / c.fps.denominator;
  const durationSeconds = Number((c.durationFrames / fps).toFixed(2));
  const aspectRatio = c.width === c.height ? "1:1" : c.height > c.width ? "9:16" : "16:9";

  const manifest: MotionDeliverablesBundleManifest = {
    bundleVersion: 1,
    projectId: project.id,
    projectName: project.name,
    jobId: job.id,
    createdAt: new Date().toISOString(),
    bundleDir,
    composition: {
      width: c.width,
      height: c.height,
      aspectRatio,
      fps,
      durationFrames: c.durationFrames,
      durationSeconds,
      layersCount: c.layers.length,
    },
    files: {
      mp4: {
        fileName: "video.mp4",
        path: mp4Path,
        bytes: mp4Bytes.length,
        sha256: mp4Sha,
        mimeType: "video/mp4",
      },
      webm: {
        fileName: "video.webm",
        path: webmPath,
        bytes: webmBytes.length,
        sha256: sha256(webmBytes),
        mimeType: "video/webm",
      },
      gif: {
        fileName: "preview.gif",
        path: gifPath,
        bytes: gifBytes.length,
        sha256: sha256(gifBytes),
        mimeType: "image/gif",
      },
      srt: {
        fileName: "captions.srt",
        path: srtPath,
        bytes: srtBytes.length,
        sha256: sha256(srtBytes),
        mimeType: "application/x-subrip",
      },
    },
  };

  const manifestPath = path.join(bundleDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  emitMotionStudioEvent({
    type: "job.completed",
    workspace,
    projectId: project.id,
    jobId: job.id,
    artifactUrl: mp4Path,
  });

  return manifest;
}

export async function getMotionDeliverablesBundleManifest(
  workspace: string,
  projectId: string,
): Promise<MotionDeliverablesBundleManifest | null> {
  const root = await studioStorageRoot(workspace, false);
  const manifestPath = path.join(root, "bundles", projectId, "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as MotionDeliverablesBundleManifest;
  } catch {
    return null;
  }
}
