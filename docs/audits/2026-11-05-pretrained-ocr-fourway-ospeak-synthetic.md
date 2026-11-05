# Real four-way OCR inference, synthetic PDF scans

Date: 2026-11-05; samples: 12; no model training.

| Engine | CER | WER | page p50 (s) | p95 (s) | observed RSS (MiB) |
|---|---:|---:|---:|---:|---:|
| tiny | 0.00% | 0.00% | 0.531 | 0.582 | 360.31 |
| small | 0.15% | 2.08% | 0.762 | 0.776 | 486.93 |
| medium | 33.33% | 33.33% | 2.141 | 2.397 | 867.03 |
| tesseract | 3.12% | 8.14% | 0.288 | 0.351 | 103.19 |

## Scope and caveats
- All real pretrained OCR engines ran against actual PDF-rendered fixture images; no mock.
- Peak RSS is sampled independently every ~10ms across worker+child processes using psutil; not an OS kernel high-water mark. Results depend on this machine.
- Synthetic fixtures are NOT representative real ID/EN scans or independent human-gold.
- Confidence/bbox IoU, real documents, installed T-Line E2E and production MCP activation remain separate gates.
- No OCR model was trained, fine-tuned, quantized or distilled.
- Per-sample outputs, model hashes and timestamps are in the JSON companion.
