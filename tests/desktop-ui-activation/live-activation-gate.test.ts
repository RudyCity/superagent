import { describe, expect, it } from "vitest";
import {
  assessDesktopMcpOwnerEvidence,
  type McpServiceEvidence,
} from "../../src/core/desktopUi/liveActivationGate.js";

const publicUrl = "https://example.trycloudflare.com/mcp";
const active: McpServiceEvidence = {
  service: "mcp",
  port: 9227,
  state: "active",
  ownerPid: 1001,
  ownershipVerified: true,
  details: {
    publicUrl,
    reloadable: true,
    backendPid: 2002,
    backendHealthy: true,
    authMode: "oauth",
    backendGenerationDetails: [{ sessions: 9, inFlight: 2 }],
  },
};

describe("desktop MCP live owner preflight", () => {
  it("accepts matching active owner snapshots and reports live session risk", () => {
    const result = assessDesktopMcpOwnerEvidence(active, structuredClone(active), publicUrl);
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toContain("MCP_SESSIONS_OR_REQUESTS_ACTIVE");
    expect(result.ownerPid).toBe(1001);
  });

  it("fails closed if a single doctor snapshot cannot verify the owner", () => {
    const doctor = structuredClone(active);
    doctor.state = "degraded";
    doctor.ownershipVerified = false;
    const result = assessDesktopMcpOwnerEvidence(active, doctor, publicUrl);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("MCP_OWNER_NOT_CONSISTENTLY_VERIFIED");
  });

  it("rejects a stale backend generation even if both views say active", () => {
    const doctor = structuredClone(active);
    doctor.details!.backendPid = 2003;
    expect(assessDesktopMcpOwnerEvidence(active, doctor, publicUrl).reasons)
      .toContain("MCP_BACKEND_GENERATION_CHANGED");
  });

  it("refuses mismatched owner PID or public URL", () => {
    const doctor = structuredClone(active);
    doctor.ownerPid = 5555;
    expect(assessDesktopMcpOwnerEvidence(active, doctor, publicUrl).reasons)
      .toContain("MCP_OWNER_IDENTITY_CHANGED");
    expect(assessDesktopMcpOwnerEvidence(active, active, "https://other.example/mcp").reasons)
      .toContain("MCP_PUBLIC_URL_MISMATCH");
  });

  it("refuses missing evidence and unhealthy backend", () => {
    expect(assessDesktopMcpOwnerEvidence(undefined, active, publicUrl).reasons)
      .toContain("MCP_SERVICE_EVIDENCE_MISSING");
    const unhealthy = structuredClone(active);
    unhealthy.details!.backendHealthy = false;
    expect(assessDesktopMcpOwnerEvidence(active, unhealthy, publicUrl).reasons)
      .toContain("MCP_BACKEND_NOT_HEALTHY");
  });
});
