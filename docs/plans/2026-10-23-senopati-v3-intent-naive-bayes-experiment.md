> **ARSIP HISTORIS — TRAINING SUDAH DIPINDAH KE CIKA.** Perintah TypeScript experiment yang tertulis di bawah tidak lagi tersedia di repository SuperAgent. Jalankan `rudy superagent/pipelines/experiment_intent_v3.rdy prepare` lalu `rudy superagent/pipelines/experiment_intent_v3.rdy run` dari `G:\project\cika`. Lihat `docs/plans/2026-10-23-senopati-v3-training-moved-to-cika.md`. Angka pada dokumen lama adalah hasil eksperimen sebelumnya; pipeline native Rudy merupakan reimplementasi dengan grid baru, bukan hasil yang identik.

# Senopati V3 intent-only candidate — development experiment (2026-10-23)

**Result: REJECTED_ON_GROUP_TEST. No candidate was exported or activated.**

## Why this experiment exists

Senopati V2 risk/approval are already forced to abstain for automatic tool routing. On 111 previously examined development examples, raw intent accuracy was only ~47.8%; group-separated *within that inspected set*, no similarity-share threshold satisfied the conservative lower-bound acceptance rule. A higher-quality intent model must be trained and assessed before any proposal to expand automation.

This experiment trains a fresh, isolated **intent-only Multinomial Naive Bayes V3 research candidate**, using only `G:/project/cika/superagent/datasets/v2_training.jsonl` (the existing **864 curated/synthetic development records**, NOT independent human-verified gold labels). All nine intent classes are evaluated, including rare `approve` and `reject`.

`src/core/senopatiV2IntentCandidateResearch.ts` contains the research-only weighted sparse feature model, deterministic group split, macro-F1 and minority-F1 metrics, and rejection gate. `scripts/experiment-senopati-v3-intent.ts` runs a 32-candidate fixed hyperparameter grid and emits aggregate-only metrics under the Git-ignored `build/superagent/quality/`. No training input text is stored in the result.

## Evaluation design

- 292 original template groups split **atomically** into 182 training groups (567 rows), 55 validation groups (143 rows), and 55 evaluation groups (154 rows). Groups are hashed and stratified by their majority intent, with deterministic seed and checks that repeated normalized (context, text) pairs cannot cross a partition.
- Model selection uses **only the validation groups**, over smoothing `alpha = [0.05, 0.25, 1, 3]`, prior weights `[0, 0.3, 0.7, 1]`, and minimum feature document frequency `[1, 2]` (32 combinations).
- The baseline is a newly fitted copy of the pre-existing **Senopati V2 sparse nearest-record algorithm**, trained on **the identical 567 training records**. This is a paired evaluation, not a comparison to the production/ONNX model or the previous 756-record experiment.
- The selected model is evaluated **once** on the separate group evaluation split after parameters are fixed, alongside baseline. These original examples have been seen during earlier development; group separation limits template leakage but does **not** turn this into an independent blind study.
- The acceptance gate refuses a candidate when test macro-F1 fails to improve, minority macro-F1 regresses or test accuracy declines by more than 1 percentage point. Even passing this research gate **never** grants production release or tool execution.

## Observed results

| Metric | V2 sparse baseline | Intent V3 Naive Bayes |
|---|---:|---:|
| Validation accuracy (143) | 74.83% | **83.22%** |
| Validation macro-F1 (143) | 0.6763 | **0.6931** |
| Test accuracy (154) | **75.97%** | 75.32% |
| Test macro-F1 (154) | **0.7050** | 0.6038 |
| Test minority macro-F1 | Higher | **Lower by 0.2121** |

Best validation configuration: `alpha=0.05`, `priorWeight=0.7`, `minDf=1`. Its apparent validation advantage failed to generalize to the reserved development test groups. The test macro-F1 regression was **-0.1012**, and minority-class macro-F1 regressed **-0.2121**.

**This is useful negative evidence.** Do not select on validation accuracy alone, re-tune parameters on the observed test split, or publish the higher validation accuracy as evidence of improved intent routing. Any subsequent algorithm explored using this same test split can no longer claim the split was untouched by iteration.

The research model is not a probability calibrator: `relativeScore` is softmax over uncalibrated Naive Bayes log scores. It never produces executable tool permissions. The training script intentionally **does not save or register candidate model weights**, because the result was rejected. All true production release gates remain blocked.

## Reproduction

From the SuperAgent repository root, with a local Cika checkout:

```powershell
bun scripts/experiment-senopati-v3-intent.ts --dataset "G:/project/cika/superagent/datasets/v2_training.jsonl" --out build/superagent/quality/senopati_v3_intent_nb_research.json
bun --bun x vitest run tests/senopatiV2IntentCandidateResearch.test.ts
```

The report includes per-class confusion summaries, support, F1, selected parameter list, source SHA-256 and a `researchGate.status = REJECTED_ON_GROUP_TEST`.

### Type-check scope

At implementation time the repository-wide TypeScript compilation encountered syntax errors in the **unrelated, concurrently edited** `src/core/commands/coreCommands.ts` around line 822. We left that file untouched. The research module, CLI and tests were separately type-checked using an ignored temporary TypeScript project at `build/superagent/quality/tsconfig-senopati-v3-research.json`. This isolated check passed, alongside focused Vitest tests. Do not mistake it for a successful whole-repository build.

## Remaining blockers

1. Collect new, genuinely independent bilingual/Indonesian-English intent examples, reviewed by accountable human adjudicators. Current new independent labels: **zero**.
2. Compare stronger discriminative models on a **new pre-registered dataset split** rather than further tuning based on the test results above.
3. Report class-specific false positives, rare-class confusion, calibrated abstention and confidence intervals on a fresh sealed set before any runtime consideration.
4. Keep risk/approval safety gating and ToolExecutor authorization completely independent of learned intent. Neither this module nor this script is imported by live routing.
