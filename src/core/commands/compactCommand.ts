import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import { getContextWindowLimit, getEffectiveMasterModel } from "../config.js";
import { benchmarkCompaction, hierarchyForCheckpoint } from "../context/ContextContinuity.js";
import { PruningStrategy } from "../context/strategies/PruningStrategy.js";

/**
 * Commands are shared by CLI and T-Line:
 * /compact [status|preview|now|snapshots|undo [id]|benchmark]
 */
export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Inspect context, compact, benchmark or undo a compaction",
  async execute(args, ctx) {
    const tokens = args.trim().split(/\s+/).filter(Boolean);
    const action = (tokens[0] || "status").toLowerCase();
    const agent = ctx.agent;
    const conversation = agent?.getHistory();
    const cm = conversation?.getContextManager?.();
    const add = (message: string, error = false) => ctx.addLine({
      type: error ? "error" : "system", content: message, timestamp: Date.now(),
    });

    if (!agent || !conversation || !cm) {
      add("ContextManager not initialized. Send a message first.", true);
      return;
    }
    const store = cm.getContinuity();
    const messages = conversation.getMessages();
    const model = getEffectiveMasterModel("auto") || getDefaultModel();
    const modelLimit = getContextWindowLimit(model);
    const estimated = cm.estimateTokensForAll(messages).total;
    const checkpoint = store.preview(messages).checkpoint;

    if (action === "preview") {
      const layers = hierarchyForCheckpoint(checkpoint);
      add([
        "Compaction preview (read-only; no LLM call or changes)",
        "  Model: " + model,
        "  Estimated tokens: " + estimated.toLocaleString(),
        "  Adaptive threshold: " + cm.getAdaptiveThreshold().toLocaleString(),
        "  Active goal: " + (layers.working.goal || "(unknown)"),
        "  Pending tasks: " + layers.working.pending.slice(0, 8).join(" | "),
        "  Blockers: " + layers.working.blockers.slice(0, 4).join(" | "),
        "  Session decisions: " + layers.session.decisions.length,
        "  Known files: " + layers.session.files.length,
        "  Verification evidence: " + layers.session.verification.length,
        "  Project memory: candidates only (requires review before RMemory promotion)",
      ].join("\n"));
      return;
    }
    if (action === "snapshots") {
      const snapshots = store.listSnapshots();
      add(snapshots.length
        ? "Compaction snapshots (newest last):\n" + snapshots.map((s) =>
          "  " + s.id + " | " + new Date(s.createdAt).toLocaleString() +
          " | " + s.messages + " messages | " + s.goal
        ).join("\n")
        : "No undo snapshots for this session.");
      return;
    }
    if (action === "undo") {
      if (cm.getState() !== "IDLE") {
        add("Cannot undo while ContextManager is " + cm.getState() + ".", true);
        return;
      }
      const restored = store.restore(tokens[1]);
      if (!restored) {
        add("No matching snapshot. Use /compact snapshots to view available IDs.", true);
        return;
      }
      conversation.replaceMessages(restored);
      await agent.saveHistory();
      add("Restored " + restored.length + " messages from compaction snapshot. Review the current goal before continuing.");
      return;
    }
    if (action === "benchmark") {
      if (messages.length < 2) { add("Not enough messages to benchmark.", true); return; }
      // Non-mutating dry-run: deterministic pruning on cloned source, no LLM.
      const after = await new PruningStrategy().execute(structuredClone(messages), {
        tokenBudget: Math.max(1000, Math.floor(cm.getAdaptiveThreshold() * 0.5)),
        preserveRecent: 8,
      });
      const report = benchmarkCompaction(messages, after.messages);
      add([
        "Context compaction benchmark (dry-run)",
        "  Payload bytes: " + report.bytesBefore.toLocaleString() + " -> " + report.bytesAfter.toLocaleString(),
        "  Reduction: " + report.reductionPct + "%",
        "  Continuity quality: " + report.quality.score + "/100",
        "  Goal retained: " + report.quality.passed,
        "  Risks: " + (report.quality.warnings.concat(report.quality.missing).join(", ") || "none"),
        "  Structured checkpoint fields: " + report.checkpointFields,
      ].join("\n"));
      return;
    }
    if (action === "now") {
      if (cm.getState() !== "IDLE") {
        add("Cannot compact: ContextManager is " + cm.getState() + ".", true);
        return;
      }
      if (messages.length < 10) { add("Not enough messages to compact (minimum 10 messages).", true); return; }
      add("Forcing context compaction (quality validation + undo snapshot enabled)...");
      try {
        const result = await cm.compact(messages);
        conversation.replaceMessages(result.messages);
        await agent.saveHistory();
        const after = cm.estimateTokensForAll(result.messages).total;
        add([
          "Compaction completed.",
          "  Strategy: " + result.metadata.strategy,
          "  Messages: " + messages.length + " -> " + result.messages.length,
          "  Tokens: " + estimated.toLocaleString() + " -> " + after.toLocaleString(),
          "  Continuity score: " + (result.metadata.quality?.score ?? cm.getQualityScore()) + "/100",
          "  Undo: /compact undo",
        ].join("\n"));
      } catch (error) {
        add("Compaction failed: " + (error instanceof Error ? error.message : String(error)), true);
      }
      return;
    }
    if (action !== "status") {
      add("Usage: /compact [status|preview|now|snapshots|undo [id]|benchmark]", true);
      return;
    }
    const metrics = store.getMetrics();
    const last = metrics.latest;
    add([
      conversation.getCompactSummary(modelLimit),
      "ContextManager: " + cm.getState(),
      "  Adaptive trigger: " + cm.getAdaptiveThreshold().toLocaleString() + " tokens",
      "  Compactions (session metrics): " + metrics.count,
      "  Tokens saved: " + metrics.tokensSaved.toLocaleString(),
      "  Failures: " + metrics.failures,
      "  Mean compaction time: " + (metrics.count ? Math.round(metrics.totalDurationMs / metrics.count) : 0) + " ms",
      "  Last strategy: " + (last?.strategy || "none"),
      "  Last continuity quality: " + (last?.quality ?? "n/a"),
      "  Last heuristic fallback: " + (last?.fallback ? "yes" : "no"),
      "  Undo snapshots: " + store.listSnapshots().length,
      "  Commands: /compact preview | now | snapshots | undo | benchmark",
    ].join("\n"));
  },
};
registry.register(compactCommand);
