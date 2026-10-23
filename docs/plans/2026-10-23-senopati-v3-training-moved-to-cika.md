# Senopati V3 training moved to Cika (2026-10-23)

## Authoritative owner

Training, model-family experiments (intent Naive Bayes and linear SGD), grouped split planning, hyperparameter selection and rejection gates for the **SuperAgent-specific Senopati V3 intent classifier** are now owned by the independent **Cika** repository:

`G:\project\cika`

Canonical Rudy-native files:
- `superagent/pipelines/intent_v3_research.rdy`
- `superagent/pipelines/experiment_intent_v3.rdy`
- `tests/senopati_v2/test_intent_v3_cika.rdy`
- `superagent/pipelines/INTENT_V3_MIGRATION.md`
- Root `AGENTS.md` — explicit ownership, test and release rules

Cika commit: `b326db0` (`feat(senopati): centralize V3 intent training in native Cika Rudy`).

Run only from Cika:

```powershell
rudy superagent/pipelines/experiment_intent_v3.rdy prepare
rudy superagent/pipelines/experiment_intent_v3.rdy run
rudy tests/senopati_v2/test_intent_v3_cika.rdy
rudy superagent/check_layout.rdy
```

Outputs are development-only and ignored by Git under `build/superagent/intent_v3_cika/`. The group manifest must exist and match the source hash before any fitting. **This native Rudy migration is an independent reimplementation**, not bit-exact reproduction of the previous TypeScript hyperparameter searches; past candidate comparisons remain historical experimental evidence.

## SuperAgent application ownership

The SuperAgent repository retains runtime **shadow inference**, compact cache, candidate registry, parity tests, audit/reporting, safety guards and ToolExecutor's independent authorization policy.

The following **duplicate training implementations and entry points** were removed from the SuperAgent app repository after Cika's runnable replacement passed Cika's native Rudy test and layout checks:

- `src/core/senopatiV2IntentCandidateResearch.ts`
- `src/core/senopatiV3IntentLinearResearch.ts`
- `scripts/experiment-senopati-v3-intent.ts`
- `scripts/experiment-senopati-v3-linear.ts`
- `tests/senopatiV2IntentCandidateResearch.test.ts`
- `tests/senopatiV3IntentLinearResearch.test.ts`

The old historical report documents are retained so the previous failed V3 experiments remain auditable, but their sample training commands are **not runnable from SuperAgent**. Follow Cika's current native Rudy commands above instead. No model or cache was deployed.

The *remaining offline-only* SuperAgent shadow-quality, selective intent threshold, and blinded evidence scripts are currently untouched to preserve tests/compatibility with other active work. They must **not** be used for candidate fitting or production model promotion; consolidate further training-related evaluation into Cika in separate dependency-audited changes. Avoid editing parallel sessions' active SuperAgent runtime/CLI/MCP files.

## QA / release

- Cika native Rudy plan preparation and research evaluation ran successfully; proposed V3 model rejected on minority-class regression.
- Cika `tests/senopati_v2/test_intent_v3_cika.rdy`, `superagent/check_layout.rdy`, and project doctor all passed.
- **No** authenticated independent human gold labels have been added, and no blind release gate passed. The learned models cannot independently authorize tools. Production release remains **BLOCKED**.

Migration does not change SuperAgent live routing, its ONNX files, runtime classifier import, policy hashes, or ToolExecutor.
