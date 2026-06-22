import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";
export interface SummarizationConfig {
    model?: any;
    abortSignal?: AbortSignal;
}
export declare class SummarizationStrategy implements CompactionStrategy {
    name: string;
    private config?;
    constructor(config?: SummarizationConfig);
    setConfig(config: SummarizationConfig): void;
    canHandle(context: CompactionContext): boolean;
    execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
    estimateCost(messages: Message[]): CompactionCost;
    private generateLLMSummary;
    private createHeuristicSummary;
}
//# sourceMappingURL=SummarizationStrategy.d.ts.map