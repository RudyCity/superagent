# Senopati V3 — evidence collection, contamination screening and dual signed review

**Date:** 2026-10-23
**Scope:** Offline research only in SuperAgent. Does not change live intent/risk/approval, model weights, Cika dataset, ONNX, ToolExecutor, MCP, routing or permissions.
**Release state:** `BLOCKED`. Signed reviewer attestations are **quarantined**, never accepted automatically as authenticated human gold labels.

## Why this exists

Both earlier V3 intent candidates regressed against the V2 sparse baseline: Naive Bayes group-test macro-F1 0.604 vs V2 0.705, and linear softmax group-test macro-F1 0.592 vs V2 0.630. The same development corpus (864 examples, 292 groups) and previous audit packets have already been inspected extensively. Trying further hyperparameters on those revealed group tests would inflate model selection bias.

The correct next step is **new, consented, genuinely unseen bilingual examples** with stronger provenance and dual independent reviewer adjudication. There are **zero currently authenticated external human gold labels** and no publisher/signature trust root for production. This pipeline creates the necessary offline controls, but does NOT manufacture evidence of reviewer independence.

## Modules delivered

- `src/core/senopatiV3EvidenceIntake.ts`: bounded unlabeled intake, identity/format checks, Unicode-normalized exact duplicate detection, char-4-gram Jaccard near-duplicate screening (threshold 0.82), cross-group reference overlap detection, basic unredacted email/Indonesian mobile pattern screening, and a group-frozen research partition map. It produces blinded review requests without weak or model labels.
- `src/core/senopatiV3SignedReview.ts`: checks Ed25519 signatures against a provided public-key roster, requires distinct reviewer keys, checks full per-reviewer packet coverage, verifies fingerprints and 3-head valid label sets, and requires a separate third adjudicator signing key for conflicting cases. Consensus and adjudication stay `SIGNATURE_CHECKED_QUARANTINE_ONLY`.
- `scripts/senopati-v3-evidence.ts`: `prepare` and `verify` commands; source/reference SHA-256 manifests, packet hash, exclusions, frozen research split plan, and quarantined signed-annotation results. Outputs are written exclusively into ignored `build/superagent/quality/` and existing files are never overwritten.
- `scripts/sign-senopati-v3-review.ts`: runs **on a reviewer's device**, using a reviewer-owned Ed25519 private key **outside the project directory**. It does not generate, upload or persist private keys. Signing proves only possession of the corresponding private key; source identity and independence must be established by a separate trusted process.
- `tests/senopatiV3Evidence.test.ts` and `tests/senopatiV3EvidenceCli.test.ts`: unit/integration tests including corrupted signatures, changed packets, duplicate reviewer keys, insufficient label coverage, adverse source overlap and full end-to-end agreement/adjudication. Only tests generate temporary signing keys; tests delete them afterwards.

### What counts as a genuinely new input

Each JSONL record is **unlabeled** and has this structure:

```json
{"id":"fresh-anon-0001","text":"Tolong jelaskan cara mengevaluasi sumber berita yang kredibel.","context":"","language":"id","group":"collection-session-001","source":"approved-study-batch-001","origin":"new_external_collection"}
```

`origin` and `source` are unverified metadata supplied by the collector, **not proof of consent, independent provenance or new gold labels**. A real collector must separately document consent/usage rights, collection time, source process, privacy-redaction approach and restricted reviewer access in an externally governed evidence repository. Don't include real phone/email/account numbers, customer secrets or unredacted private messages. Basic regex screening is **not a complete personal-information detector**.

The pipeline rejects previous development examples, exact matches and high-overlap paraphrases. Fuzzy matching cannot guarantee semantic independence, especially for multilingual synonyms, reordered phrases or short inputs. Human review of potential leakage remains mandatory.

### Prepare a packet (SuperAgent machine, research only)

```powershell
bun scripts/senopati-v3-evidence.ts prepare --source "G:/secured_review/new_anonymous_examples.jsonl" --reference "G:/project/cika/superagent/datasets/v2_training.jsonl" --reference "G:/project/cika/data/senopati/v2/frozen_holdout.jsonl" --reference "G:/project/cika/data/senopati/v2/safety_holdout.jsonl" --out build/superagent/quality/v3_new_collection_manifest.json
```

This creates `v3_new_collection_manifest.json`, `v3_new_collection_manifest_reviewer_packet.jsonl`, `v3_new_collection_manifest_screening_exclusions.json` and `v3_new_collection_manifest_sealed_partition_plan.json`.

The reviewer packet has `id,text,context,language,sampleHash` and `review_status`, with no labels, predictions, confidence or candidate ranking. The internal partition plan is **not** shared with reviewers. Its deterministic hash split keeps entire groups together, but **does not guarantee stratified class support** because true labels are not yet available. If minority classes have inadequate test support, obtain more examples rather than reshuffling the sealed split based on test results.

