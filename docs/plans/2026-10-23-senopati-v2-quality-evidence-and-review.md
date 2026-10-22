# Senopati V2 — evidence-first intent, risk and approval audit
Date: 2026-10-23. Branch: `main` (SuperAgent). **Experimental, read-only, previously inspected development data. Not a blind benchmark, no production model or ToolExecutor changes.**

## What was implemented

- `src/core/senopatiV2QualityAudit.ts` aggregates **per-class confusion, support, precision, recall and F1** separately for `intent`, `risk`, and `approval`. It distinguishes raw model predictions from the current shadow safety guard. For approval it additionally compares the independent **selective approval postprocessor**. The audit flags false affirmative approvals, destructive false negatives, sensitive-as-safe misses, advisory acceptance mistakes, and exact text/context hash collisions with training.
- `scripts/audit-senopati-v2-quality.ts` runs the hash-pinned *experimental* compact-cached classifier and writes a local audit report with sample **IDs and error types only**, not original prompts. Every source file has its SHA-256 digest recorded in the report; duplicate IDs across datasets are rejected.
- `src/core/senopatiV2BlindReviewPacket.ts` creates an **unlabeled** review packet after excluding sample IDs that exactly match training, repeat another evaluation example, or share an explicitly provided training group. The packet is sorted by ID (not model severity), with no model predictions, suggested answers, risk/approval labels or triage priorities.
- `scripts/prepare-senopati-v2-quality-review.ts` refuses altered sources by rechecking source digests. It generates separate blank reviewer packets and an unverified manifest. Existing changed packets cannot be overwritten. The private packets contain original prompts for manual annotation; all artifacts are kept under the **Git-ignored** `build/superagent/quality/` path.
- `tests/senopatiV2QualityAudit.test.ts` and `tests/senopatiV2BlindReviewPacket.test.ts` cover confusion/counters, errors, invalid labels, privacy, duplicate detection, source overlap exclusion and fail-closed behavior.

## Reproduction

From the SuperAgent repository root with the existing local hash-pinned experimental model and Cika datasets:

```powershell
bun scripts/audit-senopati-v2-quality.ts --registry build/superagent/registry/senopati_v2_sparse_shadow.json --training G:/project/cika/superagent/datasets/v2_training.jsonl --set frozen=G:/project/cika/data/senopati/v2/frozen_holdout.jsonl --set safety=G:/project/cika/data/senopati/v2/safety_holdout.jsonl --set contrastive=G:/project/cika/superagent/teacher/approval_challenge_v1.jsonl --set adversarial=G:/project/cika/superagent/teacher/approval_adversarial_v1.jsonl --out build/superagent/quality/senopati_quality_audit_v1.json

bun scripts/prepare-senopati-v2-quality-review.ts --audit build/superagent/quality/senopati_quality_audit_v1.json --set frozen=G:/project/cika/data/senopati/v2/frozen_holdout.jsonl --set safety=G:/project/cika/data/senopati/v2/safety_holdout.jsonl --set contrastive=G:/project/cika/superagent/teacher/approval_challenge_v1.jsonl --set adversarial=G:/project/cika/superagent/teacher/approval_adversarial_v1.jsonl --out build/superagent/quality/senopati_quality_reviewer_a.jsonl

bun --bun x vitest run tests/senopatiV2QualityAudit.test.ts tests/senopatiV2BlindReviewPacket.test.ts
```

## Diagnostic results (one local run)

**272 inspected/development cases**, 494 labeled head comparisons (some GPT-6 contrastive examples have **only** approval labels; the audit never invents missing intent or risk truth). The candidate is a 756-record sparse shadow model, **not** the separately reported 902-row teacher experiment. Results from those two different candidates must not be conflated.

| Event | Raw sparse | Guarded sparse | Separate selective approval |
|---|---:|---:|---:|
| Incorrect affirmative approvals | **76** | 0 | 0 |
| Missed destructive risk labels | 1 | 0 | n/a |
| Sensitive risk misclassified as safe | 4 | **2** | n/a |

There were **14 exact training-overlap cases** (all in GPT-6-authored approval contrastive/adversarial development examples), **12 duplicate evaluation messages**, and no training group-ID collisions in the supplied data. The current *advisory* selective profile accepted 32 intent predictions, of which **13 disagreed with the existing development labels** (40.6% observed error rate among accepted intent suggestions). This is a strong signal against treating relative similarity shares as reliable probabilities or enabling automatic intent routing.

The unlabelled reviewer packet retained **246** distinct, non-training-overlapping examples and excluded **26** items. This is **not** a newly independent blind holdout: all these source sets had previously been inspected/used in development, some were AI authored, and reviewer identities are not authenticated. An independent benchmark requires newly sampled data, external labeling and verified provenance.

## Privacy, review and release limitations

- Audit reports record **identifiers, labels, per-class confusion, and aggregate statistics** but not full prompt text. The **local-only** reviewer packets necessarily include text/context to allow future annotation; do not publish them or commit them.
- Source SHA-256 proves only byte-level consistency between audit and packet generation. It is **not a signature**, proof of independent review or an accountable reviewer identity.
- Reviewer packet A and B are **blank templates**, not completed human reviews. Model or teacher predictions are not included. External reviewer authentication, blinded annotation, disagreement resolution and audit trails remain unsatisfied.
- No new training labels, classifier weights or ONNX model were produced or promoted. **Global abstain and independent ToolExecutor consent rules remain unchanged**. Risk and approval remain completely barred from automatic model authorization.
- Previously inspected development scores, including zeros for some errors, are **not** evidence of correctness on unseen real-world multilingual traffic. The release gate remains BLOCKED.

## Priority next work

1. Have genuinely independent accountable reviewers label **newly collected, representative Indonesian and English prompts**, especially minority risk and approval classes, with adjudication of disagreements.
2. Fit/select thresholds on a distinct calibration partition, evaluate once on a **sealed never-tuned** multilingual holdout, and report class-specific risk/approval false-negative rates plus uncertainty intervals.
3. Compare a newly trained sparse and neural candidate with the same separately reviewed data. Continue pure shadow only until all release gates pass.

All work is isolated to the SuperAgent shadow and offline scripts; no modifications to live router, browser, MCP, current production ONNX or ToolExecutor.
