import chalk from "chalk";
import { execa } from "execa";
import path from "path";
import fs from "fs";

interface GitFileDiff {
  added: number;
  deleted: number;
}

export type GitSnapshot = Record<string, GitFileDiff>;

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  try {
    const { stdout: isGit } = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
    if (isGit.trim() !== "true") {
      return null;
    }

    const snapshot: GitSnapshot = {};

    // Get tracked changes relative to HEAD
    const { stdout: numstat } = await execa("git", ["diff", "HEAD", "--numstat"], { cwd, reject: false });
    const lines = numstat.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
        const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
        const filepath = parts.slice(2).join(" ");
        snapshot[filepath] = { added, deleted };
      }
    }

    // Get untracked files
    const { stdout: untracked } = await execa("git", ["ls-files", "--others", "--exclude-standard"], { cwd, reject: false });
    const untrackedFiles = untracked.split("\n").map(f => f.trim()).filter(Boolean);
    
    if (untrackedFiles.length > 100) {
      // Avoid parallel disk reads on massive untracked files lists (e.g. build directories)
      for (const filepath of untrackedFiles) {
        snapshot[filepath] = { added: 0, deleted: 0 };
      }
    } else {
      // Read files concurrently to avoid serial disk I/O bottlenecks
      await Promise.all(
        untrackedFiles.map(async (filepath) => {
          const fullPath = path.resolve(cwd, filepath);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.isFile()) {
              // Only read contents if file is under 1MB to avoid memory blowup on large artifacts
              if (stat.size < 1024 * 1024) {
                const content = await fs.promises.readFile(fullPath, "utf-8");
                const linesCount = content.split(/\r?\n/).length;
                snapshot[filepath] = { added: linesCount, deleted: 0 };
              } else {
                snapshot[filepath] = { added: 0, deleted: 0 };
              }
            }
          } catch {
            snapshot[filepath] = { added: 0, deleted: 0 };
          }
        })
      );
    }

    return snapshot;
  } catch {
    return null;
  }
}

export function getGitDiffSummary(start: GitSnapshot | null, end: GitSnapshot | null): string | null {
  if (!end) return null;
  const startMap = start || {};
  const summaryLines: string[] = [];

  const allFiles = new Set([...Object.keys(startMap), ...Object.keys(end)]);

  for (const file of allFiles) {
    const startVal = startMap[file] || { added: 0, deleted: 0 };
    const endVal = end[file];

    if (!endVal) {
      const addedDiff = -startVal.added;
      const deletedDiff = -startVal.deleted;
      if (addedDiff !== 0 || deletedDiff !== 0) {
        const parts: string[] = [];
        if (addedDiff !== 0) {
          parts.push(addedDiff > 0 ? `+${addedDiff}` : `${addedDiff}`);
        }
        if (deletedDiff !== 0) {
          parts.push(deletedDiff > 0 ? `-${deletedDiff}` : `+${-deletedDiff}`);
        }
        const statusText = chalk.green.bold("committed to repo");
        summaryLines.push(`- ${file}: ${statusText} (${parts.join(", ")})`);
      }
      continue;
    }

    const addedDiff = endVal.added - startVal.added;
    const deletedDiff = endVal.deleted - startVal.deleted;

    if (addedDiff !== 0 || deletedDiff !== 0) {
      const parts: string[] = [];
      if (addedDiff !== 0) {
        parts.push(addedDiff > 0 ? `+${addedDiff}` : `${addedDiff}`);
      }
      if (deletedDiff !== 0) {
        parts.push(deletedDiff > 0 ? `-${deletedDiff}` : `+${-deletedDiff}`);
      }
      summaryLines.push(`- ${file}: ${parts.join(", ")}`);
    }
  }

  if (summaryLines.length === 0) return null;
  return summaryLines.join("\n");
}
