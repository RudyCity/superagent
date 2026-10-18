import { Tool } from "./types.js";
import { getMuseDirectChatReadiness } from "../remoteAgent/museChatReadiness.js";
import { getMuseWatcher } from "../remoteAgent/museWatcherRegistry.js";

export const getMuseDirectChatReadinessTool: Tool = {
  name: "get_muse_direct_chat_readiness",
  description: "Report whether direct two-way chat with Muse is ready right now. Requires an active Muse watcher, websocket transport, and a live connection so reply_to correlation can work.",
  parameters: {
    type: "object",
    properties: {
      detailed: {
        type: "boolean",
        description: "Include extra watcher details and a short next-step hint. Default: true.",
      },
    },
  },
  async execute(args) {
    const detailed = args?.detailed !== false;
    const readiness = await getMuseDirectChatReadiness();
    const watcher = getMuseWatcher();
    const nextSteps: string[] = [];

    if (!readiness.ready) {
      if (!readiness.watcherActive) nextSteps.push("Start the Muse watcher / tunnel.");
      if (readiness.transport !== "websocket") nextSteps.push("Switch the watcher to the websocket transport.");
      if (!readiness.watcherConnected) nextSteps.push("Connect the Muse client to the websocket bridge.");
    }

    const payload: Record<string, unknown> = {
      ready: readiness.ready,
      reason: readiness.reason,
      transport: readiness.transport,
      watcherActive: readiness.watcherActive,
      watcherConnected: readiness.watcherConnected,
      replyCorrelationSupported: readiness.replyCorrelationSupported,
    };

    if (detailed) {
      payload.details = readiness.details;
      payload.nextSteps = nextSteps;
      if (watcher) {
        const stats = watcher.getStats();
        payload.watcherStats = {
          transport: stats.transport,
          transportDetails: stats.transportDetails,
          uptimeSeconds: stats.uptimeSeconds,
          tasksCompleted: stats.tasksCompleted,
          batchesExecuted: stats.batchesExecuted,
          activeTaskId: stats.activeTaskId,
        };
      }
    }

    return JSON.stringify(payload, null, 2);
  },
};
