/**
 * Agent Client Protocol (ACP) - Runtime & Execution Bridge
 * Orchestrates Superagent's ContextManager and Agent loop with the AcpServer,
 * streaming LLM reasoning, text deltas, and human-in-the-loop approvals.
 */

import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { AcpServer } from "./acpServer.js";
import type { SessionPromptParams } from "./types.js";
import { Agent, type AgentEvent } from "../../agent.js";
import { getSystemPrompt } from "../../config/base.js";

export interface AcpRuntimeOptions {
  workspace?: string;
  inputStream?: Readable;
  outputStream?: Writable;
  name?: string;
  version?: string;
}

export class AcpRuntime {
  public readonly server: AcpServer;
  private agents = new Map<string, Agent>();
  private defaultWorkspace: string;

  constructor(options?: AcpRuntimeOptions) {
    this.defaultWorkspace = options?.workspace ? path.resolve(options.workspace) : process.cwd();

    this.server = new AcpServer({
      inputStream: options?.inputStream || process.stdin,
      outputStream: options?.outputStream || process.stdout,
      name: options?.name || "superagent-acp-core",
      version: options?.version || "1.14.107",
      onPrompt: this.handlePrompt.bind(this),
    });

    // Clean up agents when session is cancelled
    this.server.on("session_cancelled", ({ sessionId }: { sessionId: string }) => {
      const agent = this.agents.get(sessionId);
      if (agent) {
        agent.abort();
        this.agents.delete(sessionId);
      }
    });
  }

