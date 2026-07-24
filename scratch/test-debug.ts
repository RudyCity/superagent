import { ContextManager } from "../src/core/context/ContextManager.js";
import { Message } from "../src/core/conversation.js";
import { TokenTracker } from "../src/core/context/TokenTracker.js";
import { getSettings } from "../src/core/config.js";

const manager = new ContextManager({
  model: "claude-3-5-sonnet-20241022",
  contextWindowLimit: 100000,
});

const messages: Message[] = [];
for (let i = 0; i < 75; i++) {
  messages.push({
    role: "user",
    content: "A".repeat(4000),
    timestamp: Date.now() + i,
  });
}

const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
await tracker.ensureEncoder();
console.log("Settings:", getSettings());
console.log("Tracker resolve vision saving:", TokenTracker.resolveVisionSaving("claude-3-5-sonnet-20241022"));
console.log("Single message estimate:", tracker.estimateTokens(messages[0]));
console.log("Total tokens:", tracker.estimateTokensForAll(messages).total);
console.log("Threshold:", manager["calculateThreshold"]());
const decision = manager.shouldCompact(messages);
console.log("Decision:", decision);
