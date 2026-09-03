/**
 * OpenAI SSE Adapter module
 *
 * Provides utilities for handling Server-Sent Events (SSE) streams and JSON responses
 * from custom OpenAI-compatible endpoints:
 * - Extracts JSON payloads from raw text.
 * - Reconstructs ChatCompletion JSON from SSE event streams for non-streaming consumers.
 * - Synthesizes SSE streams from standard non-streaming ChatCompletion JSON responses (for endpoints that do not support streaming).
 * - Transforms SSE streams to map delta.reasoning_content into <think>...</think> within delta.content so @ai-sdk/openai does not drop reasoning tokens.
 */

export function extractJSON(text: string): string {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let startIdx = -1;

  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = firstBrace < firstBracket ? firstBrace : firstBracket;
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  if (startIdx === -1) {
    return text;
  }

  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === "{") {
      braceCount++;
    } else if (char === "}") {
      braceCount--;
    } else if (char === "[") {
      bracketCount++;
    } else if (char === "]") {
      bracketCount--;
    }

    if (braceCount === 0 && bracketCount === 0) {
      return text.substring(startIdx, i + 1);
    }
  }

  return text;
}

export function reconstructChatCompletionFromSse(rawText: string): any {
  let accumulatedText = "";
  const toolCallsMap = new Map<number, { id?: string; type?: string; name?: string; arguments: string }>();
  let firstChunkJson: any = {};

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      if (!firstChunkJson.id && json.id) {
        firstChunkJson = json;
      }

      const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
      if (choice) {
        let content = choice.delta?.content ?? choice.message?.content ?? choice.text;
        if (!content || (typeof content === "string" && !content.trim())) {
          const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.message?.reasoning_content ?? choice.message?.reasoning;
          if (typeof reasoning === "string" && reasoning.trim()) {
            content = `<think>\n${reasoning}\n</think>`;
          }
        }
        if (typeof content === "string") {
          accumulatedText += content;
        } else if (Array.isArray(content)) {
          accumulatedText += content
            .map((part) => part?.text ?? part?.content ?? "")
            .filter((part) => typeof part === "string" && part.length > 0)
            .join("");
        }

        const deltaToolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
        if (Array.isArray(deltaToolCalls)) {
          for (const tc of deltaToolCalls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, { arguments: "" });
            }
            const current = toolCallsMap.get(idx)!;
            if (tc.id) current.id = tc.id;
            if (tc.type) current.type = tc.type;
            if (tc.function?.name) current.name = tc.function.name;
            if (tc.function?.arguments) current.arguments += tc.function.arguments;
          }
        }
      }
    } catch {
      // Ignore parsing errors of individual lines
    }
  }

  const choicesMessage: any = {
    role: "assistant",
    content: accumulatedText || null,
  };

  if (toolCallsMap.size > 0) {
    const toolCalls = Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, tc]) => ({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 11)}`,
        type: tc.type || "function",
        function: {
          name: tc.name || "",
          arguments: tc.arguments,
        },
      }));
    choicesMessage.tool_calls = toolCalls;
  }

  return {
    id: firstChunkJson.id || "chatcmpl-mock",
    object: "chat.completion",
    created: firstChunkJson.created || Math.floor(Date.now() / 1000),
    model: firstChunkJson.model || "custom-model",
    choices: [
      {
        index: 0,
        message: choicesMessage,
        finish_reason: toolCallsMap.size > 0 ? "tool_calls" : "stop",
      },
    ],
  };
}

/**
 * Synthesizes an SSE stream of chunks from a standard non-streaming Chat Completion JSON object.
 * Used when a custom endpoint (e.g. 78_openai_server.rdy or proxy) returns application/json
 * even though stream: true was requested.
 */
export function synthesizeSseFromChatCompletion(json: any, fallbackModel: string): string {
  if (json?.error) {
    const errMsg = typeof json.error === "string" ? json.error : json.error?.message || "Upstream API error";
    throw new Error(`Cannot synthesize SSE from error payload: ${errMsg}`);
  }
  if (!Array.isArray(json?.choices) || json.choices.length === 0) {
    throw new Error("Invalid ChatCompletion object: missing choices array");
  }

  const choice = json.choices[0];
  const message = choice?.message;
  let content = message?.content ?? choice?.text ?? "";
  const reasoning = message?.reasoning_content ?? message?.reasoning ?? "";
  const toolCalls = message?.tool_calls;

  const id = json?.id || `chatcmpl-${Date.now()}`;
  const model = json?.model || fallbackModel;
  const created = json?.created || Math.floor(Date.now() / 1000);
  const sseChunks: string[] = [];

  // Chunk 1: Role
  sseChunks.push(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  })}\n\n`);

  // If reasoning exists, wrap in <think>...</think> if not already wrapped
  if (reasoning && typeof reasoning === "string" && reasoning.trim() && !content.includes("<think>")) {
    content = `<think>\n${reasoning.trim()}\n</think>\n\n${content}`;
  }

  // Chunk 2: Content (if any)
  if (content && typeof content === "string" && content.length > 0) {
    sseChunks.push(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })}\n\n`);
  }

  // Chunk 3: Tool calls (if any)
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    sseChunks.push(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
    })}\n\n`);
  }

  // Chunk 4: Finish
  sseChunks.push(`data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || "stop" }],
  })}\n\n`);

  sseChunks.push(`data: [DONE]\n\n`);
  return sseChunks.join("");
}

