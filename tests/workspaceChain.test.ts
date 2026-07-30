/**
 * workspaceChain.test.ts — Unit tests for workspace chain feature.
 *
 * Tests chain creation, validation, config persistence, and topology formatting.
 */

import { describe, it, expect } from "vitest";

import {
  WorkspaceChain,
  WorkspaceNode,
  validateChain,
  generateChainId,
  generateNodeId,
  formatChainTopology,
} from "../src/core/workspace/WorkspaceChainTypes.js";

describe("WorkspaceChainTypes", () => {
  describe("generateChainId", () => {
    it("should generate ID from name", () => {
      expect(generateChainId("My Chain")).toBe("my-chain");
      expect(generateChainId("Deploy & Build")).toBe("deploy-build");
    });

    it("should fallback for empty name", () => {
      const id = generateChainId("");
      expect(id).toMatch(/^chain-\d+$/);
    });
  });

  describe("generateNodeId", () => {
    it("should generate ID from label", () => {
      expect(generateNodeId("SSH Server")).toBe("ssh-server");
      expect(generateNodeId("Local Dev")).toBe("local-dev");
    });

    it("should fallback for empty label", () => {
      const id = generateNodeId("");
      expect(id).toMatch(/^node-\d+$/);
    });
  });

  describe("validateChain", () => {
    it("should pass for valid chain", () => {
      const chain: WorkspaceChain = {
        id: "test-chain",
        name: "Test Chain",
        nodes: [
          { id: "main", label: "Main", type: "local", role: "main", path: "/tmp" },
          { id: "deploy", label: "Deploy", type: "ssh", role: "deploy", sshConfig: { host: "h", port: 22, username: "u", remoteCwd: "/app" } },
        ],
        primaryNodeId: "main",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors).toHaveLength(0);
    });

    it("should fail for empty nodes", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [],
        primaryNodeId: "main",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors).toContain("Chain must have at least one node");
    });

    it("should fail for missing primary node", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [
          { id: "node1", label: "N1", type: "local", role: "main", path: "/tmp" },
        ],
        primaryNodeId: "nonexistent",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors.some(e => e.includes("Primary node ID"))).toBe(true);
    });

    it("should fail for local node without path", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [
          { id: "n1", label: "N1", type: "local", role: "main" } as WorkspaceNode,
        ],
        primaryNodeId: "n1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors.some(e => e.includes("missing path"))).toBe(true);
    });

    it("should fail for ssh node without sshConfig", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [
          { id: "n1", label: "N1", type: "ssh", role: "deploy" } as WorkspaceNode,
        ],
        primaryNodeId: "n1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors.some(e => e.includes("missing sshConfig"))).toBe(true);
    });

    it("should fail for duplicate node IDs", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [
          { id: "dup", label: "N1", type: "local", role: "main", path: "/a" },
          { id: "dup", label: "N2", type: "local", role: "module", path: "/b" },
        ],
        primaryNodeId: "dup",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors.some(e => e.includes("Duplicate node ID"))).toBe(true);
    });

    it("should fail for invalid dependsOn reference", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [
          { id: "n1", label: "N1", type: "local", role: "main", path: "/a", dependsOn: ["nonexistent"] },
        ],
        primaryNodeId: "n1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const errors = validateChain(chain);
      expect(errors.some(e => e.includes("depends on non-existent node"))).toBe(true);
    });
  });

  describe("formatChainTopology", () => {
    it("should format chain with nodes", () => {
      const chain: WorkspaceChain = {
        id: "my-chain",
        name: "My Chain",
        description: "Test chain",
        nodes: [
          { id: "main", label: "Main Project", type: "local", role: "main", path: "/home/user/project" },
          { id: "deploy", label: "Deploy Server", type: "ssh", role: "deploy", sshConfig: { host: "prod.example.com", port: 22, username: "deploy", remoteCwd: "/var/www/app" }, dependsOn: ["main"] },
        ],
        primaryNodeId: "main",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const topology = formatChainTopology(chain, "main");
      expect(topology).toContain("My Chain");
      expect(topology).toContain("Main Project");
      expect(topology).toContain("Deploy Server");
      expect(topology).toContain("[ACTIVE]");
      expect(topology).toContain("[PRIMARY]");
      expect(topology).toContain("depends: [main]");
      expect(topology).toContain("prod.example.com");
    });

    it("should format without active node marker", () => {
      const chain: WorkspaceChain = {
        id: "test",
        name: "Test",
        nodes: [
          { id: "n1", label: "N1", type: "local", role: "main", path: "/tmp" },
        ],
        primaryNodeId: "n1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const topology = formatChainTopology(chain);
      expect(topology).toContain("[PRIMARY]");
      expect(topology).not.toContain("[ACTIVE]");
    });
  });
});

describe("WorkspaceChainConfig", () => {
  it("should create and validate a chain structure", () => {
    const nodes: WorkspaceNode[] = [
      { id: "local-dev", label: "Local Dev", type: "local", role: "main", path: "/home/user/dev" },
      {
        id: "ssh-prod",
        label: "SSH Prod",
        type: "ssh",
        role: "deploy",
        sshConfig: {
          host: "prod.server.com",
          port: 22,
          username: "deploy",
          remoteCwd: "/var/www/app",
        },
        dependsOn: ["local-dev"],
        description: "Production deployment server",
      },
    ];
    const chain: WorkspaceChain = {
      id: generateChainId("Dev to Prod"),
      name: "Dev to Prod",
      description: "Chain from local dev to production SSH",
      nodes,
      primaryNodeId: "local-dev",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const errors = validateChain(chain);
    expect(errors).toHaveLength(0);
    expect(chain.id).toBe("dev-to-prod");
    expect(chain.nodes).toHaveLength(2);
    expect(chain.nodes[1].dependsOn).toEqual(["local-dev"]);
  });
});