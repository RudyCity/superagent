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
export function findBalancedJson(str: string, startIndex: number): { json: string; endIndex: number } | null {
  let braceCount = 0;
  let inString = false;
  let escape = false;
  let i = startIndex;
  while (i < str.length) {
    const char = str[i];
    if (escape) {
      escape = false;
    } else if (char === "\\") {
      escape = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString) {
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          return {
            json: str.substring(startIndex, i + 1),
            endIndex: i + 1
          };
        }
      }
    }
    i++;
  }
  return null;
}

export function normalizeMalformedToolCalls(text: string): string {
  const regex = /<tool(?:_name|\s+name)\s*=\s*"([^"]+)"\s*,?\s*["']arguments["']\s*:\s*/gi;
  let match;
  let result = "";
  let lastIndex = 0;

  regex.lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    const matchStartIndex = match.index;
    const matchEndIndex = regex.lastIndex;
    const toolName = match[1];

    const balanced = findBalancedJson(text, matchEndIndex);
    if (balanced) {
      result += text.substring(lastIndex, matchStartIndex);
      
      let replaceEnd = balanced.endIndex;
      if (replaceEnd < text.length && text[replaceEnd] === "}") {
        replaceEnd++;
      }

      result += `<tool_call>{"name": "${toolName}", "arguments": ${balanced.json}}</tool_call>`;
      lastIndex = replaceEnd;
      regex.lastIndex = replaceEnd;
    } else {
      result += text.substring(lastIndex, matchEndIndex);
      lastIndex = matchEndIndex;
    }
  }
  result += text.substring(lastIndex);
  return result;
}

function tryParseToolCallJson(rawBody: string): any {
  try {
    return JSON.parse(rawBody);
  } catch {}
  try {
    return JSON.parse(decodeHtmlEntities(rawBody));
  } catch {}

  const trimmed = rawBody.trim();

  // Fallback for XML-like tags inside <tool_call>
  try {
    if (trimmed.includes("<") && trimmed.includes(">")) {
      const nameMatch = /<(?:tool_name|name)>([\s\S]*?)<\/(?:tool_name|name)>/i.exec(trimmed);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        const args: Record<string, any> = {};
        const tagRegex = /<([a-zA-Z0-9_-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/gi;
        let tagMatch;
        while ((tagMatch = tagRegex.exec(trimmed)) !== null) {
          const key = tagMatch[1];
          if (key.toLowerCase() !== "tool_name" && key.toLowerCase() !== "name") {
            const val = tagMatch[2].trim();
            if (val === "true") args[key] = true;
            else if (val === "false") args[key] = false;
            else if (val === "null") args[key] = null;
            else if (/^-?\d+(?:\.\d+)?$/.test(val)) args[key] = Number(val);
            else {
              try {
                args[key] = JSON.parse(val);
              } catch {
                args[key] = decodeHtmlEntities(val);
              }
            }
          }
        }
        return { name, arguments: args, args };
      }
    }
  } catch {}

  // Fallback for malformed/unescaped JSON arrays or objects
  try {
    if (trimmed.startsWith("[")) {
      const elementRegex = /\{[\s\S]*?\}(?=\s*,\s*\{|\s*\])/g;
      const elements = trimmed.match(elementRegex);
      if (elements) {
        const parsedElements = elements.map(el => tryParseToolCallJson(el)).filter(Boolean);
        if (parsedElements.length > 0) return parsedElements;
      }
    }

    const nameMatch = /["']name["']\s*:\s*["']([^"']+)["']/i.exec(trimmed);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();

    const argsBlockRegex = /["'](?:arguments|args)["']\s*:\s*\{([\s\S]*)\}/i;
    const argsMatch = argsBlockRegex.exec(trimmed);
    let args: Record<string, any> = {};

    if (argsMatch) {
      const argsContent = argsMatch[1].trim();
      const pairRegex = /["']([a-zA-Z0-9_-]+)["']\s*:\s*(?:["']([\s\S]*?)["'](?=\s*,\s*["'][a-zA-Z0-9_-]+["']\s*:|\s*\}$|\s*\}[\s\S]*?$)|\s*(-?\d+(?:\.\d+)?|true|false|null|\[[\s\S]*?\]|\{[\s\S]*?\}))/gi;
      
      let pairMatch;
      while ((pairMatch = pairRegex.exec(argsContent)) !== null) {
        const key = pairMatch[1];
        const strVal = pairMatch[2];
        const otherVal = pairMatch[3];

        if (strVal !== undefined) {
          args[key] = decodeHtmlEntities(strVal);
        } else if (otherVal !== undefined) {
          const trimmedVal = otherVal.trim();
          if (trimmedVal === "true") args[key] = true;
          else if (trimmedVal === "false") args[key] = false;
          else if (trimmedVal === "null") args[key] = null;
          else if (/^-?\d+(?:\.\d+)?$/.test(trimmedVal)) args[key] = Number(trimmedVal);
          else {
            try {
              args[key] = JSON.parse(trimmedVal);
            } catch {
              args[key] = trimmedVal;
            }
          }
        }
      }
    }

    return { name, arguments: args, args };
  } catch {
    return null;
  }
}

