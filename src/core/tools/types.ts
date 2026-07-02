export type AgentTier = "master" | "superagent" | "subagent" | "single";

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
  autoRetry?: boolean;
  onExit?: string;
  completedAt?: number;
  isHidden?: boolean;
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

export interface SuperagentType {
  name: string;
  description: string;
  systemPrompt: string;
}

export interface SubagentInstance {
  id: string;
  typeName: string;
  role: string;
  agent: any;
  status: "idle" | "running" | "completed" | "paused" | "error";
  logs: string[];
  result?: string;
  completedAt?: number;
  tokenUsage?: { prompt: number; completion: number };
  parentId?: string;
  historyFilePath?: string;
  speed?: number;
  violations?: ViolationRecord[];
}

export interface SuperagentInstance {
  id: string;
  role: string;
  task: string;
  branch: string;
  worktreePath: string;
  agent: any;
  status: "running" | "completed" | "error" | "paused";
  logs: string[];
  result?: string;
  completedAt?: number;
  tokenUsage?: { prompt: number; completion: number };
  historyFilePath?: string;
  speed?: number;
  customTypeName?: string;
  constraints?: string;
  acceptanceCriteria?: string[];
  violations?: ViolationRecord[];
}

/**
 * Record of an illegal operation detected by a child agent and reported
 * to its parent in multi-agent mode.
 */
export interface ViolationRecord {
  timestamp: number;
  /** Machine-readable reason code, e.g. "master_direct_modify_blocked" */
  reason: string;
  /** Which tool triggered the violation */
  toolName: string;
  /** Human-readable description of the violation */
  description: string;
  /** Severity level: "warning" for soft blocks, "critical" for hard policy violations */
  severity: "warning" | "critical";
  /** Optional metadata (filePath, command, worktreePath, etc.) */
  meta?: Record<string, unknown>;
}

export interface QuestionItem {
  question: string;
  options: string[];
  isMultiSelect?: boolean;
}

export type QuestionHandler = (
  question: string | QuestionItem[],
  options?: string[],
  isMultiSelect?: boolean,
  initialCheckedIndices?: number[]
) => Promise<string | string[]>;

