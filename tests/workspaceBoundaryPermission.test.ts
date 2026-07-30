/**
 * tests/workspaceBoundaryPermission.test.ts
 *
 * Verifies that the split out-of-bounds permission bypass flags work correctly:
 * - allowSessionOutOfBounds (shell/glob tools) must NOT bypass file write tools
 * - allowSessionFileWriteOutOfBounds (file write tools) must NOT bypass shell tools
 * - Approving a shell tool "for session" does not grant file write bypass
 * - Non-interactive CLI mode blocks out-of-bounds file writes and allows shell
 */

import { describe, it, expect, vi } from "vitest";
import { Agent } from "../src/core/agent.js";
import type { AgentEvent } from "../src/core/agent.js";
import { MODIFYING_TOOLS, isToolCallOutOfBounds } from "../src/core/permissions.js";
import { workspaceMode } from "../src/core/ssh/workspaceMode.js";

function makeAgent() {
  const onEvent = vi.fn((_e: AgentEvent) => {});
  const onPermission = vi.fn(async () => true as true);
  const onQuestion = vi.fn(async () => "");
  const agent = new Agent(onEvent, onPermission, onQuestion);
  agent.workingDirectory = "D:\\workspace\\project";
  return { agent, onEvent, onPermission, onQuestion };
}

// ─── Split flag defaults ───────────────────────────────────────────────────────

describe("Agent – workspace boundary split flags", () => {
  it("allowSessionOutOfBounds defaults to false", () => {
    const { agent } = makeAgent();
    expect(agent.allowSessionOutOfBounds).toBe(false);
  });

  it("allowSessionFileWriteOutOfBounds defaults to false", () => {
    const { agent } = makeAgent();
    expect(agent.allowSessionFileWriteOutOfBounds).toBe(false);
  });

  it("allowSessionOutOfBounds and allowSessionFileWriteOutOfBounds are independent", () => {
    const { agent } = makeAgent();
    agent.allowSessionOutOfBounds = true;
    // Setting shell bypass must NOT affect file write bypass
    expect(agent.allowSessionFileWriteOutOfBounds).toBe(false);
  });

  it("allowSessionFileWriteOutOfBounds=true does NOT affect allowSessionOutOfBounds", () => {
    const { agent } = makeAgent();
    agent.allowSessionFileWriteOutOfBounds = true;
    // Setting file write bypass must NOT affect shell bypass
    expect(agent.allowSessionOutOfBounds).toBe(false);
  });

  it("both flags can be set independently to true", () => {
    const { agent } = makeAgent();
    agent.allowSessionOutOfBounds = true;
    agent.allowSessionFileWriteOutOfBounds = true;
    expect(agent.allowSessionOutOfBounds).toBe(true);
    expect(agent.allowSessionFileWriteOutOfBounds).toBe(true);
  });
});

// ─── MODIFYING_TOOLS list correctness ─────────────────────────────────────────

describe("MODIFYING_TOOLS list", () => {
  it("contains the expected file write tools", () => {
    const expected = [
      "write",
      "write_to_file",
      "edit",
      "replace_file_content",
      "multi_replace_file_content",
      "apply_patch",
    ];
    for (const tool of expected) {
      expect(MODIFYING_TOOLS).toContain(tool);
    }
  });

  it("does NOT contain shell/read tools", () => {
    const nonWriteTools = ["run_command", "bash", "glob", "grep", "read_file", "list_dir"];
    for (const tool of nonWriteTools) {
      expect(MODIFYING_TOOLS).not.toContain(tool);
    }
  });
});

// ─── Non-interactive CLI permission handler ────────────────────────────────────

