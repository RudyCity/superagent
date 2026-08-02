import { describe, it, expect } from "vitest";
import { 
  analyzePromptIntent, 
  translatePromptToEnglish, 
  detectLanguage, 
  registerIntentShortcut, 
  setLastPromptOptions,
  translationBadgeEmitter,
  withProcessingLock 
} from "../src/core/promptClarification.js";

describe("Prompt Clarification, Multi-Language, High Performance & Badge Emitter", () => {
  it("detects languages accurately (ID, JA, ZH, ES, FR, DE, EN)", () => {
    expect(detectLanguage("perbaiki file ini")).toBe("id");
    expect(detectLanguage("ファイルを修正して")).toBe("ja");
    expect(detectLanguage("修复这个文件")).toBe("zh");
    expect(detectLanguage("corregir el archivo")).toBe("es");
    expect(detectLanguage("corriger le fichier")).toBe("fr");
    expect(detectLanguage("datei beheben")).toBe("de");
    expect(detectLanguage("fix this file")).toBe("en");
  });

  it("translates multi-language technical prompts to English", () => {
    const resId = translatePromptToEnglish("ptrompt automatis di yranslate ke englosih apa bisa?");
    expect(resId.translated).toContain("prompt automatically translated to English");

    const resJa = translatePromptToEnglish("ファイルを修正してできますか?");
    expect(resJa.translated).toContain("file fix");

    const resZh = translatePromptToEnglish("修复这个文件可以吗?");
    expect(resZh.translated).toContain("fix");
  });

  it("emits translationBadge event for t-line desktop client UI", async () => {
    let emittedBadge: any = null;
    translationBadgeEmitter.once("badge", (b: any) => {
      emittedBadge = b;
    });

    analyzePromptIntent("ptrompt automatis di yranslate ke englosih apa bisa?");
    expect(emittedBadge).not.toBeNull();
    expect(emittedBadge.detectedLanguage).toBe("id");
    expect(emittedBadge.translatedPrompt).toContain("prompt automatically translated to English");
  });

  it("matches word-boundary intent shortcuts ('perbaiki header dong')", () => {
    registerIntentShortcut("perbaiki header", "src/ui/components/Header.tsx");
    const result = analyzePromptIntent("tolong perbaiki header dong sekarang");
    expect(result.shortcutApplied).toBe(true);
    expect(result.translatedEnglishPrompt).toContain("src/ui/components/Header.tsx");
  });

  it("resolves numeric multi-turn selections ('pilih 2', 'nomor 1')", () => {
    setLastPromptOptions(["Option A: src/ui/Header.tsx", "Option B: src/core/prompts.ts"]);
    
    const resNumeric = translatePromptToEnglish("pilih 2");
    expect(resNumeric.translated).toContain("Option B: src/core/prompts.ts");

    const resWord = translatePromptToEnglish("yang pertama");
    expect(resWord.translated).toContain("Option A: src/ui/Header.tsx");
  });

  it("prevents execution race conditions using processing lock", async () => {
    let executedCount = 0;

    const task1 = withProcessingLock(async () => {
      executedCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "task1";
    });

    const task2Promise = withProcessingLock(async () => {
      executedCount++;
      return "task2";
    });

    await expect(task2Promise).rejects.toThrow("Request locked");
    const res1 = await task1;
    expect(res1).toBe("task1");
    expect(executedCount).toBe(1);
  });
});
