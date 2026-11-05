# MASTER PLAN — SuperAgent PDF Full Completion, Security Certification & Production Activation
Date: 2026-11-04
Status: PLANNED / READY FOR EXECUTION; production feature NOT DONE
Primary repository: superagent (currently branch main; no new branches/worktrees)
Desktop repository: t-line (currently main)
Execution policy: Do not commit/push/restart/replace live MCP/Core/OAuth/desktop owners without separate authorization and owner-level preflight. Preserve unrelated Muse/tray changes. This plan changes documentation only.

## 0. Executive decision and precise completion contract

Objective: ship a secure, usable PDF editor integrated into the existing SuperAgent Agent, dynamic tools, primary authenticated MCP, CLI and T-Line desktop. Finish source-level functionality, independent validation and a production E2E release gate. Avoid promises of mathematically lossless editing for every arbitrarily constructed PDF. Report supported formats, unsupported cases and verification evidence.

"Complete" has THREE independent checkboxes:
- F — FUNCTIONALLY COMPLETE: all agreed operations pass the frozen supported-PDF matrix; unsupported input fails closed and explains why, without claiming that an overlay is original text editing.
- S — SECURITY & QUALITY VERIFIED: redaction, signatures, OCR, permissions, fidelity, resilience and licensing are independently tested against frozen fixtures with independent validators and human review.
- P — PRODUCTION ACTIVATED: verified live primary @s1000 tool discovery, schemas and real call dispatch; authorized live owner/version rollout; T-Line installed GUI flow; rollback and audit evidence. No second persistent owner.
Overall DONE = F AND S AND P AND release checklist signed off, with all P0/P1 issues closed. A successful source build alone is NEVER DONE.

Support tiers:
- T0: Structural PDF transforms, rendering, forms and selectable text. This is an existing functional baseline; certify across matrix.
- T1: Original-content edit without layout regression where semantically provable (simple Tj, then Type0/subset/CMap and fragmented TJ with validated glyph geometry); unsupported complex/ambiguous cases return explicit refusal.
- T2: Secure content removal across supported text, vector, image, annotations and metadata. Never label mere black overlay as secure redaction.
- T3: Digital signatures: initially authenticated local CMS signing + validation; production profile requires chain, revocation and trusted timestamp with clear PAdES level, or a documented lower-profile release.
- T4: Real scanned-document OCR with frozen independent human gold and **off-the-shelf pretrained** language-aware engines (Tesseract/PaddleOCR); improve current mock-fallback tests into authentic full-pipeline tests. **No OCR model training, fine-tuning, distillation or custom weights are in scope.**

Do not make "100% of all PDFs" an acceptance criterion. Instead publish a support matrix and demand 100% PASS of *eligible* frozen acceptance cases with zero silent corruption/false-success. Unsupported cases must fail closed and are measured separately rather than counted as feature support.

## 1. Baseline and evidence inventory (READ-ONLY audit)

Observed on 2026-11-04 (not a new production certification):
- 12 PDF tools registered in the source: pdf_inspect, pdf_extract, pdf_ocr, pdf_ocr_searchable, pdf_render, pdf_edit, pdf_split, pdf_redact_raster, pdf_verify, pdf_edit_vector_exact, pdf_sign, pdf_verify_signature. MCP names are prefixed superagent_. Dynamic discovery implementation exists, but live activation is separate.
- Existing engines: src/core/pdf/pdfEngine.ts, pdfVector.ts, pdfSigning.ts; optional scripts/pdf_vector_backend.py using pikepdf/pdfminer, pdf-lib/fontkit, OpenSSL/@signpdf; T-Line PDF side panel and Assistant handoff.
- Current vector edit supports one unique ASCII Standard-14 Tj; not arbitrary existing-text replacement/layout-preserving reflow.
- Current vector redaction removes a mapped Tj and paints a vector rectangle, but cannot certify all sensitive strings across objects, previous revisions, attachments or metadata.
- Current signature validation checks detached CMS integrity with OpenSSL -noverify; it does NOT validate certificate trust, revocation or authoritative time. Do not say "trusted signature".
- Actual Tesseract OCR benchmark produced mean CER 1.19%, WER 3.65% on 12 synthetic scan PDFs with eng model only; this does NOT measure independent natural scans nor Indonesian traineddata.
- Last focused tests reported: 106/106 SuperAgent tests in 14 suites PASS and 9/9 T-Line UI tests PASS; Core and frontend builds PASS. No complete repository test, installed native desktop E2E or production rollout claimed.
- LIVE @s1000 gateway check on 2026-11-04: tool_search("pdf") returned generic document tools only, NOT the 11 PDF tools. This is a verified deployment gap.
- Git safety: superagent branch main was ahead of origin/main by 3, behind by 1 at preflight; extensive unrelated modified/untracked Muse, tray and MCP files remain. Never auto-reset, checkout, stash, format, stage all or create a worktree. Prior implementation and plan files were untracked; preserve byte-for-byte.
- Existing references: docs/plans/2026-11-04-superagent-pdf-editing-toolset-master-plan.md; docs/audits/2026-11-04-pdf-advanced-signatures-vector-ocr.md; docs/guides/pdf-advanced.md; docs/audits/2026-11-04-pdf-ocr-real-benchmark-v2.json; t-line/docs/guides/pdf-editing-assistant-handoff.md.

