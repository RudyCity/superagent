export interface TaskContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TaskRequestEnvelope {
  v: 1;
  kind: "task_request";
  id: string;
  session?: string;
  task: string;
  workspace: string;
  tools: string[];
  reply_hint?: string;
  system_prompt?: string;
  context?: TaskContextMessage[];
}

export interface BatchToolCall {
  id: string;
  tool: string;
  args?: Record<string, any>;
}

export interface TaskBatchEnvelope {
  v: 1;
  kind: "task_batch";
  id: string;
  task_id: string;
  calls: BatchToolCall[];
}

export interface BatchToolResult {
  id: string;
  ok: boolean;
  output?: string;
  error?: string;
}

export interface TaskResultEnvelope {
  v: 1;
  kind: "task_result";
  id: string;
  task_id: string;
  results: BatchToolResult[];
}

export interface TaskDoneEnvelope {
  v: 1;
  kind: "task_done";
  id?: string;
  task_id: string;
  summary: string;
}

export interface ChatEnvelope {
  v: 1;
  kind: "chat";
  text: string;
}

export interface SessionResetEnvelope {
  v: 1;
  kind: "session_reset";
  id?: string;
  session?: string;
  message?: string;
  system_prompt?: string;
}

export interface TaskCancelEnvelope {
  v: 1;
  kind: "task_cancel";
  id?: string;
  task_id: string;
  reason?: string;
}

export const DEFAULT_MUSE_SYSTEM_PROMPT = `You are Muse, the remote cognitive brain for Superagent CLI running locally on the user's computer.
You reason and plan high-level tasks; Superagent executes tool batches locally on the file system and terminal.

COMMUNICATION PROTOCOL (JSON envelopes, v: 1):
1. Format all responses strictly as valid JSON envelopes or MUSEBUS chunks.
2. Tools available:
   - File inspection: read, glob, grep, ripgrep_search
   - File editing: write, edit, write_to_file, replace_file_content, apply_patch
   - Shell & Terminal: run_command (args: { "command": "<cmd>" }), bash (args: { "command": "<cmd>" })
3. Tool batch (task_batch):
   When you need to inspect files, edit code, or run commands, reply with:
   {"v": 1, "kind": "task_batch", "id": "batch_<uuid>", "task_id": "<task_id>", "calls": [{"id": "c1", "tool": "run_command", "args": {"command": "git status"}}]}
   Superagent executes the batch locally and returns task_result with outputs.
4. Completion (task_done):
   When the task is complete, reply with:
   {"v": 1, "kind": "task_done", "task_id": "<task_id>", "summary": "<formatted markdown summary>"}
   Format the summary with clean paragraphs, double newlines, bullet points (-), and numbered items (1., 2.) for terminal readability.
5. Task cancellation (task_cancel):
   When you receive {"v": 1, "kind": "task_cancel", "task_id": "<task_id>"}, immediately halt all reasoning and abort the task. Do not send further batches.
6. Session reset (session_reset):
   When you receive {"v": 1, "kind": "session_reset", "session": "<id>"}, clear previous conversational working memory and start fresh.`;

export type RemoteAgentEnvelope =
  | TaskRequestEnvelope
  | TaskBatchEnvelope
  | TaskResultEnvelope
  | TaskDoneEnvelope
  | ChatEnvelope
  | SessionResetEnvelope
  | TaskCancelEnvelope;

export const CHUNK_HEADER_PREFIX = "MUSEBUS";
export const DEFAULT_MAX_CHUNK_SIZE = 3800;
export const REASSEMBLY_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Encodes an envelope as an array of Telegram message text strings.
 * If the serialized JSON is under maxChunkSize (~3800 chars), returns a single string.
 * Otherwise, splits it into multiple MUSEBUS-prefixed chunks.
 */
