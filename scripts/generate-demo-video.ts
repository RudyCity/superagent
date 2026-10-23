import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import {
  generateMotionFromPrompt,
  type MotionDirectorPlan,
} from "../src/core/motion/director/directorService.js";
import { getMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { localVoiceoverReady } from "../src/core/motion/director/localVoiceover.js";

async function main() {
  console.log("==================================================");
  console.log(" SuperAgent Studio: End-to-End Video Demo Test");
  console.log("==================================================");

  // 1. Verify Piper TTS status
  const ttsReady = await localVoiceoverReady();
  console.log(`[1/5] Offline Piper TTS Local Voiceover Status: ${ttsReady ? "READY" : "NOT READY"}`);
  if (!ttsReady) {
    console.error("Error: Piper TTS binary or model not found. Run 'bun run setup:piper' first.");
    process.exit(1);
  }

  // 2. Setup demo workspace
  const workspace = path.resolve("./demo-studio-output");
  await fs.mkdir(workspace, { recursive: true });
  console.log(`[2/5] Target Workspace: ${workspace}`);

  // 3. Define 3-Scene Motion Storyboard Plan
  const promoPlan: MotionDirectorPlan = {
    name: "SuperAgent Studio Promo",
    durationSeconds: 6,
    background: "#0F172A",
    aspectRatio: "16:9",
    artDirection: "neon",
    transition: "wipe",
    scenes: [
      {
        headline: "SuperAgent Studio",
        subtitle: "Offline Motion & Video Engine",
        accent: "#38BDF8",
        motion: "elastic-scale",
        narration: "Selamat datang di Superagent Studio.",
        layout: "center",
      },
      {
        headline: "Animasi Kinetik Cepat",
        subtitle: "234 Efek Kinetik & 20 Compound Presets",
        accent: "#F43F5E",
        motion: "bounce-drop",
        narration: "Didukung efek kinetik dan transisi dinamis.",
        layout: "center",
      },
      {
        headline: "Suara Lokal Offline",
        subtitle: "Piper Neural TTS Bahasa Indonesia",
        accent: "#10B981",
        motion: "scale-pop",
        narration: "Serta narasi suara lokal offline.",
        layout: "center",
      },
    ],
  };

  const voiceoverScript = "Selamat datang di Superagent Studio. Didukung efek kinetik dinamis dan narasi suara lokal offline.";
  console.log(`[3/5] Synthesizing Indonesian Voiceover & Compiling Timeline...`);
  console.log(`      Script: "${voiceoverScript}"`);

  // 4. Generate motion project & start render job
  const result = await generateMotionFromPrompt(
    workspace,
    "Buat video promo Superagent Studio 3 scene dengan narasi lokal Piper",
    {
      planner: async () => promoPlan,
      voiceoverText: voiceoverScript,
      voiceoverGain: 1.0,
      width: 640,
    }
  );

  console.log(`[4/5] Project Created: ${result.project.id} (rev ${result.project.revision})`);
  console.log(`      Render Job ID:   ${result.job.id}`);
  console.log(`      Waiting for detached FFmpeg render to complete...`);

  // Poll job status
  let finalJob = result.job;
  const startTime = Date.now();
  for (let i = 0; i < 180; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    finalJob = await getMotionJob(workspace, result.job.id);
    if (finalJob.status === "rendering") {
      process.stdout.write(`\r      Rendering frame: ${finalJob.framesCompleted || 0} / ${finalJob.profile?.frameCount || 180}`);
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(finalJob.status)) {
      break;
    }
  }
  process.stdout.write("\n");

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (finalJob.status !== "completed") {
    console.error(`[ERROR] Render failed with status: ${finalJob.status}`);
    console.error(`        Details: ${finalJob.error}`);
    process.exit(1);
  }

  console.log(`[5/5] Render COMPLETED in ${elapsed}s!`);
  console.log(`      Artifact Path:  ${finalJob.artifact?.path}`);
  console.log(`      File Size:      ${((finalJob.artifact?.bytes || 0) / 1024).toFixed(1)} KB`);
  console.log(`      Video Hash:     ${finalJob.artifact?.sha256?.slice(0, 16)}...`);

  // Verify artifact with ffprobe
  if (finalJob.artifact?.path) {
    try {
      const { stdout } = await execa("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration,size,bit_rate:stream=codec_name,width,height",
        "-of", "json",
        finalJob.artifact.path,
      ]);
      const probe = JSON.parse(stdout);
      console.log("==================================================");
      console.log(" FFprobe Verification Details:");
      console.log(` - Video Stream: ${probe.streams?.[0]?.codec_name} (${probe.streams?.[0]?.width}x${probe.streams?.[0]?.height})`);
      console.log(` - Audio Stream: ${probe.streams?.[1]?.codec_name || "None"}`);
      console.log(` - Duration:     ${Number(probe.format?.duration).toFixed(2)}s`);
      console.log("==================================================");
      console.log(`🎉 Demo Video Berhasil Dibuat! Lokasi File:\n${finalJob.artifact.path}`);
    } catch (probeErr) {
      console.warn("ffprobe check warning:", probeErr);
    }
  }
}

main().catch(err => {
  console.error("Execution failed:", err);
  process.exit(1);
});
