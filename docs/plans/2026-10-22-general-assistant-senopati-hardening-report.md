# SuperAgent general-purpose assistant hardening and Senopati gate

Date: 2026-10-22. Repositories: SuperAgent and `G:\\project\\cika`.

## Changes integrated in SuperAgent

- Explicit plan approval is standalone, negation-aware and conditional-safe (`src/core/agent/ApprovalIntent.ts`); a mode switch or a stale plan file is not approval. Continuations require an active approved workflow.
- Existing Senopati ONNX classifier remains the neural inference backend. A conservative assistant task-domain overlay (`src/core/assistantRouting.ts`) maps general-purpose writing, knowledge, productivity, creative and research requests onto the existing seven tool-access classes without deploying incompatible class-head weights.
- Domain-specific `assist` guidance, conditional coding skills, and context-scoped engineering instructions. Conversational FastPath uses the concise general identity, with project file instructions omitted from casual replies.
- MCP descriptions and Muse/Sidepanel/CLI prompts use the general assistant identity and respect permission boundaries. Package metadata and README reflect this use case.

## Verified behavior and tests

- No plan approval from `tidak setuju`, `jangan perbaiki`, conditional replies, or unrelated mode changes.
- Existing Senopati ONNX + domain routing tested end-to-end, including benign caption, PDF/presentation, poster, reminder, research, and explicitly dangerous `git reset --hard`.
- Regression suite and Bun TypeScript build must pass before merging.

## Cika retraining candidate (not deployed)

- Non-destructive, additive Rudy scripts:
  - `tools/generate_general_assistant_corpus.rdy`
  - `train_senopati_general_assistant.rdy`
  - `tools/evaluate_senopati_general_candidate.rdy`
- Candidate corpus: 1,467 category examples, 456 urgency examples, 515 risk examples; candidate training artifacts isolated under `build/senopati_general_candidate/`.
- Initial candidate was trained for 8 epochs with Rudy. Independent held-out 21-example choice accuracy: **5/21 = 23.8%**. **FAILED** the minimum 80% gate and was **not promoted to production**.
- Native `.rmdl` to ONNX produced a 94-byte invalid output; it was removed. The legacy PyTorch ONNX exporter did not run under Rudy syntax and its incomplete `.rdy` port was removed. Production ONNX and vocab remain untouched.
- Candidate script now defaults to 60 epochs but supports `SENOPATI_GENERAL_EPOCHS` environment override. The evaluation script exits unsuccessfully if below the minimum threshold. Do not promote a candidate unless choice accuracy, safety false negatives, ONNX graph validity, label order, vocabulary parity, and live SuperAgent inference parity are all verified.

## Next validation prerequisites for native model promotion

1. Build an actual Rudy-compatible, valid ONNX exporter for the classifier heads and tokenizer contract (not a placeholder graph).
2. Improve independent held-out generalization to >= 80% and verify there are no destructive false negatives in the critical safety set; use a sufficiently broad frozen holdout sample.
3. Verify `choice_probs`, `score_probs`, `noul_probs` shapes, the seven label IDs, vocabulary, runtime inference, and per-class confusion matrix before an explicit versioned rollout.
4. Keep a rollback copy and compare candidate versus current production model on the same frozen evaluation corpus.

The model was deliberately **not** swapped; deployment quality gate has not been satisfied.
