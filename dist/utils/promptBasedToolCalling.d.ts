/**
 * promptBasedToolCalling.ts
 *
 * Provides a fallback mechanism for providers that don't support native
 * OpenAI-format tool calling (e.g. local OpenAI-compatible proxies wrapping
 * Claude models without forwarding the `tools` parameter).
 *
 * When detected, tool definitions are injected directly into the system prompt
 * as XML, and Claude's native XML-format tool call responses are parsed back
 * into structured ToolCall objects.
 */
export interface ToolDefinition {
    name: string;
    description: string;
    input_schema: {
        type: string;
        properties?: Record<string, {
            type: string;
            description?: string;
        }>;
        required?: string[];
    };
}
export declare function probeToolCallSupport(baseUrl: string, apiKey: string, model: string): Promise<boolean>;
/** Clears the tool-call-support probe cache (useful in tests). */
export declare function clearToolCallSupportCache(): void;
/**
 * Builds the XML tool definitions block that is injected into the system
 * prompt when native tool calling is unavailable.
 *
 * Claude is trained to recognize this format and will output tool calls as:
 *   <tool_calls>
 *     <tool_call>
 *       {"name": "tool_name", "arguments": {...}}
 *     </tool_call>
 *   </tool_calls>
 */
export declare function buildToolsSystemPromptBlock(tools: ToolDefinition[]): string;
//# sourceMappingURL=promptBasedToolCalling.d.ts.map