Required M0 snapshot:
1. New preflight report: git status --short --branch, owner PID identity and active process birth, tool catalog, docs/code checksums, installed native desktop build identity, registered project permissions. Record before touching runtime.
2. Map all code/doc owners: PDF-specific files owned by the PDF workstream; main MCP registration and T-Line App/Console are shared with Muse/tray -> diff-first, minimal patch, test, no overwrite.
3. Pin dependency versions, licenses, platform versions and Python isolated venv, Tesseract traineddata SHA-256, OpenSSL executable version/signature and the renderer revision. Never mutate global Python.
4. Re-run the prior 106 and 9 focused tests, plus full-test baseline; record failures as pre-existing/new, not silently ignore them.
5. Freeze numbered Acceptance Contract v1.0 and fixture manifest before optimizing. Evidence must have source commits/hash, inputs, settings, commands, environment and test output.

M0 exit gate: baseline and risks reproducible, no unrelated file damaged, signed-off acceptance matrix. P0.

## 2. Target capability matrix and refusal behavior

Class A — native selectable-text PDF:
  A1 Standard-14 single Tj lines; A2 fragmented TJ/spacing; A3 embedded/subset Type0 CID fonts; A4 rotated pages & cropbox; A5 multiple text boxes/lines; A6 vector shapes/images overlapping text; A7 tagged PDF with links/bookmarks/annotations; A8 forms AcroForm/XFA; A9 encrypted/password-protected PDF; A10 incremental update + existing signatures.
Class B — scanned PDF:
  B1 300 DPI clean ID; B2 300 DPI clean EN; B3 150–200 DPI; B4 skew/noise/blur; B5 tables/forms; B6 multi-column, mixed language; B7 handwriting; B8 no text layer; B9 incorrect/incomplete pre-existing OCR layer.
Class C — adversarial:
  C1 invalid xref/object streams; C2 huge compressed/decompression bombs; C3 nested XObjects/pattern/OCG; C4 embedded files/JavaScript/actions; C5 attachment metadata/multiple revisions; C6 invalid signatures/ByteRange and malformed PKCS#12; C7 path traversal, symlinks and concurrency races; C8 font path/TTF payload abuse.
For each case: specify supported/unsupported operation and reason, expected exact error code, minimum independent verification, performance ceiling and affected file operations. Unsupported is a valid *safe refusal*, not a pass toward supported text-edit coverage.

