import { withCdpTargetRead, withCdpTargetWrite } from "../../src/core/tools/chromeCdpSessionManager.js";
const [mode, targetId, agentId, token] = process.argv.slice(2);
try {
  const work = async () => {
    await new Promise(r => setTimeout(r, 80));
    return "worker_done";
  };
  const out = mode === "read"
    ? await withCdpTargetRead(9222, targetId, { agentId, sessionToken: token }, work)
    : await withCdpTargetWrite(9222, targetId, agentId, work, { sessionToken: token });
  console.log("CDP_OK:" + out);
} catch (error: any) {
  console.log("CDP_DENIED:" + error.message);
  process.exitCode = 2;
}
