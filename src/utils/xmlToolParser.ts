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
export function parseXmlToolCalls(
  textContent: string,
  toolDefs: { name: string }[]
): { toolCalls: ParsedToolCall[]; cleanText: string } {
  const toolCalls: ParsedToolCall[] = [];
  let cleanText = textContent;

  const generateId = () => `call_${Math.random().toString(36).substring(2, 15)}`;

  // 1. Match <function_calls>...</function_calls> blocks
  const functionCallsRegex = /<function_calls\s*>([\s\S]*?)<\/function_calls>/gi;
  let fcMatch;
  while ((fcMatch = functionCallsRegex.exec(textContent)) !== null) {
    const blockContent = fcMatch[1];
    const fullBlock = fcMatch[0];

    // Parse invokes within this block
    const blockInvokeRegex = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi;
    let invMatch;
    while ((invMatch = blockInvokeRegex.exec(blockContent)) !== null) {
      const toolName = invMatch[1].trim();
      const body = invMatch[2];
      const args = parseXmlBody(body);
      toolCalls.push({
        id: generateId(),
        name: toolName,
        args,
      });
    }

    cleanText = cleanText.replace(fullBlock, "");
  }

  // 2. Match standalone <invoke name="...">...</invoke> if any were not inside <function_calls>
  const standaloneInvokeRegex = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi;
  let standMatch;
  while ((standMatch = standaloneInvokeRegex.exec(textContent)) !== null) {
    const fullBlock = standMatch[0];
    if (cleanText.includes(fullBlock)) {
      const toolName = standMatch[1].trim();
      const body = standMatch[2];
      const args = parseXmlBody(body);
      toolCalls.push({
        id: generateId(),
        name: toolName,
        args,
      });
      cleanText = cleanText.replace(fullBlock, "");
    }
  }

  // 3. Match direct tool tags, e.g. <ask_question>...</ask_question>
  const toolNames = toolDefs.map((t) => t.name);
  for (const toolName of toolNames) {
    // Escape tool name for regex
    const escapedName = toolName.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const directTagRegex = new RegExp(`<${escapedName}\\s*>([\\s\\S]*?)<\\/${escapedName}>`, "gi");
    let directMatch;
    while ((directMatch = directTagRegex.exec(textContent)) !== null) {
      const fullBlock = directMatch[0];
      if (cleanText.includes(fullBlock)) {
        const body = directMatch[1];
        const args = parseXmlBody(body);
        toolCalls.push({
          id: generateId(),
          name: toolName,
          args,
        });
        cleanText = cleanText.replace(fullBlock, "");
      }
    }
  }

  return {
    toolCalls,
    cleanText: cleanText.trim(),
  };
}

function parseXmlBody(body: string): Record<string, any> {
  const args: Record<string, any> = {};

  // 1. Try to parse <parameter name="paramName">value</parameter>
  const paramRegex = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi;
  let match;
  let foundParams = false;
  while ((match = paramRegex.exec(body)) !== null) {
    const name = match[1].trim();
    const valStr = match[2];
    args[name] = parseXmlValue(valStr);
    foundParams = true;
  }

  // 2. If no <parameter> tags found, look for direct child tags, e.g. <question>...</question>
  if (!foundParams) {
    const tagRegex = /<([^>\s]+)\s*>([\s\S]*?)<\/\1>/g;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(body)) !== null) {
      const name = tagMatch[1].trim();
      const valStr = tagMatch[2];
      args[name] = parseXmlValue(valStr);
    }
  }

  return args;
}

function parseXmlValue(valStr: string): any {
  const trimmed = valStr.trim();
  const subTagRegex = /<([^>\s]+)\s*>([\s\S]*?)<\/\1>/g;
  const subTags = [...trimmed.matchAll(subTagRegex)];

  if (subTags.length > 0) {
    const tagNames = subTags.map((m) => m[1]);
    const uniqueNames = new Set(tagNames);

    // Homogeneous list (e.g. multiple <option> elements or multiple <question> elements)
    if (uniqueNames.size === 1) {
      return subTags.map((m) => parseXmlValue(m[2]));
    }

    // Heterogeneous list (e.g. object with multiple fields)
    const obj: Record<string, any> = {};
    for (const m of subTags) {
      const key = m[1];
      const val = parseXmlValue(m[2]);
      obj[key] = val;
    }
    return obj;
  }

  // Parse primitive values
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!isNaN(num)) return num;
  }
  return trimmed;
}
