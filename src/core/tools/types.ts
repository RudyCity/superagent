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
}

export type QuestionHandler = (question: string, options: string[]) => Promise<string>;
