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
 * Fuzzy subsequence score of `query` against `target` (case-insensitive).
 * Returns 0 when the query is not a subsequence of the target.
 * Higher scores reward matches at the start of the string, at word
 * boundaries (after `_`, `-`, space, `.`), and consecutive character runs.
 */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase().trim();
  const t = target.toLowerCase();
  if (!q || !t) return 0;
  let score = 0;
  let ti = 0;
  let prev = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let p = ti; p < t.length; p++) {
      if (t[p] === ch) {
        found = p;
        break;
      }
    }
    if (found === -1) return 0;
    score += 10;
    if (found === 0) {
      score += 8;
    } else if (/[_\-\s.]/.test(t[found - 1])) {
      score += 6;
    }
    if (prev !== -1) {
      if (found === prev + 1) {
        score += 4;
      } else {
        score -= Math.min(3, found - prev - 1);
      }
    }
    prev = found;
    ti = found + 1;
  }
  score += Math.max(0, 10 - (t.length - q.length) * 0.5);
  return Math.max(1, Math.round(score * 10) / 10);
};

/**
 * Minimal tool shape needed for discovery listing.
 */
export interface DiscoveryDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/**
 * Core list_tools logic over an explicit definition list.
 * Extracted so mode-aware wrappers can list a filtered toolset
 * instead of the static catalog.
 */
export async function runListTools(defs: DiscoveryDef[], args: unknown): Promise<string> {
  const rawQuery = (args as any)?.query ?? (args as any)?.q ?? (args as any)?.filter ?? (args as any)?.keyword ?? "";
  const q = String(rawQuery).toLowerCase().trim();
  const filtered = q
    ? defs
        .map((d) => ({
          def: d,
          score: Math.max(
            fuzzyScore(q, d.name),
            0.5 * fuzzyScore(q, d.description)
          ),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.def)
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
}


/**
 * Lists available tool names with one-line descriptions.
 * Optional keyword query filters the list. Use describe_tool for full schemas.
 */
export const listToolsTool: Tool = {
  name: "list_tools",
  description:
    "List all available tool names with one-line descriptions. Provide an optional keyword query to filter (fuzzy search over name and description, best matches first). Use describe_tool to get exact argument schemas for specific tools.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Fuzzy keyword filter, e.g. 'browser', 'clibrdg', 'bckgrnd'. Omit to list everything.",
      },
    },
    required: [],
  },
  async execute(args) {
    const { getToolDefinitions } = await import("./index.js");
    return runListTools(getToolDefinitions(), args);
  },
};

export interface RunDescribeToolOptions {
  /**
   * Custom tool resolver. Defaults to exact -> case-insensitive ->
   * hyphen/underscore-normalized matching over `tools`.
   */
  findTool?: (name: string) => DiscoveryDef | undefined;
  /**
   * When a name can't be resolved, return this message instead of the
   * generic "Unknown tool" error. Return undefined to fall through to
   * the generic error.
   */
  unavailableMessage?: (name: string) => string | undefined;
}

/**
 * Core describe_tool logic over an explicit tool list.
 * Extracted so mode-aware wrappers can describe a filtered toolset
 * and report hidden tools as unavailable instead of unknown.
 */
export async function runDescribeTool(
  tools: DiscoveryDef[],
  args: unknown,
  opts: RunDescribeToolOptions = {}
): Promise<string> {
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

  const findTool =
    opts.findTool ??
    ((name: string) => {
      const clean = name.trim().replace(/^['"`]+|['"`]+$/g, "");
      if (!clean) return undefined;
      const exact = tools.find((t) => t.name === clean);
      if (exact) return exact;
      const lower = clean.toLowerCase();
      const caseMatch = tools.find((t) => t.name.toLowerCase() === lower);
      if (caseMatch) return caseMatch;
      const norm = lower.replace(/[-_]/g, "_");
      return tools.find((t) => t.name.toLowerCase().replace(/[-_]/g, "_") === norm);
    });

  const out = names.map((name) => {
    const t = findTool(name);
    if (!t) {
      const custom = opts.unavailableMessage?.(name);
      if (custom) return { name, error: custom };
      const suggestions = tools
        .map((tool) => ({
          name: tool.name,
          score: fuzzyScore(name, tool.name),
        }))
        .filter((x) => x.score >= Math.max(16, name.length * 8))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((x) => x.name);

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
}


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
    return runDescribeTool(allTools, args, {
      findTool: (name: string) => getToolByName(name),
    });
  },
};
