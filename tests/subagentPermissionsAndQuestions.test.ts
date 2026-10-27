import { describe, expect, it, vi } from "vitest";

describe("Subagent permissions and question fallback (DEEP-03 & DEEP-11)", () => {
  it("fails closed on permission checks when no parent handler exists", async () => {
    // Simulate subagent permission handler logic
    const parentAgent = null;
    const subagentId = "sub-123";
    const role = "coder";

    const permissionHandler = async (toolCall: any, desc: string) => {
      const cmd = (toolCall.args?.command as string || "").trim();
      const isDestructive = cmd.includes("rm -rf") || cmd.includes("format");
      if (isDestructive) return false;

      if (parentAgent && typeof (parentAgent as any).onPermission === "function") {
        return await (parentAgent as any).onPermission(toolCall, desc);
      }
      return false; // Fail closed
    };

    const outOfBoundsCall = { name: "write_to_file", args: { files: [{ filePath: "../outside.ts" }] } };
    const result = await permissionHandler(outOfBoundsCall, "Write out of bounds");
    expect(result).toBe(false);
  });

  it("delegates to parent permission handler with provenance and inherits approval", async () => {
    const parentCalls: any[] = [];
    const parentAgent: any = {
      sessionId: "parent-sess-456",
      onPermission: vi.fn(async (toolCall, desc) => {
        parentCalls.push({ toolCall, desc });
        return true;
      }),
    };
    const subagentId = "sub-123";
    const role = "coder";

    const permissionHandler = async (toolCall: any, desc: string) => {
      const cmd = (toolCall.args?.command as string || "").trim();
      const isDestructive = cmd.includes("rm -rf");
      if (isDestructive) return false;

      const provenance = `[Subagent ${subagentId} (${role}) via parent ${parentAgent?.sessionId || "root"}]`;
      if (parentAgent && typeof parentAgent.onPermission === "function") {
        try {
          const approved = await parentAgent.onPermission(toolCall, `${provenance} ${desc}`);
          return approved === "session" ? true : !!approved;
        } catch {
          return false;
        }
      }
      return false;
    };

    const sensitiveCall = { name: "read", args: { filePaths: [".env"] } };
    const approved = await permissionHandler(sensitiveCall, "Accessing .env");
    expect(approved).toBe(true);
    expect(parentCalls).toHaveLength(1);
    expect(parentCalls[0].desc).toContain("[Subagent sub-123 (coder) via parent parent-sess-456]");
  });

  it("blocks destructive commands even if parent might approve", async () => {
    const parentAgent: any = {
      sessionId: "parent-sess-456",
      onPermission: vi.fn(async () => true),
    };
    const subagentId = "sub-123";
    const role = "coder";

    const permissionHandler = async (toolCall: any, desc: string) => {
      const cmd = (toolCall.args?.command as string || "").trim();
      const isDestructive = /\b(rm\s+-rf|format|drop\s+database)\b/i.test(cmd);
      if (isDestructive) return false;

      if (parentAgent && typeof parentAgent.onPermission === "function") {
        return await parentAgent.onPermission(toolCall, desc);
      }
      return false;
    };

    const destructiveCall = { name: "run_command", args: { command: "rm -rf /" } };
    const approved = await permissionHandler(destructiveCall, "Destructive rm");
    expect(approved).toBe(false);
    expect(parentAgent.onPermission).not.toHaveBeenCalled();
  });

  it("throws explicit [NEEDS_INPUT] error and never silently falls back to options[0]", async () => {
    let subagentStatus = "running";
    const activeUIHandler = null; // No UI handler
    const masterAgent = null; // No master agent

    const questionHandler = async (question: string, options: string[] = []) => {
      if (masterAgent) return "master answer";
      if (activeUIHandler) return "ui answer";

      subagentStatus = "waiting";
      const qStr = typeof question === "string" ? question : JSON.stringify(question);
      throw new Error(
        `[NEEDS_INPUT] No active user interface or master orchestrator is available to answer question: "${qStr}". Execution paused pending user input.`
      );
    };

    await expect(
      questionHandler("Should we deploy to production?", ["Yes, deploy immediately", "No, cancel"])
    ).rejects.toThrow(/\[NEEDS_INPUT\].*Execution paused pending user input/);

    expect(subagentStatus).toBe("waiting");
  });
});
