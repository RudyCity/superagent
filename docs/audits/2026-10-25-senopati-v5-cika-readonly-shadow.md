# Senopati V5 Cika research handoff (read-only)

Date: 2026-10-25

This project has an additional read-only verifier and an offline comparison
script for Cika's V5 one-encoder/three-head research candidate.

Neither script changes requestClassifier, active routing, credentials, agent
sessions, tools, delegations, permission checks, or production model assets.
**Research candidate activation is explicitly blocked by the Cika release gate.**

## Source and pinned artifacts

Registered Cika workspace: G:\project\cika

Cika research manifest:
build/senopati_v4_research/joint_v5/joint_v5_shadow_handoff_v1.json

Model artifact verification:
- Model base Laya ModernBERT
- Three-head safetensors checkpoint (seed41)
- Head training/threshold metadata
- Dataset manifest
- Multiseed validation report
- BLOCKED release gate

All six files are read through a realpath/bounded-file verifier and checked
against the Cika SHA256 manifest. Activations, authorizesExecution,
authorizesDelegation, productionReleaseAuthorized and related privileged flags
must be explicitly false. Publisher signature is not verified; SHA256 proves
only that the files have not changed relative to the local handoff, not that
their creator is trusted.

## Usage

From SuperAgent workspace:

    bun scripts/verify-senopati-cika-joint-v5-shadow.ts --cika-root "G:/project/cika"

Optional offline synthetic smoke comparison (requires the 18-item fixture
and generated Cika predictions in the Cika research folder):

    bun scripts/compare-senopati-cika-joint-v5-shadow.ts --cika-root "G:/project/cika"

Unit tests:

    bun test tests/senopatiCikaJointV5Shadow.test.ts
    bun test tests/senopatiCikaHandoff.test.ts tests/senopatiV2Safety.test.ts tests/senopatiV2Shadow.test.ts

The offline comparison loads the current local ONNX Senopati classifier, but
never calls the Agent loop or tools. It reports a cross-tab of seven active
ONNX categories versus six Cika Choice intents. They are NOT equivalent label
spaces, so numerical parity is deliberately not claimed.

## Security boundaries

- No model input becomes an authorization credential.
- Shadow predictions are observational and not consumed by the active Agent.
- No sensitive prompt text is persisted in candidate observations by default;
  only SHA256 hashes and model decisions. Plain hashes are intended for
  synthetic samples; do not use this offline research log as a private
  customer-traffic logging system.
- Trusted authenticated caller, tenant ID, resource ownership, RBAC,
  per-action permission, delegated scope and human confirmation MUST be
  checked in the production host before executing a tool or fetching private data.
- A model predicting Noul=0 is not permission.
- The candidate cannot replace the existing production router until an
  independent human-reviewed gold benchmark and all release gates pass.

## Observed status

- Read-only Cika handoff: verified 6 pinned artifact files successfully.
- 18 research-only offline observations: success, 0 tool/delegation/private
  data actions, no live sessions changed.
- Current ONNX category for the 18 synthetic prompts: question for all;
  candidate spans six intent labels. Insufficient evidence for promotion.
- Vitest regression: 5/5 new handoff tests pass; 39/39 targeted
  Senopati safety and handoff tests pass in aggregate.
- Production candidate gate: BLOCKED.

Further information: Cika report at
docs/audits/2026-10-25-senopati-v5-shared-encoder-phases-1-5.md.
