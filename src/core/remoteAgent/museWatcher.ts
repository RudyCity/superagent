import crypto from "crypto";
import path from "path";
import {
  loadRemoteAgentConfig,
  maskToken,
  RemoteAgentConfig,
  getWatchedWorkspaces,
  RemoteAgentTransport,
} from "./config.js";
import {
  RemoteAgentEnvelope,
  TaskBatchEnvelope,
  TaskResultEnvelope,
  TaskDoneEnvelope,
  ChatEnvelope,
  SessionResetEnvelope,
  TaskCancelEnvelope,
  DEFAULT_MUSE_SYSTEM_PROMPT,
} from "./protocol.js";
import { MuseClient } from "./museClient.js";
import {
  RemoteTransport,
  TelegramTransport,
  RemoteEnvelopeMeta,
} from "./transport.js";
import { createMuseWsTransport } from "./museWsTransport.js";
import { executeBatch } from "./batchExecutor.js";
import { formatReadableSummary } from "./formatSummary.js";
import type { Agent } from "../agent.js";
import { logE2E } from "../utils/unifiedLogger.js";

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
}

export interface MuseWatcherOptions {
  workspace?: string;
  workspaces?: string[];
  agent?: Agent | null;
  customConfigPath?: string;
  announce?: boolean;
  autoApproveWorkspace?: boolean;
  tunnel?: boolean;
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

/**
 * MuseWatcher: Persistent watch daemon where Superagent is continuously controlled by Muse.
 * Listens for incoming tool batches from Muse over Telegram, executes them locally,
 * and posts execution results back to Telegram in real-time.
 */
export class MuseWatcher {
  private config: RemoteAgentConfig;
  private client: MuseClient;
  private isRunning = false;
  private abortController: AbortController | null = null;
  private startedAt?: number;
  private tasksCompleted = 0;
  private batchesExecuted = 0;
  private lastActiveAt?: number;
  private activeTaskId?: string;
  private options: MuseWatcherOptions;
  private activeBatchAborts = new Set<AbortController>();
  private seenChatIds = new Set<string>();
  private seenBatchIds = new Set<string>();
  private activeBatchIds = new Set<string>();
  private completedBatchResults = new Map<
    string,
    {
      resultEnvelope: TaskResultEnvelope;
      completedAt: number;
      hasError: boolean;
    }
  >();
  private pendingReplyMessageIds = new Map<string, Set<number>>();
  private batchQueue: Array<{
    type: "batch" | "done";
    envelope: TaskBatchEnvelope | TaskDoneEnvelope;
    meta?: RemoteEnvelopeMeta;
    resolve?: () => void;
    reject?: (err: any) => void;
  }> = [];
  private isProcessingQueue = false;
  private workspaces: string[] = [];
  private transport!: RemoteTransport;
  private quickTunnelStarted = false;
  private tunnelMetadata: { publicUrl: string; wssUrl: string; localUrl: string; pid: number } | null = null;

  constructor(options: MuseWatcherOptions = {}) {
    this.options = options;
    this.config = loadRemoteAgentConfig(options.customConfigPath);
    this.client = new MuseClient(this.config);
    this.initWorkspaces();
    this.initTransport();
  }

  private initTransport(): void {
    if (this.options.transport) {
      this.transport = this.options.transport;
      if (this.transport instanceof TelegramTransport) {
        this.client = this.transport.getClient();
      }
      return;
    }

    const effectiveType = this.options.transportType || this.config.transport || "telegram";
    if (effectiveType === "websocket") {
      this.transport = createMuseWsTransport(this.config, this.options.customConfigPath);
    } else {
      this.client = new MuseClient(this.config);
      this.transport = new TelegramTransport(this.config, this.client);
    }
  }

  public getTransport(): RemoteTransport {
    return this.transport;
  }

  public getClient(): MuseClient {
    return this.client;
  }

