/**
 * Offline per-session reconciliation casebook. No prompts, workspace paths,
 * message payloads, session IDs or bearer credentials are printed.
 *
 * Revalidates the private snapshot before and AFTER reading SQLite/receipts.
 * Produces review obligations only, never clearance to replay side effects.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { reconcileCoreRecoveryEvidence } from "./coreColdReconciliation.js";
const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as {
  Database: new(file: string, options: { readonly: boolean }) => {
    query(sql: string): { all(): any[]; get(): any }; close(): void;
  };
};
const hashId = (id: string) => crypto.createHash("sha256").update(id).digest("hex");
const MAX_CASES = 10000;
type StateCounts = Record<string, number>;
interface PrivateCase {
  id: string;
  fromReceipt: boolean;
  inHistory: boolean;
  turnStates: StateCounts;
}
export interface CoreRecoveryCase {
  sessionRef: string;
  receiptPresent: boolean;
  historyPresent: boolean;
  turnStates: StateCounts;
  status: "missing_history"|"incomplete_turn_review"|"external_effect_review";
  requiredActions: string[];
  replayAuthorized: false;
  resumeAuthorized: false;
}
export interface CoreRecoveryCasebook {
  version: 1;
  snapshotId: string;
  evidenceVerified: true;
  totalCases: number;
  returnedCases: number;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
  cases: CoreRecoveryCase[];
  externalEffectsReconciled: false;
  restartAuthorized: false;
  automaticReplayAllowed: false;
  nextStep: "OPERATOR_VERIFY_EXTERNAL_EFFECTS_AND_AGENT_HISTORY";
}
function ensureFinitePositiveCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CASES) {
    throw new Error("Unsafe recovery case count");
  }
}
export function createCoreRecoveryCasebook(folder: string, limit = 100, offset = 0): CoreRecoveryCasebook {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500 ||
      !Number.isInteger(offset) || offset < 0 || offset > MAX_CASES) {
    throw new Error("Recovery case limit must be 1..500 and offset 0..10000");
  }
  const initial = reconcileCoreRecoveryEvidence(folder); // validates SHA and manifest
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8")) as {
    files: Array<{ name: string }>; database: { present: boolean };
  };
  const cases = new Map<string, PrivateCase>();
  const get = (id: string): PrivateCase => {
    if (typeof id !== "string" || id.length < 1 || id.length > 128 ||
        /[\x00-\x1f\x7f]/.test(id)) throw new Error("Invalid session identity in private evidence");
    let current = cases.get(id);
    if (!current) {
      if (cases.size >= MAX_CASES) throw new Error("Too many recovery cases; refusing partial result");
      current = { id, fromReceipt: false, inHistory: false, turnStates: Object.create(null) as StateCounts };
      cases.set(id, current);
    }
    return current;
  };
  for (const file of manifest.files) {
    if (!file.name.startsWith("receipts/")) continue;
    const raw = fs.readFileSync(path.join(folder, ...file.name.split("/")), "utf8");
    if (raw.length > 8192) throw new Error("Recovery receipt oversized");
    const value = JSON.parse(raw) as { version?: number; sessionId?: string };
    if (value.version !== 1 || typeof value.sessionId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) {
      throw new Error("Invalid session receipt in recovery evidence");
    }
    const digest = hashId(value.sessionId);
    if (file.name !== "receipts/" + digest.slice(0,2) + "/" + digest + ".json") {
      throw new Error("Receipt filename and session identity mismatch");
    }
    get(value.sessionId).fromReceipt = true;
  }
  if (manifest.database.present) {
    const database = new Database(path.join(folder, "history.db"), { readonly: true });
    try {
      const tableRows = database.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','chat_turns')"
      ).all() as Array<{name:string}>;
      const tables = new Set(tableRows.map(row => row.name));
      if (tables.has("sessions")) {
        for (const row of database.query("SELECT id FROM sessions").all() as Array<{id:string}>) {
          get(row.id).inHistory = true;
        }
      }
      if (tables.has("chat_turns")) {
        // Do not read message_json, workspace or any tool payload.
        const rows = database.query(
          "SELECT session_id AS sessionId, state, COUNT(*) AS total FROM chat_turns GROUP BY session_id, state"
        ).all() as Array<{sessionId:string;state:string;total:number}>;
        for (const row of rows) {
          ensureFinitePositiveCount(row.total);
          if (typeof row.state !== "string" || row.state.length > 40 ||
              !/^[a-z_]+$/.test(row.state)) throw new Error("Invalid turn state in evidence");
          const c = get(row.sessionId);
          c.turnStates[row.state] = row.total;
        }
      }
      if (!tables.has("sessions") && initial.persistedSessionCount !== null)
        throw new Error("Recovery sessions table disappeared");
    } finally { database.close(); }
  }
  // Deterministic ordering avoids unstable operator review cursors.
  const ordered = [...cases.values()].sort((a,b) => hashId(a.id).localeCompare(hashId(b.id)));
  const output = ordered.slice(offset, offset + limit).map((c):CoreRecoveryCase => {
    const ambiguous = Object.entries(c.turnStates).some(
      ([state,count]) => count > 0 && !["completed","failed","cancelled"].includes(state));
    const status = !c.inHistory ? "missing_history" :
      ambiguous ? "incomplete_turn_review" : "external_effect_review";
    return {
      sessionRef: hashId(c.id).slice(0,24),
      receiptPresent:c.fromReceipt,
      historyPresent:c.inHistory,
      turnStates:c.turnStates,
      status,
      requiredActions:[
        ...(!c.fromReceipt?["VERIFY_LEGACY_SESSION_OWNERSHIP"]:[]),
        ...(!c.inHistory?["RECOVER_DURABLE_HISTORY_BEFORE_ANY_RESUME"]:[]),
        ...(ambiguous?["MANUALLY_RECONCILE_UNCERTAIN_TOOL_TURNS"]:[]),
        "VERIFY_EXTERNAL_EFFECTS_AND_APPROVAL_OUTCOMES",
      ],
      replayAuthorized:false,resumeAuthorized:false,
    };
  });
  // The casebook is derived from an owner-local file copy. Detect replacement
  // between reads, but never authorize restart even when hashes remain valid.
  const after = reconcileCoreRecoveryEvidence(folder);
  if (JSON.stringify(after) !== JSON.stringify(initial)) {
    throw new Error("Recovery evidence changed while building casebook");
  }
  return { version:1,snapshotId:initial.snapshotId,
    evidenceVerified:true,totalCases:ordered.length,returnedCases:output.length,
    offset,nextOffset:offset + output.length < ordered.length ? offset + output.length : null,
    truncated:offset + output.length < ordered.length,cases:output,
    externalEffectsReconciled:false,restartAuthorized:false,
    automaticReplayAllowed:false,
    nextStep:"OPERATOR_VERIFY_EXTERNAL_EFFECTS_AND_AGENT_HISTORY" };
}
