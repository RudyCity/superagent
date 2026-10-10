import type { Agent } from "../agent.js";
import type { RemoteAgentTransport } from "./config.js";
import type { RemoteTransport, RemoteEnvelopeMeta } from "./transport.js";
import type { TaskBatchEnvelope, TaskDoneEnvelope } from "./protocol.js";

export interface MuseWatcherStats {
  isRunning: boolean;
  startedAt?: number;
  uptimeSeconds: number;
  tasksCompleted: number;
  batchesExecuted: number;
  lastActiveAt?: number;
  activeTaskId?: string;
  workspace: string;
  workspaces: string[];
  groupId?: string | number;
  museBotId?: string | number;
  queuedBatches?: number;
  transport?: string;
  transportDetails?: string;
  tunnel?: boolean;
  tunnelUrl?: string;
  tunnelPort?: number;
}

export interface MuseWatcherOptions {
  workspace?: string;
  workspaces?: string[];
  agent?: Agent | null;
  customConfigPath?: string;
  announce?: boolean;
  autoApproveWorkspace?: boolean;
  tunnel?: boolean;
  wsPort?: number;
  isHttps?: boolean;
  transport?: RemoteTransport;
  transportType?: RemoteAgentTransport;
  onProgress?: (message: string) => void;
  onLog?: (message: string) => void;
  onLine?: (line: { type: string; content: string; timestamp?: number }) => void;
  onToolStart?: (toolCall: any, description: string) => void;
  onToolEnd?: (toolCall: any, toolResult: any, description: string) => void;
  onStatusChange?: (isRunning: boolean) => void;
  onPermissionPrompt?: (toolCall: any, description: string) => Promise<boolean | "session">;
  onWaitingPermission?: (toolCall: any, description: string) => void | Promise<void>;
  onPermissionDecision?: (toolCall: any, description: string, approved: boolean) => void | Promise<void>;
}

export interface BatchQueueItem {
  type: "batch" | "done";
  envelope: TaskBatchEnvelope | TaskDoneEnvelope;
  meta?: RemoteEnvelopeMeta;
}
