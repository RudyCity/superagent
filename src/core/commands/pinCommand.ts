import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";

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

    // /pin list-messages - show all messages with correct indexes
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

      const pinned = cm.getPinnedMessages();
      const lines = ["Conversation Messages (use these indexes for /pin):"];
      lines.push("─".repeat(70));

      const displayCount = Math.min(messages.length, 50); // Show last 50 messages
      const startIndex = Math.max(0, messages.length - displayCount);

      for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i];
        const msgId = `${i}:${msg.role}:${msg.timestamp}`;
        const isPinned = pinned.has(msgId);
        const pinIndicator = isPinned ? " 📌" : "";
        const preview = msg.content.length > 60 ? msg.content.substring(0, 60) + "..." : msg.content;
        lines.push(`[${i}] ${msg.role}${pinIndicator}: ${preview}`);
      }

      if (messages.length > displayCount) {
        lines.push(`... (${messages.length - displayCount} older messages not shown)`);
      }

      lines.push("─".repeat(70));
      lines.push(`Total: ${messages.length} messages, ${pinned.size} pinned`);
      lines.push("\nUsage: /pin <index> to pin, /pin unpin <index> to unpin");

      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    // /pin list - show all pinned messages
    if (trimmed === "list" || trimmed === "") {
      const pinned = cm.getPinnedMessages();
      if (pinned.size === 0) {
        ctx.addLine({
          type: "system",
          content: "No pinned messages.\n\nUsage:\n  /pin <index>     - Pin message at index (0 = oldest)\n  /pin last        - Pin the last user message\n  /pin unpin <idx> - Unpin message at index\n  /pin list        - Show pinned messages",
          timestamp: now,
        });
        return;
      }

      const messages = agent.getHistory().getMessages();
      const lines = ["Pinned Messages:"];
      lines.push("─".repeat(60));

      const pinnedArray = Array.from(pinned);
      for (let i = 0; i < pinnedArray.length; i++) {
        const msgId = pinnedArray[i];
        const msg = messages.find((m, idx) => `${idx}:${m.role}:${m.timestamp}` === msgId);
        if (msg) {
          const preview = msg.content.length > 80 ? msg.content.substring(0, 80) + "..." : msg.content;
          lines.push(`[${i}] ${msg.role}: ${preview}`);
        }
      }

      lines.push("─".repeat(60));
      ctx.addLine({
        type: "system",
        content: lines.join("\n"),
        timestamp: now,
      });
      return;
    }

    // /pin last - pin the last user message
    if (trimmed === "last") {
      const messages = agent.getHistory().getMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
          const msgId = `${i}:${messages[i].role}:${messages[i].timestamp}`;
          cm.addPinnedMessage(msgId);
          const preview = messages[i].content.length > 80 ? messages[i].content.substring(0, 80) + "..." : messages[i].content;
          ctx.addLine({
            type: "system",
            content: `✓ Pinned message [${i}]: ${preview}`,
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

    // /pin unpin <index>
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
      cm.removePinnedMessage(msgId);
      ctx.addLine({
        type: "system",
        content: `✓ Unpinned message [${idx}]`,
        timestamp: now,
      });
      return;
    }

    // /pin <index> - pin message at index
    const idx = parseInt(trimmed, 10);
    if (isNaN(idx)) {
      ctx.addLine({
        type: "error",
        content: "Invalid argument. Usage:\n  /pin <index>     - Pin message at index (0 = oldest)\n  /pin last        - Pin the last user message\n  /pin unpin <idx> - Unpin message at index\n  /pin list        - Show pinned messages",
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
    cm.addPinnedMessage(msgId);
    const preview = msg.content.length > 80 ? msg.content.substring(0, 80) + "..." : msg.content;
    ctx.addLine({
      type: "system",
      content: `✓ Pinned message [${idx}] (${msg.role}): ${preview}`,
      timestamp: now,
    });
  },
};

registry.register(pinCommand);
