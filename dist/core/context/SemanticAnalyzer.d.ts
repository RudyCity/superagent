import { Message } from "../conversation.js";
export interface SemanticChunk {
    messages: Message[];
    startIndex: number;
    endIndex: number;
    topic?: string;
}
export interface KeyPoint {
    messageIndex: number;
    type: "decision" | "requirement" | "error" | "conclusion";
    content: string;
}
export declare class SemanticAnalyzer {
    detectTopicBoundaries(messages: Message[]): number[];
    splitIntoChunks(messages: Message[]): SemanticChunk[];
    scoreImportance(message: Message): number;
    extractKeyPoints(messages: Message[]): KeyPoint[];
    private extractFilePaths;
    private containsDecision;
    private containsArchitectureChoice;
    private containsUserRequirement;
    private containsErrorMessage;
    private containsFilePath;
    private isRoutineToolCall;
    private isVerboseOutput;
}
//# sourceMappingURL=SemanticAnalyzer.d.ts.map