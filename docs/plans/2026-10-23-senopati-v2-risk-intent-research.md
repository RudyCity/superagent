# Senopati V2 — research risk escalation and honest intent threshold audit
Date: 2026-10-23. Repository: SuperAgent `main`. **Status: DEVELOPMENT/SHADOW ONLY.**

## Goal and source boundaries

This follows the 272-example, already-inspected Senopati V2 quality audit. It addresses two concrete misses in the *existing development data* while avoiding claims of independent accuracy improvement. One source file (`src/core/senopatiV2Safety.ts`) is currently being modified by another work session and was intentionally **not touched or staged**.

The existing live SuperAgent request router, ToolExecutor authorization, and production ONNX classifier are untouched. Neither research module can approve plans, authorize tools or promote a model.

## 1. Experimental risk escalator — not production policy

The new `src/core/senopatiV2RiskResearch.ts` proposes **sensitive** when an explicit external delivery action involves a document plus an unfamiliar external recipient, or when an explicit wire/bank transfer authorization involves an unknown/unverified beneficiary. It never lowers an existing risk classification, cannot turn destructive into sensitive/safe, and reports `authorizesExecution:false`, `eligibleForAutomaticToolRouting:false`, `confidenceCalibrated:false`.

The examples motivating these two narrow patterns were:

- `hold-0047`: an instruction to send a report to an unknown external email address.
- `safety-0031`: an instruction to authorize a wire transfer to an unfamiliar beneficiary.

These are **known, inspected evaluation examples**; the new patterns were tuned after seeing these errors and are NOT evidence of generalization. Research-only comparison appears as `byHead.risk.experimental` in the existing audit report. No changes to `src/core/senopatiV2Safety.ts`.

On 272 development examples (111 with risk labels, remaining approval-only):

| Metric | Original raw | Existing guard | Experimental guard + narrow escalator |
|---|---:|---:|---:|
| Destructive false negatives | 1 | 0 | 0 |
| Sensitive labeled as safe | 4 | 2 | **0** |
| New risk false positives due to escalator | n/a | n/a | **0 on seen samples** |
| Total risk false positives (including existing guard) | not shown here | baseline already has errors | **4 on seen samples** |

Two examples were newly escalated; **four total risk false positives** already existed in the guarded baseline and were not introduced by this experiment. This is a targeted development-dataset patch proposal only, not a production safety certificate or an independent benchmark.

The tests in `tests/senopatiV2RiskResearch.test.ts` cover the two observed misses, paraphrases in Indonesian/English, no-matches, monotonicity, input size, and no tool authorization.

## 2. Intent selective threshold — separate development partitions

The new `src/core/senopatiV2IntentSplitExperiment.ts` uses deterministic, group-separated calibration and evaluation partitions of **previously inspected development data**, stratified by intent label where possible. Exact normalized training overlaps and repeated evaluation texts are removed before splitting. The threshold is selected **only on calibration** using a predeclared Wilson lower 95% precision bound of 0.90 and a minimum of 12 accepted examples; it is then measured on the **separate evaluation** partition. The output never participates in live routing.

Important: when the safety/approval postprocessor overrides an intent label, the original sparse score no longer describes that changed label. Such examples automatically abstain from intent advisory acceptance rather than treating a raw relative similarity score as confidence in the overridden label.

Results for previously inspected Cika `frozen_holdout.jsonl` and `safety_holdout.jsonl`:

| Metric | Calibration | Evaluation |
|---|---:|---:|
| Samples | 64 | 47 |
| Raw intent accuracy | 46.875% | 48.936% |
| Guarded intent accuracy | 51.563% | 53.191% |
| Changed intent labels | 3 | 2 |
| Accepted intent suggestions | **0** | **0** |

**Selected threshold: null** (`NO_THRESHOLD_MEETS_DEVELOPMENT_BOUND`). This is the conservative result. It does **not** mean a classifier with 0% error, and the separately recorded evaluation accuracy is still on development data, not independent testing. No experimental threshold or risk escalation can grant tool execution.

## Reproduction

From the SuperAgent root, with the existing hash-pinned local experimental registry:

```powershell
bun scripts/audit-senopati-v2-quality.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --training G:/project/cika/superagent/datasets/v2_training.jsonl --set frozen=G:/project/cika/data/senopati/v2/frozen_holdout.jsonl --set safety=G:/project/cika/data/senopati/v2/safety_holdout.jsonl --set contrastive=G:/project/cika/superagent/teacher/approval_challenge_v1.jsonl --set adversarial=G:/project/cika/superagent/teacher/approval_adversarial_v1.jsonl --out build/superagent/quality/senopati_quality_audit_risk_research_v1.json

bun scripts/audit-senopati-v2-intent-split.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --training G:/project/cika/superagent/datasets/v2_training.jsonl --set G:/project/cika/data/senopati/v2/frozen_holdout.jsonl --set G:/project/cika/data/senopati/v2/safety_holdout.jsonl --out build/superagent/quality/senopati_intent_split_v1.json

bun --bun x vitest run tests/senopatiV2RiskResearch.test.ts tests/senopatiV2IntentSplitExperiment.test.ts
bun --bun x tsc --noEmit
```

The reports are Git-ignored under `build/superagent/quality/`; they store aggregate error counts and sample IDs only, not raw prompts.

## Remaining work / release blockers

- Obtain **fresh independent and blinded multilingual examples** not seen during model or heuristic design, with externally authenticated reviewers and adjudication. Existing human verification count remains **zero**.
- Validate risk escalation for false positives on representative benign financial/administrative tasks. The two-case development benefit does not warrant production promotion.
- Train a better intent candidate against genuinely verified data; current intent performance and lack of a conservative threshold prohibit automatic routing.
- Treat risk/approval as *nonauthoritative* shadow diagnostics. The Senopati V2 production release gate remains blocked, and the current runtime model/permissions are unchanged.
