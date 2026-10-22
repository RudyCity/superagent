# Senopati V2 P0–P3 — isolated selective shadow operations

**2026-10-22 — Research-only.** This feature set does not change active SuperAgent routing, existing consent logic, or production ONNX. The registry is explicitly opt-in and stored in ignored `build/superagent/`.

## Components

- `src/core/senopatiV2SelectiveDecision.ts`: checks experimental OOF profile, returns per-head similarity-share advisory acceptance, reason for abstain, and always marks global `abstain: true`, `authorizesExecution: false`, `eligibleForAutomaticToolRouting: false`.
- `src/core/senopatiV2CandidateRegistry.ts`: explicit hash-pinned `SHA-256` candidate model + profile registry. Rejects production status, manipulated artifacts, schema mismatch, and any risk/approval threshold.
- `scripts/register-senopati-v2-shadow.ts`: opt-in creation of manifest under ignored `build/superagent/registry/`. Existing manifest cannot be overwritten with different bytes; no model files are copied.
- `scripts/bench-senopati-v2-shadow.ts`: cold load and single-process inference latency (mean, p50/p95/p99), heap usage, aggregate accepted-head counts, with **no user prompts stored in output**.
- `tests/senopatiV2SelectiveDecision.test.ts`: guards against forged release/calibration claims, profile tampering, edited model artifacts and accidental execution authorization.

## Confidence meaning

V2 sparse `relativeScores` are proportions of raw similarity scores and **not calibrated probabilities**. Cika's `superagent/evaluation/fit_selective_policy.rdy` uses five-fold grouped OOF development predictions to select read-only experimental thresholds of 0.20 for domain, 0.25 for intent, and 0.30 for action. Risk and approval have **null** thresholds, because minority class support and human review are insufficient. These values were selected and evaluated on the same development dataset, so they **must not** be treated as statistically independent safety thresholds.

In all scenarios the decision remains observational; the existing SuperAgent routing/ToolExecutor remains solely responsible for real user requests and authorization. No code in this feature is called by the live router or ToolExecutor.

## Reproduce

First run in Cika:

```powershell
cd G:\project\cika
rudy superagent/evaluation/fit_selective_policy.rdy
rudy tests/senopati_v2/test_selective_calibration.rdy
```

Then from the separate SuperAgent repository:

```powershell
bun scripts/register-senopati-v2-shadow.ts --model "G:/project/cika/build/superagent/senopati_v2_candidate/sparse_baseline.json" --policy "G:/project/cika/build/superagent/calibration/selective_oof_v1.json" --out "build/superagent/registry/senopati_v2_sparse_shadow.json"
bun scripts/bench-senopati-v2-shadow.ts --registry "build/superagent/registry/senopati_v2_sparse_shadow.json" --dataset "G:/project/cika/build/superagent/teacher_review/review_requests.jsonl" --out "build/superagent/benchmarks/senopati_v2_shadow.json"
bun --bun x vitest run tests/senopatiV2SelectiveDecision.test.ts
bun --bun x tsc --noEmit
```

Local measurement on 146 development prompts: ~22.94ms cold loading, 3.90ms mean inference, 6.33ms p95. Single-process, one local machine only; **not representative of concurrent service traffic**. All 146 requests globally abstained. The output preserves only timing/heap/counts and hash identifiers.

## Pending gates

P1: 146 synthetic review cases prepared for blinded independent review. The existing development validation is short by 7 destructive, 8 sensitive, 8 affirmative, 8 deny and 8 conditional cases under current minimum-support rules. These are sample-count deficits, not new verified labels.

P2: Rudy's `verified_retraining_preflight.rdy` intentionally fails; the repo has no authenticated independent human-review identities or signed attestation verification. It never promotes GPT-6 teacher proposals as gold.

P3: For later verified models, concurrency/load trials, opt-in shadow telemetry, model provenance and rollback plans must be reviewed before any canary or production activation.

**Do not interpret this as approval for live automatic tool routing or model release.** The existing Senopati V2 release gate remains fail-closed.
