export interface ParsedToolCall {
    id: string;
    name: string;
    args: Record<string, any>;
}
/**
 * Parses XML-formatted tool calls from model response text.
 * Handles:
 * 1. <function_calls><invoke name="tool_name">...</invoke></function_calls> (Anthropic-style)
 * 2. <invoke name="tool_name">...</invoke> (Standalone invoke)
 * 3. <tool_name>...</tool_name> (Direct tag matching an active tool name)
 *
 * It extracts all detected tool calls and returns a cleaned version of the text
 * with these XML blocks removed.
 */
export declare function parseXmlToolCalls(textContent: string, toolDefs: {
    name: string;
}[]): {
    toolCalls: ParsedToolCall[];
    cleanText: string;
};
export declare class StreamXmlFilter {
    private buffer;
    private onText;
    private toolNames;
    private activeTags;
    constructor(onText: (text: string) => void, toolDefs: {
        name: string;
    }[]);
    push(delta: string): void;
    flush(): void;
    private process;
}
//# sourceMappingURL=xmlToolParser.d.ts.map