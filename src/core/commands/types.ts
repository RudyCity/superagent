import type { Agent } from "../agent.js";

export interface ChatLine {
  type: "user" | "assistant" | "system" | "error" | "tool_start" | "tool_end";
  content: string;
  timestamp: number;
}

export interface SlashCommandContext {
  addLine: (line: ChatLine) => void;
  exit: () => void;
  agent: Agent | null;
  clearLines?: () => void;
  setContextLimit?: (limit: number) => void;
  setActiveModel?: (model: string) => void;
  setActiveWizard?: (val: { type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills"; step: number; data: Record<string, string> } | null) => void;
  setWizardOptions?: (options: string[]) => void;
  setWizardSelectedIndex?: (index: number) => void;
  resumeSession?: () => Promise<void>;
  resumeFromPath?: (filePath: string) => Promise<void>;
  setPlanState?: (state: "IDLE" | "PLANNING_PENDING" | "APPROVED") => void;
  setGoalMode?: (val: { goal: string; startedAt: number } | null) => void;
  setIsProcessing?: (val: boolean) => void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  execute(args: string, ctx: SlashCommandContext): Promise<void> | void;
}

export function getProviderLabel(): string {
  const active = process.env.ACTIVE_PROVIDER;
  if (active) {
    const prefix = `PROVIDER_${active.toUpperCase()}`;
    const baseUrl = process.env[`${prefix}_BASE_URL`] || "";
    if (baseUrl) {
      try {
        const url = new URL(baseUrl);
        return `${active} (${url.host})`;
      } catch {
        return active;
      }
    }
    return active;
  }
  if (process.env.CUSTOM_BASE_URL) {
    try {
      const url = new URL(process.env.CUSTOM_BASE_URL);
      return `custom (${url.host})`;
    } catch {
      return "custom";
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

export function getDefaultModel(): string {
  if (process.env.CUSTOM_BASE_URL) return "custom";
  if (process.env.ANTHROPIC_API_KEY) return "claude-sonnet-4-20250514";
  return "gpt-4o";
}

export function formatPresetValue(preset: any): string {
  if (!preset) return "";
  if (typeof preset === "string") {
    return preset;
  }
  if (Array.isArray(preset)) {
    return `[ ${preset.map(p => formatPresetValue(p)).join(" ; ")} ]`;
  }
  if (typeof preset === "object" && preset !== null) {
    const parts: string[] = [];
    if (preset.command) {
      parts.push(`cmd: "${preset.command}"`);
    }
    if (preset.description) {
      parts.push(`desc: "${preset.description}"`);
    }
    if (preset.cwd) {
      parts.push(`cwd: "${preset.cwd}"`);
    }
    if (preset.background) {
      parts.push("bg: true");
    }
    if (preset.env && Object.keys(preset.env).length > 0) {
      parts.push(`env: ${JSON.stringify(preset.env)}`);
    }
    return `{ ${parts.join(", ")} }`;
  }
  return JSON.stringify(preset);
}

export function getPresetLabel(key: string, val: any): string {
  if (val && typeof val === "object" && val.name) {
    return val.name;
  }
  return key;
}

export function findPreset(presets: Record<string, any>, nameOrKey: string): { key: string; value: any } | null {
  if (presets[nameOrKey] !== undefined) {
    return { key: nameOrKey, value: presets[nameOrKey] };
  }
  const lowerName = nameOrKey.toLowerCase();
  for (const k of Object.keys(presets)) {
    if (k.toLowerCase() === lowerName) {
      return { key: k, value: presets[k] };
    }
    const val = presets[k];
    if (val && typeof val === "object" && val.name && String(val.name).toLowerCase() === lowerName) {
      return { key: k, value: val };
    }
  }
  return null;
}
