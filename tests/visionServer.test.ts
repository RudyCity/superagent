import { describe, it, expect, afterAll } from "vitest";
import { execa } from "execa";
import { execSync } from "child_process";
import path from "path";

// Check if Python and all required vision dependencies are available synchronously
function hasPythonVisionDependencies(): { available: boolean; cmd: string } {
  const commands = ["python", "py", "python3"];
  for (const cmd of commands) {
    try {
      execSync(`${cmd} -c "import sys, torch, huggingface_hub, rfdetr, PIL, numpy"`, { stdio: "ignore" });
      return { available: true, cmd };
    } catch {
      continue;
    }
  }
  return { available: false, cmd: "python" };
}

describe("Python Vision Inference Server daemon", () => {
  let serverProcess: any = null;
  const testPort = 8096;
  const { available, cmd: pythonCmd } = hasPythonVisionDependencies();

  afterAll(async () => {
    if (serverProcess) {
      try {
        if (process.platform === "win32") {
          await execa("taskkill", ["/F", "/T", "/PID", String(serverProcess.pid)]);
        } else {
          serverProcess.kill();
        }
      } catch {}
    }
  });

  const runOrSkip = available ? it : it.skip;

  runOrSkip("spawns local Python HTTP server and responds on /health", async () => {
    const scriptPath = path.join(process.cwd(), "scripts", "vision_server.py");
    
    // Spawn the daemon
    serverProcess = execa(pythonCmd, [scriptPath, String(testPort)]);
    serverProcess.catch(() => {});
    
    // Wait for server to boot (give it enough time to import torch/transformers)
    let isHealthy = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const res = await fetch(`http://127.0.0.1:${testPort}/health`);
        if (res.ok) {
          const body = await res.json() as any;
          if (body.status === "healthy") {
            isHealthy = true;
            break;
          }
        }
      } catch {}
    }

    expect(isHealthy).toBe(true);
  }, 60000); // 60s timeout to allow PyTorch to load
});
