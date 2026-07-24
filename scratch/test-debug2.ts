import { SummarizationStrategy } from "../src/core/context/strategies/SummarizationStrategy.js";
import { Message } from "../src/core/conversation.js";
import { TokenTracker } from "../src/core/context/TokenTracker.js";

const strategy = new SummarizationStrategy();
const messages: Message[] = [
  { role: "user", content: "User 1", timestamp: 1 },
  { role: "assistant", content: "a".repeat(800), timestamp: 2 },
  {
    role: "tool",
    content: "",
    toolResults: [{ toolCallId: "c1", name: "t1", result: "t1 result" }],
    timestamp: 3,
  },
  { role: "user", content: "User 2", timestamp: 4 }
];

const tracker = new TokenTracker("");
await tracker.ensureEncoder();
console.log("Token estimate for User 1:", tracker.estimateTokens(messages[0]));
console.log("Token estimate for assistant:", tracker.estimateTokens(messages[1]));
console.log("Token estimate for tool:", tracker.estimateTokens(messages[2]));
console.log("Token estimate for User 2:", tracker.estimateTokens(messages[3]));

const result = await strategy.execute(messages, {
  preserveRecent: 3,
  tokenBudget: 900,
});

console.log("Result messages:");
console.dir(result.messages, { depth: null });