export function encodeEnvelope(
  envelope: RemoteAgentEnvelope,
  maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE
): string[] {
  const json = JSON.stringify(envelope);
  if (json.length <= maxChunkSize) {
    return [json];
  }

  const envelopeId =
    (envelope as any).id || (envelope as any).task_id || `env_${Date.now()}`;
  const rawChunks: string[] = [];
  let pos = 0;

  while (pos < json.length) {
    rawChunks.push(json.slice(pos, pos + maxChunkSize));
    pos += maxChunkSize;
  }

  const total = rawChunks.length;
  return rawChunks.map(
    (chunk, index) => `${CHUNK_HEADER_PREFIX} ${envelopeId} ${index + 1}/${total}\n${chunk}`
  );
}

interface PendingAssembly {
  envelopeId: string;
  parts: Map<number, string>;
  totalParts: number;
  createdAt: number;
}

/**
 * Reassembles incoming Telegram text chunks into full RemoteAgentEnvelope objects.
 * Handles both plain single JSON messages and chunked MUSEBUS messages.
 */
export class EnvelopeReassembler {
  private pending: Map<string, PendingAssembly> = new Map();
  private ttlMs: number;

  constructor(ttlMs: number = REASSEMBLY_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending.entries()) {
      if (now - entry.createdAt > this.ttlMs) {
        this.pending.delete(id);
      }
    }
  }

  /**
   * Processes a raw inbound Telegram message string.
   * Returns a parsed envelope if the message completed an envelope, or null if incomplete/invalid.
   */
  public processMessage(rawText: string): RemoteAgentEnvelope | null {
    this.pruneExpired();

    if (!rawText || typeof rawText !== "string") {
      return null;
    }

    const trimmed = rawText.trim();
    if (trimmed.startsWith(CHUNK_HEADER_PREFIX)) {
      // Chunk format: MUSEBUS <envelope_id> <n>/<N>\n<chunk>
      const match = trimmed.match(/^MUSEBUS\s+(\S+)\s+(\d+)\/(\d+)\n([\s\S]*)$/);
      if (!match) {
        return null;
      }

      const envelopeId = match[1];
      const partIndex = parseInt(match[2], 10);
      const totalParts = parseInt(match[3], 10);
      const chunkData = match[4];

      if (totalParts <= 0 || partIndex <= 0 || partIndex > totalParts) {
        return null;
      }

      let assembly = this.pending.get(envelopeId);
      if (!assembly) {
        assembly = {
          envelopeId,
          parts: new Map(),
          totalParts,
          createdAt: Date.now(),
        };
        this.pending.set(envelopeId, assembly);
      }

      assembly.parts.set(partIndex, chunkData);

      if (assembly.parts.size === assembly.totalParts) {
        const fullParts: string[] = [];
        for (let i = 1; i <= assembly.totalParts; i++) {
          const part = assembly.parts.get(i);
          if (part === undefined) {
            // Missing part in sequence, keep waiting
            return null;
          }
          fullParts.push(part);
        }
        this.pending.delete(envelopeId);
        const combinedJson = fullParts.join("");
        try {
          return JSON.parse(combinedJson) as RemoteAgentEnvelope;
        } catch {
          return null;
        }
      }

      return null;
    }

    // Direct JSON message
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        return parsed as RemoteAgentEnvelope;
      }
    } catch {
      // Not JSON or chunked format
    }

    return null;
  }

  public getPendingCount(): number {
    return this.pending.size;
  }

  public clear(): void {
    this.pending.clear();
  }
}

export interface ValidationContext {
  groupId?: string | number;
  museBotId?: string | number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  envelope?: RemoteAgentEnvelope;
}

/**
 * Validates envelope schema, sender authorization, and chat group matching.
 */
