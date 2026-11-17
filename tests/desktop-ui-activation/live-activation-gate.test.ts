import { describe, expect, it } from "vitest";
import {
  assessDesktopMcpOwnerEvidence,
  isSameVerifiedMcpGeneration,
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

  it("rejects a successful but replaced owner/backend between preflight and postflight", () => {
    const digest = "b".repeat(64);
    const snapshot = structuredClone(active);
    snapshot.details!.backendReleaseDigest = digest;
    const before = assessDesktopMcpOwnerEvidence(snapshot, snapshot, publicUrl, digest);
    expect(isSameVerifiedMcpGeneration(before, before)).toBe(true);
    const newOwner = structuredClone(snapshot);
    newOwner.ownerPid = 3003;
    const ownerAfter = assessDesktopMcpOwnerEvidence(newOwner, newOwner, publicUrl, digest);
    expect(ownerAfter.ready).toBe(true);
    expect(isSameVerifiedMcpGeneration(before, ownerAfter)).toBe(false);
    const newBackend = structuredClone(snapshot);
    newBackend.details!.backendPid = 4004;
    const backendAfter = assessDesktopMcpOwnerEvidence(newBackend, newBackend, publicUrl, digest);
    expect(backendAfter.ready).toBe(true);
    expect(isSameVerifiedMcpGeneration(before, backendAfter)).toBe(false);
    expect(isSameVerifiedMcpGeneration(before,
      assessDesktopMcpOwnerEvidence(undefined, snapshot, publicUrl, digest))).toBe(false);
  });

  it("attests exact activated release digest across status and doctor snapshots", () => {
    const digest = "b".repeat(64);
    const matching = structuredClone(active);
    matching.details!.backendReleaseDigest = digest;
    const doctor = structuredClone(matching);
    expect(assessDesktopMcpOwnerEvidence(matching, doctor, publicUrl, digest).ready).toBe(true);

    // A healthy owner without a staged release is not the expected new build.
    expect(assessDesktopMcpOwnerEvidence(active, active, publicUrl, digest).reasons)
      .toContain("MCP_BACKEND_RELEASE_DIGEST_MISMATCH");
    doctor.details!.backendReleaseDigest = "c".repeat(64);
    expect(assessDesktopMcpOwnerEvidence(matching, doctor, publicUrl, digest).reasons)
      .toContain("MCP_BACKEND_RELEASE_DIGEST_MISMATCH");
    expect(assessDesktopMcpOwnerEvidence(matching, matching, publicUrl, "invalid").ready)
      .toBe(false);
    expect(assessDesktopMcpOwnerEvidence(matching, matching, publicUrl, "c".repeat(64)).ready)
      .toBe(false);
  });
});
