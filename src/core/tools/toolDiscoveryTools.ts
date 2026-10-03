import type { Tool } from "./types.js";

/**
 * Normalizes input arguments to extract a list of tool names.
 * Supports:
 * - { tool: "..." }
 * - { name: "..." }
 * - { tool_name: "..." }
 * - { toolName: "..." }
 * - { names: ["..."] } or { names: "..." }
 * - { tools: ["..."] } or { tools: "..." }
 * - raw string or array of strings
 */
export function extractToolNames(args: unknown): string[] {
  if (!args) return [];
  if (typeof args === "string") {
    const trimmed = args.trim().replace(/^['"`]+|['"`]+$/g, "");
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(args)) {
    return Array.from(new Set(args.flatMap((item) => extractToolNames(item))));
  }
  if (typeof args === "object") {
    const obj = args as Record<string, unknown>;
    const candidates: unknown[] = [];

    // Prioritized known keys
    if (obj.tool !== undefined) candidates.push(obj.tool);
    if (obj.name !== undefined) candidates.push(obj.name);
    if (obj.tool_name !== undefined) candidates.push(obj.tool_name);
    if (obj.toolName !== undefined) candidates.push(obj.toolName);
    if (obj.names !== undefined) candidates.push(obj.names);
    if (obj.tools !== undefined) candidates.push(obj.tools);
    if (obj.tool_names !== undefined) candidates.push(obj.tool_names);
    if (obj.toolNames !== undefined) candidates.push(obj.toolNames);
    if (obj.target !== undefined) candidates.push(obj.target);
    if (obj.query !== undefined) candidates.push(obj.query);
    if (obj.input !== undefined) candidates.push(obj.input);

    // Fallback: check any string or array value in obj if no known keys matched
    if (candidates.length === 0) {
      for (const val of Object.values(obj)) {
        if (typeof val === "string" || Array.isArray(val)) {
          candidates.push(val);
        }
      }
    }

    const result: string[] = [];
    for (const c of candidates) {
      if (typeof c === "string") {
        const cleaned = c.trim().replace(/^['"`]+|['"`]+$/g, "");
        if (cleaned) result.push(cleaned);
      } else if (Array.isArray(c)) {
        for (const item of c) {
          if (typeof item === "string") {
            const cleaned = item.trim().replace(/^['"`]+|['"`]+$/g, "");
            if (cleaned) result.push(cleaned);
          }
        }
      }
    }
    return Array.from(new Set(result));
  }
  return [];
}

/**
 * Lists available tool names with one-line descriptions.
 * Optional keyword query filters the list. Use describe_tool for full schemas.
 */
export const listToolsTool: Tool = {
  name: "list_tools",
  description:
    "List all available tool names with one-line descriptions. Provide an optional keyword query to filter (matches name and description). Use describe_tool to get exact argument schemas for specific tools.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keyword filter, e.g. 'browser', 'git', 'memory', 'background'. Omit to list everything.",
      },
    },
    required: [],
  },
  async execute(args) {
    const { getToolDefinitions } = await import("./index.js");
    const defs = getToolDefinitions();
    const rawQuery = (args as any)?.query ?? (args as any)?.q ?? (args as any)?.filter ?? (args as any)?.keyword ?? "";
    const q = String(rawQuery).toLowerCase().trim();
    const filtered = q
      ? defs.filter((d) =>
          `${d.name} ${d.description}`.toLowerCase().includes(q)
        )
      : defs;
    if (filtered.length === 0) {
      return `No tools match query "${rawQuery}".`;
    }
    return filtered
      .map((d) => {
        const firstLine = d.description.split("\n")[0].trim();
        const shortDesc = firstLine.length > 70 ? firstLine.slice(0, 67) + "..." : firstLine;
        return `- ${d.name}: ${shortDesc}`;
      })
      .join("\n");
  },
};

/**
 * Returns the full description and JSON argument schema for the named tools.
 */
export const describeToolTool: Tool = {
  name: "describe_tool",
  description:
    "Get the full description and JSON argument schema for one or more tools by name. Use this instead of guessing arguments. Supports singular { tool: \"...\" } or plural { names: [\"...\"] }.",
  parameters: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "Single tool name to describe, e.g. 'run_background_process' or 'manage_plan'.",
      },
      names: {
        type: "array",
        items: { type: "string" },
        description: "Tool names to describe, e.g. [\"run_background_process\", \"manage_plan\"].",
      },
      name: {
        type: "string",
        description: "Alias for tool name.",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: "Alias for names.",
      },
    },
    required: [],
  },
  async execute(args) {
    const { getToolByName, allTools } = await import("./index.js");
    const names = extractToolNames(args);
    if (names.length === 0) {
      return JSON.stringify(
        [
          {
            error:
              'No tool name provided. Please specify a tool name using { tool: "name" } or { names: ["name"] }, e.g. describe_tool({ tool: "run_background_process" }). Use list_tools to view all available tools.',
          },
        ],
        null,
        2
      );
    }

    const out = names.map((name) => {
      const t = getToolByName(name);
      if (!t) {
        const lowerName = name.toLowerCase();
        const tokens = lowerName.split(/[-_ \t]+/).filter((tok) => tok.length > 2);
        const suggestions = allTools
          .map((tool) => tool.name)
          .filter((n) => {
            const nLower = n.toLowerCase();
            return (
              nLower.includes(lowerName) ||
              lowerName.includes(nLower) ||
              tokens.some((token) => nLower.includes(token))
            );
          })
          .slice(0, 5);

        return {
          name,
          error:
            suggestions.length > 0
              ? `Unknown tool "${name}". Did you mean: ${suggestions.join(", ")}?`
              : `Unknown tool "${name}". Use list_tools to see all available tools.`,
        };
      }
      return {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      };
    });
    return JSON.stringify(out, null, 2);
  },
};
