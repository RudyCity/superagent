import { scoreNearDuplicateSimilarity } from "../src/core/selfdev/distiller.js";

type Example = { label: "duplicate" | "different"; name: string; left: string; right: string };
const THRESHOLD = 0.35;
const examples: Example[] = [
  { label: "duplicate", name: "focused-test workflow", left: "Run focused tests after changing the task lifecycle before merge", right: "Run focused tests after changing the task lifecycle code before merging" },
  { label: "duplicate", name: "parameterized SQL", left: "Use parameterized database queries and validate inputs before execution", right: "Validate every input and use parameterized SQL queries before execution" },
  { label: "duplicate", name: "secret redaction", left: "Redact secrets before persisting task evidence", right: "Redact credential secrets before storing evidence from tasks" },
  { label: "duplicate", name: "workspace isolation", left: "Validate exact workspace scope before reading evidence", right: "Check the exact workspace boundary before reading task evidence" },
  { label: "duplicate", name: "atomic file writes", left: "Write to a temporary file and atomically rename after success", right: "Write a temporary file then rename it atomically on success" },
  { label: "duplicate", name: "bounded tool calls", left: "Bound tool calls and stop repeating the same failed operation", right: "Stop repeating a failed operation and keep tool calls bounded" },
  { label: "duplicate", name: "abort behavior", left: "Record task abortion but skip automatic distillation", right: "When a task is aborted, record it and skip automatic distillation" },
  { label: "duplicate", name: "feedback semantics", left: "Do not infer that a lesson helped from task completion alone", right: "Task completion alone does not prove a lesson helped" },
  { label: "different", name: "opposite caching policy", left: "Always cache results when input is stable and validated", right: "Never cache results when input is stable and validated" },
  { label: "different", name: "opposite workspace policy", left: "Allow workspace crossover when retrieving lesson evidence", right: "Never allow workspace crossover when retrieving lesson evidence" },
  { label: "different", name: "opposite retry policy", left: "Retry failed storage writes with exponential backoff", right: "Do not retry failed storage writes with exponential backoff" },
  { label: "different", name: "opposite transaction policy", left: "Use transactions for batch inserts and updates", right: "Avoid transactions for batch inserts and updates" },
  { label: "different", name: "unrelated interface rule", left: "Validate user input and reject unknown fields before execution", right: "Use keyboard accessible navigation landmarks and visible focus indicators" },
  { label: "different", name: "unrelated graphics rule", left: "Keep old event evidence protected during retention cleanup", right: "Optimize generated image prompts with clear subject composition" },
  { label: "different", name: "opposite retention behavior", left: "Keep old event evidence during retention cleanup", right: "Delete old event evidence during retention cleanup" },
  { label: "different", name: "opposite candidate decision", left: "Approve a candidate after evidence review confirms workspace isolation", right: "Reject a candidate after evidence review confirms workspace isolation" },
  { label: "different", name: "opposite evidence behavior", left: "Retain lesson evidence when pruning old events", right: "Remove lesson evidence when pruning old events" },
  { label: "different", name: "opposite aborted-task behavior", left: "Stop distillation for tasks marked aborted", right: "Run distillation for tasks marked aborted" },
];

let tp = 0, fp = 0, tn = 0, fn = 0;
const errors: Array<{ type: "FP" | "FN"; name: string; score: number; left: string; right: string }> = [];
for (const example of examples) {
  const score = scoreNearDuplicateSimilarity(example.left, example.right);
  const predicted = score >= THRESHOLD;
  const actual = example.label === "duplicate";
  if (predicted && actual) tp++;
  else if (predicted && !actual) { fp++; errors.push({ type: "FP", name: example.name, score, left: example.left, right: example.right }); }
  else if (!predicted && !actual) tn++;
  else { fn++; errors.push({ type: "FN", name: example.name, score, left: example.left, right: example.right }); }
}
const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
console.log("Selfdev near-duplicate synthetic evaluation");
console.log(`- Threshold: ${THRESHOLD}`);
console.log(`- Labeled examples: ${examples.length} (${examples.filter(x => x.label === "duplicate").length} duplicate, ${examples.filter(x => x.label === "different").length} different)`);
console.log(`- Confusion matrix: TP=${tp}, FP=${fp}, TN=${tn}, FN=${fn}`);
console.log(`- Precision: ${(precision * 100).toFixed(1)}%`);
console.log(`- Recall: ${(recall * 100).toFixed(1)}%`);
console.log("- Misclassified examples:");
if (!errors.length) console.log("  none");
for (const error of errors) console.log(`  ${error.type} ${error.name} (score ${error.score.toFixed(3)})`);
console.log("Note: synthetic fixture only; it is a regression signal, not a production-quality calibrated metric.");
