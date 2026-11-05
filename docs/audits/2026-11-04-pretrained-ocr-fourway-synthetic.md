# Real four-way OCR inference, synthetic PDF scans

Date: 2026-11-04; samples: 12; no model training.

| Engine | CER | WER | page p50 (s) | p95 (s) | observed RSS (MiB) |
|---|---:|---:|---:|---:|---:|
| tiny | 0.00% | 0.00% | 0.484 | 0.510 | 111.65 |
| small | 0.15% | 2.08% | 0.711 | 0.751 | 140.96 |
| medium | 33.33% | 33.33% | 1.812 | 1.848 | 245.07 |
| tesseract | 3.12% | 8.14% | 0.259 | 0.295 | 35.20 |

## Scope and caveats
- All real pretrained OCR engines ran against actual PDF-rendered fixture images; no mock.
- RSS is sampled after initialization/pages, not guaranteed kernel peak. Results depend on this machine.
- Synthetic fixtures are NOT representative real ID/EN scans or independent human-gold.
- Confidence/bbox IoU, real documents, installed T-Line E2E and production MCP activation remain separate gates.
- No OCR model was trained, fine-tuned, quantized or distilled.
- Per-sample outputs, model hashes and timestamps are in the JSON companion.
