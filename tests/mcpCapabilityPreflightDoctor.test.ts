/**
 * mcpCapabilityPreflightDoctor.test.ts — Comprehensive test matrix for MCP Tool Capability,
 * Preflight Engine, Doctor, and Health Aggregator.
 *
 * Covers scenarios:
 * 1. Project grant available but host policy blocks.
 * 2. OAuth scope missing.
 * 3. Project capability missing.
 * 4. File outside workspace / project root.
 * 5. Native approval not granted / required.
 * 6. Dependency missing.
 * 7. Service timeout isolated (does not fail other services).
 * 8. Target CDP not claimed (session lease missing).
 * 9. Session revision changed / lease validation.
 * 10. Schema offers action that is uncertified.
 * 15. Dynamic gateway discovery and aliases compatibility.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runToolPreflight } from "../src/core/mcp/mcpToolPreflight.js";
import { runToolDoctor } from "../src/core/mcp/mcpToolDoctor.js";
import { doctorCommand } from "../src/core/commands/coreCommands.js";
import {
  getBaseToolCapability,
  getToolActionCapabilities,
  evaluateActionCapability,
} from "../src/core/mcp/mcpCapabilityMatrix.js";
import { aggregateRuntimeHealth } from "../src/core/mcp/mcpHealthAggregator.js";
import { checkDependencies } from "../src/core/mcp/mcpDependencyManager.js";
import { canonicalizeToolName, getDeprecatedAliasInfo } from "../src/core/tools/toolAliases.js";
import {
  describeGatewayTool,
  searchGatewayTools,
  validateGatewayExecuteTarget,
  isCdpGatewayOnly,
  isGatewayInitiallyAdvertisedTool,
} from "../src/core/mcp/mcpToolGateway.js";

describe("Unified Tool Capability Matrix & Preflight Engine", () => {
  // Scenario 1: Project grant available but host policy blocks
  it("Scenario 1: reports host_policy_blocked when project grant is present but host policy is uncertified", async () => {
    const res = await runToolPreflight({
      name: "superagent_chrome_cdp",
      action: "eval_js",
      arguments: { command: "eval_js", script: "alert(1)" },
      hasProjectAccess: () => true,
      hostPolicyActive: true,
    });

    expect(res.ok).toBe(false);
    expect(res.reasonCode).toBe("host_policy_blocked");
    expect(res.readiness).toBe("policy_blocked");
    expect(res.message).toContain("uncertified under permanent host file-policy");
    expect(res.remediation).toBeTruthy();
  });

  // Scenario 2: OAuth scope missing
  it("Scenario 2: rejects execution with oauth_scope_missing when caller lacks required scope", async () => {
    const res = await runToolPreflight({
      name: "superagent_write_files",
      arguments: { files: [{ path: "test.txt", content: "hello" }] },
      scopes: ["mcp:tools"], // missing mcp:tools:write
    });

    expect(res.ok).toBe(false);
    expect(res.reasonCode).toBe("oauth_scope_missing");
    expect(res.readiness).toBe("approval_required");
    expect(res.checks.oauth.pass).toBe(false);
    expect(res.remediation).toContain("mcp:tools:write");
  });

  // Scenario 3: Project capability missing
  it("Scenario 3: reports project_grant_missing when caller lacks required project capability", async () => {
    const res = await runToolPreflight({
      name: "superagent_git_action",
      action: "commit",
      arguments: { action: "commit", message: "test commit" },
      // Without project selection
    });

    expect(res.ok).toBe(false);
    expect(res.reasonCode).toBe("project_grant_missing");
    expect(res.checks.project_grants.pass).toBe(false);
    expect(res.remediation).toContain("registered project");
  });

  // Scenario 4: File outside workspace / project
  it("Scenario 4: reports file_outside_project when argument references file outside project root", async () => {
    const preflight = await runToolPreflight({
      name: "superagent_read_files",
      arguments: { files: ["/outside/root/secret.txt"], filePath: "../../secret.txt" },
      projectPath: "D:\\test_project",
      hasProjectAccess: () => true,
    });

    expect(preflight.checks.path_boundary).toBeDefined();
    expect(preflight.checks.path_boundary?.pass).toBe(false);
    expect(preflight.reasonCode).toBe("file_outside_project");
  });

  // Scenario 5: Native approval required
  it("Scenario 5: flags approval_required for operations requiring operator confirmation", async () => {
    const res = await runToolPreflight({
      name: "superagent_desktop_ui",
      action: "screenshot",
      arguments: { command: "screenshot" },
      hasProjectAccess: () => true,
    });

    expect(res.readiness).toBe("approval_required");
    expect(res.reasonCode).toBe("approval_required");
    expect(res.message).toContain("operator");
  });

  // Scenario 6: Dependency missing
  it("Scenario 6: reports dependency_missing when action prerequisites are not met", async () => {
    const res = await runToolPreflight({
      name: "superagent_media_transform",
      action: "remove_background",
      arguments: { operation: "remove_background", inputPath: "a.png", outputPath: "b.png" },
      hasProjectAccess: () => true,
    });

    // In environment without rembg, must flag dependency_missing
    const depCheck = await checkDependencies(["rembg"]);
    if (!depCheck.allSatisfied) {
      expect(res.ok).toBe(false);
      expect(res.reasonCode).toBe("dependency_missing");
      expect(res.checks.dependencies.pass).toBe(false);
      expect(res.remediation).toContain("rembg");
    }
  });

  // Scenario 7: Service timeout isolated
  it("Scenario 7: aggregates service health and isolates probe timeouts without failing other services", async () => {
    const health = await aggregateRuntimeHealth(["core", "daemon", "cdp"], 500);

    expect(health).toBeDefined();
    expect(health.services.daemon).toBeDefined();
    expect(health.services.daemon.state).toBe("active");
    // Even if CDP or core is unavailable or times out, daemon state is not cancelled
    expect(typeof health.summary.active).toBe("number");
    expect(health.services.daemon.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // Scenario 8: Target CDP not claimed
  it("Scenario 8: reports target_not_claimed when leased web actions are invoked without sessionToken", async () => {
    const res = await runToolPreflight({
      name: "superagent_chrome_cdp",
      action: "navigate",
      arguments: {
        command: "navigate",
        url: "https://example.com",
        expectedRevision: 1,
        // sessionToken omitted
      },
      hasProjectAccess: () => true,
      serviceAvailable: true,
    });

    expect(res.ok).toBe(false);
    expect(res.reasonCode).toBe("target_not_claimed");
    expect(res.checks.target_session.pass).toBe(false);
    expect(res.remediation).toContain("claim_target");
  });

  // Scenario 9: Session revision changed / invalid expectedRevision
  it("Scenario 9: validates expectedRevision in preflight arguments", async () => {
    const res = await runToolPreflight({
      name: "superagent_chrome_cdp",
      action: "navigate",
      arguments: {
        command: "navigate",
        url: "https://example.com",
        sessionToken: "valid_session_token_12345678",
        expectedRevision: -5, // invalid revision
      },
      hasProjectAccess: () => true,
      serviceAvailable: true,
    });

    expect(res.ok).toBe(false);
    expect(res.reasonCode).toBe("invalid_arguments");
    expect(res.checks.lease_and_revision.pass).toBe(false);
  });

  // Scenario 10: Schema offers action that is uncertified
  it("Scenario 10: accurately flags uncertified actions in capability matrix", () => {
    const caps = getToolActionCapabilities("superagent_chrome_cdp");
    const uploadCap = caps.find((c) => c.action === "upload_file");
    const evalCap = caps.find((c) => c.action === "eval_js");
    const listCap = caps.find((c) => c.action === "list_targets");

    expect(uploadCap).toBeDefined();
    expect(uploadCap?.hostFilePolicy).toBe("certified_upload_ingress");
    expect(evalCap?.hostFilePolicy).toBe("uncertified");
    expect(listCap?.hostFilePolicy).toBe("certified_read");
  });

  // Scenario 15: Compatibility dynamic gateway and aliases
  it("Scenario 15: preserves dynamic gateway discovery, resolves tool aliases, and identifies deprecated endpoints", () => {
    // Aliases
    expect(canonicalizeToolName("cdp")).toBe("control_chrome_cdp");
    expect(canonicalizeToolName("get_tools")).toBe("list_tools");
    expect(canonicalizeToolName("get_tool")).toBe("describe_tool");

    const deprecated = getDeprecatedAliasInfo("superagent_remote_chrome");
    expect(deprecated.deprecated).toBe(true);
    expect(deprecated.canonical).toBe("superagent_chrome_cdp");

    // Gateway describe
    const dummyTools = [
      { name: "superagent_chrome_cdp", description: "CDP automation", inputSchema: { type: "object" } },
      { name: "superagent_tool_search", description: "Search", inputSchema: { type: "object" } },
    ];
    const desc = describeGatewayTool(dummyTools as any, "superagent_chrome_cdp");
    expect(desc).not.toBeNull();
    expect(desc?.actions).toBeDefined();
    expect(desc?.actions?.length).toBeGreaterThan(0);

    // Gateway search
    const searchRes = searchGatewayTools(dummyTools as any, { query: "chrome" });
    expect(searchRes.length).toBeGreaterThan(0);
    expect(searchRes[0].name).toBe("superagent_chrome_cdp");

    // Gateway target validation
    const validTarget = validateGatewayExecuteTarget(dummyTools as any, {
      name: "superagent_chrome_cdp",
      arguments: { command: "list_targets" },
    });
    expect(validTarget).not.toBeNull();
    expect(validTarget?.name).toBe("superagent_chrome_cdp");
  });
});

describe("Tool Doctor Diagnostics", () => {
  it("audits the MCP catalog and classifies actions without blind success claims", async () => {
    const report = await runToolDoctor({ filter: "chrome", runSmokeTests: false });

    expect(report.summary.totalTools).toBeGreaterThan(0);
    expect(report.summary.countsByStatus).toBeDefined();
    expect(report.actions.length).toBeGreaterThan(0);

    const mutatingAction = report.actions.find(
      (a) => a.toolName === "superagent_chrome_cdp" && a.action === "eval_js"
    );
    expect(mutatingAction).toBeDefined();
    expect(mutatingAction?.status).toBe("not_tested_by_design");
  });

  it("doctorCommand executes and writes formatted audit report to context", async () => {
    const lines: Array<{ type: string; content: string }> = [];
    const mockCtx = {
      addLine: (line: { type: string; content: string }) => lines.push(line),
    };

    await doctorCommand.execute("fast", mockCtx as any);

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const reportLine = lines.find((l) => l.content.includes("SUPERAGENT MCP TOOL DOCTOR AUDIT REPORT"));
    expect(reportLine).toBeDefined();
    expect(reportLine?.content).toContain("Total Audited Tools");
    expect(reportLine?.content).toContain("STATUS TIERS");
    expect(reportLine?.content).toContain("Discovered");
    expect(reportLine?.content).toContain("RUNTIME DEPENDENCIES");
  });
});
