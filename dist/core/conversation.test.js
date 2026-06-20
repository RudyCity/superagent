import { describe, it, expect, afterEach } from "vitest";
import { Conversation } from "./conversation.js";
import fs from "fs/promises";
import path from "path";
describe("Conversation", () => {
    const tempConvPath = path.resolve(process.cwd(), "temp_conversation.json");
    afterEach(async () => {
        try {
            await fs.unlink(tempConvPath);
        }
        catch { }
    });
    it("should add user and assistant messages and retrieve them", () => {
        const conv = new Conversation();
        conv.addUserMessage("Hello there");
        conv.addAssistantMessage("Hi! How can I help you?");
        const msgs = conv.getMessages();
        expect(msgs).toHaveLength(2);
        expect(msgs[0].role).toBe("user");
        expect(msgs[0].content).toBe("Hello there");
        expect(msgs[1].role).toBe("assistant");
        expect(msgs[1].content).toBe("Hi! How can I help you?");
    });
    it("should filter system messages in getApiMessages", () => {
        const conv = new Conversation();
        conv.addMessage({
            role: "system",
            content: "You are an assistant",
            timestamp: Date.now(),
        });
        conv.addUserMessage("Who are you?");
        const apiMsgs = conv.getApiMessages();
        expect(apiMsgs).toHaveLength(1);
        expect(apiMsgs[0].role).toBe("user");
        expect(apiMsgs[0].content).toBe("Who are you?");
    });
    it("should estimate tokens based on length", () => {
        const conv = new Conversation();
        conv.addUserMessage("12345678"); // 8 chars -> ~2 tokens
        expect(conv.getTokenEstimate()).toBe(2);
    });
    it("should enforce max history limit", () => {
        const conv = new Conversation();
        // maxHistory is 200, let's write 205 messages
        for (let i = 0; i < 205; i++) {
            conv.addUserMessage(`message ${i}`);
        }
        const msgs = conv.getMessages();
        expect(msgs).toHaveLength(200);
        expect(msgs[0].content).toBe("message 5");
        expect(msgs[199].content).toBe("message 204");
    });
    it("should prune messages to fit token limit", () => {
        const conv = new Conversation();
        conv.addUserMessage("A very long message"); // 19 chars -> 5 tokens
        conv.addAssistantMessage("Short"); // 5 chars -> 2 tokens
        conv.addUserMessage("Another message"); // 15 chars -> 4 tokens
        conv.addAssistantMessage("Extra message here"); // 18 chars -> 5 tokens
        // Prune to limit of ~10 tokens
        conv.pruneToTokenLimit(10);
        const msgs = conv.getMessages();
        expect(conv.getTokenEstimate()).toBeLessThanOrEqual(10);
        expect(msgs[msgs.length - 1].content).toBe("Extra message here");
    });
    it("should save and load conversation history to/from file", async () => {
        const conv = new Conversation();
        conv.addUserMessage("Test file save");
        await conv.saveToFile(tempConvPath);
        const loadedConv = new Conversation();
        await loadedConv.loadFromFile(tempConvPath);
        const msgs = loadedConv.getMessages();
        expect(msgs).toHaveLength(1);
        expect(msgs[0].content).toBe("Test file save");
    });
});
//# sourceMappingURL=conversation.test.js.map