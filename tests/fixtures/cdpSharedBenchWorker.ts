import { withCdpTargetWrite } from "../../src/core/tools/chromeCdpSessionManager.js";

type Work = { port: number; targetId: string; agentId: string; sessionToken: string; actions: number; workMs: number };
let raw = "";
for await (const chunk of process.stdin) raw += chunk.toString();
const task = JSON.parse(raw) as Work;
const elapsed: number[] = [];
let failed = 0;
for (let i = 0; i < task.actions; i++) {
  const start = performance.now();
  try {
    await withCdpTargetWrite(task.port, task.targetId, task.agentId, async () => {
      await new Promise<void>(resolve => setTimeout(resolve, task.workMs));
    }, { sessionToken: task.sessionToken, waitMs: 120_000 });
    elapsed.push(performance.now() - start);
  } catch { failed++; }
}
process.stdout.write(JSON.stringify({ agentId: task.agentId, elapsed, failed }) + "\n");