  /**
   * Dispatches incoming user prompt from ACP client to the bound Superagent Agent.
   */
  private async handlePrompt(params: SessionPromptParams, server: AcpServer): Promise<void> {
    const session = server.getSession(params.sessionId);
    const workspacePath = session?.workspacePath || this.defaultWorkspace;

    let agent = this.agents.get(params.sessionId);
    if (!agent) {
      agent = await this.createAgentForSession(params.sessionId, workspacePath, server);
      this.agents.set(params.sessionId, agent);
    }

    try {
      server.sendUpdate(params.sessionId, {
        kind: "status_change",
        status: "thinking",
        summary: "Processing prompt...",
      });

      let promptContent = typeof params.prompt === "string"
        ? params.prompt
        : (Array.isArray(params.prompt)
            ? params.prompt.map((p: any) => p.text || (typeof p === "string" ? p : "")).filter(Boolean).join("\n")
            : String(params.prompt));

      // Long loop / Goal Mode detection & activation
      const isLoopRequested = Boolean(
        params.loop ||
        params.context?.loop ||
        params.mode === "goal" ||
        params.mode === "loop" ||
        params.context?.mode === "goal" ||
        params.context?.mode === "loop"
      );
      const explicitGoal = params.goalMode || params.context?.goalMode;
      const goalMatch = promptContent.match(/^\/(?:goal|loop)\s+(.+)/is);

      if (goalMatch || explicitGoal || isLoopRequested) {
        const objective = goalMatch
          ? goalMatch[1].trim()
          : (explicitGoal ? String(explicitGoal).trim() : promptContent.trim());
        agent.goalMode = objective;
        promptContent = `GOAL MODE: Your primary objective is to achieve the following goal completely and verifiably:\n\n"${objective}"\n\nBegin immediately. Plan thoroughly, execute step by step, verify completion, and report back with GOAL_COMPLETE or GOAL_PARTIAL.`;
        server.sendUpdate(params.sessionId, {
          kind: "status_change",
          status: "thinking",
          summary: `🎯 Goal Mode Activated: ${objective.slice(0, 80)}`,
        });
      }

      if (params.maxIterations !== undefined || params.context?.maxIterations !== undefined) {
        const customMax = Number(params.maxIterations ?? params.context?.maxIterations);
        if (!isNaN(customMax) && customMax >= 0) {
          (agent as any).goalMaxIterations = customMax === 0 ? Infinity : customMax;
        }
      }

      await agent.sendMessage(promptContent);
      // Ensure terminal "done" notification is dispatched to ACP client when turn settles
      server.sendUpdate(params.sessionId, {
        kind: "status_change",
        status: "done",
        summary: "Completed turn",
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        server.sendUpdate(params.sessionId, {
          kind: "status_change",
          status: "done",
          summary: "Task aborted by user",
        });
      } else {
        server.sendUpdate(params.sessionId, {
          kind: "status_change",
          status: "error",
          summary: err?.message || String(err),
        });
      }
    }
  }

  /**
   * Creates an Agent instance with event interceptors wired directly to ACP notifications.
   */
  private async createAgentForSession(
    sessionId: string,
    workspacePath: string,
    server: AcpServer
  ): Promise<Agent> {
    const onEvent = (event: AgentEvent) => {
      if (event.type === "text" && event.content) {
        server.sendUpdate(sessionId, {
          kind: "text_chunk",
          delta: event.content,
        });
      } else if (event.type === "reasoning" && event.content) {
        server.sendUpdate(sessionId, {
          kind: "thought_chunk",
          delta: event.content,
        });
      } else if (event.type === "tool_start") {
        const ev = event as any;
        server.sendUpdate(sessionId, {
          kind: "tool_call_start",
          callId: ev.toolCall?.id || `call_${Date.now()}`,
          tool: ev.toolCall?.name || "system_tool",
          actor: "agent",
          description: ev.description,
        });
      } else if (event.type === "tool_end") {
        const ev = event as any;
        server.sendUpdate(sessionId, {
          kind: "tool_call_end",
          callId: ev.toolResult?.id || `call_${Date.now()}`,
          tool: ev.toolResult?.name || "system_tool",
          actor: "agent",
          status: ev.toolResult?.isError ? "failed" : "completed",
        });
      } else if (event.type === "done") {
        server.sendUpdate(sessionId, {
          kind: "status_change",
          status: "done",
          summary: "Completed turn",
        });
      } else if (event.type === "goal_done") {
        const ev = event as any;
        server.sendUpdate(sessionId, {
          kind: "status_change",
          status: ev.status === "complete" ? "done" : "thinking",
          summary: `Goal status: ${ev.status || "completed"}`,
        });
      } else if (event.type === "error") {
        server.sendUpdate(sessionId, {
          kind: "status_change",
          status: "error",
          summary: (event as any).message || "Execution error",
        });
      }
    };

    // Permission handler connects to ACP session/request_permission
    const onPermission = async (toolCall: any, description: string): Promise<boolean | "session"> => {
      const isWrite = toolCall?.name?.includes("write") || toolCall?.name?.includes("edit");
      const permissionId = toolCall?.id || `perm_${Date.now()}`;
      try {
        const res = await server.requestPermission({
          permissionId,
          sessionId,
          workspacePath,
          action: isWrite ? "file_write" : "command_execute",
          target: toolCall?.name || "system_tool",
          description,
          riskLevel: isWrite ? "medium" : "high",
        });
        if (res.decision === "approved_session") return "session";
        return res.decision === "approved";
      } catch {
        return false;
      }
    };

    const onQuestion = async (
      question: string | any,
      options?: string[]
    ): Promise<string> => {
      const qText = typeof question === "string" ? question : JSON.stringify(question || "");
      // Auto-continue loop when maximum iteration limit is reached
      if (
        (qText.includes("maximum iteration limit") || qText.includes("iteration limit")) &&
        Array.isArray(options) &&
        options.includes("Yes, continue")
      ) {
        server.sendUpdate(sessionId, {
          kind: "status_change",
          status: "thinking",
          summary: "Auto-continuing iteration block for long loop...",
        });
        return "Yes, continue";
      }
      return options?.[0] || "";
    };

    const acpSystemPrompt = getSystemPrompt("acp");

    const agent = new Agent(
      onEvent,
      onPermission,
      onQuestion,
      acpSystemPrompt,
      undefined,
      workspacePath
    );
    agent.tier = "single";
    return agent;
  }

  public getAgent(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  public start(): void {
    this.server.start();
  }

  public close(): void {
    this.server.close();
    for (const agent of this.agents.values()) {
      agent.abort();
    }
    this.agents.clear();
  }
}

/**
 * Top-level CLI entry point for running Superagent in ACP server mode over Stdio.
 */
export async function startSuperagentAcpServer(options?: AcpRuntimeOptions): Promise<AcpRuntime> {
  const runtime = new AcpRuntime(options);
  runtime.start();
  return runtime;
}
