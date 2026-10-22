/** Compare an optional, observational Bun approval policy with a Cika Rudy oracle. */
import { readFileSync } from "node:fs";
import { inferSelectiveApproval, observeSelectiveApproval } from "../src/core/senopatiV2ApprovalSelective.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: bun scripts/check-senopati-v2-approval-parity.ts <rudy-oracle.jsonl>");
  process.exit(2);
}
const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
if (rows.length < 200) throw new Error("At least 200 development parity cases required");
const mismatches: unknown[] = [];
for (const row of rows) {
  if (!row.id || typeof row.text !== "string" || typeof row.context !== "string" ||
      !["none", "affirm", "deny", "conditional"].includes(row.advisory_label)) {
    throw new Error("Invalid approval parity oracle row");
  }
  const actual = inferSelectiveApproval(row.text, row.context);
  const observation = observeSelectiveApproval(row.text, row.context);
  if (actual !== row.advisory_label || observation.authorizesExecution !== false) {
    mismatches.push({ id: row.id, expected: row.advisory_label, actual, context: row.context });
  }
}
console.log("Senopati selective approval Rudy/Bun parity:", rows.length - mismatches.length, "/", rows.length);
if (mismatches.length) {
  console.error(JSON.stringify(mismatches.slice(0, 20), null, 2));
  process.exit(1);
}
console.log("PASS: shadow-only approval classification parity; no execution authorization or production promotion");