  private initWorkspaces(): void {
    const list: string[] = [];
    if (Array.isArray(this.options.workspaces) && this.options.workspaces.length > 0) {
      list.push(...this.options.workspaces);
    }
    if (this.options.workspace) {
      list.push(this.options.workspace);
    }
    if (list.length === 0) {
      list.push(...getWatchedWorkspaces(this.config));
    }

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const item of list) {
      if (typeof item === "string" && item.trim()) {
        const resolved = path.resolve(item.trim());
        const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
        if (!seen.has(key)) {
          seen.add(key);
          normalized.push(resolved);
        }
      }
    }
    this.workspaces = normalized.length > 0 ? normalized : [path.resolve(process.cwd())];
  }

  public getWorkspaces(): string[] {
    return [...this.workspaces];
  }

  public addWorkspace(wsPath: string): void {
    const resolved = path.resolve(wsPath.trim());
    const isWin = process.platform === "win32";
    const exists = this.workspaces.some((w) =>
      isWin ? w.toLowerCase() === resolved.toLowerCase() : w === resolved
    );
    if (!exists) {
      this.workspaces.push(resolved);
      this.emitLine(
        "system",
        `[Muse Watch] Added project workspace to watch list: ${resolved} (Total: ${this.workspaces.length})`
      );
    }
  }

  public removeWorkspace(wsPath: string): boolean {
    const resolved = path.resolve(wsPath.trim());
    const isWin = process.platform === "win32";
    const prevLen = this.workspaces.length;
    this.workspaces = this.workspaces.filter((w) =>
      isWin ? w.toLowerCase() !== resolved.toLowerCase() : w !== resolved
    );
    if (this.workspaces.length === 0) {
      this.workspaces.push(path.resolve(process.cwd()));
    }
    const removed = this.workspaces.length < prevLen;
    if (removed) {
      this.emitLine(
        "system",
        `[Muse Watch] Removed project workspace from watch list: ${resolved} (Remaining: ${this.workspaces.length})`
      );
    }
    return removed;
  }

  public setWorkspaces(list: string[]): void {
    const normalized = list.map((w) => path.resolve(w.trim()));
    this.workspaces = normalized.length > 0 ? normalized : [path.resolve(process.cwd())];
  }