export function parseXmlToolCalls(
  textContent: string,
  toolDefs: { name: string }[]
): { toolCalls: ParsedToolCall[]; cleanText: string } {
  const toolCalls: ParsedToolCall[] = [];
  
  // Normalize any malformed XML/JSON mixed tool calls like <tool name="..." ...}}
  const normalizedMalformed = normalizeMalformedToolCalls(textContent);

  // Normalize DSML namespaces to standard tags
  const normalizedText = normalizedMalformed
    .replace(/｜｜DSML｜｜/gi, "")
    .replace(/｜DSML｜/gi, "")
    .replace(/\|\|DSML\|\|/gi, "")
    .replace(/\|DSML\|/gi, "");

  let cleanText = normalizedText;

  const generateId = () => `call_${Math.random().toString(36).substring(2, 15)}`;

  const cleanJsonString = (str: string): string => {
    let cleaned = str.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, "");
      cleaned = cleaned.replace(/\s*```$/, "");
    }
    return cleaned.trim();
  };

  const decodeEntitiesRecursive = (val: any): any => {
    if (typeof val === "string") {
      return decodeHtmlEntities(val);
    }
    if (Array.isArray(val)) {
      return val.map(decodeEntitiesRecursive);
    }
    if (val && typeof val === "object") {
      const res: Record<string, any> = {};
      for (const [k, v] of Object.entries(val)) {
        res[k] = decodeEntitiesRecursive(v);
      }
      return res;
    }
    return val;
  };

  // 0. Match <tool_calls>...</tool_calls> blocks containing JSON-based <tool_call>...</tool_call> or XML-based <invoke>
  const toolCallsRegex = /<tool_calls(?:\s+[^>]*)?>([\s\S]*?)<\/tool_calls>/gi;
  let tcMatch;
  while ((tcMatch = toolCallsRegex.exec(normalizedText)) !== null) {
    const blockContent = tcMatch[1];
    const fullBlock = tcMatch[0];

    // Check JSON-based <tool_call>
    const blockToolCallRegex = /<tool_call(?:\s+[^>]*)?>((?:(?!<tool_call(?:\s+[^>]*)?>)[\s\S])*?)(?:<\/tool_call>|<\/tool_calls>|$)/gi;
    let singleTcMatch;
    while ((singleTcMatch = blockToolCallRegex.exec(blockContent)) !== null) {
      const rawBody = cleanJsonString(singleTcMatch[1]);
      try {
        const parsedJson = tryParseToolCallJson(rawBody);
        if (!parsedJson) throw new Error("Parse failed");

        const name = parsedJson.name;
        let args = parsedJson.arguments || parsedJson.args || {};
        args = decodeEntitiesRecursive(args);

        if (name) {
          toolCalls.push({
            id: generateId(),
            name: name.trim(),
            args,
          });
        }
      } catch (err) {
        // Ignore or log error
      }
    }

    // Check XML-based <invoke> (like DSML)
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

    if (toolCalls.length === 0) {
      const rawBody = cleanJsonString(blockContent);
      try {
        const parsedJson = tryParseToolCallJson(rawBody);
        if (!parsedJson) throw new Error("Parse failed");

        const candidates = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
        for (const candidate of candidates) {
          const name = candidate.name;
          let args = candidate.arguments || candidate.args || {};
          args = decodeEntitiesRecursive(args);

          if (name) {
            toolCalls.push({
              id: generateId(),
              name: name.trim(),
              args,
            });
          }
        }
      } catch (err) {
        // Ignore
      }
    }

    cleanText = cleanText.replace(fullBlock, "");
  }

  // Match standalone <tool_call>...</tool_call> blocks that are not wrapped in <tool_calls>
  const standaloneToolCallRegex = /<tool_call(?:\s+[^>]*)?>((?:(?!<tool_call(?:\s+[^>]*)?>)[\s\S])*?)(?:<\/tool_call>|<\/tool_calls>|$)/gi;
  let standTcMatch;
  while ((standTcMatch = standaloneToolCallRegex.exec(normalizedText)) !== null) {
    const fullBlock = standTcMatch[0];
    if (cleanText.includes(fullBlock)) {
      const rawBody = cleanJsonString(standTcMatch[1]);
      try {
        const parsedJson = tryParseToolCallJson(rawBody);
        if (!parsedJson) throw new Error("Parse failed");

        const name = parsedJson.name;
        let args = parsedJson.arguments || parsedJson.args || {};
        args = decodeEntitiesRecursive(args);

        if (name) {
          toolCalls.push({
            id: generateId(),
            name: name.trim(),
            args,
          });
        }
      } catch (err) {
        // Ignore
      }
      cleanText = cleanText.replace(fullBlock, "");
    }
  }

  // 1. Match <function_calls>...</function_calls> blocks
  const functionCallsRegex = /<function_calls(?:\s+[^>]*)?>([\s\S]*?)<\/function_calls>/gi;
  let fcMatch;
  while ((fcMatch = functionCallsRegex.exec(normalizedText)) !== null) {
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

  // 2. Match standalone <invoke name="...">...</invoke> if any were not inside <function_calls> or <tool_calls>
  const standaloneInvokeRegex = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/gi;
  let standMatch;
  while ((standMatch = standaloneInvokeRegex.exec(normalizedText)) !== null) {
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
    const directTagRegex = new RegExp(`<${escapedName}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escapedName}>`, "gi");
    let directMatch;
    while ((directMatch = directTagRegex.exec(normalizedText)) !== null) {
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

  // Clean up any leftover/stray XML tool tags and model system tags like [/SYS]
  cleanText = cleanText
    .replace(/([ \t]*│)?[ \t]*<\/function_calls\s*>/gi, "")
    .replace(/([ \t]*│)?[ \t]*<function_calls(?:\s+[^>]*)?>/gi, "")
    .replace(/([ \t]*│)?[ \t]*<\/tool_calls?\s*>/gi, "")
    .replace(/([ \t]*│)?[ \t]*<tool_calls?(?:\s+[^>]*)?>/gi, "")
    .replace(/([ \t]*│)?[ \t]*<\/tool_call\s*>/gi, "")
    .replace(/([ \t]*│)?[ \t]*<tool_call(?:\s+[^>]*)?>/gi, "")
    .replace(/\[\/SYS\]/gi, "");

  // Remove lines containing only space/tab and a vertical line
  cleanText = cleanText.replace(/^[ \t]*│[ \t]*(?:\r?\n|$)/gm, "");

  return {
    toolCalls,
    cleanText: cleanText.trim(),
  };
}

function parseXmlBody(body: string): Record<string, any> {
  const args: Record<string, any> = {};

  // 1. Try to parse <parameter name="paramName">value</parameter>
  const paramRegex = /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/gi;
  let match;
  let foundParams = false;
  while ((match = paramRegex.exec(body)) !== null) {
    const name = match[1].trim();
    const attrs = match[2];
    const valStr = match[3];
    
    const isExplicitString = /\bstring\s*=\s*"true"/i.test(attrs) || /\bstring\s*=\s*'true'/i.test(attrs);
    
    args[name] = isExplicitString ? decodeHtmlEntities(valStr.trim()) : parseXmlValue(valStr);
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

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, "`");
}

