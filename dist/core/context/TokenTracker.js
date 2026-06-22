export class TokenTracker {
    model;
    cache = new Map();
    encoder = null;
    constructor(model) {
        this.model = model;
        this.initEncoder();
    }
    async initEncoder() {
        try {
            const { get_encoding } = await import("tiktoken");
            this.encoder = get_encoding("cl100k_base");
        }
        catch {
            this.encoder = null;
        }
    }
    setModel(model) {
        this.model = model;
        this.cache.clear();
    }
    getModel() {
        return this.model;
    }
    estimateTokens(message) {
        const hash = this.hashMessage(message);
        if (this.cache.has(hash)) {
            return this.cache.get(hash);
        }
        let tokens = this.countText(message.content);
        if (message.toolCalls) {
            for (const call of message.toolCalls) {
                tokens += this.countText(JSON.stringify(call.args));
            }
        }
        if (message.toolResults) {
            for (const result of message.toolResults) {
                tokens += this.countText(result.result);
            }
        }
        this.cache.set(hash, tokens);
        return tokens;
    }
    estimateTokensForAll(messages) {
        let systemPrompt = 0;
        let messagesTokens = 0;
        let toolCalls = 0;
        let toolResults = 0;
        for (const msg of messages) {
            if (msg.role === "system") {
                systemPrompt += this.countText(msg.content);
            }
            else {
                messagesTokens += this.countText(msg.content);
            }
            if (msg.toolCalls) {
                for (const call of msg.toolCalls) {
                    toolCalls += this.countText(JSON.stringify(call.args));
                }
            }
            if (msg.toolResults) {
                for (const result of msg.toolResults) {
                    toolResults += this.countText(result.result);
                }
            }
        }
        return {
            systemPrompt,
            messages: messagesTokens,
            toolCalls,
            toolResults,
            total: systemPrompt + messagesTokens + toolCalls + toolResults,
        };
    }
    getBreakdown(messages, systemPrompt) {
        const breakdown = this.estimateTokensForAll(messages);
        if (systemPrompt) {
            const sysTokens = this.countText(systemPrompt);
            breakdown.systemPrompt += sysTokens;
            breakdown.total += sysTokens;
        }
        return breakdown;
    }
    countText(text) {
        if (!text)
            return 0;
        if (this.encoder) {
            try {
                return this.encoder.encode(text).length;
            }
            catch {
                // Fall through to heuristic
            }
        }
        // Fallback: improved heuristic
        const hasCode = /[{}\[\]()=<>]/.test(text);
        const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(text);
        let ratio = 4;
        if (hasCode)
            ratio = 3;
        if (hasCJK)
            ratio = 2;
        return Math.ceil(text.length / ratio);
    }
    hashMessage(message) {
        return `${message.role}:${message.content.length}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}`;
    }
}
//# sourceMappingURL=TokenTracker.js.map