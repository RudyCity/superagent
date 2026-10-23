import { EventEmitter } from "node:events";

export interface MotionStudioEvent {
  type:
    | "project.created"
    | "project.updated"
    | "project.deleted"
    | "job.queued"
    | "job.started"
    | "job.progress"
    | "job.completed"
    | "job.failed"
    | "job.cancelled";
  workspace: string;
  projectId?: string;
  jobId?: string;
  revision?: number;
  frame?: number;
  totalFrames?: number;
  progress?: number;
  artifactUrl?: string;
  error?: string;
  timestamp: string;
}

const studioEventEmitter = new EventEmitter();
studioEventEmitter.setMaxListeners(100);

let activeStreamCount = 0;

export function emitMotionStudioEvent(event: Omit<MotionStudioEvent, "timestamp">): void {
  const fullEvent: MotionStudioEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };
  studioEventEmitter.emit("event", fullEvent);
}

export function subscribeMotionStudioEvents(
  workspace: string,
  listener: (event: MotionStudioEvent) => void,
): () => void {
  const handler = (event: MotionStudioEvent) => {
    // Only forward events belonging to the subscriber's workspace
    if (!event.workspace || event.workspace.toLowerCase() === workspace.toLowerCase()) {
      listener(event);
    }
  };
  studioEventEmitter.on("event", handler);
  activeStreamCount++;

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    activeStreamCount = Math.max(0, activeStreamCount - 1);
    studioEventEmitter.off("event", handler);
  };
}

export function getMotionBridgeStats(): {
  activeStreamSubscribers: number;
  channel: "sse" | "ws";
  ready: boolean;
} {
  return {
    activeStreamSubscribers: activeStreamCount,
    channel: "sse",
    ready: true,
  };
}
