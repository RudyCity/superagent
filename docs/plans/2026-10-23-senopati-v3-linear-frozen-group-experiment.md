# Senopati V3 intent discriminative research — frozen group plan (2026-10-23)

**Decision: REJECTED_ON_GROUP_TEST.** This work is a development-only experiment; no model weights were exported, no runtime classifier was activated, and the current ToolExecutor/production ONNX remains untouched.

## Rationale

The previous Naive Bayes V3 candidate improved validation but regressed in the group test; its original test split was inspected during that iteration. Rather than tune again on those exposed outcomes, this experiment evaluates a **multiclass discriminative linear softmax model**, fitted with deterministic online SGD on **a different, predeclared group plan**.

**Important:** the entire 864-row Cika training/development corpus is still familiar from previous experiments. A newly generated split of these same examples is **not a fresh independent blind benchmark**, regardless of the local preregistration controls. A failure is informative, but a success could only justify further externally reviewed testing.

## Implemented modules

- `src/core/senopatiV3IntentLinearResearch.ts`: a group-split planner and hash-bound plan validator; an opt-in, intent-only sparse linear research model using existing Rudy-aligned weighted word, bigram and character-gram features with train-only vocabulary; deterministic SGD and bounded hyperparameter selection. It has no runtime imports into live routing.
- `scripts/experiment-senopati-v3-linear.ts`: two **explicit** commands, `prepare` and `run`. The first freezes group assignment to a local JSON manifest **before fitting**. The second refuses missing, edited, or source-mismatched plans; selects on validation only, checks the selected model against a V2 sparse baseline trained on the **same training data**, and reads the group test partition after choosing parameters.
- `tests/senopatiV3IntentLinearResearch.test.ts`: deterministic group isolation, altered-manifest rejection, source mismatch, normalized prompt leakage detection, deterministic training outputs, bounded input validation and safety gates.

All input datasets reside in the Cika checkout. Plans and reports are local files under Git-ignored `build/superagent/quality/`. The reports contain labels, aggregate class metrics and input SHA-256, **not raw prompt text**. This is not signed external attestation: a local manifest can be changed by someone with sufficient file access, though the loader checks it against the fixed planner and source bytes.

## Fixed research design

- Input: 864 previously labeled development examples, 292 semantic/template groups. No new human labels.
- Planner seed: `senopati-v3-linear-group-plan-v1-20261023`; manifest digest: `d170c1e647f474a21152f42422d43dab1a199d1841117a7665d21163eb160547`.
- Group allocation: **182 training groups / 501 examples**, **55 validation groups / 132 examples**, **55 test groups / 231 examples**. Semantic groups are not separated; exact normalized cross-partition duplicate prompts are rejected. The planner does not detect all possible near-duplicate paraphrases.
- Models: V2 sparse baseline retrained using *only these 501 rows* versus V3 intent-only discriminative multinomial linear softmax model. The V3 model never trains or outputs a risk/approval authorization.
- Fixed grid: learning rates `0.04, 0.12, 0.25`, epochs `12, 24`, L2 epoch shrinkage `0, 0.002`, optional inverse-sqrt class weighting `false, true` = **24 candidates**.
- Parameters selected **only on validation macro-F1**, with minority macro-F1, accuracy, and fixed JSON ordering as tie-breakers.
- Candidate and V2 baseline group test metrics computed after selecting hyperparameters. The test was not used in the grid loop.
- Acceptance: both overall and minority macro-F1 must improve, and accuracy cannot regress by more than 1 percentage point. Even a model satisfying that *development-only* gate cannot access automatic tool routing or production release.

## Recorded outcome

| Metric | V2 sparse baseline | V3 linear SGD |
|---|---:|---:|
| Validation accuracy (132) | **72.73%** | 65.15% |
| Validation macro-F1 (132) | **0.6161** | 0.6061 |
| Validation minority macro-F1 | 0.5089 | **0.5773** |
| Group test accuracy (231) | **68.83%** | 67.10% |
| Group test macro-F1 | **0.6303** | 0.5918 |
| Group test minority macro-F1 | **0.6032** | 0.5391 |

Validation picked `learningRate=0.25`, `epochs=24`, `l2=0`, `balanceClasses=false` as the best *among the 24 SGD candidates*. Being the best model in this candidate grid **does not imply** it beats the sparse baseline, even on validation.

The group's test macro-F1 declined **0.0385**; its minority macro-F1 declined **0.0641** and accuracy declined **1.73 percentage points**. The gate rejects the candidate: `REJECTED_ON_GROUP_TEST`.

Some sparse minority classes have extremely small support: only **4 chat** and **2 approve** examples in the group test. The linear model's test F1 for `chat` fell from 0.857 to 0.400 and for `approve` from 0.667 to **0**; it did improve `modify` in this particular group split. These per-class results are unstable with such limited support, another reason to prioritize new independent human-reviewed examples rather than optimizing on this test set.

## Reproduce

Run these commands from the SuperAgent root on a machine that also has the Cika checkout:

```powershell
bun scripts/experiment-senopati-v3-linear.ts prepare --dataset G:/project/cika/superagent/datasets/v2_training.jsonl --plan build/superagent/quality/senopati_v3_linear_split_plan.json

bun scripts/experiment-senopati-v3-linear.ts run --dataset G:/project/cika/superagent/datasets/v2_training.jsonl --plan build/superagent/quality/senopati_v3_linear_split_plan.json --out build/superagent/quality/senopati_v3_linear_research.json

bun --bun x tsc --noEmit
bun --bun x vitest run tests/senopatiV3IntentLinearResearch.test.ts
```

The script refuses changed existing manifests/reports, and never exports a trained candidate or writes to production model paths.

## Next prerequisites

1. Independently collect **new Indonesian and English prompts** representative of real tool requests; keep personally identifying data out of the datasets. Use two independent, authenticated, blinded human reviewers and adjudicate disagreements.
2. Fix label taxonomy and a sealed source-specific group split **before seeing predictions**. Verify near-duplicate exclusion and report confidence intervals/minority-class support.
3. Only then train more discriminative encoders on the *training* partition and use validation-only hyperparameter tuning. Evaluate a genuinely sealed holdout once, including minority false positives/negatives and safe human escalation.
4. Keep learned scores separate from authorization; risk and approval must continue abstaining until independent safety evidence and ToolExecutor policy requirements pass.

**No Senopati V3 production release is authorized by this experiment.**
