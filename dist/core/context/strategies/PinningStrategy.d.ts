import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";
export declare class PinningStrategy implements CompactionStrategy {
    name: string;
    canHandle(context: CompactionContext): boolean;
    execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
    estimateCost(messages: Message[]): CompactionCost;
    private getMessageId;
    private reconstructOrder;
}
//# sourceMappingURL=PinningStrategy.d.ts.map