export type AgentTier = "master" | "superagent" | "subagent";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, cwd: string, signal?: AbortSignal) => Promise<string>;
}

export interface BackgroundTask {
  id: string;
  command: string;
  process: any;
  output: string[];
  logPath?: string;
  hasExited?: boolean;
  exitCode?: number | null;
  /** true for non-headless terminals launched via /terminal — the launcher
   *  process exits immediately but the visible window keeps running. */
  isDetachedWindow?: boolean;
  /** Human-readable label for the window (preset name or first word of cmd) */
  windowLabel?: string;
}

export type TaskChangeListener = () => void;
export type ActiveOutputListener = (text: string) => void;

export interface ScheduleJob {
  id: string;
  prompt: string;
  timer?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

export interface SubagentType {
  name: string;
  description: string;
  systemPrompt: string;
}

export interface SubagentInstance {
  id: string;
  typeName: string;
  role: string;
  agent: any;
  status: "idle" | "running" | "completed";
  logs: string[];
  result?: string;
  completedAt?: number;
  tokenUsage?: { prompt: number; completion: number };
  parentId?: string;
  historyFilePath?: string;
}

export interface SuperagentInstance {
  id: string;
  role: string;
  task: string;
  branch: string;
  worktreePath: string;
  agent: any;
  status: "running" | "completed" | "error";
  logs: string[];
  result?: string;
  completedAt?: number;
  tokenUsage?: { prompt: number; completion: number };
  historyFilePath?: string;
}

export type QuestionHandler = (question: string, options: string[], isMultiSelect?: boolean) => Promise<string>;
