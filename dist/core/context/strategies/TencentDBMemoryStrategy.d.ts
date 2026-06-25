import { CompactionStrategy, CompactionContext, CompactionResult, CompactionOptions, CompactionCost } from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";
export declare class TencentDBMemoryStrategy implements CompactionStrategy {
    name: string;
    private historyFilePath?;
    private lastCapturedTimestamp;
    private lastConnectAttempt;
    private gatewayOffline;
    constructor(config?: {
        historyFilePath?: string;
    });
    canHandle(context: CompactionContext): boolean;
    execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
    estimateCost(messages: Message[]): CompactionCost;
}
//# sourceMappingURL=TencentDBMemoryStrategy.d.ts.map