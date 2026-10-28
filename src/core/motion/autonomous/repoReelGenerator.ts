import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { generateMotionFromPrompt, type MotionDirectorResult } from "../director/directorService.js";
import type { MotionArtDirection } from "../director/creativePresets.js";

export interface RepoReelOptions {
  style?: MotionArtDirection;
  palette?: string;
  width?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  wait?: boolean;
}

export interface ReleasePromoOptions extends RepoReelOptions {
  version?: string;
}

/**
 * Parses package.json and README.md from the workspace to extract authentic project metadata.
 */
export async function inspectWorkspaceRepository(workspace: string): Promise<{
  name: string;
  version: string;
  description: string;
  features: string[];
  recentCommits: string[];
}> {
  let name = "Superagent";
  let version = "1.0.0";
  let description = "Autonomous AI Agent Engine";
  const features: string[] = [];
  const recentCommits: string[] = [];

  // 1. package.json
  try {
    const pkgPath = path.join(workspace, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw) as { name?: string; version?: string; description?: string };
    if (pkg.name) name = pkg.name;
    if (pkg.version) version = pkg.version;
    if (pkg.description) description = pkg.description;
  } catch {
    // Graceful fallback
  }

  // 2. README.md
  try {
    const readmePath = path.join(workspace, "README.md");
    const readmeRaw = await fs.readFile(readmePath, "utf8");
    const lines = readmeRaw.replace(/\r/g, "").split("\n");
    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*:\s*(.+)$/);
      if (match && features.length < 3) {
        // Strip emojis and leading icons from feature title
        const cleanTitle = match[1].replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").trim();
        if (cleanTitle) features.push(cleanTitle);
      } else if (line.match(/^\s*[-*]\s+([A-Z][a-zA-Z0-9\s-]{4,40})$/) && features.length < 3) {
        features.push(line.replace(/^\s*[-*]\s+/, "").trim());
      }
    }
  } catch {
    // Graceful fallback
  }

  // 3. Git log
  try {
    const { stdout } = await execa("git", ["log", "-n", "3", "--oneline"], { cwd: workspace, windowsHide: true });
    const logLines = stdout.split("\n").filter(Boolean);
    for (const l of logLines) {
      // Strip commit hash
      const clean = l.replace(/^[a-f0-9]+\s+/, "").trim();
      if (clean) recentCommits.push(clean);
    }
  } catch {
    // Not in git repo or git unavailable
  }

  return { name, version, description, features, recentCommits };
}

/**
 * Parses CHANGELOG.md to extract authentic release highlights for a given version.
 */
export async function inspectChangelogRelease(workspace: string, targetVersion?: string): Promise<{
  version: string;
  date: string;
  highlights: string[];
}> {
  const changelogPath = path.join(workspace, "CHANGELOG.md");
  const raw = await fs.readFile(changelogPath, "utf8");
  const lines = raw.replace(/\r/g, "").split("\n");

  let currentVersion = "";
  let currentDate = "";
  const highlights: string[] = [];
  let capturing = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^##\s+\[([0-9.]+)\](?:\s+-\s+([0-9-]+))?/);

    if (headerMatch) {
      const ver = headerMatch[1];
      const date = headerMatch[2] || "";

      if (!targetVersion || ver === targetVersion) {
        currentVersion = ver;
        currentDate = date;
        capturing = true;
        continue;
      } else if (capturing) {
        // Next version reached, stop capturing
        break;
      }
    }

    if (capturing) {
      // Look for top bullet points (including indented bullets)
      const bulletMatch = line.match(/^\s*[-*]\s+\*\*([^*]+)\*\*:\s*(.+)$/);
      if (bulletMatch && highlights.length < 3) {
        const cleanHigh = bulletMatch[1].replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "").trim();
        if (cleanHigh) highlights.push(cleanHigh);
      } else if (line.match(/^\s*[-*]\s+([A-Z].{10,80})$/) && highlights.length < 3) {
        const item = line.replace(/^\s*[-*]\s+/, "").replace(/\s*\([^)]*\)$/, "").trim();
        if (item) highlights.push(item);
      }
    }
  }

  if (!currentVersion) {
    throw new Error(`Version '${targetVersion || "latest"}' not found in CHANGELOG.md`);
  }

  return { version: currentVersion, date: currentDate, highlights };
}

/**
 * Autonomous Repo-to-Reel: automatically generates an authentic, high-impact
 * video showcase from repository files (package.json, README.md, git history).
 */
export async function generateRepoReel(
  workspace: string,
  options: RepoReelOptions = {},
): Promise<MotionDirectorResult> {
  const repo = await inspectWorkspaceRepository(workspace);

  const style = options.style ?? "neon";
  const feat1 = repo.features[0] || "Autonomous Multi-Tier Agent";
  const feat2 = repo.features[1] || "Pure Declarative Motion Studio Engine";

  const prompt = [
    `${repo.name} v${repo.version}`,
    `Featuring ${feat1}`,
    `Equipped with ${feat2}`,
  ].join(". ");

  return generateMotionFromPrompt(workspace, prompt, {
    width: options.width,
    aspectRatio: options.aspectRatio,
    artDirection: style,
  });
}

/**
 * Autonomous Release Promo: generates an authentic release showcase video
 * directly from CHANGELOG.md bullet points and version tags.
 */
export async function generateReleasePromo(
  workspace: string,
  options: ReleasePromoOptions = {},
): Promise<MotionDirectorResult> {
  const release = await inspectChangelogRelease(workspace, options.version);
  const repo = await inspectWorkspaceRepository(workspace);

  const style = options.style ?? "neon";
  const high1 = release.highlights[0] || "Major Performance & Architectural Evolution";
  const high2 = release.highlights[1] || "Autonomous Motion & Multi-Agent Capabilities";

  const prompt = [
    `${repo.name} v${release.version} Release`,
    `Highlighting ${high1}`,
    `Upgrades including ${high2}`,
  ].join(". ");

  return generateMotionFromPrompt(workspace, prompt, {
    width: options.width,
    aspectRatio: options.aspectRatio,
    artDirection: style,
  });
}