/**
 * Transforms an SSE stream of text, mapping delta.reasoning_content into <think>...</think>
 * tags within delta.content so @ai-sdk/openai does not drop reasoning tokens.
 */
export function transformSseText(rawText: string): string {
  let inReasoning = false;
  const lines = rawText.split(/\r?\n/);
  const outLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") {
      outLines.push(line);
      continue;
    }
    const payload = trimmed.slice(5).trim();
    try {
      const json = JSON.parse(payload);
      const choice = json?.choices?.[0];
      if (choice?.delta) {
        const delta = choice.delta;
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        const content = delta.content;

        if (reasoning && (!content || content.length === 0)) {
          if (!inReasoning) {
            inReasoning = true;
            delta.content = `<think>${reasoning}`;
          } else {
            delta.content = reasoning;
          }
          outLines.push(`data: ${JSON.stringify(json)}`);
          continue;
        } else if (inReasoning && (content || choice.finish_reason)) {
          inReasoning = false;
          delta.content = `</think>${content || ""}`;
          outLines.push(`data: ${JSON.stringify(json)}`);
          continue;
        }
      }
    } catch {}
    outLines.push(line);
  }

  if (inReasoning) {
    outLines.push(`data: {"choices":[{"index":0,"delta":{"content":"</think>\\n\\n"},"finish_reason":null}]}`);
  }
  return outLines.join("\n");
}

/**
 * Transforms an incoming ReadableStream of SSE chunks to wrap reasoning_content into delta.content.
 */
export function transformSseStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let inReasoning = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const transformed = transformSseText(buffer);
            if (transformed) {
              controller.enqueue(encoder.encode(transformed));
            }
          }
          if (inReasoning) {
            const closeChunk = `data: {"choices":[{"index":0,"delta":{"content":"</think>\\n\\n"},"finish_reason":null}]}\n\n`;
            controller.enqueue(encoder.encode(closeChunk));
          }
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        let output = "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") {
            output += line + "\n";
            continue;
          }
          const payload = trimmed.slice(5).trim();
          try {
            const json = JSON.parse(payload);
            const choice = json?.choices?.[0];
            if (choice?.delta) {
              const delta = choice.delta;
              const reasoning = delta.reasoning_content ?? delta.reasoning;
              const content = delta.content;

              if (reasoning && (!content || content.length === 0)) {
                if (!inReasoning) {
                  inReasoning = true;
                  delta.content = `<think>${reasoning}`;
                } else {
                  delta.content = reasoning;
                }
                output += `data: ${JSON.stringify(json)}\n\n`;
                continue;
              } else if (inReasoning && (content || choice.finish_reason)) {
                inReasoning = false;
                delta.content = `</think>${content || ""}`;
                output += `data: ${JSON.stringify(json)}\n\n`;
                continue;
              }
            }
          } catch {}
          output += line + "\n";
        }

        if (output.length > 0) {
          controller.enqueue(encoder.encode(output));
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}
