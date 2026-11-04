import type { Tool } from "./types.js";
import { delegateBridge, type DelegateMethod } from "../delegate/bridge.js";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

function tool(
  name: DelegateMethod,
  description: string,
  parameters: Record<string, unknown>,
  prepare: (args: Record<string, unknown>) => Record<string, unknown>,
  timeoutMs = 20_000,
): Tool {
  return {
    name, description, parameters,
    async execute(args: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<string> {
      try {
        return await delegateBridge.request(name, prepare(args), signal, timeoutMs);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

const emptyArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  if (Object.keys(args).length) throw new Error("This tool takes no arguments");
  return {};
};

export const delegateCreateChatTool: Tool = tool(
  "delegate.create_chat",
  "Start a new ChatGPT conversation in an existing logged-in chatgpt.com tab. Never reloads to recover.",
  schema({}),
  emptyArgs,
);

export const delegateReadChatTool: Tool = tool(
  "delegate.read_chat",
  "Read current ChatGPT messages, status (working/finished/waiting_for_input), and latest response text. Read-only.",
  schema({}),
  emptyArgs,
);

export const delegateSendMessageTool: Tool = tool(
  "delegate.send_message",
  "Send a message exactly once to the current ChatGPT chat. On timeout it never resends; inspect with delegate.read_chat.",
  schema({ message: { type: "string", minLength: 1, maxLength: 100_000 } }, ["message"]),
  (args) => {
    if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000) {
      throw new Error("DELEGATE_INVALID_MESSAGE: message must be a nonempty string of at most 100000 characters");
    }
    return { message: args.message };
  },
  30_000,
);

export const delegateStopGenerationTool: Tool = tool(
  "delegate.stop_generation",
  "Stop ChatGPT generation only when explicitly requested. Never called as timeout or abort recovery.",
  schema({}),
  emptyArgs,
);
