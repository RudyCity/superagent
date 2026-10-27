import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CORE_GUARDIAN_POLICY, decideCoreGuardianRecovery,
  validateCoreGuardianPolicy, coreGuardianFile, readCoreGuardianLease,
} from "../src/core/runtime/coreGuardian.js";

const originalConfig = process.env.SUPERAGENT_CONFIG_DIR;
const paths: string[] = [];
afterEach(() => {
  if (originalConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfig;
  for (const root of paths.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function withRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "core-guardian-unit-"));
  paths.push(root);
  process.env.SUPERAGENT_CONFIG_DIR = root;
  return root;
}
const allowed = {
  guardianStopping: false, verifiedInitialOwner: true, currentChildWasOwned: true,
  checkpointVerified: true, foreignOwnerOnline: false, recentAttempts: 0,
};
describe("bounded, owner-scoped Core guardian", () => {
  it("requires a verified child and matching checkpoint, never adopts outside-owned supervisor", () => {
    expect(decideCoreGuardianRecovery(allowed)).toBe("recover");
    for (const key of ["guardianStopping", "foreignOwnerOnline"] as const) {
      expect(decideCoreGuardianRecovery({ ...allowed, [key]: true })).toBe("refuse");
    }
    for (const key of ["verifiedInitialOwner", "currentChildWasOwned", "checkpointVerified"] as const) {
      expect(decideCoreGuardianRecovery({ ...allowed, [key]: false })).toBe("refuse");
    }
  });
  it("limits repeated failures rather than looping forever", () => {
    expect(DEFAULT_CORE_GUARDIAN_POLICY.maxRecoveries).toBe(3);
    expect(decideCoreGuardianRecovery({
      ...allowed, recentAttempts: DEFAULT_CORE_GUARDIAN_POLICY.maxRecoveries,
    })).toBe("refuse");
    expect(decideCoreGuardianRecovery({ ...allowed, recentAttempts: -1 })).toBe("refuse");
    expect(decideCoreGuardianRecovery(allowed, { maxRecoveries: 0, backoffMs: 100, windowMs: 10_000 }))
      .toBe("refuse");
  });
  it("rejects unbounded policy input", () => {
    expect(() => validateCoreGuardianPolicy({ maxRecoveries: 99, windowMs: 60_000, backoffMs: 1000 })).toThrow();
    expect(() => validateCoreGuardianPolicy({ maxRecoveries: 3, windowMs: 999, backoffMs: 1000 })).toThrow();
    expect(() => validateCoreGuardianPolicy({ maxRecoveries: 3, windowMs: 60_000, backoffMs: 0 })).toThrow();
  });
  it("conservatively reports missing, corrupt and symlinked leases", () => {
    const root = withRoot();
    const port = 53416;
    expect(readCoreGuardianLease(port)).toBeNull();
    const file = coreGuardianFile(port);
    fs.writeFileSync(file, "invalid");
    expect(() => readCoreGuardianLease(port)).toThrow();
    fs.writeFileSync(file, JSON.stringify({ version: 1, port, pid: 12,
      instanceId: "a".repeat(32), startedAt: 123, clientMode: "tline",
      supervisorPid: 44, ownership: "adopted" }));
    expect(readCoreGuardianLease(port)).toMatchObject({
      port, pid: 12, clientMode: "tline", supervisorPid: 44, ownership: "adopted",
    });
    fs.rmSync(file);
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, JSON.stringify({}));
    fs.symlinkSync(target, file);
    expect(() => readCoreGuardianLease(port)).toThrow();
  });
  it("rejects wrong ports and unknown lease schemas", () => {
    withRoot();
    expect(() => coreGuardianFile(0)).toThrow();
    expect(() => coreGuardianFile(99999)).toThrow();
    const file = coreGuardianFile(53316);
    fs.writeFileSync(file, JSON.stringify({
      version: 1, port: 53316, pid: -1, instanceId: "b".repeat(32),
      startedAt: 123, clientMode: "tline",
    }));
    expect(() => readCoreGuardianLease(53316)).toThrow();
  });
});
