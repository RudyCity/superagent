import { existsSync } from "node:fs";
import path from "node:path";
import { getHistoryDb } from "../storage/historyDb.js";
import { getRootConfigDir, getSelfDevLessonsPath } from "../config/paths.js";
import { ReviewService } from "./reviewService.js";
import { getSelfDevRuntimeMetrics, type SelfDevRuntimeMetrics } from "./selfdevAgent.js";
import { getSelfDevConfig } from "./settings.js";
import type { SqliteDbLike } from "./types.js";

export type DiagnosticState = "ok" | "info" | "warning" | "error";
export interface SelfDevDiagnosticCheck {
  name: string;
  state: DiagnosticState;
  detail: string;
}
export interface SelfDevDoctorReport {
  workspace: string;
  enabled: boolean;
  userOptOut: boolean;
  configVersion: number;
  checks: SelfDevDiagnosticCheck[];
  lessonCounts: { candidate: number; active: number; retired: number };
  eventCount: number;
  healthy: boolean;
}
export interface SelfDevMetricsReport {
  workspace: string;
  enabled: boolean;
  userOptOut: boolean;
  configVersion: number;
  storageAvailable: boolean;
  eventCount: number;
  eventsByKind: Record<string, number>;
  lessonCounts: { candidate: number; active: number; retired: number };
  feedback: { injected: number; applied: number; helped: number; harmed: number };
  runtime: SelfDevRuntimeMetrics;
  runtimeMetricsScope: "current-process-only";
}

function rootStorePath(): string {
  const cfg = getSelfDevConfig();
  return cfg.storePath || getSelfDevLessonsPath();
}

function emptyLessonCounts() {
  return { candidate: 0, active: 0, retired: 0 };
}

async function readLessonCounts(workspace: string, storePath: string) {
  const counts = emptyLessonCounts();
  const service = new ReviewService({ storePath, enabled: () => true });
  const lessons = await service.list(workspace);
  for (const lesson of lessons) {
    if (lesson.status === "candidate") counts.candidate += 1;
    else if (lesson.status === "active") counts.active += 1;
    else if (lesson.status === "retired") counts.retired += 1;
  }
  return counts;
}

function getTables(db: SqliteDbLike): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: string }>;
  return new Set(rows.map(row => row.name).filter((name): name is string => typeof name === "string"));
}

function collectStoredCounters(workspace: string): {
  available: boolean;
  eventCount: number;
  eventsByKind: Record<string, number>;
  feedback: { injected: number; applied: number; helped: number; harmed: number };
} {
  const result = {
    available: false,
    eventCount: 0,
    eventsByKind: {} as Record<string, number>,
    feedback: { injected: 0, applied: 0, helped: 0, harmed: 0 },
  };
  try {
    const db = getHistoryDb() as unknown as SqliteDbLike;
    const tables = getTables(db);
    result.available = true;

    if (tables.has("selfdev_events")) {
      const rows = db.prepare(
        "SELECT kind, COUNT(*) AS count FROM selfdev_events WHERE workspace = ? GROUP BY kind"
      ).all(workspace) as Array<{ kind?: string; count?: number }>;
      for (const row of rows) {
        if (typeof row.kind === "string") {
          const count = Number(row.count) || 0;
          result.eventsByKind[row.kind] = count;
          result.eventCount += count;
        }
      }
    }

    if (tables.has("selfdev_feedback")) {
      const rows = db.prepare(
        "SELECT metric, COUNT(DISTINCT session_id || ':' || version) AS count FROM selfdev_feedback WHERE workspace = ? GROUP BY metric"
      ).all(workspace) as Array<{ metric?: string; count?: number }>;
      for (const row of rows) {
        if (row.metric === "injected" || row.metric === "applied" || row.metric === "helped" || row.metric === "harmed") {
          result.feedback[row.metric] = Number(row.count) || 0;
        }
      }
    }
  } catch {
    result.available = false;
  }
  return result;
}

