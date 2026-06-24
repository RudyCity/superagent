import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import type { AgentTag, PinnedMessage } from "../context/ContextManager.js";
import { addToKnowledge, removeKnowledgeByPin, updateKnowledgeTag } from "../pinnedKnowledge.js";
import { contentToString } from "../conversation.js";

/** Build an AgentTag from the current agent context */
function buildAgentTag(agent: any): AgentTag {
  return {
    tier: agent.tier || "unknown",
    subagentType: agent.subagentType,
    worktreePath: agent.worktreePath || undefined,
    workingDirectory: agent.workingDirectory,
    sessionLabel: agent.isMultiAgent
      ? `${agent.tier}${agent.subagentType ? `:${agent.subagentType}` : ""}`
      : undefined,
  };
}

/** Build a clean preview string from a message (single-line, truncated) */
function buildPreview(content: string, maxLen: number): string {
  let raw = (content || "").replace(/\r?\n/g, " ").trim();
  if (raw.length === 0) raw = "(empty)";
  return raw.length > maxLen ? raw.substring(0, maxLen) + "..." : raw;
}

/** Format an AgentTag into a short display string */
function formatAgentTag(tag?: AgentTag): string {
  if (!tag) return "";
  const parts: string[] = [];
  if (tag.tier && tag.tier !== "unknown") parts.push(tag.tier);
  if (tag.subagentType) parts.push(tag.subagentType);
  return parts.length > 0 ? `[${parts.join(":")}]` : "";
}

/** Format timestamp to relative time */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

