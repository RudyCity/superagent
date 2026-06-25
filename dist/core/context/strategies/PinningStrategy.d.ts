import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";
export declare class PinningStrategy implements CompactionStrategy {
    name: string;
    canHandle(context: CompactionContext): boolean;
    execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
    estimateCost(messages: Message[]): CompactionCost;
    /**
     * Build an informative summary of pruned messages by extracting
     * file paths, tool names, and error keywords — so the agent still
     * has context about what was removed.
     */
    private buildPruneSummary;
}
//# sourceMappingURL=PinningStrategy.d.ts.map