import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  planGlobalLifecycleRecycle,
  executeGlobalLifecycleRecycle,
  reconcileGlobalLifecycleRecycle,
  determineServiceDisposition,
  GlobalRecycleLedger,
  type GlobalRecyclePlan,
} from "../src/core/runtime/globalLifecycleRecycle.js";
import type { ServiceStatus } from "../src/core/runtime/serviceManager.js";

describe("Global Lifecycle Recycle Orchestrator", () => {
  it("determines safe dispositions for various service states", async () => {
    // Supervised healthy Core
    const supervisedCore: ServiceStatus = {
      service: "core",
      port: 7888,
      state: "active",
      ownerPid: 1001,
      ownershipVerified: true,
      actions: ["status", "plan", "restart"],
      reason: "Supervised Core",
    };
    const coreDisp = await determineServiceDisposition(supervisedCore);
    expect(coreDisp.disposition).toBe("keep");
    expect(coreDisp.reasonCode).toBe("CORE_SUPERVISED_HEALTHY");

    // Verified reloadable MCP
    const reloadableMcp: ServiceStatus = {
      service: "mcp",
      port: 8857,
      state: "active",
      ownerPid: 1002,
      ownershipVerified: true,
      actions: ["status", "plan", "reload"],
      reason: "Reloadable MCP",
      details: { reloadable: true },
    };
    const mcpDisp = await determineServiceDisposition(reloadableMcp);
    expect(mcpDisp.disposition).toBe("keep");
    expect(mcpDisp.reasonCode).toBe("MCP_VERIFIED_RELOADABLE_PRESERVED");

    // Inactive optional channel host
    const inactiveChannel: ServiceStatus = {
      service: "channel_host",
      port: 7892,
      state: "inactive",
      ownerPid: null,
      ownershipVerified: false,
      actions: ["status"],
      reason: "No channel host",
    };
    const channelDisp = await determineServiceDisposition(inactiveChannel);
    expect(channelDisp.disposition).toBe("skip_inactive");

    // Embedded Daemon
    const embeddedDaemon: ServiceStatus = {
      service: "daemon",
      port: 7888,
      state: "embedded",
      ownerPid: null,
      ownershipVerified: true,
      actions: ["status"],
      reason: "Embedded scheduler",
    };
    const daemonDisp = await determineServiceDisposition(embeddedDaemon);
    expect(daemonDisp.disposition).toBe("verify_only");

    // Tunnels are never mutated
    const restTunnel: ServiceStatus = {
      service: "rest_tunnel",
      port: 7888,
      state: "active",
      ownerPid: 1003,
      ownershipVerified: true,
      actions: ["status"],
      reason: "Cloudflare tunnel",
    };
    const tunnelDisp = await determineServiceDisposition(restTunnel);
    expect(tunnelDisp.disposition).toBe("keep");
    expect(tunnelDisp.reasonCode).toBe("TUNNEL_PRESERVED");
  });

  it("plans global lifecycle recycle with bounded expiration and safe invariants", async () => {
    const plan = await planGlobalLifecycleRecycle();

    expect(plan.version).toBe(1);
    expect(plan.operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(plan.expiresAt).toBeGreaterThan(plan.createdAt);
    expect(plan.expiresAt - plan.createdAt).toBe(5 * 60 * 1000);
    expect(plan.publicTunnelMutationAllowed).toBe(false);
    expect(plan.arbitraryPidKillAllowed).toBe(false);

    expect(plan.children.length).toBeGreaterThanOrEqual(10);
    expect(plan.summary.total).toBe(plan.children.length);
    expect(plan.summary.mutations + plan.summary.noops + plan.summary.blocked).toBe(plan.summary.total);

    // MCP must be KEEP or BLOCKED, never arbitrary restart/recycle
    const mcpPlan = plan.children.find((c) => c.service === "mcp");
    expect(["keep", "blocked", "skip_inactive"]).toContain(mcpPlan?.disposition);

    // Daemon and Process Supervisor must be VERIFY_ONLY
    const daemonPlan = plan.children.find((c) => c.service === "daemon");
    expect(daemonPlan?.disposition).toBe("verify_only");
    const supervisorPlan = plan.children.find((c) => c.service === "process_supervisor");
    expect(supervisorPlan?.disposition).toBe("verify_only");
  }, 25000);

  it("fails closed on expired plan or unconfirmed execution", async () => {
    const plan: GlobalRecyclePlan = {
      version: 1,
      operationId: crypto.randomUUID(),
      createdAt: Date.now() - 10 * 60 * 1000,
      expiresAt: Date.now() - 5 * 60 * 1000, // Expired 5 mins ago
      dependencyOrder: ["core", "mcp"],
      children: [],
      summary: { total: 0, mutations: 0, noops: 0, blocked: 0 },
      publicTunnelMutationAllowed: false,
      arbitraryPidKillAllowed: false,
      note: "expired plan",
    };

    // Unconfirmed fails closed
    await expect(executeGlobalLifecycleRecycle(plan, false)).rejects.toThrow(
      "GLOBAL_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED"
    );

    // Expired fails closed
    await expect(executeGlobalLifecycleRecycle(plan, true)).rejects.toThrow(
      "GLOBAL_RECYCLE_PLAN_EXPIRED"
    );
  });

  it("fails closed when any child plan is blocked", async () => {
    const plan: GlobalRecyclePlan = {
      version: 1,
      operationId: crypto.randomUUID(),
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      dependencyOrder: ["vision"],
      children: [
        {
          service: "vision",
          disposition: "blocked",
          reasonCode: "VISION_GRACEFUL_STOP_UNAVAILABLE",
          note: "Cannot shut down legacy vision safely",
          dependencyState: [],
        },
      ],
      summary: { total: 1, mutations: 0, noops: 0, blocked: 1 },
      publicTunnelMutationAllowed: false,
      arbitraryPidKillAllowed: false,
      note: "blocked child plan",
    };

    new GlobalRecycleLedger().recordPlan(plan);
    await expect(executeGlobalLifecycleRecycle(plan, true)).rejects.toThrow(
      "GLOBAL_RECYCLE_CHILD_BLOCKED"
    );
  });

  it("reconciles uncertain operations without re-executing mutations", async () => {
    const testOpId = crypto.randomUUID();
    const ledger = new GlobalRecycleLedger();

    const plan: GlobalRecyclePlan = {
      version: 1,
      operationId: testOpId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,
      dependencyOrder: ["core"],
      children: [
        {
          service: "core",
          disposition: "keep",
          reasonCode: "CORE_SUPERVISED_HEALTHY",
          note: "test",
          dependencyState: [],
        },
      ],
      summary: { total: 1, mutations: 0, noops: 1, blocked: 0 },
      publicTunnelMutationAllowed: false,
      arbitraryPidKillAllowed: false,
      note: "reconcile test plan",
    };

    ledger.recordPlan(plan);
    ledger.fail(testOpId, "uncertain", "Simulated network timeout");

    const before = ledger.lookup(testOpId);
    expect(before?.status).toBe("uncertain");

    // Reconcile requires operator reviewed confirmation
    await expect(reconcileGlobalLifecycleRecycle(testOpId, false)).rejects.toThrow(
      "GLOBAL_RECYCLE_RECONCILE_REVIEWED_REQUIRED"
    );

    const reconciled = await reconcileGlobalLifecycleRecycle(testOpId, true);
    expect(reconciled.status).toBe("reconciled");

    const after = ledger.lookup(testOpId);
    expect(after?.status).toBe("reconciled");
  });
});