// /pin command - pin important messages to prevent them from being compacted
export const pinCommand: SlashCommand = {
  name: "pin",
  description: "Pin an important message to prevent it from being compacted",
  execute(args, ctx) {
    const now = Date.now();
    const agent = ctx.agent;

    if (!agent) {
      ctx.addLine({
        type: "error",
        content: "No active agent.",
        timestamp: now,
      });
      return;
    }

    const cm = agent.getContextManager();
    if (!cm) {
      ctx.addLine({
        type: "error",
        content: "ContextManager not initialized. Send a message first to initialize it.",
        timestamp: now,
      });
      return;
    }

    const trimmed = args.trim();

    // ── /pin list-messages ─────────────────────────────────────────────
    if (trimmed === "list-messages" || trimmed === "lm") {
      const messages = agent.getHistory().getMessages();
      if (messages.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No messages in conversation.",
          timestamp: now,
        });
        return;
      }

      const pinnedIds = cm.getPinnedMessages();
      const pinnedFull = cm.getPinnedMessagesFull();
      const lines: string[] = [];

      lines.push("╔══════════════════════════════════════════════════════════════╗");
      lines.push("║          CONVERSATION MESSAGES (indexes for /pin)           ║");
      lines.push("╚══════════════════════════════════════════════════════════════╝");
      lines.push("");

      const displayCount = Math.min(messages.length, 50);
      const startIndex = Math.max(0, messages.length - displayCount);

      if (messages.length > displayCount) {
        lines.push(`  ... ${messages.length - displayCount} older messages not shown ...`);
        lines.push("");
      }

      const maxIdxStr = String(messages.length - 1).length;

      for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i];
        const msgId = `${i}:${msg.role}:${msg.timestamp}`;
        const isPinned = pinnedIds.has(msgId);

        let roleIcon: string;
        switch (msg.role) {
          case "user":      roleIcon = "👤 user"; break;
          case "assistant": roleIcon = "✦ agent"; break;
          case "tool":      roleIcon = "⚙ tool"; break;
          case "system":    roleIcon = "ℹ sys"; break;
          default:          roleIcon = `? ${msg.role}`; break;
        }

        const idxPadded = String(i).padStart(maxIdxStr, " ");
        const rolePadded = roleIcon.padEnd(9);

        // Build pin badge with agent tag if available
        let pinBadge = "";
        if (isPinned) {
          const pinnedData = pinnedFull.get(msgId);
          const agentTagStr = pinnedData ? formatAgentTag(pinnedData.agentTag) : "";
          const tagStr = pinnedData?.tag ? ` #${pinnedData.tag}` : "";
          pinBadge = ` 📌${agentTagStr}${tagStr}`;
        }

        // Build clean preview
        let rawContent = contentToString(msg.content || "");
        rawContent = rawContent.replace(/\r?\n/g, " ").trim();
        if (rawContent.length === 0) {
          if (msg.toolCalls && msg.toolCalls.length > 0) {
            rawContent = `(tool calls: ${msg.toolCalls.map((tc: any) => tc.name).join(", ")})`;
          } else if (msg.toolResults && msg.toolResults.length > 0) {
            rawContent = `(tool results: ${msg.toolResults.map((tr: any) => tr.name).join(", ")})`;
          } else {
            rawContent = "(empty)";
          }
        }

        const maxPreviewLen = 80;
        const preview = rawContent.length > maxPreviewLen
          ? rawContent.substring(0, maxPreviewLen) + "..."
          : rawContent;

        lines.push(`  [${idxPadded}] ${rolePadded}${pinBadge} ${preview}`);
      }

      lines.push("");
      lines.push("──────────────────────────────────────────────────────────────");
      lines.push(`  Total: ${messages.length} messages  |  Pinned: ${pinnedIds.size}`);
      lines.push("");
      lines.push("  /pin <index>       Pin message (full content + agent tag stored)");
      lines.push("  /pin unpin <index> Unpin message at index");
      lines.push("  /pin last          Pin last user message");
      lines.push("  /pin list          Show all pinned messages with full data");
      lines.push("  /pin view <index>  View full pinned message content");
      lines.push("  /pin tag <idx> <label>  Tag a pinned message with a label");

      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    // ── /pin list ──────────────────────────────────────────────────────
    if (trimmed === "list" || trimmed === "") {
      const pinnedFull = cm.getPinnedMessagesFull();
      if (pinnedFull.size === 0) {
        ctx.addLine({
          type: "system",
          content: [
            "No pinned messages.",
            "",
            "Usage:",
            "  /pin <index>          Pin message (stores full content + agent tag)",
            "  /pin last             Pin the last user message",
            "  /pin unpin <idx>      Unpin message at index",
            "  /pin list             Show pinned messages with metadata",
            "  /pin view <idx>       View full pinned message content",
            "  /pin tag <idx> <lbl>  Tag a pinned message with a label",
            "  /pin list-messages    Show all messages with indexes",
          ].join("\n"),
          timestamp: now,
        });
        return;
      }

      const lines: string[] = [];
      lines.push("╔══════════════════════════════════════════════════════════════╗");
      lines.push("║         PINNED MESSAGES  (🌐 Global Knowledge)               ║");
      lines.push("╚══════════════════════════════════════════════════════════════╝");
      lines.push("");

      const pinnedArray = Array.from(pinnedFull.values());
      for (let i = 0; i < pinnedArray.length; i++) {
        const pin = pinnedArray[i];
        const agentTagStr = formatAgentTag(pin.agentTag);
        const tagStr = pin.tag ? ` #${pin.tag}` : "";
        const timeStr = timeAgo(pin.pinnedAt);

        // Role icon
        let roleIcon: string;
        switch (pin.role) {
          case "user":      roleIcon = "👤 user"; break;
          case "assistant": roleIcon = "✦ agent"; break;
          case "tool":      roleIcon = "⚙ tool"; break;
          case "system":    roleIcon = "ℹ sys"; break;
          default:          roleIcon = `? ${pin.role}`; break;
        }

        // Content preview
        let rawContent = (pin.content || "").replace(/\r?\n/g, " ").trim();
        if (rawContent.length === 0) {
          if (pin.toolCalls && pin.toolCalls.length > 0) {
            rawContent = `(tool calls: ${pin.toolCalls.map(tc => tc.name).join(", ")})`;
          } else if (pin.toolResults && pin.toolResults.length > 0) {
            rawContent = `(tool results: ${pin.toolResults.map(tr => tr.name).join(", ")})`;
          } else {
            rawContent = "(empty)";
          }
        }
        const preview = rawContent.length > 100 ? rawContent.substring(0, 100) + "..." : rawContent;

        // Content size indicator
        const contentLen = (pin.content || "").length;
        const sizeStr = contentLen > 500 ? ` (${contentLen.toLocaleString()} chars stored)` : "";

        lines.push(`  📌 [${i}] ${roleIcon} ${agentTagStr}${tagStr}`);
        lines.push(`     ${preview}${sizeStr}`);
        lines.push(`     pinned ${timeStr} (original index: ${pin.originalIndex})`);
        lines.push("");
      }

      lines.push("──────────────────────────────────────────────────────────────");
      lines.push(`  ${pinnedArray.length} pinned  |  Total stored: ${pinnedArray.reduce((s, p) => s + (p.content?.length || 0), 0).toLocaleString()} chars  |  🌐 synced to global knowledge`);
      lines.push("");
      lines.push("  /pin view <idx>       View full content");
      lines.push("  /pin tag <idx> <lbl>  Add/edit tag label (synced globally)");
      lines.push("  /pin unpin <idx>      Remove pin (removes from global too)");
      lines.push("  /knowledge            Browse global knowledge from all sessions");

      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    // ── /pin view <index> ──────────────────────────────────────────────
    if (trimmed.startsWith("view ")) {
      const idxStr = trimmed.substring(5).trim();
      const idx = parseInt(idxStr, 10);
      if (isNaN(idx)) {
        ctx.addLine({ type: "error", content: "Invalid index. Usage: /pin view <index>", timestamp: now });
        return;
      }

      const pinnedArray = Array.from(cm.getPinnedMessagesFull().values());
      if (idx < 0 || idx >= pinnedArray.length) {
        ctx.addLine({ type: "error", content: `Invalid index. Valid range: 0-${pinnedArray.length - 1}`, timestamp: now });
        return;
      }

      const pin = pinnedArray[idx];
      const agentTagStr = formatAgentTag(pin.agentTag);
      const tagStr = pin.tag ? ` #${pin.tag}` : "";

      const lines: string[] = [];
      lines.push("╔══════════════════════════════════════════════════════════════╗");
      lines.push(`║  📌 PINNED MESSAGE [${idx}] ${pin.role.toUpperCase()} ${agentTagStr}${tagStr}`);
      lines.push("╚══════════════════════════════════════════════════════════════╝");
      lines.push("");

      if (pin.agentTag) {
        lines.push(`  Agent Tier  : ${pin.agentTag.tier}`);
        if (pin.agentTag.subagentType) lines.push(`  Subagent    : ${pin.agentTag.subagentType}`);
        if (pin.agentTag.worktreePath) lines.push(`  Worktree    : ${pin.agentTag.worktreePath}`);
        if (pin.agentTag.workingDirectory) lines.push(`  Working Dir : ${pin.agentTag.workingDirectory}`);
        lines.push("");
      }

      lines.push(`  Pinned      : ${timeAgo(pin.pinnedAt)}`);
      lines.push(`  Original Idx: ${pin.originalIndex}`);
      lines.push(`  Content Size: ${(pin.content || "").length.toLocaleString()} characters`);
      if (pin.tag) lines.push(`  Tag         : #${pin.tag}`);
      lines.push("");
      lines.push("─────────────────────── FULL CONTENT ─────────────────────────");
      lines.push("");
      lines.push(pin.content || "(empty)");
      lines.push("");

      if (pin.toolCalls && pin.toolCalls.length > 0) {
        lines.push("─────────────────────── TOOL CALLS ───────────────────────────");
        for (const tc of pin.toolCalls) {
          lines.push(`  Tool: ${tc.name}`);
          lines.push(`  Args: ${JSON.stringify(tc.args, null, 2)}`);
          lines.push("");
        }
      }

      if (pin.toolResults && pin.toolResults.length > 0) {
        lines.push("─────────────────────── TOOL RESULTS ─────────────────────────");
        for (const tr of pin.toolResults) {
          lines.push(`  Tool: ${tr.name} ${tr.isError ? "(ERROR)" : "(OK)"}`);
          const resultPreview = tr.result.length > 500 ? tr.result.substring(0, 500) + "..." : tr.result;
          lines.push(`  Result: ${resultPreview}`);
          lines.push("");
        }
      }

      lines.push("──────────────────────────────────────────────────────────────");

      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    // ── /pin tag <index> <label> ───────────────────────────────────────
    if (trimmed.startsWith("tag ")) {
      const rest = trimmed.substring(4).trim();
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx === -1) {
        ctx.addLine({ type: "error", content: "Usage: /pin tag <index> <label>", timestamp: now });
        return;
      }

      const idxStr = rest.substring(0, spaceIdx);
      const label = rest.substring(spaceIdx + 1).trim();
      const idx = parseInt(idxStr, 10);
      if (isNaN(idx)) {
        ctx.addLine({ type: "error", content: "Invalid index. Usage: /pin tag <index> <label>", timestamp: now });
        return;
      }

      const pinnedArray = Array.from(cm.getPinnedMessagesFull().keys());
      if (idx < 0 || idx >= pinnedArray.length) {
        ctx.addLine({ type: "error", content: `Invalid index. Valid range: 0-${pinnedArray.length - 1}`, timestamp: now });
        return;
      }

      const msgId = pinnedArray[idx];
      const success = cm.setPinnedMessageTag(msgId, label);
      if (success) {
        // Propagate tag to global knowledge store
        try {
          const pinnedData = cm.getPinnedMessage(msgId);
          if (pinnedData) {
            const sessionPath = agent.getCurrentHistoryFilePath();
            updateKnowledgeTag(sessionPath, pinnedData.content || "", label);
          }
        } catch { /* non-critical */ }

        ctx.addLine({
          type: "system",
          content: `✓ Tagged pinned message [${idx}] with #${label} (synced to global knowledge)`,
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "error",
          content: `Failed to tag message [${idx}]`,
          timestamp: now,
        });
      }
      return;
    }

    // ── /pin last ──────────────────────────────────────────────────────
    if (trimmed === "last") {
      const messages = agent.getHistory().getMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          const msg = messages[i];
          const msgId = `${i}:${msg.role}:${msg.timestamp}`;
          const agentTag = buildAgentTag(agent);

          const stringContent = contentToString(msg.content);
          cm.addPinnedMessage(msgId, {
            id: msgId,
            role: msg.role,
            content: stringContent,
            timestamp: msg.timestamp,
            pinnedAt: now,
            originalIndex: i,
            agentTag,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
          });

          // Auto-export to global knowledge store
          try {
            const sessionPath = agent.getCurrentHistoryFilePath();
            addToKnowledge(
              { id: msgId, role: msg.role, content: stringContent, timestamp: msg.timestamp, pinnedAt: now, originalIndex: i, agentTag, toolCalls: msg.toolCalls, toolResults: msg.toolResults },
              sessionPath,
              agent.workingDirectory
            );
          } catch { /* non-critical */ }

          const preview = buildPreview(stringContent, 80);
          ctx.addLine({
            type: "system",
            content: `✓ Pinned message [${i}] ${formatAgentTag(agentTag)}: ${preview}\n  Full content stored (${stringContent.length.toLocaleString()} chars). Added to global knowledge. Use /pin list to view.`,
            timestamp: now,
          });
          return;
        }
      }
      ctx.addLine({
        type: "error",
        content: "No user messages to pin.",
        timestamp: now,
      });
      return;
    }

    // ── /pin unpin <index> ─────────────────────────────────────────────
    if (trimmed.startsWith("unpin ")) {
      const idxStr = trimmed.substring(6).trim();
      const idx = parseInt(idxStr, 10);
      if (isNaN(idx)) {
        ctx.addLine({
          type: "error",
          content: "Invalid index. Usage: /pin unpin <index>",
          timestamp: now,
        });
        return;
      }

      const pinnedArray = Array.from(cm.getPinnedMessages());
      if (idx < 0 || idx >= pinnedArray.length) {
        ctx.addLine({
          type: "error",
          content: `Invalid index. Valid range: 0-${pinnedArray.length - 1}`,
          timestamp: now,
        });
        return;
      }

      const msgId = pinnedArray[idx];

      // Get pinned data before removal for global knowledge cleanup
      const pinnedData = cm.getPinnedMessage(msgId);
      cm.removePinnedMessage(msgId);

      // Also remove from global knowledge store
      if (pinnedData) {
        try {
          const sessionPath = agent.getCurrentHistoryFilePath();
          removeKnowledgeByPin(sessionPath, pinnedData.content || "");
        } catch { /* non-critical */ }
      }

      ctx.addLine({
        type: "system",
        content: `✓ Unpinned message [${idx}] (removed from global knowledge)`,
        timestamp: now,
      });
      return;
    }

    // ── /pin <index> ───────────────────────────────────────────────────
    const idx = parseInt(trimmed, 10);
    if (isNaN(idx)) {
      ctx.addLine({
        type: "error",
        content: [
          "Invalid argument. Usage:",
          "  /pin <index>            Pin message (stores full content + agent tag)",
          "  /pin last               Pin the last user message",
          "  /pin unpin <idx>        Unpin message at index",
          "  /pin list               Show pinned messages with metadata",
          "  /pin view <idx>         View full pinned message content",
          "  /pin tag <idx> <label>  Tag a pinned message with a label",
          "  /pin list-messages      Show all messages with indexes",
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    const messages = agent.getHistory().getMessages();
    if (idx < 0 || idx >= messages.length) {
      ctx.addLine({
        type: "error",
        content: `Invalid index. Valid range: 0-${messages.length - 1}`,
        timestamp: now,
      });
      return;
    }

    const msg = messages[idx];
    const msgId = `${idx}:${msg.role}:${msg.timestamp}`;
    const agentTag = buildAgentTag(agent);

    const stringContent = contentToString(msg.content);
    cm.addPinnedMessage(msgId, {
      id: msgId,
      role: msg.role,
      content: stringContent,
      timestamp: msg.timestamp,
      pinnedAt: now,
      originalIndex: idx,
      agentTag,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
    });

    // Auto-export to global knowledge store
    try {
      const sessionPath = agent.getCurrentHistoryFilePath();
      addToKnowledge(
        { id: msgId, role: msg.role, content: stringContent, timestamp: msg.timestamp, pinnedAt: now, originalIndex: idx, agentTag, toolCalls: msg.toolCalls, toolResults: msg.toolResults },
        sessionPath,
        agent.workingDirectory
      );
    } catch { /* non-critical */ }

    const preview = buildPreview(stringContent, 80);
    ctx.addLine({
      type: "system",
      content: `✓ Pinned message [${idx}] (${msg.role}) ${formatAgentTag(agentTag)}: ${preview}\n  Full content stored (${stringContent.length.toLocaleString()} chars). Added to global knowledge. Use /pin list to view.`,
      timestamp: now,
    });
  },
};

registry.register(pinCommand);
