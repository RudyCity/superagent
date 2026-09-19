import fs from "fs";
import path from "path";
import os from "os";
import { getInstalledSkills } from "../config/skills.js";
import { listSynthesizedSkills } from "./skillSynthesizer.js";

export interface SkillStatItem {
  name: string;
  type: "installed" | "synthesized";
  category?: string;
  executionCount: number;
  lastUsed?: number;
  lastSynthesized?: number;
  path?: string;
  description: string;
}

interface PersistedSkillStats {
  skills: Record<
    string,
    {
      executionCount: number;
      lastUsed?: number;
      lastSynthesized?: number;
    }
  >;
}

function getStatsFilePath(): string {
  const dir = path.join(os.homedir(), ".superagent-r");
  return path.join(dir, "skill-stats.json");
}

function readPersistedStats(): PersistedSkillStats {
  const filePath = getStatsFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.skills === "object") {
        return parsed;
      }
    }
  } catch {}
  return { skills: {} };
}

function savePersistedStats(data: PersistedSkillStats): void {
  const filePath = getStatsFilePath();
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}

export function recordSkillExecution(skillName: string): void {
  const normalized = skillName.trim().toLowerCase();
  if (!normalized) return;

  const data = readPersistedStats();
  const existing = data.skills[normalized] || { executionCount: 0 };
  existing.executionCount = (existing.executionCount || 0) + 1;
  existing.lastUsed = Date.now();
  data.skills[normalized] = existing;
  savePersistedStats(data);
}

export function recordSkillSynthesized(skillName: string): void {
  const normalized = skillName.trim().toLowerCase();
  if (!normalized) return;

  const data = readPersistedStats();
  const existing = data.skills[normalized] || { executionCount: 0 };
  existing.lastSynthesized = Date.now();
  data.skills[normalized] = existing;
  savePersistedStats(data);
}

export function getSkillStats(workspace: string = process.cwd()): SkillStatItem[] {
  const persisted = readPersistedStats();
  const results: Map<string, SkillStatItem> = new Map();

  // Load installed skills
  try {
    const installed = getInstalledSkills();
    for (const s of installed) {
      const p = persisted.skills[s.name.toLowerCase()];
      results.set(s.name.toLowerCase(), {
        name: s.name,
        type: "installed",
        category: s.category || "standard",
        executionCount: p?.executionCount || 0,
        lastUsed: p?.lastUsed,
        lastSynthesized: p?.lastSynthesized,
        path: s.path,
        description: s.description || "",
      });
    }
  } catch {}

  // Load synthesized skills
  try {
    const synthesized = listSynthesizedSkills(workspace);
    for (const s of synthesized) {
      const key = s.name.toLowerCase();
      const p = persisted.skills[key];
      const existing = results.get(key);
      if (existing) {
        existing.type = "synthesized";
        existing.path = s.path;
        existing.description = s.description;
        existing.lastSynthesized = p?.lastSynthesized || s.createdAt;
      } else {
        results.set(key, {
          name: s.name,
          type: "synthesized",
          category: "custom",
          executionCount: p?.executionCount || 0,
          lastUsed: p?.lastUsed,
          lastSynthesized: p?.lastSynthesized || s.createdAt,
          path: s.path,
          description: s.description,
        });
      }
    }
  } catch {}

  // Also include any persisted skills not yet discovered from disk
  for (const [key, p] of Object.entries(persisted.skills)) {
    if (!results.has(key)) {
      results.set(key, {
        name: key,
        type: "synthesized",
        category: "custom",
        executionCount: p.executionCount || 0,
        lastUsed: p.lastUsed,
        lastSynthesized: p.lastSynthesized,
        description: "Recorded skill",
      });
    }
  }

  return Array.from(results.values()).sort((a, b) => {
    if (b.executionCount !== a.executionCount) {
      return b.executionCount - a.executionCount;
    }
    return a.name.localeCompare(b.name);
  });
}