**Legacy audit demonstration, successfully run:** import the prior 246 blank reviewer cases with `--legacy-development`, and reference the 864-row training and 111-row inspected holdouts. Result: **246/246 excluded** as previously inspected development sources. Diagnostics also identified 111 exact and 7 near-overlap signals; these reasons can overlap and should not be summed into distinct cases. No legacy sample was accepted as newly independent.

### Signing annotations (on each external reviewer's OWN computer)

Each reviewer receives an independently delivered identical blind packet, not the model predictions or the other reviewer's answers. They label **all three heads** (`intent`, `risk`, `approval`) using the taxonomy from `SENOPATI_V2_HEADS`; the blank packet remains unmodified. Their local annotation JSONL has:

```json
{"id":"fresh-anon-0001","sampleHash":"<sampleHash from original packet>","labels":{"intent":"ask","risk":"safe","approval":"none"}}
```

The reviewer generates and stores their Ed25519 key **on their own secured machine** through their organization's PKI/security process. The private PEM must never enter the SuperAgent workspace, chat, shared build cache, git, or a data-collection tool. The public key is registered in a roster with an externally checked reviewer identity:

```powershell
bun scripts/sign-senopati-v3-review.ts --manifest build/superagent/quality/v3_new_collection_manifest.json --packet build/superagent/quality/v3_new_collection_manifest_reviewer_packet.jsonl --annotations "D:/secure/annotations_a.jsonl" --private-key "D:/secure/keys/reviewer_a_private.pem" --signer reviewer-a --out build/superagent/quality/v3_signed_reviewer_a.json
```

Reviewer B repeats independently with another key, their own annotations, and `--signer reviewer-b`. Signed responses must cover the entire packet. Do not allow reviewers to see each other's labels or a model's weak labels before signing.

The public-key roster is a private JSON file with:

```json
{"schema":1,"externalIdentityVerification":"not_verified","identities":[
  {"id":"reviewer-a","role":"reviewer","publicKeyPem":"<real reviewer A Ed25519 SPKI PEM>"},
  {"id":"reviewer-b","role":"reviewer","publicKeyPem":"<real reviewer B Ed25519 SPKI PEM>"},
  {"id":"adjudicator-c","role":"adjudicator","publicKeyPem":"<distinct adjudicator Ed25519 SPKI PEM>"}
]}
```

PEM fields shown as placeholders above are **not actual usable keys**. Identity vetting, separation of duties, reviewer consent and roster authenticity must be checked outside this code. Editable roster contents are insufficient to establish independent human identity.

### Verify and adjudicate (research quarantine only)

```powershell
bun scripts/senopati-v3-evidence.ts verify --manifest build/superagent/quality/v3_new_collection_manifest.json --packet build/superagent/quality/v3_new_collection_manifest_reviewer_packet.jsonl --roster "D:/secure/review_roster.json" --a build/superagent/quality/v3_signed_reviewer_a.json --b build/superagent/quality/v3_signed_reviewer_b.json --out build/superagent/quality/v3_quarantine_review.json
```

When the reviewers disagree, the initial output records unresolved items and excludes their labels from the finalized quarantine. The third adjudicator independently labels **only the disputed IDs**, signs them with `sign-senopati-v3-review.ts --adjudication --signer adjudicator-c`, and the full `verify` command is rerun with an additional `--adjudication signed_adjudicator.json` to a **new** output filename. No existing evidence file is overwritten.

Valid signatures detect falsified or altered review contents, but they **do not** prove the signer is human, that the roster is independently authenticated, or that the original data source was lawfully collected. Consequently the result always sets:

```json
{"identitiesIndependentlyAuthenticated":false,"newGoldLabelsAuthorized":0,"trainingAuthorized":false,"evaluationReleaseAuthorized":false,"toolRoutingAuthorized":false}
```

These are guardrails, not missing auto-enablement flags. An **external verified provenance + human identity attestation mechanism, with trusted verification**, is still required before reviewed labels can even be considered for model retraining. The existing Cika `verified_retraining_preflight.rdy` stays fail-closed.

## QA / next gates

Local CLI integration has passed with **ephemeral test-only reviewer keys** including real Ed25519 sign/verify, third-party adjudication and tampered signed responses. New examples were synthetic **only in unit tests**; they are not real collected independent data.

Next recommended work once actual data and humans exist: source attestation and privacy review, verifiable public-key roster, class coverage quotas and grouped split QC, independent adjudicated training labels, calibration separate from test, and a sealed multilingual holdout with minority-class Wilson bounds. Only a separately authorized production review can then consider changes to routing. Until then **production release remains BLOCKED**.
