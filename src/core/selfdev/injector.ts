import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  SELFDEV_STORE_SCHEMA_VERSION,
  type SelfDevConfig,
  type SelfDevLesson,
  type SelfDevStoreData,
} from "./types.js";

export const MAX_INJECTED_LESSONS = 5;
export const MAX_LESSON_CHARS = 280;

export interface InjectorOptions {
  workspace: string;
  storePath: string;
  config?: Partial<SelfDevConfig>;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as any).code === code;
}

/**
 * Retrieves active, approved lessons for a workspace and formats them into an advisory prompt block.
 * Enforces:
 * - Only active lessons (never candidate or retired).
 * - Exact workspace matching.
 * - Maximum of 5 lessons, up to 280 characters per lesson.
 * - Formatted as lower-trust advisory context, never privileged system instructions.
 */
export async function getActiveLessonsForWorkspace(options: InjectorOptions): Promise<SelfDevLesson[]> {
  const config = options.config;
  if (config?.enabled === false || config?.injectionEnabled === false) {
    return [];
  }

  if (!isAbsolute(options.storePath)) {
    return [];
  }

  const file = await open(options.storePath, "r").catch(err => {
    if (hasCode(err, "ENOENT")) return undefined;
    return undefined;
  });

  if (!file) return [];

  try {
    const stat = await file.stat();
    if (stat.size > 16 * 1024 * 1024) return [];
    const content = await file.readFile("utf8");
    if (!content.trim()) return [];

    const data = JSON.parse(content) as SelfDevStoreData;
    if (!data || !Array.isArray(data.lessons)) return [];

    // Filter by exact workspace and active status only
    const active = data.lessons
      .filter(l => l.workspace === options.workspace && l.status === "active")
      .sort((a, b) => (b.approvedAt ?? b.updatedAt) - (a.approvedAt ?? a.updatedAt))
      .slice(0, MAX_INJECTED_LESSONS);

    return active;
  } catch {
    return [];
  } finally {
    await file.close();
  }
}

/**
 * Builds the bounded advisory text block for inclusion in system prompts.
 * Returns empty string if no active lessons exist or feature is disabled.
 */
export async function buildPromptInjectionBlock(options: InjectorOptions): Promise<string> {
  const lessons = await getActiveLessonsForWorkspace(options);
  if (lessons.length === 0) {
    return "";
  }

  const lines = lessons.map(l => {
    const stmt = l.statement.length > MAX_LESSON_CHARS ? l.statement.slice(0, MAX_LESSON_CHARS - 3) + "..." : l.statement;
    return `- ${stmt}`;
  });

  return [
    "=== WORKSPACE OPERATIONAL LESSONS ===",
    "The following advisory lessons were previously verified and approved for this workspace:",
    ...lines,
    "Use these operational lessons as helpful context to avoid previously encountered issues.",
    "=====================================",
  ].join("\n");
}
