import type { Tool } from "./types.js";
import { TOOL_ALIASES } from "./toolAliases.js";

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
const INTENT_SYNONYMS: Record<string, string[]> = {
  audit: ["inspect", "review", "search", "test", "scan", "check"],
  inspect: ["read", "view", "list", "search", "grep"],
  fix: ["edit", "patch", "replace", "write", "modify"],
  build: ["compile", "test", "run", "command"],
  test: ["run", "command", "execute", "verify"],
  commit: ["git", "stage", "repository"],
  browse: ["chrome", "browser", "cdp", "web"],
  remember: ["memory", "rmemory", "history"],
  project: ["workspace", "file", "repository"],
  deploy: ["git", "ssh", "terminal", "process"],
  perbaiki: ["edit", "patch", "replace", "write", "fix"],
  ubah: ["edit", "replace", "write", "patch"],
  cek: ["inspect", "read", "search", "grep", "test"],
  cari: ["search", "find", "grep", "glob"],
  jalankan: ["run", "command", "execute", "process"],
  uji: ["test", "run", "verify", "command"],
  baca: ["read", "view", "file"],
  simpan: ["write", "save", "memory"],
  memori: ["rmemory", "memory", "history"],
};

/** Low-cost intent matching against only the authorized catalog. */
export function rankToolsForIntent(defs: DiscoveryDef[], intent: string, limit = 8): DiscoveryDef[] {
  const tokens = [...new Set(intent.toLowerCase().match(/[a-z0-9_]+/g) || [])]
    .filter((word) => word.length > 2).slice(0, 16);
  if (!tokens.length) return [];
  return defs.map((def) => {
    const name = def.name.toLowerCase().replace(/[_-]/g, " ");
    const description = def.description.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (name.split(/\s+/).includes(token)) score += 12;
      else if (name.includes(token)) score += 8;
      else if (description.includes(token)) score += 3;
      for (const synonym of INTENT_SYNONYMS[token] || []) {
        if (name.includes(synonym)) score += 5;
        else if (description.includes(synonym)) score += 1;
      }
    }
    return { def, score };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.def.name.localeCompare(b.def.name))
    .slice(0, Math.max(1, Math.min(20, Math.floor(limit))))
    .map(({ def }) => def);
}

export async function runListTools(defs: DiscoveryDef[], args: unknown): Promise<string> {
  const rawQuery = (args as any)?.query ?? (args as any)?.q ?? (args as any)?.filter ?? (args as any)?.keyword ?? "";
  const q = String(rawQuery).toLowerCase().trim();
  const intent = typeof (args as any)?.intent === "string" ? (args as any).intent.trim().slice(0, 500) : "";
  const wantedLimit = Number((args as any)?.limit);
  const boundedLimit = Number.isFinite(wantedLimit) && wantedLimit > 0 ? Math.min(20, Math.floor(wantedLimit)) : 8;
  const filtered = intent ? rankToolsForIntent(defs, intent, boundedLimit) : q
    ? defs
        .map((d) => {
          const nameScore = fuzzyScore(q, d.name);
          const lowerDesc = d.description.toLowerCase();
          let descScore = 0;
          if (lowerDesc.includes(q)) {
            const idx = lowerDesc.indexOf(q);
            descScore = 30 + Math.max(0, 10 - idx * 0.1);
          } else {
            const words = lowerDesc.split(/[^a-z0-9_]+/);
            for (const word of words) {
              if (word.startsWith(q) && q.length >= 3) {
                descScore = 20;
                break;
              }
            }
            const tokens = q.split(/[\s,;]+/).filter((t) => t.length > 1);
            if (tokens.length > 1) {
              const allInDesc = tokens.every((tok) => lowerDesc.includes(tok));
              const allInNameOrDesc = tokens.every((tok) => d.name.toLowerCase().includes(tok) || lowerDesc.includes(tok));
              if (allInDesc) {
                descScore = Math.max(descScore, 25);
              } else if (allInNameOrDesc) {
                descScore = Math.max(descScore, 20);
              }
            }
          }
          return {
            def: d,
            score: Math.max(nameScore, descScore),
          };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.def)
    : defs;
  const presented = !intent && Number.isFinite(wantedLimit) && wantedLimit > 0
    ? filtered.slice(0, boundedLimit) : filtered;
  if (presented.length === 0) {
    return `No tools match ${intent ? "intent" : "query"} "${intent || rawQuery}".`;
  }
  return presented
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
    "List authorized tools with one-line descriptions. Use query for one short keyword or intent for a natural-language task; intent ranks up to 8 matches by default. Call describe_tool to unlock full schemas.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Single short keyword or tool name to filter (e.g. 'git', 'chrome', 'port', 'clibrdg'). Omit to list all tools. Do NOT pass natural language questions, sentences, or user prompt text.",
      },
      intent: {
        type: "string",
        description: "Natural-language task intent for lightweight capability ranking, e.g. 'audit checkout and commit'. Returns a short ranked list. Does not grant tool permissions.",
      },
      limit: {
        type: "number", minimum: 1, maximum: 20,
        description: "Maximum tools to show (1-20); intent defaults to 8.",
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
      const normMatch = tools.find((t) => t.name.toLowerCase().replace(/[-_]/g, "_") === norm);
      if (normMatch) return normMatch;
      const aliasTarget = TOOL_ALIASES[norm] || TOOL_ALIASES[lower];
      if (aliasTarget) {
        return tools.find((t) => t.name === aliasTarget);
      }
      return undefined;
    });

  const out = names.map((name) => {
    const t = findTool(name);
    if (!t) {
      const custom = opts.unavailableMessage?.(name);
      if (custom) return { name, error: custom };
      const lowerName = name.toLowerCase();
      const tokens = lowerName.split(/[-_ \t]+/).filter((tok) => tok.length > 2);

      const suggestions = tools
        .map((tool) => {
          const tName = tool.name.toLowerCase();
          const fScore = fuzzyScore(name, tool.name);
          let tokenScore = 0;
          if (tName.includes(lowerName) || lowerName.includes(tName)) {
            tokenScore += 50;
          }
          for (const token of tokens) {
            if (tName.includes(token)) {
              tokenScore += 25;
            }
          }
          const score = Math.max(fScore, tokenScore);
          return { name: tool.name, score };
        })
        .filter((x) => x.score >= 16)
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
    "Get full descriptions and JSON argument schemas for one or more tools by name, unlocking them for execution. ALWAYS call this BEFORE calling an unfamiliar tool. Calling an undescribed tool will fail. Supports batch lookup: { names: [\"tool1\", \"tool2\"] }.",
  parameters: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: "Single tool name to describe and unlock, e.g. 'run_command' or 'manage_plan'.",
      },
      names: {
        type: "array",
        items: { type: "string" },
        description: "Batch tool names to describe and unlock in ONE call, e.g. [\"read\", \"write_to_file\", \"run_command\"].",
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

export const getToolsTool = listToolsTool;
export const describeToolsTool = describeToolTool;

