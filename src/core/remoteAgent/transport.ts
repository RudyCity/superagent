import { RemoteAgentEnvelope } from "./protocol.js";
import { RemoteAgentConfig, maskToken } from "./config.js";
import { MuseClient } from "./museClient.js";

export interface RemoteEnvelopeMeta {
  messageId?: number;
  senderId?: number | string;
  senderUsername?: string;
  transport?: "telegram" | "websocket" | "https";
  connectionId?: string;
}

export type EnvelopeHandler = (
  envelope: RemoteAgentEnvelope,
  meta?: RemoteEnvelopeMeta
) => Promise<void> | void;

export interface RemoteTransport {
  readonly type: "telegram" | "websocket" | "https";
  start(onEnvelope: EnvelopeHandler, abortSignal?: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  sendEnvelope(
    envelope: RemoteAgentEnvelope,
    replyToMeta?: RemoteEnvelopeMeta,
    onProgress?: (message: string) => void
  ): Promise<boolean>;
  isConnected(): boolean;
  getTransportInfo(): { type: "telegram" | "websocket" | "https"; details: string };
}

/**
 * TelegramTransport wraps MuseClient to satisfy the RemoteTransport interface.
 */
export class TelegramTransport implements RemoteTransport {
  public readonly type = "telegram" as const;
  private client: MuseClient;
  private config: RemoteAgentConfig;
  private isStarted = false;
  private abortController: AbortController | null = null;

  constructor(config: RemoteAgentConfig, client?: MuseClient) {
    this.config = { ...config };
    this.client = client || new MuseClient(this.config);
  }

  public getClient(): MuseClient {
    return this.client;
  }

  public async start(onEnvelope: EnvelopeHandler, abortSignal?: AbortSignal): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;
    this.abortController = new AbortController();

    const signal = abortSignal || this.abortController.signal;

    return this.client.pollEnvelopes(async (envelope, meta) => {
      await onEnvelope(envelope, {
        messageId: meta?.messageId,
        transport: "telegram",
      });
    }, signal);
  }

  public async stop(): Promise<void> {
    if (!this.isStarted) return;
    this.isStarted = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  public async sendEnvelope(
    envelope: RemoteAgentEnvelope,
    replyToMeta?: RemoteEnvelopeMeta,
    onProgress?: (message: string) => void
  ): Promise<boolean> {
    return this.client.sendEnvelope(
      envelope,
      this.config.groupId,
      replyToMeta?.messageId,
      onProgress
    );
  }

  public isConnected(): boolean {
    return this.isStarted && this.client.isPollerActive();
  }

  public getTransportInfo(): { type: "telegram"; details: string } {
    return {
      type: "telegram",
      details: `Telegram (Group: ${this.config.groupId || "none"}, MuseBotId: ${this.config.museBotId || "none"}, Token: ${maskToken(this.config.botToken)})`,
    };
  }
}

/**
 * HttpsTransport wraps Superagent HTTP REST/SSE server for watch mode.
 */
export class HttpsTransport implements RemoteTransport {
  public readonly type = "https" as const;
  private port: number;
  private isRunning = false;

  constructor(port: number = 7888) {
    this.port = port;
  }

  public async start(onEnvelope: EnvelopeHandler, abortSignal?: AbortSignal): Promise<void> {
    this.isRunning = true;
    const { ensureSuperagentServer } = await import("./cloudflareTunnel.js");
    await ensureSuperagentServer(this.port);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
  }

  public async sendEnvelope(
    envelope: RemoteAgentEnvelope,
    replyToMeta?: RemoteEnvelopeMeta,
    onProgress?: (message: string) => void
  ): Promise<boolean> {
    return true;
  }

  public isConnected(): boolean {
    return this.isRunning;
  }

  public getTransportInfo(): { type: "https"; details: string } {
    return {
      type: "https",
      details: `HTTP REST/SSE Server (port ${this.port})`,
    };
  }
}
