import { describe, it, expect } from "vitest";
import { SemanticAnalyzer } from "../src/core/context/SemanticAnalyzer.js";
import { Message } from "../src/core/conversation.js";

describe("SemanticAnalyzer", () => {
  it("should detect topic boundaries", () => {
    const analyzer = new SemanticAnalyzer();
    const messages: Message[] = [
      { role: "user", content: "Read file1.ts", timestamp: 1000 },
      { role: "assistant", content: "Reading file1.ts", timestamp: 1001 },
      { role: "user", content: "Now read file2.ts", timestamp: 1002 },
      { role: "assistant", content: "Reading file2.ts", timestamp: 1003 },
    ];

    const boundaries = analyzer.detectTopicBoundaries(messages);
    expect(boundaries).toContain(0);
    expect(boundaries).toContain(2);
  });

  it("should score message importance - decision higher than routine", () => {
    const analyzer = new SemanticAnalyzer();

    const decision: Message = {
      role: "assistant",
      content: "We decided to use PostgreSQL for the database",
      timestamp: 1000,
    };

    const routine: Message = {
      role: "assistant",
      content: "Reading file...",
      timestamp: 1000,
    };

    const decisionScore = analyzer.scoreImportance(decision);
    const routineScore = analyzer.scoreImportance(routine);

    expect(decisionScore).toBeGreaterThan(routineScore);
  });

  it("should split messages into semantic chunks", () => {
    const analyzer = new SemanticAnalyzer();
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: 1000 + i * 1000,
      });
    }

    const chunks = analyzer.splitIntoChunks(messages);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].startIndex).toBe(0);
  });

  it("should detect time-gap boundaries", () => {
    const analyzer = new SemanticAnalyzer();
    const messages: Message[] = [
      { role: "user", content: "First question", timestamp: 1000 },
      { role: "assistant", content: "Answer", timestamp: 1001 },
      { role: "assistant", content: "Later answer", timestamp: 1000 + 6 * 60 * 1000 },
    ];

    const boundaries = analyzer.detectTopicBoundaries(messages);
    expect(boundaries).toContain(0);
    expect(boundaries.length).toBeGreaterThanOrEqual(2);
  });

  it("should extract key points from high-importance messages", () => {
    const analyzer = new SemanticAnalyzer();
    const messages: Message[] = [
      {
        role: "assistant",
        content: "We decided to use React for the frontend architecture",
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: "Reading file...",
        timestamp: 1001,
      },
      {
        role: "user",
        content: "I need to implement authentication",
        timestamp: 1002,
      },
    ];

    const keyPoints = analyzer.extractKeyPoints(messages);
    expect(keyPoints.length).toBeGreaterThanOrEqual(1);
    expect(keyPoints.some((kp) => kp.type === "decision")).toBe(true);
  });

  it("should detect file path boundaries", () => {
    const analyzer = new SemanticAnalyzer();
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Working on src/auth/login.ts",
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: "Now editing src/api/users.ts",
        timestamp: 1001,
      },
    ];

    const boundaries = analyzer.detectTopicBoundaries(messages);
    expect(boundaries).toContain(0);
    expect(boundaries).toContain(1);
  });

  it("should boost score for error messages", () => {
    const analyzer = new SemanticAnalyzer();
    const errorMsg: Message = {
      role: "assistant",
      content: "Error: Failed to compile. Exception in module xyz.",
      timestamp: 1000,
    };

    const normalMsg: Message = {
      role: "assistant",
      content: "The build succeeded.",
      timestamp: 1000,
    };

    expect(analyzer.scoreImportance(errorMsg)).toBeGreaterThan(
      analyzer.scoreImportance(normalMsg)
    );
  });
});
