import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { workspaceChainManager } from "../src/core/workspace/WorkspaceChainManager.js";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";
import { WorkspaceChain } from "../src/core/workspace/WorkspaceChainTypes.js";
import fs from "fs";
import path from "path";

// Mock ssh2 and ssh2-sftp-client
const mockClient = {
  connect: vi.fn().mockReturnThis(),
  on: vi.fn(function(event: string, cb: any) {
    if (event === "ready") {
      setTimeout(() => cb(), 5);
    }
    return mockClient;
  }),
  exec: vi.fn((cmd: string, cb: any) => {
    const stream = {
      on: vi.fn((event: string, streamCb: any) => {
        if (event === "data") {
          setTimeout(() => streamCb(Buffer.from("mock output")), 5);
        }
        return stream;
      }),
      stderr: {
        on: vi.fn((event: string, streamCb: any) => streamCb(Buffer.from("")))
      },
      close: vi.fn()
    };
    setTimeout(() => {
      const closeCb = stream.on.mock.calls.find(c => c[0] === "close")?.[1];
      if (closeCb) closeCb(0);
    }, 15);
    cb(null, stream);
  }),
  end: vi.fn()
};

const mockSftp = {
  connect: vi.fn().mockResolvedValue(true),
  get: vi.fn().mockResolvedValue(Buffer.from("mock file content")),
  put: vi.fn().mockResolvedValue(true),
  mkdir: vi.fn().mockResolvedValue(true),
  end: vi.fn()
};

vi.mock("ssh2", () => {
  return {
    Client: vi.fn().mockImplementation(() => mockClient)
  };
});

vi.mock("ssh2-sftp-client", () => {
  return {
    default: vi.fn().mockImplementation(() => mockSftp)
  };
});


describe("WorkspaceChainManager SSH and Boundaries", () => {
  const chain: WorkspaceChain = {
    id: "test-chain",
    name: "Test Chain",
    nodes: [
      { id: "local-node", label: "Local", type: "local", role: "main", path: "/tmp/local-workspace" },
      {
        id: "ssh-node",
        label: "SSH Node",
        type: "ssh",
        role: "deploy",
        sshConfig: {
          host: "ssh.example.com",
          port: 2222,
          username: "ubuntu",
          remoteCwd: "/home/ubuntu/app"
        }
      }
    ],
    primaryNodeId: "local-node",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  beforeEach(async () => {
    workspaceMode.setLocalMode();
    await workspaceChainManager.disconnectAll();
    
    // Inject active chain directly
    (workspaceChainManager as any).activeChain = chain;
    (workspaceChainManager as any).activeNodeId = chain.primaryNodeId;

    vi.spyOn(workspaceChainManager, "getActiveChain").mockReturnValue(chain);
    vi.spyOn(workspaceChainManager, "getNode").mockImplementation((id) => {
      return chain.nodes.find(n => n.id === id) || null;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await workspaceChainManager.disconnectAll();
    workspaceMode.setLocalMode();
  });

  it("should synchronize active node changes with workspaceMode", async () => {
    // Start with local node
    workspaceChainManager.setActiveNode("local-node");
    expect(workspaceMode.isSsh()).toBe(false);

    // Switch to SSH node
    workspaceChainManager.setActiveNode("ssh-node");
    expect(workspaceMode.isSsh()).toBe(true);
    expect(workspaceMode.getConfig()?.host).toBe("ssh.example.com");

    // Switch back to local node
    workspaceChainManager.setActiveNode("local-node");
    expect(workspaceMode.isSsh()).toBe(false);
  });

  it("should enforce boundary checks for local nodes in file operations", async () => {
    workspaceChainManager.setActiveNode("local-node");

    // Local file write outside boundary should throw
    await expect(
      workspaceChainManager.writeFileToNode("local-node", "../../etc/passwd", "malicious")
    ).rejects.toThrow(/escapes local workspace boundary/);

    // Local file read outside boundary should throw
    await expect(
      workspaceChainManager.readFileFromNode("local-node", "/etc/passwd")
    ).rejects.toThrow(/escapes local workspace boundary/);
  });

  it("should enforce boundary checks for SSH nodes in file operations", async () => {
    workspaceChainManager.setActiveNode("ssh-node");

    // SSH file write outside boundary should throw
    await expect(
      workspaceChainManager.writeFileToNode("ssh-node", "../../etc/passwd", "malicious")
    ).rejects.toThrow(/escapes remote workspace boundary/);

    // SSH file read outside boundary should throw
    await expect(
      workspaceChainManager.readFileFromNode("ssh-node", "/etc/passwd")
    ).rejects.toThrow(/escapes remote workspace boundary/);
  });

  it("should enforce boundary checks for command execution", async () => {
    workspaceChainManager.setActiveNode("ssh-node");

    // SSH exec outside boundary should throw
    await expect(
      workspaceChainManager.execOnNode("ssh-node", "ls", "../../etc")
    ).rejects.toThrow(/escapes remote workspace boundary/);

    workspaceChainManager.setActiveNode("local-node");

    // Local exec outside boundary should throw
    await expect(
      workspaceChainManager.execOnNode("local-node", "ls", "../../etc")
    ).rejects.toThrow(/escapes local workspace boundary/);
  });
});
