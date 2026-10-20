/** Source adapter for read-only T-Line task inspection. No agent execution. */
import { listDelegateJobs } from "../tools/cliBridgeDelegateJobs.js";
import { listDaemonRuns } from "../storage/daemonRunLedger.js";
import { getActiveRemoteTaskSnapshot } from "../remoteAgent/taskRunner.js";
import { selectTlineWorkspaceTasks, buildTlineTaskSnapshot } from "./tlineTaskSnapshot.js";

export async function collectTlineTaskSnapshot(workspace: string, sessionId: string) {
  const incomplete: string[] = [];
  const delegates = await listDelegateJobs().catch(() => {
    incomplete.push("cli");
    return [] as Awaited<ReturnType<typeof listDelegateJobs>>;
  });
  const daemon = (() => {
    try { return listDaemonRuns({ workspacePath: workspace, limit: 100 }); }
    catch { incomplete.push("daemon"); return [] as ReturnType<typeof listDaemonRuns>; }
  })();
  const muse = (() => {
    try { return getActiveRemoteTaskSnapshot(); }
    catch { incomplete.push("muse"); return null; }
  })();
  const tasks = selectTlineWorkspaceTasks(workspace, delegates, daemon, muse, sessionId);
  return buildTlineTaskSnapshot(workspace, tasks, incomplete);
}
