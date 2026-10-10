import path from "path";
import {
  loadRemoteAgentConfig,
  RemoteAgentConfig,
  getWatchedWorkspaces,
} from "./config.js";
import {
  RemoteAgentEnvelope,
  TaskRequestEnvelope,
  TaskBatchEnvelope,
  TaskResultEnvelope,
  TaskDoneEnvelope,
  ChatEnvelope,
  SessionResetEnvelope,
  TaskCancelEnvelope,
} from "./protocol.js";
import { MuseClient } from "./museClient.js";
import {
  RemoteTransport,
  TelegramTransport,
  HttpsTransport,
  RemoteEnvelopeMeta,
} from "./transport.js";
import { createMuseWsTransport, MuseWsServerTransport } from "./museWsTransport.js";
import { executeBatch } from "./batchExecutor.js";
import { formatReadableSummary } from "./formatSummary.js";
import { logE2E } from "../utils/unifiedLogger.js";
import {
  MuseWatcherStats,
  MuseWatcherOptions,
  BatchQueueItem,
} from "./museWatcherTypes.js";
import {
  startWatcherTunnel,
  stopWatcherTunnel,
  WatcherTunnelMetadata,
} from "./museWatcherTunnel.js";

export type { MuseWatcherStats, MuseWatcherOptions } from "./museWatcherTypes.js";
export * from "./museWatcherRegistry.js";

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
  private batchQueue: BatchQueueItem[] = [];
  private isProcessingQueue = false;
  private workspaces: string[] = [];
  private transport!: RemoteTransport;
  private quickTunnelStarted = false;
  private tunnelMetadata: WatcherTunnelMetadata | null = null;

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

    const effectiveType =
      this.options.transportType ||
      (this.options.isHttps ? "https" : this.config.transport) ||
      "telegram";

    if (effectiveType === "https" || this.options.isHttps) {
      const port = this.options.wsPort || 7888;
      this.transport = new HttpsTransport(port);
    } else if (effectiveType === "websocket") {
      const effectiveCfg = this.options.wsPort
        ? { ...this.config, wsPort: this.options.wsPort }
        : this.config;
      const wsTransport = createMuseWsTransport(effectiveCfg, this.options.customConfigPath);
      if (wsTransport instanceof MuseWsServerTransport) {
        wsTransport.onConnectionChange = (connected, connId) => {
          const msg = connected
            ? `🟢 [Muse Watch] Muse connected via WebSocket! Real-time session active (Conn: ${
                connId ? connId.slice(0, 8) : "active"
              }).`
            : "🟡 [Muse Watch] Muse WebSocket connection closed.";
          this.emitLine("system", msg);
        };
      }
      this.transport = wsTransport;
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
    const list = [
      ...(Array.isArray(this.options.workspaces) ? this.options.workspaces : []),
      ...(this.options.workspace ? [this.options.workspace] : []),
    ];
    if (list.length === 0) list.push(...getWatchedWorkspaces(this.config));

    const seen = new Set<string>();
    const isWin = process.platform === "win32";
    const normalized = list
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => path.resolve(item.trim()))
      .filter((resolved) => {
        const key = isWin ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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
    const ws =
      this.workspaces[0] ||
      path.resolve(
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
      tunnelUrl: this.tunnelMetadata?.publicUrl || this.tunnelMetadata?.wssUrl,
      tunnelPort: this.tunnelMetadata?.port,
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

    const wsInfoStr =
      this.workspaces.length > 1
        ? `- Watched Projects (${this.workspaces.length}):\n${this.workspaces
            .map((w, i) => `  ${i + 1}. ${path.basename(w)} (${w})`)
            .join("\n")}`
        : `- Workspace: ${primaryWs}`;

    this.emitLine(
      "system",
      `[Muse Watch] Superagent is now controlled by Muse.\n${wsInfoStr}\n- Transport: ${transportInfo.details}\n- Listening for incoming tool batches from Muse...`
    );

    if (
      this.options.tunnel &&
      (this.transport.type === "websocket" ||
        this.transport.type === "https" ||
        this.options.isHttps)
    ) {
      const res = await startWatcherTunnel({
        isHttps: this.transport.type === "https" || Boolean(this.options.isHttps),
        wsPort: this.options.wsPort,
        config: this.config,
        customConfigPath: this.options.customConfigPath,
        primaryWorkspace: primaryWs,
        workspaces: this.workspaces,
        emitLine: (t, c) => this.emitLine(t, c),
        onLog: (m) => this.options.onLog?.(m),
      });
      this.quickTunnelStarted = res.started;
      this.tunnelMetadata = res.metadata;
    }

    const abortSignal = this.abortController.signal;

    // Optional presence greeting in background
    if (this.options.announce !== false) {
      const presenceText =
        this.workspaces.length > 1
          ? `🟢 Superagent is now active in WATCH mode (controlled by Muse) on ${this.workspaces.length} projects:\n${this.workspaces
              .map((w, i) => `${i + 1}. ${path.basename(w)} (${w})`)
              .join("\n")}`
          : `🟢 Superagent is now active in WATCH mode (controlled by Muse) on workspace: ${primaryWs}`;

      this.transport
        .sendEnvelope({ v: 1, kind: "chat", text: presenceText })
        .catch(() => {});
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
    if (!this.isRunning) return;

    this.isRunning = false;
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
      this.transport
        .sendEnvelope({ v: 1, kind: "chat", text: "🔴 Superagent WATCH mode stopped." })
        .catch(() => {});
    }

    if (this.transport) {
      try {
        await this.transport.stop();
      } catch {}
    }

    if (this.quickTunnelStarted) {
      const isHttps = this.transport?.type === "https" || this.options.isHttps;
      const port = this.options.wsPort || (isHttps ? 7888 : this.config.wsPort || 9225);
      await stopWatcherTunnel(port);
      this.quickTunnelStarted = false;
      this.tunnelMetadata = null;
    }

    this.options.onStatusChange?.(false);
    this.emitLine("system", "[Muse Watch] Watch mode stopped. Superagent is back in manual mode.");
  }

  /**
   * Dispatches incoming validated envelopes from Muse.
   * Real-time: Batch and done ingress are enqueued asynchronously without blocking the transport poller.
   */
  public async handleEnvelope(
    envelope: RemoteAgentEnvelope,
    meta?: RemoteEnvelopeMeta
  ): Promise<void> {
    this.lastActiveAt = Date.now();

    switch (envelope.kind) {
      case "task_batch": {
        this.enqueueBatch(envelope as TaskBatchEnvelope, meta);
        break;
      }

      case "task_done": {
        this.enqueueDone(envelope as TaskDoneEnvelope);
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

      case "task_request": {
        await this.handleTaskRequest(envelope as TaskRequestEnvelope, meta);
        break;
      }

      default:
        logE2E("REMOTE-AGENT", `MuseWatcher received unhandled envelope kind: ${envelope.kind}`);
        break;
    }
  }

  private enqueueBatch(
    envelope: TaskBatchEnvelope,
    meta?: RemoteEnvelopeMeta
  ): void {
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
          this.transport
            .sendEnvelope(cached.resultEnvelope, meta, this.options.onProgress)
            .catch(() => {});
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

    this.batchQueue.push({
      type: "batch",
      envelope,
      meta,
    });

    this.processBatchQueue().catch((err) => {
      logE2E("REMOTE-AGENT", `MuseWatcher queue processing error: ${err?.message || err}`);
    });
  }

  private enqueueDone(envelope: TaskDoneEnvelope): void {
    logE2E("REMOTE-AGENT", `MuseWatcher enqueued task_done for task: ${envelope.task_id}`);

    this.batchQueue.push({
      type: "done",
      envelope,
    });

    this.processBatchQueue().catch((err) => {
      logE2E("REMOTE-AGENT", `MuseWatcher queue processing error: ${err?.message || err}`);
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
        } catch (err: any) {
          logE2E("REMOTE-AGENT", `MuseWatcher queue item processing error: ${err?.message || err}`);
        }
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Waits for all queued batches and in-flight executions to finish.
   * Useful for tests, graceful shutdown, and state synchronization.
   */
  public async waitForIdle(timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (this.batchQueue.length > 0 || this.isProcessingQueue) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`MuseWatcher.waitForIdle timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
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
      if (matched) targetWs = matched;
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

    // Start real-time typing status indicators for Telegram or supported transports
    let typingTimer: NodeJS.Timeout | null = null;
    const sendTyping = () => {
      if (typeof (this.transport as any).sendChatAction === "function") {
        (this.transport as any).sendChatAction("typing").catch(() => {});
      }
    };

    sendTyping();
    typingTimer = setInterval(() => {
      if (!this.isRunning || batchAbort.signal.aborted) {
        if (typingTimer) clearInterval(typingTimer);
        return;
      }
      sendTyping();
    }, 4000);

    try {
      const results = await executeBatch(envelope.calls || [], {
        workspace: targetWs,
        workspaces: this.workspaces,
        batchWorkspace: envelope.workspace,
        batchProject: envelope.project,
        agent: this.options.agent,
        signal: batchSignal,
        autoApproveWorkspace: this.options.autoApproveWorkspace ?? true,
        onToolStart: (toolCall, description) => {
          sendTyping();
          this.options.onToolStart?.(toolCall, description);
        },
        onToolEnd: this.options.onToolEnd,
        onProgress: this.options.onProgress,
        onPermissionPrompt: this.options.onPermissionPrompt,
        onWaitingPermission: async (toolCall, reason) => {
          const msg = `⏳ Waiting for human permission approval in Superagent terminal:\n- Reason: ${reason}\n- Status: Idle (awaiting operator input)`;
          this.emitLine("system", `[Muse Watch] ${msg}`);
          try { await this.options.onWaitingPermission?.(toolCall, reason); } catch {}
          try {
            await this.transport.sendEnvelope({ v: 1, kind: "chat", text: msg }, meta);
          } catch (e: any) {
            logE2E("REMOTE-AGENT", `Failed to send waiting permission notice to Muse: ${e?.message || e}`);
          }
        },
        onPermissionDecision: async (toolCall, reason, approved) => {
          const msg = approved
            ? `✅ Human operator approved permission for: ${reason}. Resuming execution.`
            : `❌ Human operator denied permission for: ${reason}.`;
          this.emitLine("system", `[Muse Watch] ${msg}`);
          try { await this.options.onPermissionDecision?.(toolCall, reason, approved); } catch {}
          try {
            await this.transport.sendEnvelope({ v: 1, kind: "chat", text: msg }, meta);
          } catch (e: any) {
            logE2E("REMOTE-AGENT", `Failed to send permission decision notice to Muse: ${e?.message || e}`);
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
      if (typingTimer) {
        clearInterval(typingTimer);
      }
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

  /**
   * Aborts active in-flight tool batches, with notification to Muse and terminal UI.
   * Returns true if there was an active batch or task that was aborted.
   */
  public abortActiveBatch(reason?: string): boolean {
    const hasAborts = this.activeBatchAborts.size > 0;
    const hasTask = Boolean(this.activeTaskId);
    if (!hasAborts && !hasTask) {
      return false;
    }

    logE2E(
      "REMOTE-AGENT",
      `MuseWatcher aborting active batch(es). Active aborts: ${this.activeBatchAborts.size}, Active task: ${this.activeTaskId}, Reason: ${reason || "User abort"}`
    );

    this.abortAllBatches();
    const prevTaskId = this.activeTaskId;
    this.activeTaskId = undefined;

    // Drain queued batches for this task
    this.batchQueue = [];
    this.activeBatchIds.clear();

    const notice = `⚠️ [Muse Watch] Tool batch execution aborted by operator: ${reason || "Interrupted by user"}`;
    this.emitLine("system", notice);

    // Send abort notification back to Muse so Muse brain knows its batch was cancelled
    if (this.transport && this.isRunning) {
      const abortEnvelope: RemoteAgentEnvelope = {
        v: 1,
        kind: "chat",
        text: `[Operator Abort] The active execution batch for task "${prevTaskId || "current"}" was stopped by the human operator.\nReason: ${reason || "Manual user interruption (Ctrl+C or /stop)"}. Please adjust your approach or wait for new instructions.`,
      };
      this.transport.sendEnvelope(abortEnvelope).catch(() => {});
    }

    return true;
  }

  public hasActiveBatch(): boolean {
    return this.activeBatchAborts.size > 0 || Boolean(this.activeTaskId);
  }

  /**
   * Sends a steering/intervention chat message directly to Muse over transport.
   */
  public async sendSteeringMessage(text: string): Promise<boolean> {
    if (!this.transport || !this.isRunning) {
      return false;
    }
    const steerEnvelope: RemoteAgentEnvelope = {
      v: 1,
      kind: "chat",
      text: `[Operator Intervention / Menyanggah]: ${text}`,
    };
    await this.transport.sendEnvelope(steerEnvelope);
    this.emitLine("system", `[Muse Steer] Sent intervention to Muse: "${text}"`);
    return true;
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
      this.batchQueue = this.batchQueue.filter((item) => {
        if (item.envelope.task_id?.trim() === targetTaskId) {
          const batchId = (item.envelope as TaskBatchEnvelope).id;
          if (batchId) {
            this.activeBatchIds.delete(batchId);
            this.pendingReplyMessageIds.delete(batchId);
          }
          return false;
        }
        return true;
      });
    } else {
      this.batchQueue = [];
      this.activeBatchIds.clear();
      this.pendingReplyMessageIds.clear();
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

    // Clear queue
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

  private async handleTaskRequest(
    envelope: TaskRequestEnvelope,
    _meta?: RemoteEnvelopeMeta
  ): Promise<void> {
    this.activeTaskId = envelope.id;
    logE2E("REMOTE-AGENT", `MuseWatcher received task_request: id=${envelope.id}, task=${envelope.task}`);

    this.emitLine(
      "system",
      `⚡ [Muse Remote Start] Task started by Muse: "${envelope.task}" (Task ID: ${envelope.id})`
    );

    if (envelope.workspace && typeof envelope.workspace === "string") {
      const targetWs = path.resolve(envelope.workspace.trim());
      if (!this.workspaces.includes(targetWs)) {
        this.addWorkspace(targetWs);
      }
    }

    const ackEnvelope: RemoteAgentEnvelope = {
      v: 1,
      kind: "chat",
      text: `Superagent accepted remote task: "${envelope.task}". Ready for tool execution batches.`,
    };
    this.transport.sendEnvelope(ackEnvelope).catch(() => {});
  }
}
