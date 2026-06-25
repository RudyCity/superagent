export type Provider = "anthropic" | "openai" | "custom";
export interface Config {
    apiKey: string;
    provider: Provider;
    model: string;
    baseUrl?: string;
    maxTokens: number;
    systemPrompt: string;
    workingDirectory: string;
    disableStreaming?: boolean;
}
export declare function getConfig(): Config;
export declare function getSystemPrompt(): string;
//# sourceMappingURL=base.d.ts.map