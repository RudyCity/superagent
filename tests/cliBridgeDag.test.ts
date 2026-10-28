import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  getRoleProfile,
  registerRoleProfile,
  listRoleProfiles,
  type AgentRoleProfile,
} from "../src/core/tools/cliBridgeRoleProfiles.js";
import {
  createDagGraph,
  getRunnableNodes,
  advanceDagNode,
  evaluateSpeculativeCandidates,
  evaluateConsensusVerdicts,
  saveDagGraph,
  loadDagGraph,
  listDags,
  executeDagGraph,
  runSpeculativeWorkflow,
  runConsensusWorkflow,
} from "../src/core/tools/cliBridgeDag.js";

describe("Milestone M4 — Agent Profiles & Durable DAG Orchestration", () => {
  describe("Agent Role Profiles (P5)", () => {
    it("provides built-in role profiles for architect, coder, tester, reviewer, researcher", () => {
      const architect = getRoleProfile("architect");
      expect(architect).toBeDefined();
      expect(architect?.permissionMode).toBe("read-only");
      expect(architect?.resourceClass).toBe("light");

      const coder = getRoleProfile("coder");
      expect(coder).toBeDefined();
      expect(coder?.permissionMode).toBe("git-write");
      expect(coder?.worktreePolicy).toBe("isolated");

      const tester = getRoleProfile("tester");
      expect(tester?.permissionMode).toBe("safe-shell");
      expect(tester?.resourceClass).toBe("heavy");

      const reviewer = getRoleProfile("reviewer");
      expect(reviewer?.permissionMode).toBe("read-only");

      const researcher = getRoleProfile("researcher");
      expect(researcher?.permissionMode).toBe("read-only");
    });

    it("registers and lists custom project role profiles", () => {
      const customProf: AgentRoleProfile = {
        roleId: "db-specialist",
        title: "Database Specialist",
        description: "Manages migrations and schema tuning",
        cliAlias: "agy",
        permissionMode: "safe-shell",
        resourceClass: "normal",
        timeoutMs: 90000,
        worktreePolicy: "isolated",
        systemInstructions: "Optimize queries and execute migrations.",
        maxRetries: 1,
      };

      registerRoleProfile(customProf);
      const found = getRoleProfile("db-specialist");
      expect(found).toBeDefined();
      expect(found?.title).toBe("Database Specialist");

      const all = listRoleProfiles();
      expect(all.some((p) => p.roleId === "db-specialist")).toBe(true);
    });
  });

  describe("Durable DAG Graph & Dependency Orchestration (P6)", () => {
    it("fails closed on missing dependencies and circular loops", () => {
      // 1. Missing dependency
      expect(() =>
        createDagGraph({
          name: "Invalid",
          workspaceRoot: process.cwd(),
          nodes: [{ id: "stepA", prompt: "A", dependencies: ["nonExistent"] }],
        })
      ).toThrow("depends on non-existent node");

      // 2. Circular dependency
      expect(() =>
        createDagGraph({
          name: "Circular",
          workspaceRoot: process.cwd(),
          nodes: [
            { id: "stepA", prompt: "A", dependencies: ["stepB"] },
            { id: "stepB", prompt: "B", dependencies: ["stepA"] },
          ],
        })
      ).toThrow("Circular dependency detected");
    });

    it("executes multi-tier pipeline with fan-out, join/barrier, and bounded concurrency", () => {
      // Pipeline:
      // audit (architect)
      //   ├── implement1 (coder 1)
      //   └── implement2 (coder 2)
      //         └── join -> review (reviewer)
      const graph = createDagGraph({
        name: "FeatureWorkflow",
        workspaceRoot: process.cwd(),
        maxFanOut: 2,
        nodes: [
          { id: "audit", roleId: "architect", prompt: "Analyze requirements" },
          { id: "coder1", roleId: "coder", prompt: "Implement part 1", dependencies: ["audit"] },
          { id: "coder2", roleId: "coder", prompt: "Implement part 2", dependencies: ["audit"] },
          { id: "review", roleId: "reviewer", prompt: "Review both", dependencies: ["coder1", "coder2"] },
        ],
      });

      expect(graph.status).toBe("pending");

      // 1. Initially only 'audit' is runnable
      let runnable = getRunnableNodes(graph);
      expect(runnable.map((n) => n.id)).toEqual(["audit"]);

      // Complete 'audit'
      advanceDagNode(graph, "audit", { status: "succeeded" });
      expect(graph.status).toBe("running");

      // 2. Both coder1 and coder2 become runnable (fan-out = 2)
      runnable = getRunnableNodes(graph);
      expect(runnable.map((n) => n.id).sort()).toEqual(["coder1", "coder2"]);

      // 'review' must NOT run yet because coder1 and coder2 have not finished (join barrier)
      expect(runnable.some((n) => n.id === "review")).toBe(false);

      // Complete coder1 only
      advanceDagNode(graph, "coder1", { status: "succeeded" });
      runnable = getRunnableNodes(graph);
      // 'review' is still blocked waiting for coder2
      expect(runnable.map((n) => n.id)).toEqual(["coder2"]);

      // Complete coder2
      advanceDagNode(graph, "coder2", { status: "succeeded" });

      // 3. Now join barrier is satisfied, 'review' is runnable
      runnable = getRunnableNodes(graph);
      expect(runnable.map((n) => n.id)).toEqual(["review"]);

      // Complete 'review'
      advanceDagNode(graph, "review", {
        status: "succeeded",
        result: { verdict: "approve" },
      });

      // Entire graph succeeds
      expect(graph.status).toBe("succeeded");
      expect(graph.nodes.review.result?.verdict).toBe("approve");
    });

    it("propagates failure and cancels downstream nodes under failFast", () => {
      const graph = createDagGraph({
        name: "FailingPipeline",
        workspaceRoot: process.cwd(),
        failFast: true,
        nodes: [
          { id: "step1", prompt: "Setup" },
          { id: "step2", prompt: "Build", dependencies: ["step1"] },
          { id: "step3", prompt: "Deploy", dependencies: ["step2"] },
        ],
      });

      // Step 1 fails
      advanceDagNode(graph, "step1", { status: "failed", result: { error: "Compilation error" } });

      expect(graph.status).toBe("failed");
      expect(graph.nodes.step1.status).toBe("failed");
      expect(graph.nodes.step2.status).toBe("cancelled");
      expect(graph.nodes.step3.status).toBe("cancelled");

      const runnable = getRunnableNodes(graph);
      expect(runnable).toHaveLength(0);
    });
  });

  describe("Reviewer, Consensus & Speculative Execution (P7)", () => {
    it("evaluates consensus verdict across multiple independent reviewers", () => {
      const verdicts = [
        { agentId: "rev1", verdict: "approve" as const },
        { agentId: "rev2", verdict: "approve" as const },
        { agentId: "rev3", verdict: "request_changes" as const },
      ];

      const res = evaluateConsensusVerdicts(verdicts);
      expect(res.consensusVerdict).toBe("approve");
      expect(res.agreementRatio).toBe(0.67);
      expect(res.votes.approve).toBe(2);
      expect(res.votes.request_changes).toBe(1);
    });

    it("evaluates speculative candidate execution and picks the first verified winner", () => {
      const candidates = [
        { candidateId: "candA", verificationState: "verification_failed" as const },
        { candidateId: "candB", verificationState: "verified" as const },
        { candidateId: "candC", verificationState: "succeeded_unverified" as const },
      ];

      const res = evaluateSpeculativeCandidates(candidates);
      expect(res.winnerId).toBe("candB");
      expect(res.loserIds.sort()).toEqual(["candA", "candC"]);
    });
  });
});