Target modules / API surface (subject to design review):
- src/core/pdf/pdfCapabilityScanner.ts: PDF feature inventory, font/CMap/XObject/text-operator map, pages/rotation/crop, signatures, embedded objects, attachment actions and encryption.
- src/core/pdf/pdfLayoutMap.ts: glyphs/spans/line regions plus page-space transforms and reverse mapping; immutable source references.
- src/core/pdf/pdfEditPlanner.ts: preflight, dry-run, preview, edit decision with verified backend and expected source hash.
- src/core/pdf/pdfTextRewrite.ts: text content stream writer and geometry integrity; no arbitrary shell commands or guessing.
- src/core/pdf/pdfRedactionEngine.ts: text/vector/image/attachment/metadata removal pipeline and explicit policy.
- src/core/pdf/pdfSignaturePolicy.ts and pdfSignatureValidator.ts: PKI, PAdES profile and trust/revocation status.
- src/core/pdf/pdfOcrPipeline.ts and pdfOcrBenchmark.ts: deterministic raster/text layer/origin/quality.
- src/core/pdf/pdfCompare.ts: text, page, annotation, fonts, raster diffs, sensitive-data absence, signature reports.
- src/core/pdf/pdfEngine.ts and pdfTools.ts remain compatibility facade; keep 11 existing tool names stable, add new ones only after migration/testing. Avoid hardcoded agent intent/answer.
- docs/audits/pdf-full-completion/* and tests/fixtures/pdf/* for evidence.

Cross-cutting API response contract:
  status: verified | partial | unsupported | failed
  operation, backend, backendVersion, supportedFeatures, refusedReasons
  inputSha256, outputSha256, outputPath, pageCountBefore/After
  layoutVerification { renderer, compareScope, pixelDiff, bboxDiff, textSemanticDelta }
  redactionVerification { scopedTargets, residualRisk, independentChecks }
  signatureValidation { cryptoIntegrity, chain, revocation, time, PAdESLevel }
  ocrQuality { language, engine, modelHash, confidence, pageBBoxes }
  security/audit correlationId (never raw PDF/text/key/PII in logs)
  Explicit non-overwrite output and idempotency; no fabricated verification.

## 3. Ordered milestones and non-negotiable exit gates

### M0 — Governance, dependency/license review and reproducible acceptance corpus (P0)
Scope: preflight as above; record current Git state/owner state; define independent fixtures with licensing and consent; reserve module ownership.
Deliverables: baseline matrix, hazard log, environment lockfile, signed fixture manifest (SHA-256), architecture decision record, feature exclusions.
Tests: existing regression read-only; Git collision audit; tool catalog snapshot; license scan.
PASS if corpus/protocol is sealed and fixture ownership is documented; not if merely a markdown checklist exists.
Dependencies: none.

### M1 — PDF parser/glyph geometry and transaction foundation (P0)
Implement feature scanning (PDF 1.4–2.0), object streams and incremental revisions detection, text operator graph and glyph-level/font-aware mappings; page matrices; stream object reachability; signed/encrypted flags.
Atomic writer: source hash, exclusive destination lock, stage to private temp, fsync where supported, verify before publish, backup-free non-overwrite, source unmodified, cancellation and rollback.
Safety: reject unsupported xref, encrypted without authorized password, malicious file/sandbox escape, fake signature before editing.
PASS: independent PDF parser confirms objects/coordinates; 100% zero source mutation and no corrupted/partial output over forced failure/race/interruption suite. Windows and Linux matrix. P0.

### M2 — True existing text replacement with layout preservation (P0/P1)
Implement in increments:
M2-A: harden exact Tj path with font subset introspection, robust source/target identity, duplicate target selection by page/glyph bbox, escaped binary/hex strings, explicit unicode/cmap conditions. Strict fail-closed.
M2-B: TJ arrays, character/word spacing, kerning, transforms, text clipping, nested q/Q and Form XObjects; resolve original glyph runs and rewrite target operator(s) without changing unrelated content; maintain link/annotation positions.
M2-C: Unicode including Bahasa Indonesia, punctuation, accents, CJK/RTL where supported by explicit fonts; font embed/subset/shaping; conflict-resolution for changed widths. If replacement exceeds fitted bbox, offer preview+reflow within bounded region requiring explicit approval or refuse.
M2-D: optional validated region-reflow engine for multi-line paragraphs, with no movement outside authorized edit region; preserve page size/rotation/crop, nontext vectors, annotations, bookmarks, accessibility/tagging where supported. Track tagging impact; reject rather than silently break PDF/UA.
M2-E: independent renderer check PDF.js + second renderer (e.g. PDFium or MuPDF after license review); pixel compare masks only inside approved diff region; evaluate text extraction and original operators' absence.
Proposed layout gates:
- Pixels OUTSIDE authorized region unchanged to exact deterministic raster compare where same renderer and scale (allow anti-alias tolerance explicitly fixed for cross-renderer only); no unexpected page geometry, font resource or annotation changes.
- Position baseline/bbox drift within agreed tolerance (initial <= 0.5 pt for eligible exact-edit samples); replacement text appears exactly once and source text absent, other page text preserved.
- Measured line overflow = 0 for eligible bounded replacements; no clipping/overlapping neighboring elements. 100% eligible fixture set PASS; unsupported returns precise reason.
- Review 20+ real complex PDF examples, plus 50+ synthetic layout cases across A1–A10, with annotated expected edits.
Do NOT claim "lossless for all PDFs" even after PASS. P0 for eligible type support, P1 for complex breadth. Dependencies M0/M1.

### M3 — Real vector/raster redaction + sanitization (SECURITY P0)
Separate modes: redact text glyph region, redact vector graphics (paths, patterns, clipping), redact partial image pixels/XObjects (including reused XObjects), redact annotations/comments/attachments, metadata, hidden layers, form values, OCR hidden text and incremental history. Default removes all related source objects and writes a NEW normalized PDF with no recoverable previous revision; black rectangle alone = never accepted.
Policy contract: all visible occurrences or page-specific targets, cover preview with coordinate transforms, user explicit approve, per-object reachable graph, scrub declared metadata/embedded content fields; avoid removing unrelated content silently; sanitize embedded scripts/actions.
Complex cases: shared XObject referenced on multiple pages; clip/pattern; transparency; text as paths; nested forms; optional layers; invisible OCR; incremental revisions; attached originals; accessible/tagged text; mixed vector/raster pages.
Verification: independent parsers and content scanners, decompress/reachability checks on ALL saved objects, metadata/embedded-file inspection, OCR on before/after previews, dual-renderer visual check, file carving and deliberate recovery tests. Positive controls deliberately hide sensitive content in each object type.
Release gate: 0 recoverable target content in all approved redaction fixtures using independent forensic checks; 0 falsely certified redactions, untouched regions preserve content where policy requires. Any unsupported document must return UNSUPPORTED, with opt-in image-only full raster fallback only after warning.
Owner: PDF security workstream; independent adversarial reviewer must sign evidence. P0. Dependencies M1/M2.

### M4 — PKCS#12, PDF signing, PAdES and independent validation (P0/P1)
Keep existing CMS/ByteRange integrity validator and do NOT overstate certificateTrust. Implement managed trust policy:
  * Multiple signatures and signed/revisioned PDFs; signed byte ranges and incremental append-only update semantics; DocMDP/FieldMDP permissions; reject edits that break existing signatures.
  * Verified signer certificate chain against operator-managed trust anchors, expiry, EKU, key usage and algorithm constraints. No trust anchor injected through untrusted PDF/prompt.
  * CRL + OCSP freshness and offline policy (indeterminate when unavailable; never auto-mark trusted). Allow network only after explicit policy approval; secure SSRF boundaries, bounded requests, caching and no secret leakage.
  * RFC 3161 trusted timestamp validation (TSA chain/response and digest/time). Preserve evidence for replayable report.
  * PAdES baseline strategy: implement/certify B-B first; B-T once trusted time validation works; B-LT with DSS/VRI validation material; B-LTA only after archive timestamp/renewal and independent validator. Do not label a level complete until corresponding fixture + independent validation passes.
  * Certificate/key custody: forbid raw P12/password in prompt, tool output and logs, use OS keystore/HSM/PKCS#11 adapter only if approved, harden file permissions, avoid accidental commit of key, require per-document signing confirmation.
  * GUI can display signature appearance, but an image/stamp alone is NEVER a cryptographic signature.
  * Prefer verifiers not sharing the same implementation (e.g. EU DSS / Adobe Acrobat or other formally selected validator) after legal/OSS license review.
Gates: at least trusted, expired, revoked, untrusted, self-signed, wrong-EKU, wrong-chain, timestamp mismatch, edited-after-sign, multiple signatures, invalid ByteRange, unknown revocation fixtures all yield appropriate valid/invalid/indeterminate state; no false "trusted." Independent PAdES profile checks are mandatory.
P0: trusted CMS + chain/revocation/indeterminate; P1: PAdES B-T/B-LT; B-LTA conditional on actual business need, not fake-done. Dependencies M0/M1.

### M5 — Pretrained-only real OCR production benchmarking + searchable PDF creation (P0/P1)
**Firm product decision (2026-11-04): use existing pretrained OCR models only; do not train, fine-tune, distill or publish a custom OCR model.** Compare four complete local OCR pipelines on the SAME frozen evaluation PDFs: (1) Tesseract 5.x with official eng+ind tessdata; (2) PP-OCRv6 tiny detection+recognition; (3) PP-OCRv6 small detection+recognition; (4) PP-OCRv6 medium detection+recognition. An OCR pipeline must have BOTH detector and recognizer and include preprocessing/dependencies in RAM and latency measurements. No new proprietary service or external upload. PP-OCRv6 small is the **provisional default candidate**, tiny the low-resource candidate, medium the quality candidate, and Tesseract the independent control/fallback. This is a plan, NOT a measured default or deployed feature. Any new model version needs an explicit license/hash/quality review, never training.
Prepare independent, consented *evaluation-only* human-gold set (minimum 200 real printed pages: >=100 ID, >=100 EN; stratify clean, 150–200 DPI, skew/blur, forms/tables, multi-column/mixed font; separate handwriting track). Split by source document and template family; frozen hash manifest. **None of these documents may be used to train or fine-tune OCR.** Two human annotators for at least 20% subset; adjudicate disagreements; avoid logging PII.
Install and SHA-pin official pretrained ind.traineddata and eng.traineddata plus exactly pinned PP-OCRv6_tiny_det/rec, PP-OCRv6_small_det/rec and PP-OCRv6_medium_det/rec model artifacts and actual detector/recognizer dictionaries. Start with RapidOCR's supported ONNX Runtime route in an isolated local Python environment; benchmark optional OpenVINO separately on supported hardware, and retain a direct PaddleOCR integration as compatibility oracle only where required. Official docs confirm PP-OCRv6 small/medium cover 50 languages and tiny 49 (no Japanese); verify the exact Indonesian/English route and glyph dictionary with inference tests, NOT just metadata. Obtain artifact download URLs/weights from official or documented trusted model registries, confirm license and SHA-256, pin rapidocr/onnxruntime/PaddleOCR versions, and never silently download models during a user request. Do not depend on commercial cloud OCR or API keys by default.

**Model selection and resource policy (planned; measure before rollout):**
- Digital PDF with an adequate existing selectable text layer: do not invoke neural OCR by default. If the text layer is corrupt/incomplete, mark it and request an explicit local OCR pass.
- Scan/photograph: run preprocessing once, then PP-OCRv6 small detection+recognition on normal devices, or tiny when measured peak RAM/latency indicates resource pressure. Medium may be invoked on difficult pages only if memory/time budget permits and measured holdout shows an accuracy benefit.
- Tesseract eng+ind is the independently measured control; retain it as a safe alternative when PP-OCR is unavailable. A model error is not an empty-text success. Use configured, documented engine fallback and record which engine processed EACH page.
- Do not route solely on uncalibrated OCR confidence. Compare confidence calibration per engine before introducing quality-based fallback; a low-quality PDF may require human verification.
- Resource tiers to measure (not assumed hardware measurements): 4 vCPU/8 GB RAM CPU-only, 16 GB RAM CPU-only, and optional accelerated desktop. Measure peak process RSS/private bytes, model-load cold start, warm page latency p50/p95, throughput pages/minute, CPU utilization and total installed footprint (including runtime and fonts).
- Model weights are NOT process RAM: published approximate detector+recognizer file sizes (tiny ~6.3 MB, small ~30 MB, medium ~133 MB) are only discovery estimates to be independently validated against downloaded artifacts; no RAM/capacity claim from these figures.
- Engine integration must use explicit model tier, detector+recognizer, language route, version and SHA; do not rely on package defaults that may select a different size.

**Benchmark protocol — same inputs for all four candidates:**
1. Freeze two nonoverlapping datasets: calibration/dev PDFs for routing/preprocessing decisions, and >=200 independently annotated real ID/EN scan pages for locked holdout; no fine-tuning or training from either.
2. For each engine, use identical source PDF bytes and DPI/render/deskew/normalization rules where applicable. Record engine-specific preprocessing as a controlled intervention rather than comparing different undisclosed input quality.
3. Measure per-document/page CER, WER, detection precision/recall/F1, bbox IoU, reading-order accuracy, numerals/tables, language confusion, timeout/error count, p50/p95 wall-clock latency, peak RSS, cold/warm launch and CPU usage; stratify clean vs blur/skew/low-DPI/complex forms and report worst decile.
4. Benchmark with repeated warm runs plus cold-start runs; bound worker concurrency and memory; log artifact SHA-256, renderer version, OS/CPU/RAM, model pair/weights, runtime versions and deterministic settings. No raw private document data in logs.
5. Choose a default by **eligible ID/EN accuracy gates first**, then resource and latency/P95; choose a fallback only if its failure modes are validated and clearly reported. Small is merely the initial candidate. Tiny/Medium selection must be justified by actual device benchmark.
6. Never inflate results by mixing official PP-OCRv6 recognition accuracy with SuperAgent end-to-end PDF CER/WER; these metrics and datasets differ.

**Implementation work packages (M5-A to M5-F):** A model/artifact provenance+license; B isolated RapidOCR/ONNX setup with explicit v6 tiers; C end-to-end real `pdf_ocr` adapter and model availability detection; D fairness-locked CPU/RAM benchmark; E read-order/bbox/searchable PDF; F independently signed release decision with fallback and reproducibility evidence. No training/fine-tuning scope.
Run genuine full pipeline: scanned PDF -> detect selectable layer -> render -> preprocessing/deskew/denoise -> OCR -> word/char bbox + confidence -> layout-order recovery -> optional searchable PDF copy -> extract -> quality verification, all with true engine invocations and no mocked backend. Pin OCR parameters, language, DPI and per-page output/hashes. Validate word reading order, punctuation, numeric IDs and table cells; compare false-positive/false-negative content.
Proposed (tunable BEFORE unsealing holdout) target gates on held-out printed scan subset:
- Clean >=300 DPI ID+EN: CER <= 2% and WER <= 5% per language.
- Challenging low-DPI/blur stratum: CER <= 8% and WER <= 20%; always report per-condition distribution, worst decile, confidence calibration.
- Bbox localization: median text IoU >= 0.8 where ground truth supports geometry; reading-order accuracy explicitly measured.
- All 200 pages actually run through EACH eligible candidate engine in the common comparison; no fallback silently claims OCR, 0 network document uploads during inference, searchable PDF text alignment verified.
- Before approving a default, publish all four engines' CER/WER, per-language and per-condition breakdowns, p50/p95 latency, startup time and peak RSS on each documented hardware tier. Set resource/latency acceptance budgets before unsealing holdout, after dev baselines. Reject a default that exceeds the target device budget even if its model file is small.
Use 12-synthetic benchmark only as engineering smoke baseline; it is NOT this release gate. Failure to hit thresholds => improve deterministic image preprocessing, page segmentation, reading-order recovery, supported pretrained model selection, inference parameters and language routing using development/validation samples only; then rerun untouched sealed holdout. **Never respond by training or fine-tuning a custom OCR model.** P0 for real ID/EN; P1 for handwriting / complex tables. Dependencies M1.

### M6 — Integrated T-Line native PDF editor UX (P1)
In existing FileViewerTab, no new desktop/tray app or duplicate Core backend:
- Page navigator/thumbnails, zoom/pan, page rotation/crop-aware coordinates, PDF crop selection and sensitive selection with bounding-box preview.
- Before/after side-by-side + diff overlay, exact text origin/font preview, live capability detection showing supported/unsupported reason, output path and source hash; 1-based page parity.
- Human confirmation stages: inspect -> preview -> review changes -> confirm destructive operation/signing -> execute -> independent verify -> open signed/edited result.
- Undo/redo of uncommitted operations (not silent destructive changes), crash recoverable draft, progress/cancellation/retry without duplicate writes, keyboard + screen-reader support, render on large docs with bounded memory.
- Distinct labels: "Overlay text" vs "Replace original text"; "Visual cover" vs "Secure redaction"; "Draw signature" vs "Cryptographic sign".
- Preserve current Assistant session/workspace, no hidden reload, no cross-project file handoff, no auto-approve. Use dynamic tool descriptions/capability scan, not hardcoded intent.
Tests: component/unit 50+, screenshot visual regression across light/dark/DPI, OS-window lifecycle, installed native Tauri end-to-end on Windows and Linux where supported; accessibility and file-lock conflict tests.
Gate: installed T-Line user can open local PDF -> inspect -> preview -> edit/redact/sign with explicit approval -> verify -> reopen output, with tool logs and exact hash evidence. P1. Dependencies M1–M5.

### M7 — Engine packaging, licenses and repeatability (P0)
- Document license matrix and redistributability for pdf-lib, @pdf-lib/fontkit, pikepdf/MPL-2.0, pdfminer/MIT, @signpdf, OpenSSL, PDF renderer, Tesseract/traineddata, RapidOCR, ONNX Runtime and PP-OCRv6 weight artifacts/dictionaries; independent counsel review if distribution demands.
- Package optional Python backend into installation-managed immutable venv/private runtime with exact wheels and hashes for Win/Linux, no global Python mutation; verify Bun/TS module import compatibility.
- Pin binary paths and integrity; no arbitrary environment pointer passed from user documents; no shell interpolation; strict resource caps and isolated child processes; reject when unavailable.
- Preserve deterministic PDF metadata and stabilize OCR benchmark fonts, source hashes and render settings; CI with dependency/SBOM/security scan.
- Offline/slow storage performance: memory budget, max pages, file cap, timeouts, no infinite OCR, graceful cancellation and rollback; benchmark modest 10/100/500 page PDFs, 10/50/100 MiB file classes with explicit hardware declaration.
Gate: clean install on Windows and Linux; auto-feature capability detection, no undeclared external runtime dependencies, all 11 tools discoverable on newly installed clean test instance, licenses/third-party notices complete. P0. Dependencies M1–M5.

### M8 — Primary MCP dynamic tools, OAuth, YOLO and authenticated owner deployment (P0)
Current live gap confirmed: tool_search("pdf") returns only generic document tools, NOT the 11 new names.
Tasks:
1. Before attempting reload, diff existing owner files against concurrently modified Muse/tray files, inspect runtime status/ownership using authenticated lifecycle service and current manifest. Never start a duplicate persistent MCP.
2. Validate the 11 PDF tool schemas in MCP catalog, type classification (read vs dangerous), tool list/search/describe, gateway dispatch, per-call OAuth scopes, YOLO OFF/Scoped/FULL, project read/write grant, provider local-only boundary, path/symlink/hardlink and concurrent access.
3. In temporary owner-authenticated staging profile with isolated loopback endpoint, run actual MCP client handshake, tool list/search/describe/execute, read-only denial, scope revocation, cross-project escape denial, exact text, redaction and signature E2E.
4. Operator-approved maintenance: drain active connections/jobs, capture process birth identity, authenticated owner-level restart/reload of MCP only; do not restart Core automatically, migrate OAuth/session IDs or replay old writes; verify new owner identity and build manifest.
5. Reconnect primary client; verify full live 11-tool catalog and genuine file outputs & SHA-256. Roll back to previous known-good build/owner on failure, with fresh sessions and no writing from stale token.
Gate: all 11 PDF tools appear live and correct tools execute safely with explicit permissions; no phantom tool schema, no blanket privilege increase, Muse/tray unaffected; owner identity verified. P0. Dependencies M0/M1/M3/M4/M5/M7.

### M9 — Security, compatibility, fuzzing, performance and independent audit (P0)
Minimum compatible corpus of >=100 diverse PDFs plus >=200 real scanned pages in M5. Fuzz malformed xref/streams/glyph encoding/images/signatures and parser memory; adversarial PDFs contain actions, damaged streams, embedded files, escape attempts and retrieval of redacted content from revisions. Use two independent parsers and two renderers for release checks.
Required protections: no use-after-free/uncaught crash, no source overwrite, no output partial/corruption, no writes outside authorized workspace, no credential/key/document text leakage into logs, no unapproved network connections, consistent OAuth/YOLO denial and open-source license compliance.
CI matrix: Windows and Linux, Bun/Node versions, Python versions, approved OpenSSL/Tesseract combinations. CI tests for workspace symlink and protected path; backup integrity; large file/memory/timeout; constrained process kill cancellation; concurrent edits, retries, duplicate requests; deterministic recovery.
Use threat model with risks: prompt-injection within PDFs, decompression bombs, remote font injection, password/certificate theft, signature wrapping, cross-store read/writes, redaction remnants and OCR hallucination.
Gate: zero open critical/high security issues; independent reviewer signs the evidence ledger; full repository regression pass or formally audited pre-existing unrelated failures; no ignored flakes. P0. Dependencies M1–M8.

### M10 — Release readiness, documentation and support (P1)
Update README, CLI --help, prompt/tool descriptions, T-Line help and contextual warnings; user/admin docs in Indonesian and English, matrix and explicit feature refusals. Versioned release notes and migration (11 tool names stable); installation/troubleshooting/rollback runbook; key provisioning guidance without storing passwords; privacy retention and offline execution policy.
Artifact packaging: reproducible Core/desktop binaries with SHA-256/SBOM, licensing notices, signed releases when enabled, audit from staging and production acceptance. Git commit/push ONLY on explicit authorization, stage exact PDF-owned files, review shared changes and reconcile main divergence rather than force push.
Gate: reproducible clean install, signed-off demos for representative ID/EN PDFs, documentation reflects real implementation, no "100%" claim without closure. P1. Dependencies M6–M9.

### M11 — Final independent sign-off (RELEASE GATE)
Required sign-offs: PDF engine reviewer, security/redaction reviewer, OCR human-gold/eval reviewer, signing/trust reviewer, runtime owner, T-Line QA, release owner.
Decision matrix:
- PASS: every required acceptance row has reproducible evidence links, tested version/hash and independent reviewer; no high/critical unresolved; live discovery/execution passes; user-visible original edited outputs verified; rollback proven.
- PARTIAL: a subset works but any required facet is missing or only tested synthetically.
- BLOCKED: runtime owner cannot be authorized, private trust store absent, signed/encrypted doc unsupported where required, real human-gold unavailable, trust/revocation check cannot be certified, or security vulnerability open.
- NEVER use DONE merely because unit tests passed or a user requested a finish flag.

## 4. Dependency graph and execution batches

Batch A (must start first): M0 -> M1 -> data/fixture freeze and architecture.
Batch B (parallel after M1, disjoint file owners): M2 text layout engine; M3 redaction security; M4 signatures and PKI; M5 pretrained-only OCR integration and benchmark (no training).
Batch C: M7 packaging and security hardening alongside M2–M5, then M6 T-Line UI.
Batch D (after safe source stabilization): M8 authenticated live MCP activation, then M9 compatibility/security independent audit.
Batch E: M10 docs/build/release -> M11 sign-off.
No reliance on worktrees: use file ownership, small patches, shared-target lock/coordination, and tests in temporary isolated, self-owned process profiles. Do not create branches/worktrees without instruction.

Per milestone delivery template:
  owner / explicit scope / acceptance fixture IDs / tests / expected evidence /
  source hash / environment / permission & rollback / exact changed files /
  status PENDING | IN_PROGRESS | PASS | FAIL | BLOCKED / reviewer.
No silently relaxing thresholds or replacing a failed validation with fabricated warnings.

## 5. Initial execution ledger (this document does NOT implement the work)

| ID | Workstream | Initial status | Verified baseline / unresolved |
| --- | --- | --- | --- |
| G0 | Freeze matrix, owners, reproducibility | PENDING | Existing code and tests known; no complete frozen compatibility matrix |
| G1 | Parsing, secure staging and coordinates | PARTIAL | Existing engine and exact edit; no full object/glyph maps or Linux certification |
| G2 | Layout-preserving original text editing | PARTIAL | Single ASCII Standard-14 Tj only; wider PDF support missing |
| G3 | Vector redaction & all-object sanitization | PARTIAL | Single exact Tj + raster fallback; all-object recovery tests missing |
| G4 | Trusted digital signatures/PAdES | PARTIAL | CMS crypto valid; chain/revocation/TSA/PAdES unverified |
| G5 | Genuine OCR accuracy certification | PARTIAL | 12 synthetic Tesseract smoke samples; real human-gold/ind pack missing |
| G6 | T-Line native editor and installed E2E | PARTIAL | Side panel source builds and targeted UI tests; installed end-to-end untested |
| G7 | Cross-platform packaging and supply chain | PENDING | Local isolated Windows venv present; distributed installs/CI missing |
| G8 | Live primary MCP discovery/owner activation | BLOCKED | Live tool search lacks 11 tools; owner coordination and restart not done |
| G9 | Adversarial compatibility/security & complete regression | PENDING | 106 focused tests previously pass, not independent full suite/fuzz |
| G10 | Release docs and authorized installation | PENDING | Partial guides; no production install/rollback evidence |
| G11 | Independent sign-off | PENDING | Release cannot be declared DONE |

## 6. Exactly what QA must save

Audit root: docs/audits/pdf-full-completion/<execution-id>/ (new files only, never overwrite older audits)
Required artifacts:
- BASELINE.md (Git state/current source hash, owner identity, dependency/license manifests)
- SUPPORT_MATRIX.csv (class/operation/support/refusal code/fixture/reviewer)
- FIXTURE_MANIFEST.json (hash, source provenance, consent/license, language/DPI/complexity)
- TEXT_LAYOUT_REPORT.json and raster diff PNGs with allowed-edit masks (no private PDF publication)
- REDACTION_FORENSICS.json (extraction, object scan, metadata, attachments, image, old revision checks)
- SIGNATURE_VALIDATION.json (ByteRange, CMS, trust path, OCSP/CRL, TSA, PAdES, third-party verifier)
- OCR_HUMAN_GOLD_REPORT.json (per-page CER/WER/IoU, engine/model hash, no leakage)
- MCP_AUTH_OWNER_E2E.json (new owner PID/birth identity, granted scopes, denial matrix, dynamic discovery and execute evidence)
- TLINE_NATIVE_E2E.md with screenshots of preview/confirmation/result
- SECURITY_REVIEW.md and RELEASE_GO_NO_GO.md (remaining risk, rollback and independent signatures)
Keep raw private user documents and signing secrets OUT of repository artifacts; reference authorized private test storage by hash only.

## 7. Threat model / critical explicit rules

S1. Data from PDF is UNTRUSTED: no document text changes tool policy, agent prompt, filesystem scope or signing permissions.
S2. No direct second MCP/desktop owner for testing; no hidden automatic YOLO/scope elevation, no cross-project writes.
S3. No existing signature modification that silently invalidates it. All revision handling must be verified and independently checked.
S4. No visually covered-only secure redaction, no old incremental revision remnants, no hidden OCR/metadata leakage.
S5. No certificate password in tool arguments, logs, responses, settings synced to cloud or Git; private key never transferred to an agent.
S6. Offline OCR is default; optional external trust/revocation network only with explicit allowlist and network policy.
S7. No AGPL or incompatible commercial SDK silently added. Record dependencies + redistributability; any proprietary engine requires explicit license decision.
S8. No PDF source overwrite, path escapes, symlink race, unbounded decompression, infinite OCR or uncontrolled child processes.
S9. Never claim PDF/UA, PDF/A or PAdES conformance without a corresponding independent conformance audit.
S10. Before P0 destructives, require explicit user operation approval, source SHA-256 match, preview and post-operation verification.

## 8. Quality targets, triage and stop conditions

Hard P0 gates: unauthorized writes = 0; redaction false-certification = 0; signed byte-range tampering undetected = 0; published malformed PDFs = 0; original source changes = 0; leaked PII/signing secrets = 0; full eligible fixture pass; live deployment and rollback verified.
Quality targets must be frozen before observing holdout. Document acceptable antialias/pixel-diff thresholds and confidence requirements separately; do not tune evaluation after failures.
If a genuine supported PDF fails, log as FAIL with reproducible sanitized fixture; do not narrow support silently or relax thresholds. If the PDF is outside the already declared matrix, return UNSUPPORTED with exact reason and safe alternative.
Release rollback triggers: PDF output corruption, auth bypass, any false secure redaction/trust outcome, existing Muse/tray owner regression, unapproved document network export, signature invalidation, or user document loss.

## 9. Prioritized immediate next action queue

1. Freeze M0 evidence, tooling licenses, detailed matrix, owner state and run full baseline (NO restart).
2. Build independent PDF fixtures and positive/negative forensic cases first, before broadening any "supported" claims.
3. Finish M1 preflight/object map and M2 exact-original-content pipeline; separate supported vs rejected branches.
4. Implement M3 redaction object sanitization and independent forensic gate in parallel with M4 signature trust validation.
5. Run four-way M5 OCR benchmark (Tesseract eng+ind vs PP-OCRv6 tiny/small/medium through pinned RapidOCR/ONNX), freeze real consented 200-page ID/EN evaluation gold and per-engine latency/peak RSS; choose the default from verified accuracy/resource evidence, then complete pdf_ocr and searchable-PDF E2E. No OCR training or fine-tuning.
6. Update T-Line inspector with preview/diffs, approvals and post-write re-open; certify installed native flow M6.
7. Package optional runtimes and complete CI/license/vulnerability checks M7.
8. Coordinate with Muse/tray runtime owner before M8 primary MCP cutover; use owner-authenticated staging, then approved live reload; 11-tool discovery + execution parity.
9. Complete M9 independent audit, M10 release package and M11 sign-off. Only then mark all DONE.

## 10. Technical standards and living references

- ISO 32000-2:2020, PDF 2.0 and errata/TS extensions, PDF Association: https://pdfa.org/sponsored-standards/
- ISO 32000-2 at ISO catalog: https://www.iso.org/standard/75839.html
- ETSI ESI PAdES publication/work program: https://www.etsi.org/technical-groups/esi/
- PP-OCRv6 official models, 49/50 supported languages and tier behavior: https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv6/PP-OCRv6.html
- RapidOCR PP-OCRv6 tier/backend model matrix including ONNX Runtime: https://rapidai.github.io/RapidOCRDocs/main/en/model_list/
- PAdES baseline reference ETSI EN 319 142-1 (published v1.2.1, and 2026 v1.3.0 listed on approval as of this planning date). Pin and check publication status before claiming conformance.
- ETSI EN 319 102-1 for AdES creation/validation, including revocation freshness and validation logic:
  https://www.etsi.org/deliver/etsi_en/319100_319199/31910201/01.04.01_60/en_31910201v010401p.pdf
- Current source and audit are separate from product compliance. This plan's quality targets are proposed engineering gates, not claims of ISO/ETSI certification.

## 11. Release sign-off template

Release candidate:
Core commit/source manifest:
T-Line commit/source manifest:
Independent fixtures manifest:
Supported PDF classes:
Explicit unsupported classes:
Text fidelity independent verdict:
Redaction forensic verdict:
Signature CMS + trust + timestamp + PAdES verdict:
OCR ID/EN held-out verdict:
Auth/YOLO/MCP runtime owner verdict:
Installed T-Line acceptance:
Cross-platform packaging + licensing + SBOM verdict:
Full regression / fuzz verdict:
Rollback evidence:
P0/P1 unresolved count:
Independent owner/reviewers:
Final decision: NOT STARTED / PARTIAL / BLOCKED / GO
"GO" requires every required gate and real evidence; absence of a required field is NO-GO.