/** Read-only diagnostics; it never removes locks or repairs files automatically. */
export async function getSelfDevDoctorReport(workspace: string): Promise<SelfDevDoctorReport> {
  const config = getSelfDevConfig();
  const storePath = rootStorePath();
  const checks: SelfDevDiagnosticCheck[] = [];
  let eventCount = 0;
  let dbAvailable = false;

  checks.push({
    name: "Effective configuration",
    state: config.enabled ? "ok" : "info",
    detail: config.enabled
      ? "Selfdev is enabled."
      : config.userOptOut ? "Selfdev is disabled by explicit user opt-out." : "Selfdev is disabled by configuration or invalid persisted values.",
  });
  checks.push({
    name: "Default-on migration",
    state: config.configVersion >= 1 ? "ok" : "warning",
    detail: `Config version: ${config.configVersion}; explicit opt-out: ${config.userOptOut ? "yes" : "no"}.`,
  });
  checks.push({
    name: "Workspace",
    state: workspace.trim() ? "ok" : "error",
    detail: workspace.trim() ? "Workspace identifier is present; stores will be scoped to this exact value." : "Workspace identifier is empty.",
  });
  checks.push({
    name: "Lesson store path",
    state: path.isAbsolute(storePath) ? "ok" : "error",
    detail: path.isAbsolute(storePath) ? "Resolved lesson-store path is absolute." : "Lesson-store path must be absolute.",
  });

  try {
    const stored = collectStoredCounters(workspace);
    dbAvailable = stored.available;
    eventCount = stored.eventCount;
    checks.push({
      name: "History database",
      state: dbAvailable ? "ok" : "error",
      detail: dbAvailable ? "SQLite opened and metadata queries succeeded." : "History database could not be queried.",
    });
  } catch {
    checks.push({ name: "History database", state: "error", detail: "History database could not be queried." });
  }

  let lessonCounts = emptyLessonCounts();
  try {
    lessonCounts = await readLessonCounts(workspace, storePath);
    checks.push({
      name: "Lesson store",
      state: "ok",
      detail: existsSync(storePath)
        ? `Readable store; ${lessonCounts.candidate} candidate, ${lessonCounts.active} active, ${lessonCounts.retired} retired lesson(s) in this workspace.`
        : "No lesson store exists yet; it will be created when the first candidate is saved.",
    });
  } catch {
    checks.push({
      name: "Lesson store",
      state: "error",
      detail: "Lesson store is unreadable or has an invalid schema. No repair was attempted.",
    });
  }

  const lockPath = `${storePath}.lock`;
  checks.push({
    name: "Lesson-store lock",
    state: existsSync(lockPath) ? "warning" : "ok",
    detail: existsSync(lockPath)
      ? "A lock file exists. It may belong to an active writer; doctor did not remove it."
      : "No lock file is currently present.",
  });

  // Report runtime-created root path only as a configured location, not as telemetry.
  checks.push({
    name: "Config directory",
    state: path.isAbsolute(getRootConfigDir()) ? "ok" : "error",
    detail: path.isAbsolute(getRootConfigDir()) ? "Config directory resolves to an absolute path." : "Config directory is not absolute.",
  });

  return {
    workspace,
    enabled: config.enabled,
    userOptOut: config.userOptOut,
    configVersion: config.configVersion,
    checks,
    lessonCounts,
    eventCount,
    healthy: checks.every(check => check.state !== "error"),
  };
}

/** Stored metrics are workspace-scoped; process counters reset when Superagent restarts. */
export async function getSelfDevMetricsReport(workspace: string): Promise<SelfDevMetricsReport> {
  const config = getSelfDevConfig();
  const storePath = rootStorePath();
  const stored = collectStoredCounters(workspace);
  let lessonCounts = emptyLessonCounts();
  try {
    lessonCounts = await readLessonCounts(workspace, storePath);
  } catch {
    // Metrics still return useful DB/runtime counters if the lesson file is corrupt.
  }
  return {
    workspace,
    enabled: config.enabled,
    userOptOut: config.userOptOut,
    configVersion: config.configVersion,
    storageAvailable: stored.available,
    eventCount: stored.eventCount,
    eventsByKind: stored.eventsByKind,
    lessonCounts,
    feedback: stored.feedback,
    runtime: getSelfDevRuntimeMetrics(),
    runtimeMetricsScope: "current-process-only",
  };
}
