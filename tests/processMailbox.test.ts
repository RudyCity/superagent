import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  sendEnvelopeToProcess,
  pollProcessMailbox,
  cleanupProcessMailbox,
  startMailboxListener,
  getMailboxPath,
  ensureMailboxDir,
} from "../src/core/ipc/processMailbox.js";

describe("processMailbox IPC", () => {
  const testPid = process.pid;

  beforeEach(() => {
    ensureMailboxDir();
    cleanupProcessMailbox(testPid);
  });

  afterEach(() => {
    cleanupProcessMailbox(testPid);
  });

  it("writes and drains envelopes for a valid PID", () => {
    // Send envelope
    const res = sendEnvelopeToProcess(testPid, {
      type: "message",
      message: "Please focus on checkout form validation",
      sender: "mcp",
    });

    expect(res.success).toBe(true);
    expect(res.pid).toBe(testPid);

    // Verify file exists
    const mailboxFile = getMailboxPath(testPid);
    expect(fs.existsSync(mailboxFile)).toBe(true);

    // Poll and drain envelopes
    const envelopes = pollProcessMailbox(testPid);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].type).toBe("message");
    expect(envelopes[0].message).toBe("Please focus on checkout form validation");
    expect(envelopes[0].sender).toBe("mcp");

    // After polling, mailbox should be cleared
    expect(fs.existsSync(mailboxFile)).toBe(false);
    expect(pollProcessMailbox(testPid)).toHaveLength(0);
  });

  it("queues multiple envelopes in order", () => {
    sendEnvelopeToProcess(testPid, { type: "pause", sender: "mcp" });
    sendEnvelopeToProcess(testPid, { type: "message", message: "Step 1", sender: "mcp" });
    sendEnvelopeToProcess(testPid, { type: "resume", sender: "mcp" });

    const envelopes = pollProcessMailbox(testPid);
    expect(envelopes).toHaveLength(3);
    expect(envelopes[0].type).toBe("pause");
    expect(envelopes[1].type).toBe("message");
    expect(envelopes[1].message).toBe("Step 1");
    expect(envelopes[2].type).toBe("resume");
  });

  it("startMailboxListener receives envelopes asynchronously", async () => {
    const received: string[] = [];
    const stopListener = startMailboxListener(
      testPid,
      (env) => {
        received.push(env.type);
      },
      50
    );

    sendEnvelopeToProcess(testPid, { type: "pause" });
    sendEnvelopeToProcess(testPid, { type: "resume" });

    // Wait for polling interval
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopListener();

    expect(received).toContain("pause");
    expect(received).toContain("resume");
  });
});