  private emitLine(type: string, content: string): void {
    this.options.onLine?.({
      type: type as any,
      content,
      timestamp: Date.now(),
    });
    this.options.onLog?.(content);
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public getStats(): MuseWatcherStats {
    const now = Date.now();
    const uptimeSeconds = this.startedAt ? Math.floor((now - this.startedAt) / 1000) : 0;
    const ws = this.workspaces[0] || path.resolve(
      this.options.workspace || this.config.defaultWorkspace || process.cwd()
    );
    const transportInfo = this.transport ? this.transport.getTransportInfo() : undefined;

    return {
      isRunning: this.isRunning,
      startedAt: this.startedAt,
      uptimeSeconds,
      tasksCompleted: this.tasksCompleted,
      batchesExecuted: this.batchesExecuted,
      lastActiveAt: this.lastActiveAt,
      activeTaskId: this.activeTaskId,
      workspace: ws,
      workspaces: [...this.workspaces],
      groupId: this.config.groupId,
      museBotId: this.config.museBotId,
      queuedBatches: this.batchQueue.length,
      transport: transportInfo?.type,
      transportDetails: transportInfo?.details,
      tunnel: Boolean(this.quickTunnelStarted),
      tunnelUrl: this.tunnelMetadata?.wssUrl,
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.config = loadRemoteAgentConfig(this.options.customConfigPath);
    this.initWorkspaces();
    this.initTransport();

    const transportInfo = this.transport.getTransportInfo();

    if (this.transport.type === "telegram") {
      if (!this.config.botToken || !this.config.groupId || !this.config.museBotId) {
        throw new Error(
          "Remote agent (Muse) Telegram is not configured. Run '/muse config' to set botToken, groupId, and museBotId."
        );
      }
    } else if (this.transport.type === "websocket") {
      if (this.config.wsMode === "client" && !this.config.wsRemoteUrl) {
        throw new Error(
          "Remote agent (Muse) WebSocket client mode requires wsRemoteUrl. Run '/muse config' to configure."
        );
      }
    }

    // Cancel any running single-task runner to ensure token or port is exclusively polled
    try {
      const { abortActiveRemoteTask } = await import("./taskRunner.js");
      await abortActiveRemoteTask("Starting Muse Watch mode");
    } catch {}

    this.isRunning = true;
    this.startedAt = Date.now();
    this.lastActiveAt = Date.now();
    this.abortController = new AbortController();

    const primaryWs = this.workspaces[0];

    logE2E(
      "REMOTE-AGENT",
      `MuseWatcher started with ${this.workspaces.length} workspace(s). Primary: ${primaryWs}. Transport: ${transportInfo.details}`
    );

    this.options.onStatusChange?.(true);

    const wsInfoStr = this.workspaces.length > 1
      ? `- Watched Projects (${this.workspaces.length}):\n${this.workspaces.map((w, i) => `  ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
      : `- Workspace: ${primaryWs}`;

    this.emitLine(
      "system",
      `[Muse Watch] Superagent is now controlled by Muse.\n${wsInfoStr}\n- Transport: ${transportInfo.details}\n- Listening for incoming tool batches from Muse...`
    );

    if (this.options.tunnel && this.transport.type === "websocket") {
      try {
        this.emitLine("system", "[Cloudflare Tunnel] Launching quick ephemeral tunnel...");
        const { startQuickTunnel } = await import("./cloudflareTunnel.js");
        const tunnelMeta = await startQuickTunnel({
          port: this.config.wsPort,
          host: this.config.wsHost,
          path: this.config.wsPath,
          customConfigPath: this.options.customConfigPath,
          onLog: (msg) => this.options.onLog?.(`[Tunnel] ${msg.trim()}`),
        });
        this.quickTunnelStarted = true;
        this.tunnelMetadata = tunnelMeta;
        const { buildMuseConnectionPrompt, copyTextToClipboard } = await import("./cloudflareTunnel.js");
        const musePrompt = buildMuseConnectionPrompt({
          wssUrl: tunnelMeta.wssUrl,
          token: this.config.wsToken,
          publicUrl: tunnelMeta.publicUrl,
          localUrl: tunnelMeta.localUrl,
          workspaces: this.workspaces,
          cfClientId: this.config.cfAccessClientId,
          cfClientSecret: this.config.cfAccessClientSecret,
        });
        const copied = await copyTextToClipboard(musePrompt);

        this.emitLine(
          "system",
          `[Cloudflare Tunnel] Quick tunnel online!\n- Public WSS URL : ${tunnelMeta.wssUrl}\n- Bearer Token   : ${this.config.wsToken}\n- Local Target   : ${tunnelMeta.localUrl}\n\n${copied ? "Prompt for Muse (copied to clipboard, ready to send):" : "Prompt for Muse (copy & send to Muse):"}\n-----------------------------------------------------------------------------\n${musePrompt}\n-----------------------------------------------------------------------------`
        );
      } catch (err: any) {
        this.emitLine(
          "system",
          `[Cloudflare Tunnel] Warning: Failed to establish quick tunnel: ${err?.message}`
        );
      }
    }

    const abortSignal = this.abortController.signal;

    // Optional presence greeting in background
    if (this.options.announce !== false) {
      const presenceText = this.workspaces.length > 1
        ? `🟢 Superagent is now active in WATCH mode (controlled by Muse) on ${this.workspaces.length} projects:\n${this.workspaces.map((w, i) => `${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
        : `🟢 Superagent is now active in WATCH mode (controlled by Muse) on workspace: ${primaryWs}`;

      const presenceEnvelope: RemoteAgentEnvelope = {
        v: 1,
        kind: "chat",
        text: presenceText,
      };
      this.transport.sendEnvelope(presenceEnvelope).catch(() => {});
    }

    // Start background transport loop
    this.transport
      .start(async (envelope, meta) => {
        await this.handleEnvelope(envelope, meta);
      }, abortSignal)
      .catch((err: any) => {
        if (!abortSignal.aborted) {
          logE2E("REMOTE-AGENT", `MuseWatcher transport error: ${err?.message || err}`);
          this.emitLine("error", `[Muse Watch] Transport error: ${err?.message || err}`);
          this.isRunning = false;
          this.options.onStatusChange?.(false);
        }
      });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    for (const item of this.batchQueue) {
      item.resolve?.();
    }
    this.batchQueue = [];
    this.activeBatchIds.clear();
    this.pendingReplyMessageIds.clear();

    this.abortAllBatches();

    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
      this.abortController = null;
    }

    logE2E("REMOTE-AGENT", "MuseWatcher stopped.");

    if (this.options.announce !== false && this.transport) {
      const offlineEnvelope: RemoteAgentEnvelope = {
        v: 1,
        kind: "chat",
        text: "🔴 Superagent WATCH mode stopped.",
      };
      this.transport.sendEnvelope(offlineEnvelope).catch(() => {});
    }

    if (this.transport) {
      try {
        await this.transport.stop();
      } catch {}
    }

    if (this.quickTunnelStarted) {
      try {
        const { stopQuickTunnel } = await import("./cloudflareTunnel.js");
        await stopQuickTunnel();
      } catch {}
      this.quickTunnelStarted = false;
      this.tunnelMetadata = null;
    }

    this.options.onStatusChange?.(false);
    this.emitLine("system", "[Muse Watch] Watch mode stopped. Superagent is back in manual mode.");
  }

  /**
   * Dispatches incoming validated envelopes from Muse.
   * Batch execution is enqueued to ensure orderly execution.
   */
  private async handleEnvelope(
    envelope: RemoteAgentEnvelope,
    meta?: RemoteEnvelopeMeta
  ): Promise<void> {
    this.lastActiveAt = Date.now();

    switch (envelope.kind) {
      case "task_batch": {
        await this.enqueueBatch(envelope as TaskBatchEnvelope, meta);
        break;
      }

      case "task_done": {
        await this.enqueueDone(envelope as TaskDoneEnvelope);
        break;
      }

      case "task_cancel": {
        this.handleTaskCancel(envelope as TaskCancelEnvelope);
        break;
      }

      case "session_reset": {
        this.handleSessionReset(envelope as SessionResetEnvelope);
        break;
      }

      case "chat": {
        this.handleChat(envelope as ChatEnvelope);
        break;
      }

      default:
        logE2E("REMOTE-AGENT", `MuseWatcher received unhandled envelope kind: ${envelope.kind}`);
        break;
    }
  }

  private async enqueueBatch(
    envelope: TaskBatchEnvelope,
    meta?: RemoteEnvelopeMeta
  ): Promise<void> {
    const batchId = envelope.id;
    if (batchId) {
      // 1. If this batch is currently in progress (in queue or executing):
      if (this.activeBatchIds.has(batchId)) {
        logE2E(
          "REMOTE-AGENT",
          `MuseWatcher received duplicate task_batch while already in progress: ${batchId}`
        );
        this.emitLine(
          "system",
          `[Muse Watch] Batch ${batchId} is already executing. Result will be posted upon completion.`
        );
        if (meta?.messageId) {
          const pending = this.pendingReplyMessageIds.get(batchId) || new Set<number>();
          pending.add(meta.messageId);
          this.pendingReplyMessageIds.set(batchId, pending);
        }
        return;
      }

      // 2. If this batch already completed:
      if (this.completedBatchResults.has(batchId)) {
        const cached = this.completedBatchResults.get(batchId)!;
        if (cached.hasError) {
          // Previously failed; Muse or operator is retrying the batch
          logE2E(
            "REMOTE-AGENT",
            `MuseWatcher retrying previously failed task_batch: ${batchId}`
          );
          this.emitLine(
            "system",
            `⚡ [Muse Watch] Retrying previously failed batch ${batchId} (${envelope.calls?.length || 0} calls)`
          );
          this.completedBatchResults.delete(batchId);
          // Fall through to enqueue for re-execution
        } else {
          // Previously succeeded; re-send cached result immediately to satisfy Muse/Telegram
          logE2E(
            "REMOTE-AGENT",
            `MuseWatcher re-sending cached successful result for duplicate task_batch: ${batchId}`
          );
          this.emitLine(
            "system",
            `⚡ [Muse Watch] Re-sending cached result for duplicate batch ${batchId}`
          );
          await this.transport.sendEnvelope(
            cached.resultEnvelope,
            meta,
            this.options.onProgress
          );
          return;
        }
      }

      this.activeBatchIds.add(batchId);
      this.seenBatchIds.add(batchId);
      if (this.seenBatchIds.size > 1000) {
        const toRemove = Array.from(this.seenBatchIds).slice(0, 500);
        for (const id of toRemove) this.seenBatchIds.delete(id);
      }
    }

    logE2E(
      "REMOTE-AGENT",
      `MuseWatcher enqueued task_batch: id=${envelope.id}, task_id=${envelope.task_id}, queue_len=${this.batchQueue.length + 1}`
    );

    return new Promise<void>((resolve, reject) => {
      this.batchQueue.push({
        type: "batch",
        envelope,
        meta,
        resolve: () => {
          if (batchId) this.activeBatchIds.delete(batchId);
          resolve();
        },
        reject: (err) => {
          if (batchId) this.activeBatchIds.delete(batchId);
          reject(err);
        },
      });

      this.processBatchQueue().catch((err) => {
        logE2E("REMOTE-AGENT", `MuseWatcher queue processing error: ${err?.message || err}`);
      });
    });
  }

  private enqueueDone(envelope: TaskDoneEnvelope): Promise<void> {
    logE2E("REMOTE-AGENT", `MuseWatcher enqueued task_done for task: ${envelope.task_id}`);

    return new Promise<void>((resolve, reject) => {
      this.batchQueue.push({
        type: "done",
        envelope,
        resolve,
        reject,
      });

      this.processBatchQueue().catch((err) => {
        logE2E("REMOTE-AGENT", `MuseWatcher queue processing error: ${err?.message || err}`);
      });
    });
  }

  private async processBatchQueue(): Promise<void> {
    if (this.isProcessingQueue || !this.isRunning) {
      return;
    }
    this.isProcessingQueue = true;

    try {
      while (this.batchQueue.length > 0 && this.isRunning) {
        const item = this.batchQueue.shift();
        if (!item) break;

        try {
          if (item.type === "batch") {
            await this.handleTaskBatch(item.envelope as TaskBatchEnvelope, item.meta);
          } else if (item.type === "done") {
            await this.handleTaskDone(item.envelope as TaskDoneEnvelope);
          }
          item.resolve?.();
        } catch (err: any) {
          item.reject?.(err);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private async handleTaskBatch(
    envelope: TaskBatchEnvelope,
    meta?: RemoteEnvelopeMeta
  ): Promise<void> {
    this.activeTaskId = envelope.task_id;
    const callsCount = envelope.calls?.length || 0;

    let targetWs = this.workspaces[0] || process.cwd();
    const batchTarget = envelope.workspace || envelope.project;
    if (batchTarget && typeof batchTarget === "string" && batchTarget.trim()) {
      const trimmedTarget = batchTarget.trim();
      const resolvedTarget = path.resolve(trimmedTarget);
      const isWin = process.platform === "win32";

      const matched = this.workspaces.find((w) => {
        const rw = path.resolve(w);
        if (isWin ? rw.toLowerCase() === resolvedTarget.toLowerCase() : rw === resolvedTarget) return true;
        if (isWin ? path.basename(w).toLowerCase() === trimmedTarget.toLowerCase() : path.basename(w) === trimmedTarget) return true;
        return isWin ? w.toLowerCase().includes(trimmedTarget.toLowerCase()) : w.includes(trimmedTarget);
      });
      if (matched) {
        targetWs = matched;
      }
    }

    logE2E(
      "REMOTE-AGENT",
      `MuseWatcher executing task_batch: id=${envelope.id}, task_id=${envelope.task_id}, calls=${callsCount}, workspace=${targetWs}`
    );

    const wsLabel = path.basename(targetWs);
    this.emitLine(
      "system",
      `⚡ [Muse Watch] Received tool batch (${callsCount} calls) for task ${envelope.task_id}${this.workspaces.length > 1 ? ` [Target: ${wsLabel}]` : ""}`
    );
    this.options.onProgress?.(`Executing ${callsCount} tool call(s) for task ${envelope.task_id}...`);

    const batchAbort = new AbortController();
    this.activeBatchAborts.add(batchAbort);
    const batchSignal = this.abortController?.signal
      ? AbortSignal.any([this.abortController.signal, batchAbort.signal])
      : batchAbort.signal;

    try {
      const results = await executeBatch(envelope.calls || [], {
        workspace: targetWs,
        workspaces: this.workspaces,
        batchWorkspace: envelope.workspace,
        batchProject: envelope.project,
        agent: this.options.agent,
        signal: batchSignal,
        autoApproveWorkspace: this.options.autoApproveWorkspace ?? true,
        onToolStart: this.options.onToolStart,
        onToolEnd: this.options.onToolEnd,
        onProgress: this.options.onProgress,
        onPermissionPrompt: this.options.onPermissionPrompt,
        onWaitingPermission: async (toolCall, reason) => {
          const waitingMsg = `⏳ Waiting for human permission approval in Superagent terminal:\n- Reason: ${reason}\n- Status: Idle (awaiting operator input)`;
          this.emitLine("system", `[Muse Watch] ${waitingMsg}`);
          try {
            await this.options.onWaitingPermission?.(toolCall, reason);
          } catch {}

          try {
            const chatEnv: RemoteAgentEnvelope = {
              v: 1,
              kind: "chat",
              text: waitingMsg,
            };
            await this.transport.sendEnvelope(chatEnv, meta);
          } catch (err: any) {
            logE2E("REMOTE-AGENT", `Failed to send waiting permission notice to Muse: ${err?.message || err}`);
          }
        },
        onPermissionDecision: async (toolCall, reason, approved) => {
          const decisionMsg = approved
            ? `✅ Human operator approved permission for: ${reason}. Resuming execution.`
            : `❌ Human operator denied permission for: ${reason}.`;
          this.emitLine("system", `[Muse Watch] ${decisionMsg}`);
          try {
            await this.options.onPermissionDecision?.(toolCall, reason, approved);
          } catch {}

          try {
            const chatEnv: RemoteAgentEnvelope = {
              v: 1,
              kind: "chat",
              text: decisionMsg,
            };
            await this.transport.sendEnvelope(chatEnv, meta);
          } catch (err: any) {
            logE2E("REMOTE-AGENT", `Failed to send permission decision notice to Muse: ${err?.message || err}`);
          }
        },
      });

      this.batchesExecuted++;

      // If batch was aborted during execution, do not post results back
      if (batchAbort.signal.aborted || this.abortController?.signal.aborted) {
        logE2E(
          "REMOTE-AGENT",
          `MuseWatcher batch ${envelope.id} was aborted. Skipping posting results back.`
        );
        return;
      }

      const resultEnvelope: TaskResultEnvelope = {
        v: 1,
        kind: "task_result",
        id: envelope.id,
        task_id: envelope.task_id,
        results,
      };

      const hasError = results.some(
        (r) => !r.ok || (typeof r.error === "string" && r.error.length > 0)
      );

      if (envelope.id) {
        this.completedBatchResults.set(envelope.id, {
          resultEnvelope,
          completedAt: Date.now(),
          hasError,
        });
        if (this.completedBatchResults.size > 500) {
          const oldestKey = this.completedBatchResults.keys().next().value;
          if (oldestKey) this.completedBatchResults.delete(oldestKey);
        }
      }

      logE2E(
        "REMOTE-AGENT",
        `MuseWatcher completed batch ${envelope.id} with ${results.length} result(s). Posting back via transport.`
      );

      const sent = await this.transport.sendEnvelope(
        resultEnvelope,
        meta,
        this.options.onProgress
      );
      if (!sent) {
        this.emitLine(
          "error",
          `[Muse Watch] Failed to send tool results for batch ${envelope.id} via transport.`
        );
      }

      if (envelope.id && this.pendingReplyMessageIds.has(envelope.id)) {
        const extraReplyIds = this.pendingReplyMessageIds.get(envelope.id);
        this.pendingReplyMessageIds.delete(envelope.id);
        if (extraReplyIds) {
          for (const extraId of extraReplyIds) {
            if (extraId !== meta?.messageId) {
              await this.transport.sendEnvelope(resultEnvelope, { messageId: extraId }).catch(() => {});
            }
          }
        }
      }
    } catch (err: any) {
      logE2E("REMOTE-AGENT", `MuseWatcher batch execution error: ${err?.message || err}`);
      this.emitLine("error", `[Muse Watch] Error executing tool batch: ${err?.message || err}`);
    } finally {
      this.activeBatchAborts.delete(batchAbort);
      if (envelope.id) {
        this.activeBatchIds.delete(envelope.id);
      }
    }
  }

  private async handleTaskDone(envelope: TaskDoneEnvelope): Promise<void> {
    this.tasksCompleted++;
    const finishedTaskId = envelope.task_id;
    this.activeTaskId = undefined;

    logE2E("REMOTE-AGENT", `MuseWatcher received task_done for task ${finishedTaskId}`);

    const readableSummary = formatReadableSummary(envelope.summary || "");
    const formattedSummary =
      readableSummary.startsWith("📋") || /^task summary/i.test(readableSummary)
        ? readableSummary
        : `📋 Task Summary (Muse Remote)\n────────────────────────────────────────────\n${readableSummary}`;

    this.emitLine("assistant", formattedSummary);

    if (this.options.agent) {
      try {
        this.options.agent.getHistory().addAssistantMessage(readableSummary);
        const histPath = this.options.agent.getCurrentHistoryFilePath?.();
        if (histPath) {
          await this.options.agent.getHistory().saveToFile(
            histPath,
            this.options.agent.planState,
            this.options.agent.workingDirectory
          );
        }
      } catch (err: any) {
        logE2E("REMOTE-AGENT", `Failed to persist task_done to history: ${err?.message || err}`);
      }
    }

    this.emitLine(
      "system",
      `[Muse Watch] Task ${finishedTaskId} completed. Superagent is waiting for next instruction from Muse.`
    );
  }

  /** Aborts every in-flight tool batch (used by task_cancel and session_reset). */
  private abortAllBatches(): void {
    for (const c of this.activeBatchAborts) {
      try {
        c.abort();
      } catch {}
    }
    this.activeBatchAborts.clear();
  }

  private handleTaskCancel(envelope: TaskCancelEnvelope): void {
    logE2E("REMOTE-AGENT", `MuseWatcher received task_cancel for task ${envelope.task_id}`);

    const targetTaskId = envelope.task_id?.trim();
    if (!targetTaskId || !this.activeTaskId || targetTaskId === this.activeTaskId.trim()) {
      this.abortAllBatches();
      this.activeTaskId = undefined;
    }

    // Filter out queued items for this task_id (or all if task_id not specified)
    if (targetTaskId) {
      const remaining: typeof this.batchQueue = [];
      for (const item of this.batchQueue) {
        if (item.envelope.task_id?.trim() === targetTaskId) {
          if (item.type === "batch") {
            const batchId = (item.envelope as TaskBatchEnvelope).id;
            if (batchId) {
              this.activeBatchIds.delete(batchId);
              this.pendingReplyMessageIds.delete(batchId);
            }
          }
          item.resolve?.();
        } else {
          remaining.push(item);
        }
      }
      this.batchQueue = remaining;
    } else {
      for (const item of this.batchQueue) {
        if (item.type === "batch") {
          const batchId = (item.envelope as TaskBatchEnvelope).id;
          if (batchId) {
            this.activeBatchIds.delete(batchId);
            this.pendingReplyMessageIds.delete(batchId);
          }
        }
        item.resolve?.();
      }
      this.batchQueue = [];
    }

    this.emitLine(
      "system",
      `[Muse Watch] Task ${envelope.task_id || "active"} cancelled by Muse (${envelope.reason || "no reason provided"}).`
    );
  }

  /**
   * Public: resets the local session context immediately.
   * Used by /muse new|reset in the terminal and by incoming session_reset envelopes.
   */
  public resetLocalSession(origin: string, message?: string): void {
    // Stop any in-flight batch so stale results don't pollute the fresh session
    this.abortAllBatches();

    // Clear queue and resolve pending promises
    for (const item of this.batchQueue) {
      item.resolve?.();
    }
    this.batchQueue = [];

    // Clear dedup sets so legitimate retries after reset are not ignored
    this.seenBatchIds.clear();
    this.seenChatIds.clear();
    this.activeBatchIds.clear();
    this.completedBatchResults.clear();
    this.pendingReplyMessageIds.clear();

    this.activeTaskId = undefined;
    if (this.options.agent) {
      try {
        this.options.agent.getHistory().clear();
      } catch {}
    }

    this.emitLine(
      "system",
      `[Muse Watch] Session context reset ${origin} (${message || "memory cleared"}).`
    );
  }

  private handleSessionReset(envelope: SessionResetEnvelope): void {
    logE2E("REMOTE-AGENT", `MuseWatcher received session_reset: session=${envelope.session}`);
    this.resetLocalSession("by Muse", envelope.message || undefined);
  }

  private handleChat(envelope: ChatEnvelope): void {
    // Dedupe redelivered chat notes
    if (envelope.id) {
      if (this.seenChatIds.has(envelope.id)) {
        logE2E("REMOTE-AGENT", `MuseWatcher ignoring duplicate chat note: ${envelope.id}`);
        return;
      }
      this.seenChatIds.add(envelope.id);
      if (this.seenChatIds.size > 1000) this.seenChatIds.clear();
    }

    logE2E("REMOTE-AGENT", `MuseWatcher received chat note: ${envelope.text}`);

    this.emitLine("assistant", `[Muse Note]: ${envelope.text}`);
  }
}

// ─── Singleton Watcher Instance ─────────────────────────────────────────────

let globalMuseWatcher: MuseWatcher | null = null;

export function getMuseWatcher(): MuseWatcher | null {
  return globalMuseWatcher;
}

export function isMuseWatcherActive(): boolean {
  return Boolean(globalMuseWatcher && globalMuseWatcher.isActive());
}

export async function startMuseWatcher(options: MuseWatcherOptions = {}): Promise<MuseWatcher> {
  if (globalMuseWatcher && globalMuseWatcher.isActive()) {
    if (options.workspaces && options.workspaces.length > 0) {
      for (const w of options.workspaces) {
        globalMuseWatcher.addWorkspace(w);
      }
    } else if (options.workspace) {
      globalMuseWatcher.addWorkspace(options.workspace);
    }
    return globalMuseWatcher;
  }
  globalMuseWatcher = new MuseWatcher(options);
  await globalMuseWatcher.start();
  return globalMuseWatcher;
}

export async function stopMuseWatcher(): Promise<boolean> {
  if (!globalMuseWatcher) {
    return false;
  }
  await globalMuseWatcher.stop();
  globalMuseWatcher = null;
  return true;
}
