import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProjectAccessPolicyPath,
  getProjectPrincipalKey,
  grantProjectAccess,
  hasProjectAccess,
  listProjectAccess,
  revokeProjectAccess,
  revokeAllProjectAccess,
} from "../src/core/project/projectAccessPolicy.js";

const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-access-policy-"));
  dirs.push(dir);
  return path.join(dir, "project-access.json");
}
const identity = { mode: "oauth" as const, subject: "client-one" };
const anotherIdentity = { mode: "oauth" as const, subject: "client-two" };

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP project access policy", () => {
  it("starts with no grants and uses a private default policy path", () => {
    const policyPath = fixture();
    expect(getProjectAccessPolicyPath(policyPath)).toBe(path.resolve(policyPath));
    expect(hasProjectAccess(identity, "repo", "read", policyPath)).toBe(false);
  });

  it("grants exact capabilities to one stable MCP identity and persists across token rotation", () => {
    const policyPath = fixture();
    grantProjectAccess(identity, "repo", ["read", "write"], policyPath);
    expect(hasProjectAccess(identity, "repo", "read", policyPath)).toBe(true);
    expect(hasProjectAccess(identity, "repo", "write", policyPath)).toBe(true);
    expect(hasProjectAccess(identity, "repo", "execute", policyPath)).toBe(false);
    expect(hasProjectAccess(anotherIdentity, "repo", "read", policyPath)).toBe(false);
    expect(listProjectAccess(identity, policyPath)).toMatchObject([{ projectId: "repo", capabilities: ["read", "write"] }]);
    expect(getProjectPrincipalKey(identity)).not.toContain(identity.subject);
  });

  it("replaces existing capabilities and revokes only the caller's grant", () => {
    const policyPath = fixture();
    grantProjectAccess(identity, "repo", ["read", "write"], policyPath);
    grantProjectAccess(identity, "repo", ["read"], policyPath);
    expect(hasProjectAccess(identity, "repo", "write", policyPath)).toBe(false);
    expect(revokeProjectAccess(anotherIdentity, "repo", policyPath)).toBe(false);
    expect(revokeProjectAccess(identity, "repo", policyPath)).toBe(true);
    expect(hasProjectAccess(identity, "repo", "read", policyPath)).toBe(false);
  });

  it("rejects malformed capabilities and invalid persisted policy rather than granting access", () => {
    const policyPath = fixture();
    expect(() => grantProjectAccess(identity, "repo", ["admin" as any], policyPath)).toThrow(/capabilities/i);
    fs.writeFileSync(policyPath, "{bad", "utf8");
    expect(() => hasProjectAccess(identity, "repo", "read", policyPath)).toThrow(/Invalid MCP project access policy JSON/i);
  });

  it("can revoke every principal's grant when a project is removed or its target changes", () => {
    const policyPath = fixture();
    grantProjectAccess(identity, "repo", ["read"], policyPath);
    grantProjectAccess(anotherIdentity, "repo", ["read", "write"], policyPath);
    expect(revokeAllProjectAccess("repo", policyPath)).toBe(2);
    expect(hasProjectAccess(identity, "repo", "read", policyPath)).toBe(false);
    expect(hasProjectAccess(anotherIdentity, "repo", "write", policyPath)).toBe(false);
  });

  it("binds static bearer project grants to the bearer hash so token rotation does not inherit access", () => {
    const policyPath = fixture();
    const tokenA = { mode: "static-bearer" as const, subject: "bearer", credentialHash: "a".repeat(64) };
    const tokenB = { mode: "static-bearer" as const, subject: "bearer", credentialHash: "b".repeat(64) };
    grantProjectAccess(tokenA, "repo", ["read"], policyPath);
    expect(hasProjectAccess(tokenA, "repo", "read", policyPath)).toBe(true);
    expect(hasProjectAccess(tokenB, "repo", "read", policyPath)).toBe(false);
    expect(() => hasProjectAccess({ mode: "static-bearer", subject: "bearer" }, "repo", "read", policyPath)).toThrow(/credential hash/i);
  });

  it("rejects unsafe project identifiers", () => {
    const policyPath = fixture();
    expect(() => grantProjectAccess(identity, "../repo", ["read"], policyPath)).toThrow(/projectId/i);
  });
});
