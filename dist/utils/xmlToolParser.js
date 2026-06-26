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
export function parseXmlToolCalls(textContent, toolDefs) {
    const toolCalls = [];
    // Normalize DSML namespaces to standard tags
    const normalizedText = textContent
        .replace(/｜｜DSML｜｜/gi, "")
        .replace(/｜DSML｜/gi, "")
        .replace(/\|\|DSML\|\|/gi, "")
        .replace(/\|DSML\|/gi, "");
    let cleanText = normalizedText;
    const generateId = () => `call_${Math.random().toString(36).substring(2, 15)}`;
    const cleanJsonString = (str) => {
        let cleaned = str.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/, "");
            cleaned = cleaned.replace(/\s*```$/, "");
        }
        return cleaned.trim();
    };
    const decodeEntitiesRecursive = (val) => {
        if (typeof val === "string") {
            return decodeHtmlEntities(val);
        }
        if (Array.isArray(val)) {
            return val.map(decodeEntitiesRecursive);
        }
        if (val && typeof val === "object") {
            const res = {};
            for (const [k, v] of Object.entries(val)) {
                res[k] = decodeEntitiesRecursive(v);
            }
            return res;
        }
        return val;
    };
    // 0. Match <tool_calls>...</tool_calls> blocks containing JSON-based <tool_call>...</tool_call> or XML-based <invoke>
    const toolCallsRegex = /<tool_calls\s*>([\s\S]*?)<\/tool_calls>/gi;
    let tcMatch;
    while ((tcMatch = toolCallsRegex.exec(normalizedText)) !== null) {
        const blockContent = tcMatch[1];
        const fullBlock = tcMatch[0];
        // Check JSON-based <tool_call>
        const blockToolCallRegex = /<tool_call\s*>([\s\S]*?)<\/tool_call>/gi;
        let singleTcMatch;
        while ((singleTcMatch = blockToolCallRegex.exec(blockContent)) !== null) {
            const rawBody = cleanJsonString(singleTcMatch[1]);
            try {
                let parsedJson;
                try {
                    parsedJson = JSON.parse(rawBody);
                }
                catch {
                    parsedJson = JSON.parse(decodeHtmlEntities(rawBody));
                }
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
            }
            catch (err) {
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
        cleanText = cleanText.replace(fullBlock, "");
    }
    // Match standalone <tool_call>...</tool_call> blocks that are not wrapped in <tool_calls>
    const standaloneToolCallRegex = /<tool_call\s*>([\s\S]*?)<\/tool_call>/gi;
    let standTcMatch;
    while ((standTcMatch = standaloneToolCallRegex.exec(normalizedText)) !== null) {
        const fullBlock = standTcMatch[0];
        if (cleanText.includes(fullBlock)) {
            const rawBody = cleanJsonString(standTcMatch[1]);
            try {
                let parsedJson;
                try {
                    parsedJson = JSON.parse(rawBody);
                }
                catch {
                    // If direct parse fails, try decoding first
                    parsedJson = JSON.parse(decodeHtmlEntities(rawBody));
                }
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
            }
            catch (err) {
                // Ignore
            }
            cleanText = cleanText.replace(fullBlock, "");
        }
    }
    // 1. Match <function_calls>...</function_calls> blocks
    const functionCallsRegex = /<function_calls\s*>([\s\S]*?)<\/function_calls>/gi;
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
        const directTagRegex = new RegExp(`<${escapedName}\\s*>([\\s\\S]*?)<\\/${escapedName}>`, "gi");
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
    return {
        toolCalls,
        cleanText: cleanText.trim(),
    };
}
function parseXmlBody(body) {
    const args = {};
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
function decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#96;/g, "`");
}
function parseXmlValue(valStr) {
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
        const obj = {};
        for (const m of subTags) {
            const key = m[1];
            const val = parseXmlValue(m[2]);
            obj[key] = val;
        }
        return obj;
    }
    // Parse primitive values
    if (trimmed.toLowerCase() === "true")
        return true;
    if (trimmed.toLowerCase() === "false")
        return false;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const num = Number(trimmed);
        if (!isNaN(num))
            return num;
    }
    return decodeHtmlEntities(trimmed);
}
export class StreamXmlFilter {
    buffer = "";
    onText;
    toolNames;
    activeTags;
    constructor(onText, toolDefs) {
        this.onText = onText;
        this.toolNames = toolDefs.map((t) => t.name);
        this.activeTags = ["tool_calls", "tool_call", "function_calls", "invoke", "parameter", ...this.toolNames];
    }
    push(delta) {
        this.buffer += delta;
        this.process();
    }
    flush() {
        if (this.buffer) {
            this.onText(this.buffer);
            this.buffer = "";
        }
    }
    process() {
        while (true) {
            const ltIndex = this.buffer.indexOf("<");
            if (ltIndex === -1) {
                // No opening bracket, everything currently in buffer can be emitted
                this.onText(this.buffer);
                this.buffer = "";
                break;
            }
            // We have an opening bracket. Emit everything before it immediately
            if (ltIndex > 0) {
                this.onText(this.buffer.substring(0, ltIndex));
                this.buffer = this.buffer.substring(ltIndex);
            }
            // Now the buffer starts with '<'.
            const isClosingTag = this.buffer.startsWith("</");
            const nameStart = isClosingTag ? 2 : 1;
            let nameEnd = nameStart;
            while (nameEnd < this.buffer.length) {
                const char = this.buffer[nameEnd];
                if (/[a-zA-Z0-9_-]/.test(char) || char === "｜" || char === "|") {
                    nameEnd++;
                }
                else {
                    break;
                }
            }
            if (nameEnd === this.buffer.length) {
                // We reached the end of the buffer while reading the tag name.
                // We must wait for more characters to decide.
                break;
            }
            const rawTagName = this.buffer.substring(nameStart, nameEnd).trim();
            const tagName = rawTagName
                .replace(/｜｜DSML｜｜/gi, "")
                .replace(/｜DSML｜/gi, "")
                .replace(/\|\|DSML\|\|/gi, "")
                .replace(/\|DSML\|/gi, "");
            const isToolTag = this.activeTags.includes(tagName);
            if (isToolTag) {
                // Yes, it is a tool tag or tool container.
                // We must buffer this entire tag and its content until we see its matching closing tag.
                // Search for the closing tag flexibly, ignoring any potential DSML prefixes
                const escapedTagName = tagName.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
                const closingRegex = new RegExp(`<\/(?:｜｜DSML｜｜|｜DSML｜|\\|\\|DSML\\|\\||\\|DSML\\||)?${escapedTagName}\\s*>`, "i");
                const match = closingRegex.exec(this.buffer);
                if (match) {
                    // Found the closing tag! Discard the entire tag and content from the buffer.
                    this.buffer = this.buffer.substring(match.index + match[0].length);
                    // Loop again to process remaining buffer
                    continue;
                }
                else {
                    // Closing tag not found yet, keep buffering everything from '<' onwards.
                    break;
                }
            }
            else {
                // It's not a tool tag.
                // Emit the '<' character to advance the parser.
                this.onText(this.buffer[0]);
                this.buffer = this.buffer.substring(1);
            }
        }
    }
}
//# sourceMappingURL=xmlToolParser.js.map