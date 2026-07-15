import { describe, it, expect, afterAll } from "vitest";
import { execa } from "execa";
import path from "path";

describe("Python Vision Inference Server daemon", () => {
  let serverProcess: any = null;
  const testPort = 8096;

  afterAll(() => {
    if (serverProcess) {
      try {
        serverProcess.kill();
      } catch {}
    }
  });

  it("spawns local Python HTTP server and responds on /health", async () => {
    const scriptPath = path.join(process.cwd(), "scripts", "vision_server.py");
    
    // Spawn the daemon
    serverProcess = execa("python", [scriptPath, String(testPort)]);
    
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