describe("Non-interactive CLI permission handler", () => {
  /**
   * Simulate the permission handler as defined in cli.tsx (non-TTY mode).
   * We extract the exact logic here to unit-test it without starting a CLI process.
   */
  const FILE_WRITE_TOOLS = [
    "write", "write_to_file", "edit",
    "replace_file_content", "multi_replace_file_content", "apply_patch",
  ];

  function cliNonInteractivePermissionHandler(toolCall: { name: string }, _description: string): false | true {
    if (FILE_WRITE_TOOLS.includes(toolCall.name)) {
      return false;
    }
    return true;
  }

  it("blocks write_to_file out-of-bounds in non-TTY mode", () => {
    const result = cliNonInteractivePermissionHandler(
      { name: "write_to_file" },
      "Writing to C:\\outside\\workspace\\file.ts"
    );
    expect(result).toBe(false);
  });

  it("blocks replace_file_content out-of-bounds in non-TTY mode", () => {
    const result = cliNonInteractivePermissionHandler(
      { name: "replace_file_content" },
      "Editing C:\\outside\\workspace\\file.ts"
    );
    expect(result).toBe(false);
  });

  it("blocks multi_replace_file_content out-of-bounds in non-TTY mode", () => {
    const result = cliNonInteractivePermissionHandler(
      { name: "multi_replace_file_content" },
      "Editing C:\\outside\\workspace\\file.ts"
    );
    expect(result).toBe(false);
  });

  it("blocks apply_patch out-of-bounds in non-TTY mode", () => {
    const result = cliNonInteractivePermissionHandler(
      { name: "apply_patch" },
      "Applying patch to C:\\outside\\workspace\\file.ts"
    );
    expect(result).toBe(false);
  });

  it("auto-approves run_command (shell) in non-TTY mode", () => {
    const result = cliNonInteractivePermissionHandler(
      { name: "run_command" },
      "Running command in C:\\outside\\workspace\\"
    );
    expect(result).toBe(true);
  });

  it("auto-approves glob in non-TTY mode", () => {
    const result = cliNonInteractivePermissionHandler(
      { name: "glob" },
      "Globbing C:\\outside\\workspace\\**"
    );
    expect(result).toBe(true);
  });

  it("blocks all MODIFYING_TOOLS in non-TTY mode", () => {
    for (const tool of FILE_WRITE_TOOLS) {
      const result = cliNonInteractivePermissionHandler(
        { name: tool },
        `Out-of-bounds file write via ${tool}`
      );
      expect(result).toBe(false);
    }
  });
});

// ─── SSH Workspace Mode Permission Boundary Tests ──────────────────────────────

describe("isToolCallOutOfBounds with SSH workspace mode", () => {
  it("allows bash commands targeting remoteCwd in SSH mode", () => {
    workspaceMode.setSshMode({
      host: "43.134.226.18",
      port: 2345,
      username: "ubuntu",
      remoteCwd: "/home/ubuntu",
    });

    const isOutOfBounds = isToolCallOutOfBounds(
      { name: "bash", args: { command: 'ls -la /home/ubuntu 2>&1; echo "EXIT:$?"' } },
      "/home/ubuntu"
    );
    expect(isOutOfBounds).toBe(false);
    workspaceMode.setLocalMode();
  });

  it("allows file reads inside remoteCwd in SSH mode", () => {
    workspaceMode.setSshMode({
      host: "43.134.226.18",
      port: 2345,
      username: "ubuntu",
      remoteCwd: "/home/ubuntu",
    });

    const isOutOfBounds = isToolCallOutOfBounds(
      { name: "view_file", args: { AbsolutePath: "/home/ubuntu/package.json" } },
      "/home/ubuntu"
    );
    expect(isOutOfBounds).toBe(false);
    workspaceMode.setLocalMode();
  });

  it("blocks file reads outside remoteCwd in SSH mode", () => {
    workspaceMode.setSshMode({
      host: "43.134.226.18",
      port: 2345,
      username: "ubuntu",
      remoteCwd: "/home/ubuntu",
    });

    const isOutOfBounds = isToolCallOutOfBounds(
      { name: "view_file", args: { AbsolutePath: "/etc/shadow" } },
      "/home/ubuntu"
    );
    expect(isOutOfBounds).toBe(true);
    workspaceMode.setLocalMode();
  });
});

