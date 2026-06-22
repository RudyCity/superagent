import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";
export declare class PruningStrategy implements CompactionStrategy {
    name: string;
    canHandle(_context: CompactionContext): boolean;
    execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
    estimateCost(_messages: Message[]): CompactionCost;
    private createEmergencySummary;
}
//# sourceMappingURL=PruningStrategy.d.ts.map