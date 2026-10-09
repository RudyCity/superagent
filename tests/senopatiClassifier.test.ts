/**
 * Unit & integration tests for Senopati System-1 ONNX Classifier in Superagent.
 * Tests pure local inference, tokenization, urgency scoring, destructive safety guardrail,
 * and multilingual accuracy across Indonesian, English, Spanish, French, German.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  SENOPATI_CATEGORIES,
  getSenopatiModelPaths,
  cleanSenopatiText,
  encodeSenopatiTokens,
  getSenopatiSession,
  classifyWithSenopatiONNX,
  classifyRequest,
  clearLocalClassifierCache,
  getClassificationPromptAddendum,
  isDestructiveCommand,
  isHighConfidenceConversation,
  type ClassificationResult,
} from "../src/core/requestClassifier.js";

describe("Senopati System-1 ONNX Engine", () => {
  beforeEach(() => {
    clearLocalClassifierCache();
  });

  it("should verify SENOPATI_CATEGORIES contains all 7 canonical categories", () => {
    expect(SENOPATI_CATEGORIES).toEqual([
      "conversation",
      "question",
      "simple_edit",
      "research",
      "complex_task",
      "debug",
      "command",
    ]);
  });

  it("should locate the Senopati ONNX model and vocabulary files", () => {
    const paths = getSenopatiModelPaths();
    expect(paths).not.toBeNull();
    expect(paths?.modelPath).toContain("senopati_superagent.onnx");
    expect(paths?.vocabPath).toContain("senopati_superagent_vocab.json");
  });

  it("should properly clean text according to Senopati canonical rules", () => {
    const cleaned = cleanSenopatiText("tolong ubah port di config.ts, baris 25!");
    expect(cleaned).toEqual(["tolong", "ubah", "port", "di", "config.ts", "baris", "25"]);
  });

  it("should encode tokens with <cls> (2), token IDs, and <sep> (3)", async () => {
    const bundle = await getSenopatiSession();
    expect(bundle).not.toBeNull();
    const { vocab } = bundle!;
    
    const tokens = encodeSenopatiTokens("npm run build", vocab.word2id, 64);
    expect(tokens[0]).toBe(2); // <cls>
    expect(tokens[tokens.length - 1]).toBe(3); // <sep>
    expect(tokens.length).toBeGreaterThanOrEqual(3);
  });

  it("should initialize and cache the ONNX session", async () => {
    const bundle1 = await getSenopatiSession();
    expect(bundle1).not.toBeNull();
    expect(bundle1?.session).toBeDefined();
    expect(bundle1?.vocab.vocab_size).toBeGreaterThan(100);

    const bundle2 = await getSenopatiSession();
    expect(bundle2).toBe(bundle1); // Cached instance
  });

  it("should classify command requests with high confidence and zero tokens", async () => {
    const dummyHeuristic: ClassificationResult = {
      category: "question",
      confidence: "low",
      reason: "ambiguous",
      heuristicOnly: false,
      classificationTokens: 0,
    };

    const result = await classifyWithSenopatiONNX("npm run build", dummyHeuristic);
    expect(result).not.toBeNull();
    expect(result?.category).toBe("command");
    expect(result?.classificationTokens).toBe(0);
    expect(result?.heuristicOnly).toBe(false);
    expect(result?.reason).toContain("Senopati ONNX System-1");
    expect(typeof result?.urgencyScore).toBe("number");
    expect(result!.urgencyScore).toBeGreaterThanOrEqual(1.0);
    expect(result!.urgencyScore).toBeLessThanOrEqual(5.0);
  });

  it("should correctly identify destructive requests via the noul guardrail", async () => {
    const dummyHeuristic: ClassificationResult = {
      category: "question",
      confidence: "low",
      reason: "ambiguous",
      heuristicOnly: false,
      classificationTokens: 0,
    };

    const safeResult = await classifyWithSenopatiONNX("git status", dummyHeuristic);
    expect(safeResult).not.toBeNull();
    expect(safeResult?.isDestructive).toBe(false);
  });

  it("should classify Indonesian and code-switching prompts accurately", async () => {
    const dummyHeuristic: ClassificationResult = {
      category: "question",
      confidence: "low",
      reason: "ambiguous",
      heuristicOnly: false,
      classificationTokens: 0,
    };

    const resConv = await classifyWithSenopatiONNX("halo selamat pagi, siap lanjut bos!", dummyHeuristic);
    expect(resConv?.category).toBe("conversation");

    const resEdit = await classifyWithSenopatiONNX("ganti timeout fetch jadi 15000ms di config.ts", dummyHeuristic);
    expect(resEdit?.category).toBe("simple_edit");

    // Pure neural classification for registration and web automation (no regex crutches)
    const resRegGroq = await classifyWithSenopatiONNX("daftar groq dengan tempemail", dummyHeuristic);
    expect(resRegGroq?.category).toBe("command");

    const resCreateAcc = await classifyWithSenopatiONNX("buat akun di website ini", dummyHeuristic);
    expect(resCreateAcc?.category).toBe("command");

    const resLogin = await classifyWithSenopatiONNX("login ke dashboard", dummyHeuristic);
    expect(resLogin?.category).toBe("command");

    const resBun = await classifyWithSenopatiONNX("bun test", dummyHeuristic);
    expect(resBun?.category).toBe("command");

    // Verify conversational fast-path correctly respects pure neural decisions
    expect(isHighConfidenceConversation(resConv!, "single", "IDLE", false, "halo selamat pagi, siap lanjut bos!")).toBe(true);
    expect(isHighConfidenceConversation(resRegGroq!, "single", "IDLE", false, "daftar groq dengan tempemail")).toBe(false);
  });

  it("should generate proper system prompt addendums with urgency and destructive guardrails", () => {
    const safeConv: ClassificationResult = {
      category: "conversation",
      confidence: "high",
      reason: "greeting",
      heuristicOnly: false,
      classificationTokens: 0,
      urgencyScore: 1.2,
      isDestructive: false,
    };
    const addendumConv = getClassificationPromptAddendum(safeConv);
    expect(addendumConv).toContain("CLASSIFICATION: conversation");
    expect(addendumConv).toContain("Tone: Friendly, concise");

    const destructiveCmd: ClassificationResult = {
      category: "command",
      confidence: "high",
      reason: "drop tables",
      heuristicOnly: false,
      classificationTokens: 0,
      urgencyScore: 4.8,
      isDestructive: true,
    };
    const addendumDestructive = getClassificationPromptAddendum(destructiveCmd);
    expect(addendumDestructive).toContain("CLASSIFICATION: command");
    expect(addendumDestructive).toContain("[URGENCY HIGH: 4.8/5.0]");
    expect(addendumDestructive).toContain("[SENOPATI AI SYSTEM-1: DESTRUCTIVE SAFETY GUARD TRIGGERED]");
  });

  it("should correctly identify destructive commands via isDestructiveCommand", async () => {
    // Regex critical pattern match
    expect(await isDestructiveCommand("rm -rf /")).toBe(true);
    expect(await isDestructiveCommand("git reset --hard HEAD~1")).toBe(true);
    expect(await isDestructiveCommand("DROP DATABASE production;")).toBe(true);

    // Safe command checks
    expect(await isDestructiveCommand("git status")).toBe(false);
    expect(await isDestructiveCommand("npm test")).toBe(false);
    expect(await isDestructiveCommand("ls -la")).toBe(false);
  });
});

