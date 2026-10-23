/** Manual read-only Senopati V2 shadow exploration. No production model changes. */
import { SenopatiV2Shadow } from "../src/core/senopatiV2Shadow.js";

const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const ix = args.indexOf(name);
  return ix >= 0 ? args[ix + 1] : undefined;
};
const modelPath = get("--model");
const text = get("--text");
const context = get("--context") || "";
if (!modelPath || !text) {
  console.error("Usage: bun scripts/run-senopati-v2-shadow.ts --model <candidate.json> --text <message> [--context PLANNING_PENDING]");
  process.exit(2);
}
const classifier = SenopatiV2Shadow.loadCandidate(modelPath);
const raw = classifier.predict(text, context);
const guarded = classifier.predictGuarded(text, context);
console.log(JSON.stringify({
  status: "SHADOW_ONLY",
  model: raw.source,
  context,
  uncalibratedRawLabels: raw.labels,
  guardedLabels: guarded.labels,
  relativeSimilarityShares: raw.relativeScores,
  canAuthorizeTools: false,
  canReplaceProductionONNX: false,
}, null, 2));
