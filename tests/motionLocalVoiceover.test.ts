import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getPiperConfig,
  localVoiceoverConfigured,
  localVoiceoverReady,
  validateNarrationRequest,
  synthesizeLocalVoiceover,
} from "../src/core/motion/director/localVoiceover.js";
import { updateSettings } from "../src/core/config/jsonConfig.js";
import { readMotionAudio, inspectMotionWav } from "../src/core/motion/assets/motionAudio.js";

const testDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-voiceover-test-"));
  testDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Motion Director Offline Piper TTS Local Voiceover", () => {
  it("validates narration request bounds and safety", () => {
    expect(() => validateNarrationRequest({})).not.toThrow();
    expect(() => validateNarrationRequest({ voiceoverText: "Halo dunia" })).not.toThrow();
    expect(() => validateNarrationRequest({ voiceoverText: "A", voiceoverGain: 1.5 })).not.toThrow();

    // Rejects empty string or whitespace only
    expect(() => validateNarrationRequest({ voiceoverText: "" })).toThrow(/transcript/i);
    expect(() => validateNarrationRequest({ voiceoverText: "   " })).toThrow(/transcript/i);

    // Rejects text exceeding 220 characters
    expect(() => validateNarrationRequest({ voiceoverText: "a".repeat(221) })).toThrow(/transcript/i);

    // Rejects control characters
    expect(() => validateNarrationRequest({ voiceoverText: "Halo\u0000Dunia" })).toThrow(/transcript/i);

    // Rejects out of bound gain (when text is present)
    expect(() => validateNarrationRequest({ voiceoverText: "Halo", voiceoverGain: -0.1 })).toThrow(/gain/i);
    expect(() => validateNarrationRequest({ voiceoverText: "Halo", voiceoverGain: 2.1 })).toThrow(/gain/i);
    expect(() => validateNarrationRequest({ voiceoverText: "Halo", voiceoverGain: Number.NaN })).toThrow(/gain/i);
  });

  it("handles unconfigured state gracefully", () => {
    updateSettings({ motionPiperBin: undefined, motionPiperModel: undefined });
    expect(localVoiceoverConfigured()).toBe(false);
    expect(getPiperConfig()).toBeNull();
  });

  it("detects configured Piper installation via updateSettings", async () => {
    const defaultPiperBin = path.join(os.homedir(), ".superagent-r", "piper", "piper", "piper.exe");
    const defaultPiperModel = path.join(os.homedir(), ".superagent-r", "piper", "id_ID-news_tts-medium.onnx");

    updateSettings({
      motionPiperBin: defaultPiperBin,
      motionPiperModel: defaultPiperModel,
    });

    expect(localVoiceoverConfigured()).toBe(true);
    const config = getPiperConfig();
    expect(config?.binary).toBe(defaultPiperBin);
    expect(config?.model).toBe(defaultPiperModel);

    let hasFiles = false;
    try {
      const [binStat, modelStat] = await Promise.all([
        fs.stat(defaultPiperBin),
        fs.stat(defaultPiperModel),
      ]);
      hasFiles = binStat.isFile() && modelStat.isFile();
    } catch {
      hasFiles = false;
    }

    const ready = await localVoiceoverReady();
    expect(ready).toBe(hasFiles);
  });

  it("synthesizes local Indonesian voiceover WAV and imports to workspace", async () => {
    const defaultPiperBin = path.join(os.homedir(), ".superagent-r", "piper", "piper", "piper.exe");
    const defaultPiperModel = path.join(os.homedir(), ".superagent-r", "piper", "id_ID-news_tts-medium.onnx");

    updateSettings({
      motionPiperBin: defaultPiperBin,
      motionPiperModel: defaultPiperModel,
    });

    const isReady = await localVoiceoverReady();
    if (!isReady) {
      console.warn("Skipping synthesis test: Piper binary or model not installed.");
      return;
    }

    const ws = await createTempWorkspace();
    const result = await synthesizeLocalVoiceover(ws, {
      voiceoverText: "Halo, selamat datang di Superagent Studio.",
      voiceoverGain: 1.0,
    });

    expect(result).toBeDefined();
    expect(result?.id).toMatch(/^audio-[a-f0-9]{64}$/);
    expect(result?.seconds).toBeGreaterThan(0.5);
    expect(result?.gain).toBe(1.0);

    const audioBytes = await readMotionAudio(ws, result!.id);
    expect(audioBytes.length).toBeGreaterThan(1000);
    const audioMeta = inspectMotionWav(audioBytes);
    expect(audioMeta.channels).toBe(1);
    expect(audioMeta.sampleRate).toBeGreaterThan(8000);
    expect(audioMeta.seconds).toBeCloseTo(result!.seconds, 1);
  }, 45000);
});
