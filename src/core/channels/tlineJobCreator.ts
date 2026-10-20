/**
 * Server-originated creator provenance for CLI delegate background jobs.
 * Only trusted session-dispatch code can establish this AsyncLocalStorage scope.
 * Never accept creator identity via CLI bridge tool arguments or model output.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalCliWorkspace } from "../tools/cliBridgeWorkspaceScope.js";

export interface TlineJobCreator {
  clientMode: "tline";
  sessionId: string;
  workspace: string;
}
const VALID_SESSION = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const context = new AsyncLocalStorage<Readonly<TlineJobCreator>>();

export function runWithTrustedTlineCreator<T>(
  creator: TlineJobCreator,
  action: () => T,
): T {
  if (!VALID_SESSION.test(creator.sessionId) || creator.clientMode !== "tline") {
    throw new Error("Invalid trusted TLine creator context.");
  }
  const canonical = canonicalCliWorkspace(creator.workspace);
  return context.run(Object.freeze({ ...creator, workspace: canonical }), action);
}

export function getTlineCreatorForJob(workspace: string): TlineJobCreator | null {
  const creator = context.getStore();
  if (!creator || creator.clientMode !== "tline") return null;
  try {
    return canonicalCliWorkspace(workspace) === creator.workspace ? { ...creator } : null;
  } catch { return null; }
}
