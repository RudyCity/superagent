import { delegateBridge } from "./bridge.js";
import { resolveDelegateClientId } from "./historySync.js";

export interface DelegateRunUntilDoneOptions {
  clientId?: string;
  tabId?: number;
  message: string;
  maxContinuations?: number;
  pollMs?: number;
  stallMs?: number;
  maxRuntimeMs?: number;
  recoverStall?: boolean;
  completionMarker?: string;
}

function parseJson(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new Error("DELEGATE_INVALID_RESPONSE: Delegate returned invalid JSON"); }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("DELEGATE_ABORTED"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("DELEGATE_ABORTED"));
    }, { once: true });
  });
}

export async function runDelegateUntilDone(
  options: DelegateRunUntilDoneOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const clientId = resolveDelegateClientId(options.clientId);
  const message = String(options.message || "").trim();
  if (!message || message.length > 100_000) {
    throw new Error("DELEGATE_INVALID_MESSAGE: message must be nonempty text of at most 100000 characters");
  }
  const tabId = options.tabId;
  if (tabId !== undefined && (!Number.isSafeInteger(tabId) || tabId < 1)) {
    throw new Error("DELEGATE_INVALID_TAB_ID: tabId must be a positive integer");
  }
  const maxContinuations = Math.min(Math.max(Number(options.maxContinuations ?? 3), 0), 8);
  const pollMs = Math.min(Math.max(Number(options.pollMs ?? 1500), 500), 5000);
  const stallMs = Math.min(Math.max(Number(options.stallMs ?? 90_000), 15_000), 300_000);
  const maxRuntimeMs = Math.min(Math.max(Number(options.maxRuntimeMs ?? 600_000), 30_000), 900_000);
  const recoverStall = options.recoverStall === true;
  const marker = String(options.completionMarker || "[[DELEGATE_DONE]]").trim().slice(0, 120);
  if (!marker) throw new Error("DELEGATE_INVALID_COMPLETION_MARKER");

  const target = tabId === undefined ? {} : { tabId };
  const initialMessage = message + "\n\nWhen the requested task is fully complete, end your final response with exactly " + marker;
  const startedAt = Date.now();
  let continuations = 0;
  let stallRecoveries = 0;
  let lastFingerprint = "";
  let lastChangedAt = Date.now();
  let lastState: any = null;

  await delegateBridge.request(
    "delegate.set_timeout_recovery",
    { ...target, enabled: false },
    signal,
    20_000,
    clientId,
  );

  try {
    await delegateBridge.request(
      "delegate.send_message",
      { ...target, message: initialMessage },
      signal,
      36_000,
      clientId,
    );

    while (Date.now() - startedAt < maxRuntimeMs) {
      await delay(pollMs, signal);
      const state = parseJson(await delegateBridge.request(
        "delegate.read_chat",
        target,
        signal,
        26_000,
        clientId,
      ));
      lastState = state;
      const latest = String(state?.latest_response_text || "");
      const fingerprint = JSON.stringify([
        state?.status || "",
        Number(state?.total_message_count || 0),
        latest,
      ]);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastChangedAt = Date.now();
      }

      if (latest.includes(marker) && state?.status !== "working") {
        return {
          status: "completed",
          marker,
          continuations,
          stall_recoveries: stallRecoveries,
          elapsed_ms: Date.now() - startedAt,
          latest_response_text: latest,
          total_message_count: Number(state?.total_message_count || 0),
        };
      }

      if (state?.status === "delivery_timeout") {
        if (continuations >= maxContinuations) {
          return {
            status: "continuation_limit",
            reason: "delivery_timeout",
            marker,
            continuations,
            elapsed_ms: Date.now() - startedAt,
          };
        }
        await delegateBridge.request(
          "delegate.send_message",
          { ...target, message: "continue until done" },
          signal,
          36_000,
          clientId,
        );
        continuations++;
        lastChangedAt = Date.now();
        lastFingerprint = "";
        continue;
      }

      if (state?.status === "working") {
        if (Date.now() - lastChangedAt < stallMs) continue;
        if (!recoverStall) {
          return {
            status: "stalled",
            reason: "no_dom_progress",
            continuations,
            elapsed_ms: Date.now() - startedAt,
            total_message_count: Number(state?.total_message_count || 0),
          };
        }
        if (continuations >= maxContinuations) {
          return {
            status: "continuation_limit",
            reason: "stalled_generation",
            continuations,
            elapsed_ms: Date.now() - startedAt,
          };
        }
        try {
          await delegateBridge.request(
            "delegate.stop_generation",
            target,
            signal,
            20_000,
            clientId,
          );
        } catch {}
        await delegateBridge.request(
          "delegate.send_message",
          { ...target, message: "continue until done" },
          signal,
          36_000,
          clientId,
        );
        continuations++;
        stallRecoveries++;
        lastChangedAt = Date.now();
        lastFingerprint = "";
        continue;
      }

      if (["finished", "stopped", "waiting_for_input"].includes(String(state?.status || ""))) {
        if (continuations >= maxContinuations) {
          return {
            status: "continuation_limit",
            reason: "completion_marker_missing",
            marker,
            continuations,
            elapsed_ms: Date.now() - startedAt,
            latest_response_text: latest,
          };
        }
        await delegateBridge.request(
          "delegate.send_message",
          { ...target, message: "continue until done" },
          signal,
          36_000,
          clientId,
        );
        continuations++;
        lastChangedAt = Date.now();
        lastFingerprint = "";
      }
    }

    return {
      status: "timeout",
      marker,
      continuations,
      stall_recoveries: stallRecoveries,
      elapsed_ms: Date.now() - startedAt,
      last_status: String(lastState?.status || "unknown"),
      latest_response_text: String(lastState?.latest_response_text || ""),
    };
  } finally {
    try {
      await delegateBridge.request(
        "delegate.set_timeout_recovery",
        { ...target, enabled: true },
        undefined,
        20_000,
        clientId,
      );
    } catch {}
  }
}
