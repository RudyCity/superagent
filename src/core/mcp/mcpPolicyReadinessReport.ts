/**
 * Deterministic, read-only inventory of the CODE-level MCP host-file policy.
 * This is never a production certification or a permission grant.
 */
import { MCP_TOOL_DEFINITIONS } from "./superagentMcpServer.js";
import { MCP_TOOL_CLASSIFICATION, DISABLED_MCP_TOOLS } from "./mcpToolPolicy.js";
import {
  getPermanentFileToolReadiness, type PermanentFileToolReadiness,
} from "../tools/registeredFileToolGate.js";

const EFFECTS: readonly PermanentFileToolReadiness[] = [
  "certified_metadata", "certified_non_file", "certified_app_storage", "requires_explicit_files",
  "action_dependent", "uncertified",
];

export interface McpPolicyReadinessReport {
  version: 1;
  scope: "source_catalog_only";
  registeredTools: number;
  disabledTools: number;
  effectCounts: Record<PermanentFileToolReadiness, number>;
  unsafeToolNames: string[];
  classificationComplete: boolean;
  codeTested: false;
  runtimeVerified: false;
  releaseReady: false;
  limitations: string[];
}

export function buildMcpPolicyReadinessReport(): McpPolicyReadinessReport {
  const active = MCP_TOOL_DEFINITIONS.filter(t => !DISABLED_MCP_TOOLS.has(t.name));
  const names = new Set<string>();
  const effectCounts = Object.fromEntries(EFFECTS.map(effect => [effect, 0])) as
    Record<PermanentFileToolReadiness, number>;
  const unsafeToolNames: string[] = [];
  let classificationComplete = true;

  for (const tool of active) {
    if (names.has(tool.name) || !["safe", "dangerous"].includes(
      String(MCP_TOOL_CLASSIFICATION[tool.name]),
    )) classificationComplete = false;
    names.add(tool.name);
    const effect = getPermanentFileToolReadiness(tool.name);
    effectCounts[effect]++;
    if (effect === "uncertified") unsafeToolNames.push(tool.name);
  }
  unsafeToolNames.sort();

  return {
    version: 1,
    scope: "source_catalog_only",
    registeredTools: active.length,
    disabledTools: MCP_TOOL_DEFINITIONS.length - active.length,
    effectCounts,
    unsafeToolNames,
    classificationComplete,
    codeTested: false,
    runtimeVerified: false,
    releaseReady: false,
    limitations: [
      "Source-level classification is not per-action authorization.",
      "OAuth, MCP Connection Controls, project grants and native approvals remain mandatory.",
      "This report contains no installed Core/Tray, tunnel, device or release evidence.",
      "A public release requires immutable tag, native asset receipts and R0-R7 review.",
    ],
  };
}
