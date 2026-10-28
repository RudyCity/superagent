import { describe, it, expect } from "vitest";
import {
  getOrchestrationLiveStatus,
  getOrchestrationMetrics,
  registerActiveDag,
  getActiveDag,
  listActiveDags,
} from "../src/core/tools/cliBridgeOrchestrationFeed.js";
import { createDagGraph } from "../src/core/tools/cliBridgeDag.js";

describe("Milestone M6 — T-Line Live Orchestration Feed & Metrics", () => {
  it("provides live host strip, slot allocations, and active jobs feed", async () => {
    const feed = await getOrchestrationLiveStatus(process.cwd());

    expect(feed.timestamp).toBeGreaterThan(0);
    expect(feed.hostStrip.effectiveSlots).toBeGreaterThanOrEqual(2);
    expect(feed.hostStrip.effectiveSlots).toBeLessThanOrEqual(8);
    expect(["none", "moderate", "high", "critical"]).toContain(feed.hostStrip.pressure);
    expect(feed.hostStrip.cpuUsagePercent).toBeGreaterThanOrEqual(0);
    expect(feed.hostStrip.freeMemPercent).toBeGreaterThanOrEqual(0);

    expect(Array.isArray(feed.slots)).toBe(true);
    expect(feed.slots.length).toBe(feed.hostStrip.effectiveSlots);

    expect(Array.isArray(feed.jobs)).toBe(true);
    expect(Array.isArray(feed.activeDags)).toBe(true);
  });

  it("calculates aggregate metrics across completed delegations", async () => {
    const metrics = await getOrchestrationMetrics(process.cwd());

    expect(metrics.totalJobs).toBeGreaterThanOrEqual(0);
    expect(metrics.successRate).toBeGreaterThanOrEqual(0);
    expect(metrics.successRate).toBeLessThanOrEqual(1);
    expect(metrics.verifiedRate).toBeGreaterThanOrEqual(0);
    expect(metrics.verifiedRate).toBeLessThanOrEqual(1);
  });

  it("registers and retrieves active DAG workflows for live dashboard visibility", () => {
    const dag = createDagGraph({
      name: "TLine-Feature-Run",
      workspaceRoot: process.cwd(),
      nodes: [
        { id: "analyze", prompt: "Inspect module" },
        { id: "patch", prompt: "Apply fix", dependencies: ["analyze"] },
      ],
    });

    registerActiveDag(dag);

    const retrieved = getActiveDag(dag.graphId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.name).toBe("TLine-Feature-Run");

    const allDags = listActiveDags();
    expect(allDags.some((d) => d.graphId === dag.graphId)).toBe(true);
  });

  it("isolates DAG listings and hides foreign workspace slot details", async () => {
    const wsA = "C:/projects/ProjectA";
    const wsB = "C:/projects/ProjectB";

    const dagA = createDagGraph({
      name: "DAG-A",
      workspaceRoot: wsA,
      nodes: [{ id: "step1", prompt: "A task" }],
    });
    const dagB = createDagGraph({
      name: "DAG-B",
      workspaceRoot: wsB,
      nodes: [{ id: "step1", prompt: "B task" }],
    });

    registerActiveDag(dagA);
    registerActiveDag(dagB);

    const dagsForA = listActiveDags(wsA);
    expect(dagsForA.some((d) => d.graphId === dagA.graphId)).toBe(true);
    expect(dagsForA.some((d) => d.graphId === dagB.graphId)).toBe(false);

    const dagsForB = listActiveDags(wsB);
    expect(dagsForB.some((d) => d.graphId === dagB.graphId)).toBe(true);
    expect(dagsForB.some((d) => d.graphId === dagA.graphId)).toBe(false);
  });
});