function parseXmlValue(valStr: string): any {
  const trimmed = valStr.trim();

  // If the value looks like a JSON array or object, try to parse it as JSON first
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return JSON.parse(decodeHtmlEntities(trimmed));
    } catch (e) {
      try {
        return JSON.parse(trimmed);
      } catch (e2) {}
    }
  }

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
  return decodeHtmlEntities(trimmed);
}

export class StreamXmlFilter {
  private buffer = "";
  private onText: (text: string) => void;
  private toolNames: string[];
  private activeTags: string[];

  constructor(onText: (text: string) => void, toolDefs: { name: string }[]) {
    this.onText = onText;
    this.toolNames = toolDefs.map((t) => t.name);
    this.activeTags = ["tool_calls", "tool_call", "function_calls", "invoke", "parameter", ...this.toolNames];
  }

  push(delta: string) {
    this.buffer += delta;
    this.process();
  }

  flush() {
    if (this.buffer) {
      const lower = this.buffer.toLowerCase();
      if (lower.includes("[/sys]")) {
        this.buffer = this.buffer.replace(/\[\/sys\]/gi, "");
      }
      if (this.buffer) {
        this.onText(this.buffer);
      }
      this.buffer = "";
    }
  }

  private process() {
    while (true) {
      const ltIndex = this.buffer.indexOf("<");
      const sqIndex = this.buffer.indexOf("[");

      let targetIndex = -1;
      let isSquare = false;

      if (ltIndex !== -1 && sqIndex !== -1) {
        if (ltIndex < sqIndex) {
          targetIndex = ltIndex;
        } else {
          targetIndex = sqIndex;
          isSquare = true;
        }
      } else if (ltIndex !== -1) {
        targetIndex = ltIndex;
      } else if (sqIndex !== -1) {
        targetIndex = sqIndex;
        isSquare = true;
      }

      if (targetIndex === -1) {
        // No opening tag or bracket, everything currently in buffer can be emitted
        this.onText(this.buffer);
        this.buffer = "";
        break;
      }

      // We have an opening bracket or tag.
      if (targetIndex > 0) {
        const prefixText = this.buffer.substring(0, targetIndex);
        let prefixLen = 0;

        if (!isSquare) {
          const rest = this.buffer.substring(targetIndex);
          const isClosingTag = rest.startsWith("</");
          const nameStart = isClosingTag ? 2 : 1;
          let nameEnd = nameStart;
          while (nameEnd < rest.length) {
            const char = rest[nameEnd];
            if (/[a-zA-Z0-9_-]/.test(char) || char === "｜" || char === "|") {
              nameEnd++;
            } else {
              break;
            }
          }
          if (nameEnd === rest.length) {
            // Tag name is incomplete, wait for more data
            break;
          }

          const rawTagName = rest.substring(nameStart, nameEnd).trim();
          const tagName = rawTagName
            .replace(/｜｜DSML｜｜/gi, "")
            .replace(/｜DSML｜/gi, "")
            .replace(/\|\|DSML\|\|/gi, "")
            .replace(/\|DSML\|/gi, "");

          const isToolTag = this.activeTags.includes(tagName) || tagName === "tool" || tagName === "tool_name";

          if (isToolTag) {
            const match = /[ \t]*│[ \t]*$/.exec(prefixText);
            if (match) {
              prefixLen = match[0].length;
            }
          }
        }

        this.onText(this.buffer.substring(0, targetIndex - prefixLen));
        this.buffer = this.buffer.substring(targetIndex);
      }

      // Now the buffer starts with the character ('<' or '[') at index 0.

      if (isSquare) {
        const lowerBuf = this.buffer.toLowerCase();
        const targetTag = "[/sys]";
        if (lowerBuf.startsWith(targetTag)) {
          // Match! Discard the tag
          this.buffer = this.buffer.substring(targetTag.length);
          continue;
        }
        if (targetTag.startsWith(lowerBuf)) {
          // It's a prefix but incomplete, wait for more data
          break;
        }
        // Not a match, emit the first character
        this.onText(this.buffer[0]);
        this.buffer = this.buffer.substring(1);
        continue;
      }

      // Check if it is a malformed tool call starting at index 0
      const malformedRegex = /^<tool(?:_name|\s+name)\s*=\s*"([^"]+)"\s*,?\s*["']arguments["']\s*:\s*/i;
      const malformedMatch = malformedRegex.exec(this.buffer);
      if (malformedMatch) {
        const matchEndIndex = malformedMatch[0].length;
        const balanced = findBalancedJson(this.buffer, matchEndIndex);
        if (balanced) {
          let replaceEnd = balanced.endIndex;
          if (replaceEnd < this.buffer.length && this.buffer[replaceEnd] === "}") {
            replaceEnd++;
          }
          this.buffer = this.buffer.substring(replaceEnd);
          continue;
        } else {
          // JSON not fully buffered yet, wait for more data
          break;
        }
      }

      const isClosingTag = this.buffer.startsWith("</");
      const nameStart = isClosingTag ? 2 : 1;

      let nameEnd = nameStart;
      while (nameEnd < this.buffer.length) {
        const char = this.buffer[nameEnd];
        if (/[a-zA-Z0-9_-]/.test(char) || char === "｜" || char === "|") {
          nameEnd++;
        } else {
          break;
        }
      }

      if (nameEnd === this.buffer.length) {
        break;
      }

      const rawTagName = this.buffer.substring(nameStart, nameEnd).trim();
      const tagName = rawTagName
        .replace(/｜｜DSML｜｜/gi, "")
        .replace(/｜DSML｜/gi, "")
        .replace(/\|\|DSML\|\|/gi, "")
        .replace(/\|DSML\|/gi, "");
      const isToolTag = this.activeTags.includes(tagName) || tagName === "tool" || tagName === "tool_name";

      if (isToolTag) {
        const escapedTagName = tagName.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
        const closingTagNamePattern = (tagName === "tool_call" || tagName === "tool_calls" || tagName === "tool" || tagName === "tool_name")
          ? "(?:tool_call|tool_calls|tool|tool_name)"
          : escapedTagName;
        const closingRegex = new RegExp(`<\/(?:｜｜DSML｜｜|｜DSML｜|\\|\\|DSML\\|\\||\\|DSML\\||)?${closingTagNamePattern}\\s*>`, "i");
        const match = closingRegex.exec(this.buffer);
        if (match) {
          this.buffer = this.buffer.substring(match.index + match[0].length);
          continue;
        } else {
          break;
        }
      } else {
        this.onText(this.buffer[0]);
        this.buffer = this.buffer.substring(1);
      }
    }
  }
}

