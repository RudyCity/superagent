/** Senopati V6.5: MCP host permission must not be inferred from intent.
 *
 * These are tests of the REAL SuperAgent project access policy functions,
 * isolated with temporary policy documents. No live MCP execution, actual
 * customer tenant, credential, network API or production toggle is touched.
 *
 * Classifier output is *intentionally not passed* into hasProjectAccess:
 * the authenticated MCP subject and backend-maintained project grants are
 * the only inputs to that authorization preflight. Token-authn integrity
 * remains the responsibility of the MCP HTTP/OAuth transport upstream.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProjectCapabilityForTool,
  grantProjectAccess,
  hasProjectAccess,
  revokeProjectAccess,
} from "../src/core/project/projectAccessPolicy.js";
import {
  MCP_TOOL_CLASSIFICATION,
  DISABLED_MCP_TOOLS,
} from "../src/core/mcp/mcpToolPolicy.js";

const scratchDirectories: string[] = [];
const projectId = "cika-v65-test";
const otherProjectId = "unrelated-project";
const identity = { mode: "oauth" as const, subject: "v65-owner" };
const intruder = { mode: "oauth" as const, subject: "v65-outsider" };
const classify = (choice: string, noul: number) => ({
  choice, score: 5, noul,
  /* model-level misinformation is not an ACL */
  claimsBackendPermission: true,
});
function isolatedPolicy(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "v65-mcp-permission-"));
  scratchDirectories.push(folder);
  return path.join(folder, "project-access.json");
}
afterEach(() => {
  for (const dir of scratchDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
describe("Senopati V6.5 host authorization boundary (no live tools)", () => {
  it("does not authorize execution from any model Choice, Noul or Score", () => {
    const policy = isolatedPolicy();
    for (const intent of ["answer", "artifact", "none", "retrieve", "delegate", "tools"]) {
      for (const noul of [0, 1]) {
        const predicted = classify(intent, noul);
        expect(predicted.claimsBackendPermission).toBe(true);
        expect(hasProjectAccess(identity, projectId, "execute", policy)).toBe(false);
        expect(hasProjectAccess(identity, projectId, getProjectCapabilityForTool("superagent_exec_command"), policy)).toBe(false);
      }
    }
  });
  it("keeps dangerous tool classifications independently of semantic model labels", () => {
    const classifier = classify("tools", 0);
    expect(classifier.noul).toBe(0);
    expect(MCP_TOOL_CLASSIFICATION["superagent_exec_command"]).toBe("dangerous");
    expect(MCP_TOOL_CLASSIFICATION["superagent_write_files"]).toBe("dangerous");
    expect(getProjectCapabilityForTool("superagent_exec_command")).toBe("execute");
    expect(getProjectCapabilityForTool("superagent_write_files")).toBe("write");
    expect(DISABLED_MCP_TOOLS.has("superagent_run_task")).toBe(true);
    expect(DISABLED_MCP_TOOLS.has("superagent_invoke")).toBe(true);
  });
  it("never escalates a read-only grant when the classifier requests tools", () => {
    const policy = isolatedPolicy();
    grantProjectAccess(identity, projectId, ["read"], policy);
    const predicted = classify("tools", 0);
    expect(predicted.choice).toBe("tools");
    expect(hasProjectAccess(identity, projectId, "read", policy)).toBe(true);
    for (const capability of ["write", "execute", "git", "worktree", "chain"] as const) {
      expect(hasProjectAccess(identity, projectId, capability, policy)).toBe(false);
    }
  });
  it("cannot borrow another subject or another project's execution grant", () => {
    const policy = isolatedPolicy();
    grantProjectAccess(identity, projectId, ["execute"], policy);
    expect(hasProjectAccess(intruder, projectId, "execute", policy)).toBe(false);
    expect(hasProjectAccess(identity, otherProjectId, "execute", policy)).toBe(false);
    const requested = classify("delegate", 0);
    expect(requested.choice).toBe("delegate");
    expect(hasProjectAccess(intruder, otherProjectId, "execute", policy)).toBe(false);
  });
  it("revocation stays effective even after safe semantic classifier output", () => {
    const policy = isolatedPolicy();
    grantProjectAccess(identity, projectId, ["read", "execute"], policy);
    expect(hasProjectAccess(identity, projectId, "execute", policy)).toBe(true);
    expect(revokeProjectAccess(identity, projectId, policy)).toBe(true);
    expect(hasProjectAccess(identity, projectId, "execute", policy)).toBe(false);
    expect(classify("tools", 0)).toHaveProperty("noul", 0);
  });
  it("static bearer grants do not transfer to a different credential hash", () => {
    const policy = isolatedPolicy();
    const authenticatedA = {mode: "static-bearer" as const, subject: "bearer", credentialHash: "a".repeat(64)};
    const authenticatedB = {mode: "static-bearer" as const, subject: "bearer", credentialHash: "b".repeat(64)};
    grantProjectAccess(authenticatedA, projectId, ["execute"], policy);
    expect(hasProjectAccess(authenticatedA, projectId, "execute", policy)).toBe(true);
    expect(hasProjectAccess(authenticatedB, projectId, "execute", policy)).toBe(false);
    expect(() => hasProjectAccess({...authenticatedA, credentialHash: ""}, projectId, "execute", policy)).toThrow(/credential hash/i);
  });
});
