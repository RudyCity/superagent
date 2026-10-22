import { describe, expect, it, vi } from "vitest";
import type { Message } from "../src/core/conversation.js";
import { ContextManager } from "../src/core/context/ContextManager.js";
import { compactCommand } from "../src/core/commands/compactCommand.js";
import { transcriptDigest } from "../src/core/context/ContextContinuity.js";

function fixture() {
  let messages: Message[] = [
    { role: "user", content: "Create secure subscription checkout", timestamp: 1 },
    ...Array.from({ length: 28 }, (_, i) => ({
      role: "assistant" as const, content: "Intermediate diagnostic " + i,
      timestamp: i + 2,
    })),
    { role: "user", content: "Finish webhook validation", timestamp: 99 },
  ];
  const cm = new ContextManager({ model: "test", contextWindowLimit: 10000 });
  let locked = false;
  const conversation = {
    getMessages: () => messages,
    replaceMessages: (next: Message[]) => { messages = [...next]; },
    getTranscriptDigest: () => transcriptDigest(messages),
    isCompactionLocked: () => locked,
    tryAcquireCompactionLock: () => {
      if (locked) return null;
      locked = true;
      return () => { locked = false; };
    },
    getContextManager: () => cm,
    getCompactSummary: () => "Current history summary",
  };
  const saveHistory = vi.fn(async () => undefined);
  const lines: string[] = [];
  const ctx = {
    agent: { getHistory: () => conversation, saveHistory },
    addLine: (line: { content: string }) => lines.push(line.content),
  } as any;
  return { conversation, cm, saveHistory, lines, ctx };
}

describe("/compact CLI controls", () => {
  it("previews safely, compacts, lists snapshots, then restores original history", async () => {
    const { conversation, cm, saveHistory, lines, ctx } = fixture();
    const initial = structuredClone(conversation.getMessages());
    await compactCommand.execute("preview", ctx);
    expect(lines.at(-1)).toContain("Finish webhook validation");
    expect(conversation.getMessages()).toEqual(initial);
    expect(saveHistory).not.toHaveBeenCalled();

    await compactCommand.execute("now", ctx);
    expect(lines.at(-1)).toContain("Compaction completed");
    expect(saveHistory).toHaveBeenCalledTimes(1);
    expect(cm.getContinuity().listSnapshots()).toHaveLength(1);
    expect(conversation.getMessages().length).toBeLessThan(initial.length);

    await compactCommand.execute("snapshots", ctx);
    expect(lines.at(-1)).toContain("compact-");
    await compactCommand.execute("undo", ctx);
    expect(lines.at(-1)).toContain("Restored");
    expect(conversation.getMessages()).toEqual(initial);
    expect(saveHistory).toHaveBeenCalledTimes(2);
    cm.dispose();
  });

  it("supports benchmark and status without changing session history", async () => {
    const { conversation, cm, lines, ctx, saveHistory } = fixture();
    const original = structuredClone(conversation.getMessages());
    await compactCommand.execute("benchmark", ctx);
    expect(lines.at(-1)).toContain("dry-run");
    expect(lines.at(-1)).toContain("Continuity quality");
    await compactCommand.execute("status", ctx);
    expect(lines.at(-1)).toContain("Adaptive trigger");
    expect(conversation.getMessages()).toEqual(original);
    expect(saveHistory).not.toHaveBeenCalled();
    cm.dispose();
  });

  it("rejects invalid snapshot IDs and unknown subcommands", async () => {
    const { cm, lines, ctx } = fixture();
    await compactCommand.execute("undo nope", ctx);
    expect(lines.at(-1)).toContain("No matching snapshot");
    await compactCommand.execute("delete-all", ctx);
    expect(lines.at(-1)).toContain("Usage: /compact");
    cm.dispose();
  });
});
