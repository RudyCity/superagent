# Senopati V3 — quarantined review coverage gate

**Date:** 2026-10-23. **Development-only, non-authorizing** companion to `2026-10-23-senopati-v3-independent-evidence-pipeline.md`.

## Purpose

A valid Ed25519 signature does not prove that its holder is an authenticated human reviewer, that two holders are independent, or that the collection source has valid permission to use private conversation data. Even after signatures have been verified, data support and class balance must be checked **before any new experimental training/evaluation request can be assessed**.

`src/core/senopatiV3CoverageAudit.ts` performs read-only diagnostics on **freshly re-verified signed review submissions**, blind packet hashes and an unchanged frozen group partition plan. The CLI `scripts/senopati-v3-evidence.ts verify` now accepts optional `--plan <frozen-plan.json>` and includes a `coverage` object in the quarantined output.

This is **not a model accuracy audit**. No model predictions are used. The quotas below are conservative development-planning floors, **not statistical guarantees** and not conditions sufficient for deployment.

## Checks and quotas

- Validates source packet digest, reviewer signature result, versioned plan, original group plan digest and every sample ID. Each example must appear **exactly once** across train, calibration and sealed evaluation groups; missing/forged IDs are rejected.
- Checks coverage only for labels that have **two signed agreements or a separate signed adjudication**. Disagreements that have not been adjudicated do not count toward label support.
- Tracks all three heads (`intent`, `risk`, `approval`) per partition, bilingual breakdown and distinct groups.
- Requires at least **20 evaluated examples and 5 distinct evaluated groups per intent class**. For risk, this quota applies to `sensitive` and `destructive`; for approval, it applies to `affirm`, `deny`, `conditional`.
- Requires at least **50 adjudicated or agreed evaluated samples each in Indonesian and English**, with at least some signed samples in each partition. The `mixed` language segment is reported separately.
- Does **not** adjust the frozen group split to meet quotas; insufficient minority cases require a **new approved collection cohort**, not test-set reshuffling.
- Regardless of quotas, always reports `actualIndependentGoldLabelsAvailable:0`, `modelTrainingAuthorized:false`, `sealedEvaluationAuthorized:false`, `productionReleaseAuthorized:false`, and `toolAuthorization:false`. A manually asserted provenance flag or a coverage pass cannot change these outputs.

## CLI example

After `prepare`, independently signed reviewer A/B files, and (when needed) adjudicator signature have been supplied:

```powershell
bun scripts/senopati-v3-evidence.ts verify --manifest build/superagent/quality/v3_new_collection_manifest.json --packet build/superagent/quality/v3_new_collection_manifest_reviewer_packet.jsonl --plan build/superagent/quality/v3_new_collection_manifest_sealed_partition_plan.json --roster "D:/secure/review_roster.json" --a build/superagent/quality/v3_signed_reviewer_a.json --b build/superagent/quality/v3_signed_reviewer_b.json --adjudication build/superagent/quality/v3_signed_adjudicator.json --out build/superagent/quality/v3_review_and_coverage_audit.json
```

An adjudication file is **optional only if there are no conflicts**. Without one, the review output records unresolved differences as excluded from finalized label coverage. No existing result files are overwritten. The report remains in ignored local `build/superagent/quality/`.

## Verification

```powershell
bun --bun x tsc --noEmit
bun --bun x vitest run tests/senopatiV3Evidence.test.ts tests/senopatiV3EvidenceCli.test.ts
```

In the CLI integration test, only **synthetic test-only prompts** and ephemeral, isolated Ed25519 keys are used. The report correctly flags numerous minority and bilingual evaluation coverage deficits, while all release/training flags remain false. A mutated group plan is rejected after signature checks without writing any trusted output. No external human data were collected for this test.

**Outstanding production blockers:** externally authenticated and independent human identities, trusted source consent/provenance, fresh multilingual class-balanced labels, rigorous statistical evaluation, validated security boundaries and separate production approval. The Cika verified retraining preflight remains blocked.