export function validateEnvelope(
  envelope: any,
  senderId?: string | number,
  chatId?: string | number,
  context?: ValidationContext
): ValidationResult {
  if (!envelope || typeof envelope !== "object") {
    return { valid: false, error: "Envelope is not an object" };
  }

  // 1. Group ID check (if provided in context)
  if (chatId !== undefined && context?.groupId !== undefined && context.groupId !== "") {
    if (String(chatId) !== String(context.groupId)) {
      return {
        valid: false,
        error: `Message chat ID (${chatId}) does not match configured group ID (${context.groupId})`,
      };
    }
  }

  // 2. Schema check: version
  if (envelope.v !== 1) {
    return { valid: false, error: `Unsupported protocol version: ${envelope.v}` };
  }

  // 3. Schema check: known kind
  const validKinds = ["task_request", "task_batch", "task_result", "task_done", "chat", "session_reset", "task_cancel"];
  if (!validKinds.includes(envelope.kind)) {
    return { valid: false, error: `Unknown envelope kind: ${envelope.kind}` };
  }

  // 4. Sender check: only Muse may issue batches or complete tasks
  if (
    senderId !== undefined &&
    context?.museBotId !== undefined &&
    context.museBotId !== "" &&
    (envelope.kind === "task_batch" || envelope.kind === "task_done")
  ) {
    if (String(senderId) !== String(context.museBotId)) {
      return {
        valid: false,
        error: `Envelope sender (${senderId}) is not the authorized Muse bot (${context.museBotId})`,
      };
    }
  }

  // 5. Per-kind schema validation
  switch (envelope.kind) {
    case "task_request": {
      if (!envelope.id || typeof envelope.id !== "string") {
        return { valid: false, error: "task_request missing valid 'id'" };
      }
      if (!envelope.task || typeof envelope.task !== "string") {
        return { valid: false, error: "task_request missing valid 'task'" };
      }
      if (!envelope.workspace || typeof envelope.workspace !== "string") {
        return { valid: false, error: "task_request missing valid 'workspace'" };
      }
      if (!Array.isArray(envelope.tools)) {
        return { valid: false, error: "task_request missing valid 'tools' array" };
      }
      if (envelope.system_prompt !== undefined && typeof envelope.system_prompt !== "string") {
        return { valid: false, error: "task_request invalid 'system_prompt': must be a string" };
      }
      break;
    }

    case "task_batch": {
      if (!envelope.id || typeof envelope.id !== "string") {
        return { valid: false, error: "task_batch missing valid 'id'" };
      }
      if (!envelope.task_id || typeof envelope.task_id !== "string") {
        return { valid: false, error: "task_batch missing valid 'task_id'" };
      }
      if (!Array.isArray(envelope.calls)) {
        return { valid: false, error: "task_batch missing valid 'calls' array" };
      }
      for (const call of envelope.calls) {
        if (!call || typeof call !== "object" || !call.id || !call.tool) {
          return { valid: false, error: "Invalid tool call inside task_batch calls" };
        }
      }
      break;
    }

    case "task_result": {
      if (!envelope.id || typeof envelope.id !== "string") {
        return { valid: false, error: "task_result missing valid 'id'" };
      }
      if (!envelope.task_id || typeof envelope.task_id !== "string") {
        return { valid: false, error: "task_result missing valid 'task_id'" };
      }
      if (!Array.isArray(envelope.results)) {
        return { valid: false, error: "task_result missing valid 'results' array" };
      }
      break;
    }

    case "task_done": {
      if (!envelope.task_id || typeof envelope.task_id !== "string") {
        return { valid: false, error: "task_done missing valid 'task_id'" };
      }
      if (typeof envelope.summary !== "string") {
        return { valid: false, error: "task_done missing valid 'summary'" };
      }
      break;
    }

    case "chat": {
      if (typeof envelope.text !== "string") {
        return { valid: false, error: "chat missing valid 'text'" };
      }
      break;
    }

    case "session_reset": {
      if (envelope.system_prompt !== undefined && typeof envelope.system_prompt !== "string") {
        return { valid: false, error: "session_reset invalid 'system_prompt': must be a string" };
      }
      break;
    }

    case "task_cancel": {
      if (!envelope.task_id || typeof envelope.task_id !== "string") {
        return { valid: false, error: "task_cancel missing valid 'task_id'" };
      }
      break;
    }
  }

  return { valid: true, envelope: envelope as RemoteAgentEnvelope };
}
