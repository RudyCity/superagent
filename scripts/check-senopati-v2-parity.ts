/**
 * Read-only cross-runtime Senopati V2 parity gate.
 * Usage:
 * bun scripts/check-senopati-v2-parity.ts <candidate-sparse.json> <rudy-oracle.jsonl>
 * Never deploys or modifies production classifier artifacts.
 */
import { readFileSync } from "node:fs";
import { SenopatiV2Shadow } from "../src/core/senopatiV2Shadow.js";

const [modelPath, oraclePath] = process.argv.slice(2);
if (!modelPath || !oraclePath) {
  console.error("Usage: bun scripts/check-senopati-v2-parity.ts <candidate-model.json> <rudy-oracle.jsonl>");
  process.exit(2);
}
const shadow = SenopatiV2Shadow.loadCandidate(modelPath);
const entries = readFileSync(oraclePath, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (entries.length < 50) {
  throw new Error("Parity oracle has insufficient representative examples");
}
const heads = ["domain", "intent", "action", "risk", "approval"] as const;
const diffs: Array<{ id: string; head: string; got: string; expected: string }> = [];
for (const row of entries) {
  if (!row.id || typeof row.text !== "string" || typeof row.context !== "string" || !row.guarded_labels) {
    throw new Error("Malformed V2 parity oracle row");
  }
  const labels = shadow.predictGuarded(row.text, row.context).labels;
  for (const head of heads) {
    if (labels[head] !== row.guarded_labels[head]) {
      diffs.push({ id: row.id, head, got: labels[head], expected: row.guarded_labels[head] });
    }
  }
}
console.log(`Senopati V2 shadow parity: ${entries.length * heads.length - diffs.length}/${entries.length * heads.length} labels identical`);
if (diffs.length) {
  console.error(JSON.stringify(diffs.slice(0, 20), null, 2));
  process.exit(1);
}
console.log("PASS: observational shadow parity. No production promotion occurred.");
