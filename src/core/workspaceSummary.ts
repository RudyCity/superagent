import fs from "fs";
import path from "path";
import { getRootConfigDir, getWorkspaceId } from "./config/paths.js";
import { getNormalizedProjectPath } from "./tools/helpers.js";

export interface WorkspaceSummary {
  projectPath: string;
  projectName: string;
  lastUpdated: number;
  summary: string;
  keyFiles: string[];
  notes: string[];
}

export function getProjectHash(projectPath: string): string {
  return getWorkspaceId(projectPath);
}

export function getWorkspaceSummaryPath(cwd?: string): string {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const hash = getProjectHash(projectPath);
  const projectsDir = path.join(getRootConfigDir(), "projects", hash);
  if (!fs.existsSync(projectsDir)) {
    fs.mkdirSync(projectsDir, { recursive: true });
  }
  return path.join(projectsDir, "summary.json");
}

export function readWorkspaceSummary(cwd?: string): WorkspaceSummary | null {
  try {
    const summaryPath = getWorkspaceSummaryPath(cwd);
    if (fs.existsSync(summaryPath)) {
      const raw = fs.readFileSync(summaryPath, "utf-8");
      return JSON.parse(raw) as WorkspaceSummary;
    }
  } catch {
    // Ignore read or parse errors
  }
  return null;
}

export function saveWorkspaceSummary(
  summaryData: Partial<WorkspaceSummary>,
  cwd?: string
): WorkspaceSummary {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const projectName = path.basename(projectPath);
  const existing = readWorkspaceSummary(cwd);

  const updated: WorkspaceSummary = {
    projectPath,
    projectName,
    lastUpdated: Date.now(),
    summary: summaryData.summary || existing?.summary || `Workspace ${projectName} initialized.`,
    keyFiles: Array.from(new Set([...(existing?.keyFiles || []), ...(summaryData.keyFiles || [])])),
    notes: Array.from(new Set([...(existing?.notes || []), ...(summaryData.notes || [])])),
  };

  const summaryPath = getWorkspaceSummaryPath(cwd);
  fs.writeFileSync(summaryPath, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}
