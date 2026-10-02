import type { Tool } from "./types.js";

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
        description: "Keyword filter, e.g. 'browser', 'git', 'memory'. Omit to list everything.",
      },
    },
    required: [],
  },
  async execute(args) {
    const { getToolDefinitions } = await import("./index.js");
    const defs = getToolDefinitions();
    const q = String(args.query || "").toLowerCase().trim();
    const filtered = q
      ? defs.filter((d) =>
          `${d.name} ${d.description}`.toLowerCase().includes(q)
        )
      : defs;
    if (filtered.length === 0) {
      return `No tools match query "${args.query}".`;
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
    "Get the full description and JSON argument schema for one or more tools by name. Use this instead of guessing arguments.",
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        items: { type: "string" },
        description: "Tool names to describe, e.g. [\"git_action\", \"manage_plan\"].",
      },
    },
    required: ["names"],
  },
  async execute(args) {
    const { getToolByName } = await import("./index.js");
    const names = Array.isArray(args.names) ? args.names : [];
    const out = names.map((n: unknown) => {
      const name = String(n);
      const t = getToolByName(name);
      if (!t) return { name, error: "Unknown tool" };
      return {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      };
    });
    return JSON.stringify(out, null, 2);
  },
};
