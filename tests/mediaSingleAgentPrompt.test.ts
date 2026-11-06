import { describe, expect, it, vi } from "vitest";

vi.mock("../src/core/tools/helpers.js", () => ({
  resolveWindowsShell: () => ({ isBash: false, shellPath: "powershell.exe" }),
}));

import { getSystemPrompt } from "../src/core/config/base.js";
import {
  BROWSER_TASK_GUIDANCE,
  MEDIA_CORE_RULE,
  MEDIA_TASK_GUIDANCE,
  PDF_TASK_GUIDANCE,
  taskPromptModules,
} from "../src/core/agent/TaskPromptModules.js";

describe("single-agent media prompt routing", () => {
  it("includes concise routing in the actual getSystemPrompt() path without unconditional task bloat", () => {
    const prompt = getSystemPrompt();
    expect(prompt).toContain(MEDIA_CORE_RULE);
    for (const name of ["media_inspect", "media_capabilities", "media_plan", "media_transform", "media_convert", "media_batch"]) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain("create-only");
    expect(prompt).not.toContain(MEDIA_TASK_GUIDANCE);
    expect(prompt).not.toContain("# LOCAL MEDIA WORKFLOW");
    expect(MEDIA_CORE_RULE.length).toBeLessThan(550);
  });

  it.each([
    "Tolong kompres gambar ini menjadi WebP berkualitas 70",
    "Compress this image to JPEG with quality 75",
    "remove background from product photo",
    "hapus latar belakang foto produk lalu PNG transparan",
    "remove background",
    "upscale AI for a low-resolution image",
    "AI upscale",
    "Resize screenshot.png to 500x400",
    "Crop the photo and rotate it 90 degrees",
    "Tambahkan watermark pada gambar ini",
    "Convert the PNG image to PDF",
    "Konversi PDF ke Word yang editable",
    "Convert Word DOCX to PDF",
    "Ubah Excel XLSX ke CSV",
    "PowerPoint to PDF",
    "CSV ke XLSX",
    "jpg ke png",
  ])("injects contextual media guidance for a real media intent: %s", (text) => {
    const result = taskPromptModules(text);
    expect(result).toContain(MEDIA_TASK_GUIDANCE);
    expect(result).toContain("media_inspect");
    expect(result).toContain("media_capabilities");
    expect(result).toContain("media_plan");
    expect(result).toContain("media_transform");
    expect(result).toContain("media_convert");
    expect(result).toContain("media_batch");
    expect(result).toContain("Real-ESRGAN");
    expect(result).toContain("rembg");
    expect(result).toContain("create");
    expect(result.match(/# LOCAL MEDIA WORKFLOW/g)).toHaveLength(1);
  });

  it("preserves existing PDF and browser guidance alongside media when both are relevant", () => {
    const combined = taskPromptModules("Convert PDF to Word using a browser upload at https://example.org");
    expect(combined).toContain(PDF_TASK_GUIDANCE);
    expect(combined).toContain(BROWSER_TASK_GUIDANCE);
    expect(combined).toContain(MEDIA_TASK_GUIDANCE);
    const plainPdf = taskPromptModules("Please inspect the text in my PDF");
    expect(plainPdf).toContain(PDF_TASK_GUIDANCE);
    expect(plainPdf).not.toContain(MEDIA_TASK_GUIDANCE);
  });

  it.each([
    "Optimize code compression in our Rust library",
    "Implement gzip compression for API responses",
    "Please resize the Chrome browser window",
    "Explain crop yield analytics",
    "Investigate compression ratios in a database",
    "Explain Word embeddings in machine learning",
    "Review and redact the PDF",
    "Hi, how are you?",
  ])("avoids injecting media tools for unrelated intents: %s", (text) => {
    expect(taskPromptModules(text)).not.toContain(MEDIA_TASK_GUIDANCE);
  });

  it("uses prior user context only for a continuation turn, or the explicit goal", () => {
    expect(taskPromptModules("lanjut", { continuationContext: "Tolong kompres gambar photo.jpg" }))
      .toContain(MEDIA_TASK_GUIDANCE);
    expect(taskPromptModules("continue", { continuationContext: "Convert PDF to DOCX" }))
      .toContain(MEDIA_TASK_GUIDANCE);
    expect(taskPromptModules("What's next?", { continuationContext: "Convert PDF to DOCX" }))
      .not.toContain(MEDIA_TASK_GUIDANCE);
    expect(taskPromptModules("continue", { continuationContext: "debug gzip code" }))
      .not.toContain(MEDIA_TASK_GUIDANCE);
    expect(taskPromptModules("lanjut", { goal: "Hapus latar belakang foto" }))
      .toContain(MEDIA_TASK_GUIDANCE);
    expect(taskPromptModules("")).toBe("");
  });

  it("states evidence, permissions, true backend availability and editable-fidelity limits", () => {
    for (const phrase of ["permissions", "actual bytes", "never promise exact", "PNG", "Real-ESRGAN", "rembg", "editable", "layout", "hash", "never fabricate"]) {
      expect(MEDIA_TASK_GUIDANCE).toContain(phrase);
    }
    expect(MEDIA_TASK_GUIDANCE.length).toBeLessThan(2200);
  });
});
