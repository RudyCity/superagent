# PDF advanced implementation & independent QA evidence — 2026-11-04

**Repo:** SuperAgent (branch feat/muse-file-transfer-20261104); T-Line (branch main)
**Release verdict:** SOURCE VALIDATED, PRODUCTION OWNER NOT ACTIVATED, extended real-PDF certification incomplete.
**Instructions:** Preserve existing Muse/tray changes; no worktree, no general staging, no restart/commit/push.

## Completed additions

1. Native PDF content stream operation with isolated Python pikepdf/pdfminer backend: src/core/pdf/pdfVector.ts and scripts/pdf_vector_backend.py. One exact ASCII text-show; excludes complex formats. Restricts source/output via realpaths and SHA-256. Replaces original Tj or deletes Tj and adds an opaque vector rectangle, not merely an overlay; always publishes a new PDF after independent text extraction and PDF revalidation. Test verifies visual pixel parity outside the replaced area and vector stroke counts. Not general-purpose arbitrary text editing.
2. Local PKCS#12 detached CMS signing: src/core/pdf/pdfSigning.ts. Uses @signpdf modules; password available only through host env SUPERAGENT_PDF_P12_PASSWORD; explicit approval; no signing existing signed PDFs. A separately installed OpenSSL executable cryptographically verifies the extracted signed message/ByteRange before publishing; tampered signature test fails. Certificate trust/CA/CRL/TSA/PAdES level NOT validated.
3. Added pdf_edit_vector_exact (write), pdf_sign (write), pdf_verify_signature (read) to the dynamic Agent registry, primary MCP registry/catalog, typed schemas, YOLO/OAuth/project grant checks, and workflow prompts; total 11 PDF tools. No bypass of existing security layers.
4. Extended T-Line PDF edit side panel to generate restricted vector text, vector redaction, signing, and signature validation requests routed through the existing Assistant session, with explicit irreversible-action checkboxes and no password textbox.
5. Real OCR evaluation: scripts/bench-pdf-ocr-real.py executes actual Tesseract on synthetic PDF raster fixtures rendered through SuperAgent's pdf-cli.ts renderer, with real output and per-sample SHA-256 in docs/audits/2026-11-04-pdf-ocr-real-benchmark-v2.json. 12 samples, deterministic seed 41020261104; measured CER 0.0119; WER 0.0365, eng model for ID/EN. NOT a natural-world or PaddleOCR benchmark.
6. Separate isolated Python venv under user's .superagent-r/venvs/pdf-advanced; pinned pikepdf==10.17.0 (MPL-2.0), pdfminer.six==20250506 (MIT). Did not install globally or distribute user font/certificate files.

## Test evidence

- SuperAgent bun run build: **PASS** (cmd_1793799303442_cxdi1).
- SuperAgent focused test batch: **106/106 PASS across 14 suites** (cmd_1793799303442_cxdi1), including independent OpenSSL signature checks, vector text & redaction, primary authenticated MCP gateway tool discovery/dispatch, OAuth/YOLO/project grants, and OCR fallback tests.
- T-Line targeted UI tests: **9/9 PASS**, frontend TypeScript check previously PASS (cmd_1793798983045_t4owt); rerun UI tests PASS (cmd_1793799349924_5328w).
- T-Line production frontend build: **PASS** (cmd_1793799349924_5328w); browser bundle build is not installed-native desktop E2E certification.
- Real OCR Tesseract benchmark: measured v2 summary CER 1.19%, WER 3.65%; ID CER 1.14%/WER 3.37%, EN CER 1.25%/WER 3.94% with eng model. Every prediction, hash and gold string stored separately in v2 JSON.
- Live @s1000 gateway status: new PDF tools may remain undiscoverable until authorized MCP owner reload. Source registration is not live deployment.

## Known limitations / release blocking

- Exact vector edit works only on a single unique printable ASCII Tj, Standard-14 font, simple unrotated noninteractive page without XObjects and other complex graphics. Does not support arbitrary line reflow, Unicode subset fonts, all scanned PDFs, variable font transformations or a general layout-preserving editor.
- Secure vector removal is scoped to the matched operator; cannot guarantee entire document has no leftover sensitive content in metadata, embedded objects or unselected page items. A high-stakes privacy review requires independent content scrubbing and artifact examination.
- PKCS#12 self-signed test certificates provide crypto correctness only. Production requires signer identity verification, CA trust and chain validation, revocation, trusted timestamps, eIDAS/qualified signature policy where applicable. Never claim qualified signatures with current verification.
- Real OCR benchmark uses 12 deterministic synthetic scans and only an English Tesseract pack; independent natural-document human-gold and Indonesian model/handwriting/low quality calibration still pending.
- Windows remote laptop tested; Linux, installed T-Line native application E2E, 100MB large file, protected/corrupt PDF compatibility and full repository test suite not yet certified.
- Nothing committed/pushed or restarted. Muse/tray changes remain intact.

## Next gates

1. Independent realistic PDF corpus covering embedded fonts, images, signatures, interactive form fields, unusual page geometry and PDF object streams. Enforce reject-on-unsupported.
2. Human-gold OCR benchmark with real ID and EN scans, plus actual fallback engine E2E and installed ind.traineddata.
3. Cert trust + timestamp validation with explicit operator trusted store, never from an agent-provided path.
4. Owner-authenticated deployment of MCP/T-Line after coordinating concurrent work; run live discovery and authorizations.
