import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import { updateSettings } from "../src/core/config/jsonConfig.js";

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`Downloading ${path.basename(destPath)} from ${url}...`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Superagent-Setup/1.0" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status} ${response.statusText}`);
  }
  const fileStream = createWriteStream(destPath);
  // @ts-ignore
  for await (const chunk of response.body) {
    fileStream.write(chunk);
  }
  await new Promise<void>((resolve, reject) => {
    fileStream.end((err: Error | null) => (err ? reject(err) : resolve()));
  });
  const stat = await fs.stat(destPath);
  console.log(`Downloaded ${path.basename(destPath)}: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);
}

async function setupPiper(): Promise<void> {
  const home = os.homedir();
  const piperDir = path.join(home, ".superagent-r", "piper");
  await fs.mkdir(piperDir, { recursive: true });

  const zipUrl = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
  const zipPath = path.join(piperDir, "piper_windows_amd64.zip");

  const onnxUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx";
  const onnxPath = path.join(piperDir, "id_ID-news_tts-medium.onnx");

  const jsonUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx.json";
  const jsonPath = path.join(piperDir, "id_ID-news_tts-medium.onnx.json");

  // 1. Download Piper binary if piper.exe not present
  let piperExe = path.join(piperDir, "piper", "piper.exe");
  try {
    await fs.stat(piperExe);
    console.log(`piper.exe already exists at ${piperExe}`);
  } catch {
    // try direct path
    const directExe = path.join(piperDir, "piper.exe");
    try {
      await fs.stat(directExe);
      piperExe = directExe;
      console.log(`piper.exe already exists at ${piperExe}`);
    } catch {
      await downloadFile(zipUrl, zipPath);
      console.log("Extracting Piper binary archive...");
      await execa("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${piperDir}' -Force`,
      ]);
      await fs.rm(zipPath, { force: true });
      try {
        await fs.stat(piperExe);
      } catch {
        piperExe = path.join(piperDir, "piper.exe");
      }
      console.log(`Extracted Piper to ${piperExe}`);
    }
  }

  // 2. Download Indonesian ONNX model & json
  try {
    await fs.stat(onnxPath);
    console.log(`Model ${path.basename(onnxPath)} already exists`);
  } catch {
    await downloadFile(onnxUrl, onnxPath);
  }

  try {
    await fs.stat(jsonPath);
    console.log(`Model config ${path.basename(jsonPath)} already exists`);
  } catch {
    await downloadFile(jsonUrl, jsonPath);
  }

  // 3. Test piper synthesis
  console.log("Testing Piper speech synthesis...");
  const testWav = path.join(piperDir, "test.wav");
  const testText = "Halo, suara lokal Piper di Superagent Studio sudah aktif dan siap digunakan.";
  const proc = execa(piperExe, ["--model", onnxPath, "--output_file", testWav], {
    input: testText,
  });
  await proc;

  const testStat = await fs.stat(testWav);
  console.log(`Speech synthesis successful! Generated WAV size: ${(testStat.size / 1024).toFixed(1)} KB`);
  await fs.rm(testWav, { force: true });

  // 4. Update model-config.json
  console.log("Updating Superagent configuration...");
  updateSettings({
    motionPiperBin: piperExe,
    motionPiperModel: onnxPath,
  });

  console.log("Piper TTS setup complete and verified!");
  console.log(`Binary: ${piperExe}`);
  console.log(`Model:  ${onnxPath}`);
}

setupPiper().catch(err => {
  console.error("Setup failed:", err);
  process.exit(1);
});
