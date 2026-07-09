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

import fs from "fs";
import path from "path";
import { getRootConfigDir, ensureProtocol } from "../core/config/paths.js";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/**
 * Detects whether a given OpenAI-compatible endpoint actually supports tool
 * calling by sending a minimal probe request with a test tool definition.
 *
 * Returns true if the endpoint's response has `finish_reason: "tool_calls"`
 * or contains a structured `tool_calls` object. Returns false otherwise.
 *
 * Results are cached to disk to avoid repeated probes across CLI invocations.
 */
const toolCallSupportCache = new Map<string, boolean>();
let diskCacheLoaded = false;

function getCacheFilePath(): string {
  try {
    return path.join(getRootConfigDir(), "tool_support_cache.json");
  } catch {
    return "";
  }
}

function loadDiskCache(): void {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const cacheFile = getCacheFilePath();
    if (cacheFile && fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === "boolean") {
          toolCallSupportCache.set(key, value);
        }
      }
    }
  } catch {
    // Ignore cache load errors
  }
}

function saveDiskCache(): void {
  try {
    const cacheFile = getCacheFilePath();
    if (!cacheFile) return;
    const data: Record<string, boolean> = {};
    for (const [key, value] of toolCallSupportCache.entries()) {
      data[key] = value;
    }
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf-8");
  } catch {
    // Ignore cache save errors
  }
}

export async function probeToolCallSupport(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<boolean> {
  baseUrl = ensureProtocol(baseUrl) as string;
  loadDiskCache();
  const cacheKey = `${baseUrl}::${model}`;
  if (toolCallSupportCache.has(cacheKey)) {
    return toolCallSupportCache.get(cacheKey)!;
  }

  const probeBody = {
    model,
    messages: [{ role: "user", content: "You must call probe_tool with input 'hello'. do not reply with text, use the tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "probe_tool",
          description: "A test tool",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      },
    ],
    tool_choice: "auto",
    max_tokens: 128,
  };

  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(probeBody),
      signal: AbortSignal.timeout(30000), // Increased from 10000 to accommodate slower/local custom endpoints
    });

    if (!res.ok) {
      toolCallSupportCache.set(cacheKey, false);
      saveDiskCache();
      return false;
    }

    const json = (await res.json()) as any;
    const choice = json?.choices?.[0];
    const hasToolCalls = !!(
      choice?.finish_reason === "tool_calls" ||
      (choice?.message?.tool_calls && choice.message.tool_calls.length > 0)
    );

    toolCallSupportCache.set(cacheKey, hasToolCalls);
    saveDiskCache();
    return hasToolCalls;
  } catch {
    toolCallSupportCache.set(cacheKey, false);
    saveDiskCache();
    return false;
  }
}

/** Clears the tool-call-support probe cache (useful in tests). */
export function clearToolCallSupportCache(): void {
  toolCallSupportCache.clear();
  diskCacheLoaded = false;
  try {
    const cacheFile = getCacheFilePath();
    if (cacheFile && fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
  } catch {}
}

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
export function buildToolsSystemPromptBlock(tools: ToolDefinition[]): string {
  if (!tools.length) return "";

  const xmlDefs = tools
    .map((t) => {
      const params =
        t.input_schema?.properties
          ? Object.entries(t.input_schema.properties)
              .map(([pName, pDef]) => {
                const required = t.input_schema.required?.includes(pName)
                  ? " (required)"
                  : " (optional)";
                return `    - ${pName} [${pDef.type}]${required}: ${pDef.description || ""}`;
              })
              .join("\n")
          : "    (no parameters)";
      return `<tool name="${t.name}">\n  <description>${t.description}</description>\n  <parameters>\n${params}\n  </parameters>\n</tool>`;
    })
    .join("\n\n");

  return `\n\n## TOOL CALLING INSTRUCTIONS

You have access to the following tools. To use a tool, output a \`<tool_calls>\` XML block containing one or more \`<tool_call>\` elements. Each \`<tool_call>\` must contain a JSON object with the tool \`name\` and its \`arguments\` as a JSON object. Do NOT include any other text inside \`<tool_call>\` — just the JSON object.

IMPORTANT: You MUST use these tools instead of describing what you would do. Always call the appropriate tool immediately.

### Output Format Example:
<tool_calls>
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>
</tool_calls>

You may output multiple \`<tool_call>\` blocks inside a single \`<tool_calls>\` block to call multiple tools in parallel.

### Available Tools:
${xmlDefs}`;
}
