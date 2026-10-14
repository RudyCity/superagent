import type { Tool } from "./types.js";
import {
  describeToolTool,
  listToolsTool,
  runDescribeTool,
  runListTools,
  type DiscoveryDef,
} from "./toolDiscoveryTools.js";

const DISCOVERY_TOOL_NAMES = new Set(["list_tools", "describe_tool"]);

function getCatalogFingerprint(tools: Tool[]): string {
  try {
    return JSON.stringify(
      tools.map((tool) => [tool.name, tool.description, tool.parameters]),
    );
  } catch {
    return tools.map((tool) => tool.name).sort().join("|");
  }
}

function toDiscoveryDefs(tools: Tool[]): DiscoveryDef[] {
  return tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

/**
 * Keeps the tool registry authoritative while gradually exposing schemas to the
 * model. Discovery state belongs to one Agent instance, never to a global set.
 */
export class ToolDiscoveryState {
  private discoveredNames = new Set<string>();
  private catalogFingerprint = "";
  private authorizedNames = new Set<string>();

  private synchronizeCatalog(authorizedTools: Tool[]): void {
    const fingerprint = getCatalogFingerprint(authorizedTools);
    if (fingerprint !== this.catalogFingerprint) {
      this.discoveredNames.clear();
      this.catalogFingerprint = fingerprint;
    }
    this.authorizedNames = new Set(authorizedTools.map((tool) => tool.name));
  }

  public reset(): void {
    this.discoveredNames.clear();
  }

  public hasDiscovered(name: string): boolean {
    return this.discoveredNames.has(name);
  }

  /**
   * Return the model-visible tool list: discovery tools plus successfully
   * described tools that remain part of the agent's authorized catalog.
   */
  public getModelVisibleTools(authorizedTools: Tool[]): Tool[] {
    this.synchronizeCatalog(authorizedTools);
    const hasList = authorizedTools.some((tool) => tool.name === "list_tools");
    const hasDescribe = authorizedTools.some((tool) => tool.name === "describe_tool");

    // Respect explicitly supplied custom toolsets that do not opt into discovery.
    if (!hasList || !hasDescribe) return authorizedTools;

    return authorizedTools.filter(
      (tool) =>
        DISCOVERY_TOOL_NAMES.has(tool.name) ||
        this.discoveredNames.has(tool.name),
    );
  }

  /**
   * Bind list/describe execution to this agent's authorized catalog. Describing
   * a tool exposes its schema on the next model iteration; it grants no runtime
   * permission and never adds tools outside the catalog.
   */
  public wrapTools(
    authorizedTools: Tool[],
    unavailableMessage?: (name: string) => string | undefined,
  ): Tool[] {
    this.synchronizeCatalog(authorizedTools);
    const catalog = toDiscoveryDefs(authorizedTools);

    return authorizedTools.map((tool) => {
      if (tool.name === "list_tools") {
        return {
          ...listToolsTool,
          execute: async (args, _cwd, _signal) => runListTools(catalog, args),
        };
      }

      if (tool.name === "describe_tool") {
        return {
          ...describeToolTool,
          execute: async (args, _cwd, _signal) => {
            this.synchronizeCatalog(authorizedTools);
            const output = await runDescribeTool(catalog, args, {
              unavailableMessage,
            });

            try {
              const results = JSON.parse(output) as Array<{
                name?: unknown;
                error?: unknown;
              }>;
              for (const result of results) {
                if (
                  typeof result.name === "string" &&
                  !result.error &&
                  this.authorizedNames.has(result.name)
                ) {
                  this.discoveredNames.add(result.name);
                }
              }
            } catch {
              // An unexpected discovery result must not activate any tool.
            }

            return output;
          },
        };
      }

      return tool;
    });
  }
}
