/**
 * Senopati V2 shadow classifier for the Rudy-generated sparse candidate.
 * This module is opt-in/read-only: it NEVER authorizes tools, edits plans,
 * bypasses ToolExecutor approval or mutates production routing.
 *
 * No automatic absolute path to a private training workspace is permitted.
 */
import fs from "node:fs";
import { guardSenopatiV2Shadow } from "./senopatiV2Safety.js";

export const SENOPATI_V2_HEADS = {
  domain: ["conversation", "knowledge", "writing", "creative", "research", "productivity", "operations", "engineering"],
  intent: ["chat", "ask", "research", "draft", "create", "modify", "execute", "approve", "reject"],
  action: ["answer", "retrieve", "artifact", "tools", "delegate", "none"],
  risk: ["safe", "sensitive", "destructive"],
  approval: ["none", "affirm", "deny", "conditional"],
} as const;

type Head = keyof typeof SENOPATI_V2_HEADS;
const HEAD_ORDER: Head[] = ["domain", "intent", "action", "risk", "approval"];
type ModelRecord = Record<Head, string> & { features: Record<string, number> };
export type SenopatiV2ShadowLabels = { [K in Head]: (typeof SENOPATI_V2_HEADS)[K][number] };
export interface SenopatiV2ShadowPrediction {
  readonly labels: SenopatiV2ShadowLabels;
  /** Relative similarity share; NOT calibrated statistical confidence. */
  readonly relativeScores: Record<Head, number>;
  readonly source: "senopati-v2-sparse-shadow";
  readonly authorizesExecution: false;
}
export interface SenopatiV2SparsePayload {
  format: "senopati-v2-sparse-baseline";
  deployment: "candidate-only";
  heads: Record<Head, string[]>;
  records: ModelRecord[];
}

const FEATURE_RE = /^[wbpcs]:/;
const MAX_RECORDS = 10_000;
const MAX_FEATURES_PER_RECORD = 600;

/** Exact port of Rudy v2_sparse.features() for cross-runtime parity. */
export function extractSenopatiV2SparseFeatures(text: string): Record<string, number> {
  let clean = "";
  for (const c of text.toLowerCase()) {
    clean += /[\p{L}\p{N}_\-.\/]/u.test(c) ? c : " ";
  }
  const words = clean.split(/\s+/).filter(Boolean);
  const values: Record<string, number> = Object.create(null);
  let prev = "";
  for (const word of words) {
    values["w:" + word] = 3;
    if (prev) values["b:" + prev + "_" + word] = 1.8;
    prev = word;
    if (word.length >= 3) {
      values["p:" + word.slice(0, 3)] = 0.85;
      values["s:" + word.slice(-3)] = 0.85;
      for (let j = 0; j < word.length - 2; j++) {
        values["c:" + word.slice(j, j + 3)] = 0.45;
      }
    }
  }
  return values;
}

function cosine(a: Record<string, number>, b: Record<string, number>, bNorm: number): number {
  let dot = 0;
  let aNorm = 0;
  for (const [key, value] of Object.entries(a)) {
    aNorm += value * value;
    dot += value * (b[key] || 0);
  }
  return dot / Math.max(0.00001, Math.sqrt(aNorm) * bNorm);
}

export class SenopatiV2Shadow {
  private readonly records: Array<ModelRecord & { norm: number }>;

  constructor(payload: SenopatiV2SparsePayload) {
    if (payload?.format !== "senopati-v2-sparse-baseline" ||
        payload.deployment !== "candidate-only" ||
        !Array.isArray(payload.records) ||
        payload.records.length === 0 || payload.records.length > MAX_RECORDS) {
      throw new Error("Invalid / unapproved Senopati V2 candidate manifest");
    }
    for (const head of HEAD_ORDER) {
      const expected = SENOPATI_V2_HEADS[head] as readonly string[];
      const actual = payload.heads?.[head];
      if (!Array.isArray(actual) || actual.length !== expected.length ||
          actual.some((value, i) => value !== expected[i])) {
        throw new Error("Incompatible Senopati V2 label order: " + head);
      }
    }
    this.records = payload.records.map((record) => {
      if (typeof record !== "object" || !record || !record.features ||
          Object.keys(record.features).length > MAX_FEATURES_PER_RECORD) {
        throw new Error("Invalid Senopati V2 vector");
      }
      let sq = 0;
      for (const [key, value] of Object.entries(record.features)) {
        if (!FEATURE_RE.test(key) || !Number.isFinite(value) || value < 0 || value > 10) {
          throw new Error("Invalid Senopati V2 vector weight");
        }
        sq += value * value;
      }
      for (const head of HEAD_ORDER) {
        if (!(SENOPATI_V2_HEADS[head] as readonly string[]).includes(record[head])) {
          throw new Error("Invalid Senopati V2 training label: " + head);
        }
      }
      return { ...record, norm: Math.sqrt(sq) };
    });
  }

  static loadCandidate(filename: string): SenopatiV2Shadow {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
      throw new Error("Senopati V2 candidate file is not a bounded JSON model");
    }
    return new SenopatiV2Shadow(JSON.parse(fs.readFileSync(filename, "utf8")));
  }

  predict(text: string, context = ""): SenopatiV2ShadowPrediction {
    // Context is observational only. It is not interpreted as user permission.
    const input = context ? `context ${context} message ${text}` : `message ${text}`;
    const query = extractSenopatiV2SparseFeatures(input);
    const best = Object.fromEntries(HEAD_ORDER.map(head => [
      head, Object.fromEntries(SENOPATI_V2_HEADS[head].map(label => [label, [0, 0]]))
    ])) as Record<Head, Record<string, number[]>>;
    for (const row of this.records) {
      const sim = cosine(query, row.features, row.norm);
      if (sim <= 0) continue;
      for (const head of HEAD_ORDER) {
        const top = best[head][row[head]];
        if (sim > top[0]) {
          top[1] = top[0];
          top[0] = sim;
        } else if (sim > top[1]) top[1] = sim;
      }
    }
    const labels = {} as SenopatiV2ShadowLabels;
    const relativeScores = {} as Record<Head, number>;
    for (const head of HEAD_ORDER) {
      let bestLabel: string = SENOPATI_V2_HEADS[head][0];
      let bestScore = -1;
      let total = 0;
      for (const label of SENOPATI_V2_HEADS[head]) {
        const top = best[head][label];
        const score = top[0] + top[1] * 0.25;
        total += Math.max(0, score);
        if (score > bestScore) {
          bestScore = score;
          bestLabel = label;
        }
      }
      (labels as any)[head] = bestLabel;
      relativeScores[head] = total > 0 ? Math.max(0, bestScore) / total : 1 / SENOPATI_V2_HEADS[head].length;
    }
    return { labels, relativeScores, source: "senopati-v2-sparse-shadow", authorizesExecution: false };
  }

  /** Observational guarded output; never bypasses existing ToolExecutor rules. */
  predictGuarded(text: string, context = ""): SenopatiV2ShadowPrediction {
    return guardSenopatiV2Shadow(this.predict(text, context), text, context);
  }
}
