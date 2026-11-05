# SuperAgent PDF — Execution Tracker / Definition of Done
Date: 2026-11-04
Canonical plan: docs/plans/2026-11-04-superagent-pdf-full-completion-production-master-plan.md
Status: PLANNED; no runtime activation or implementation committed by the creation of this tracker.
Rules: no worktree or branch creation, no unrelated Muse/tray modification, no owner restart without authorization, and no unapproved Git commit/push.
Acceptance vocabulary: PENDING, IN_PROGRESS, PASS, FAIL, BLOCKED. PASS only with committed or source-hashed code + test evidence + reviewer; no guess-based statuses.

## 1. Execution order and responsibility boundaries

M0 -> M1 -> M2/M3/M4/M5 in parallel with separate file ownership -> M6 + M7 -> M8 -> M9 -> M10 -> M11.
Shared file owners src/core/mcp/superagentMcpServer.ts, src/core/mcp/mcpWorkspacePolicy.ts, src/core/tools/toolsets.ts, src/core/prompts.ts, src/core/config/base.ts and t-line/frontend/src/App.tsx must be checked before every patch.
Use existing branches and existing authorized runtime. Staging must be temporary, process-owner verified and shut down after the test.

## 2. Milestone checklist: items must be checked only after attached evidence

### M0 — Baseline, fixture corpus, scopes [P0 / PENDING]
- [ ] M0-01 Save current Git status, commit/build SHA, all present uncommitted project changes, port/PID authenticated owner identity and active tool search.
- [ ] M0-02 Freeze support-matrix v1.0 for text/layout/redaction/signing/OCR across real representative PDFs; declare unsupported classes.
- [ ] M0-03 Freeze independent fixture manifest with SHA-256, license/consent, dimensions, fonts, PDF version and expected results.
- [ ] M0-04 Pin Bun, Node, Python, pikepdf, pdfminer, OpenSSL, Tesseract and language traineddata hashes; SBOM/licensing review.
- [ ] M0-05 Run existing focused 106 Core + 9 T-Line tests, and record full-repository baseline (all failures classified).
Evidence: BASELINE.md, SUPPORT_MATRIX.csv, FIXTURE_MANIFEST.json and test command logs.
PASS gate: independent reviewer confirms frozen matrix and no concurrent edits overwritten.

### M1 — Scanning, parser, geometry, transactional output [P0 / PARTIAL]
- [ ] M1-01 Read-only preflight inventory: fonts and CMaps, text streams, nested XObjects, rotated/cropped pages, annotations, attachments, signatures and revisions.
- [ ] M1-02 Build original glyph/geometry identity map with immutable source object IDs, transforms, font matrix and text extraction parity.
- [ ] M1-03 Implement private staged writes, create-only atomic publish, output lock, retry idempotency, cancellation and rollback.
- [ ] M1-04 Fuzz malicious input/xref/bombs/complex encodings and enforce CPU/memory limits.
- [ ] M1-05 Cross-check independent parser and renderer on Windows + Linux.
Evidence: PARSER_AND_TRANSACTION_QA.json. PASS: zero source modification, no corrupt/partial outputs or path escapes.

### M2 — Edit original PDF text without unintended layout change [P0/P1 / PARTIAL]
- [ ] M2-01 Harden current simple Tj exact operator, including duplicate matches and font/encoding refusals.
- [ ] M2-02 Add validated TJ-array and fragmented glyph runs, kerning, bbox coordinates and support for multiple selected occurrences.
- [ ] M2-03 Add subsets, ToUnicode/CMap, Type0/CID fonts and Unicode ID/EN under a deterministic font embedding strategy.
- [ ] M2-04 Handle page transforms, Form XObjects and permitted annotations preserving all unaffected objects; otherwise fail closed.
- [ ] M2-05 Add explicit bounded reflow/overflow preview requiring user approval; preserve tagging and text accessibility where advertised.
- [ ] M2-06 Freeze independent pixel-diff oracle and bbox tolerances, check all unaffected pixels and content objects on 50+ synthetic and 20+ real PDFs.
Evidence: TEXT_LAYOUT_REPORT.json plus sanitized diff images. PASS: all eligible edit fixtures meet fidelity thresholds, no silent clipping or corrupted files, unsupported exact edits refuse.

### M3 — Secure text/vector/image redaction [P0 / PARTIAL]
- [ ] M3-01 Build scoped target selection and preflight preview; explicit approval and SHA-256 guard.
- [ ] M3-02 Remove underlying text and vector drawing objects, not overlays; handle XObjects and reuse semantics.
- [ ] M3-03 Remove pixel/image content in target areas, old OCR layers, annotation replies, hidden layers and form values.
- [ ] M3-04 Scrub declared metadata, attachments, JavaScript/actions and all incremental historical revisions; validate exact policy exclusions.
- [ ] M3-05 Independent forensic extraction/object-graph recovery attempts, dual renderers, OCR and content-carving negative tests.
- [ ] M3-06 Verify user-selected semantics on native PDF and image-only fallback; refuse unsanitizable inputs instead of claiming secure redaction.
Evidence: REDACTION_FORENSICS.json. PASS: zero recoverable sensitive targets in all in-scope positive controls, zero false-certification.

### M4 — Digital signatures, trust and PAdES [P0/P1 / PARTIAL]
- [x] M4-01 Verify existing CMS signing with temporary test certificates, malformed ByteRange and post-sign tamper test.
- [ ] M4-02 Implement trusted anchors, certificate chain, expiry, key usage and trusted signer identity status.
- [ ] M4-03 Verify CRL/OCSP with freshness, offline and indeterminate policies; network access governed by explicit allowlist.
- [ ] M4-04 Add RFC 3161 TSA validation, time evidence and safe multiple-signature/incremental revision handling.
- [ ] M4-05 Independent PAdES B-B profile validation, then B-T, B-LT and B-LTA only with their required evidence; no false qualification claims.
- [ ] M4-06 Add secure certificate/password custody, OS keystore/HSM adapter policy, denial tests and no-secret logging regression.
Evidence: signature suite **13/13 PASS** on 2026-11-05. OpenSSL verifies one CMS/ByteRange and deliberately refuses ambiguous multi-signature PDFs. Pinned pyHanko 0.38.1 independently validates **two incremental regular signatures**, operator CA trust, offline CRL, operator-only offline DER OCSP (`good` vs `revoked`), real RFC3161 signature timestamps, and now separates regular signatures from **DocTimeStamp** objects. A local long-term-evidence fixture uses `embed_validation_info=True` + `use_pades_lta=True`; the verifier sees DSS revocation material plus a trusted document timestamp and reports `B-LTA-like-evidence` while retaining `padesStructuralConformance=not_certified`. Formal AdES Basic (§5.3), With-Time (§5.5) and LTA (§5.6.3) evidence is reported separately. **Evidence-level labels are not PAdES structural certification.** M4-03 still lacks a complete freshness/expired-response production matrix; M4-04 now has multi-signature verification and incremental coverage but production append-signing policy remains open; M4-05 still lacks independent structural certification; M4-02/M4-06 production identity/keystore/HSM policy remain open.

### M5 — Pretrained-only OCR, Indonesian/English, searchable PDF [P0/P1 / PARTIAL]
**User decision:** use existing pretrained OCR models; absolutely no custom OCR training, fine-tuning, distillation or new model weights. Human-gold is evaluation-only.
- [ ] M5-01 Assemble >=200 real consented evaluation pages (>=100 ID, >=100 EN), source-separated frozen human-gold with 20% double annotation/adjudication; never use gold pages as training data.
- [ ] M5-02 Install and SHA-pin official Tesseract eng+ind pretrained data and PP-OCRv6 tiny/small/medium detector+recognizer pairs, model dictionaries and licenses. Record exact URLs, artifact sizes, hashes, RapidOCR/ONNX versions and offline availability; do not auto-download at inference.
- [ ] M5-03 Test the ACTUAL pdf_ocr tool end-to-end, no mocked backend or synthetic only.
- [ ] M5-04 Add page orientation, preprocessing, language detection, word/glyph bbox, confidence and reading-order validation.
- [ ] M5-05 Create searchable PDF copy with aligned hidden text + preserved original page image and post-export verification.
- [ ] M5-06 Freeze CER/WER/bbox + per-hardware p95 latency and peak RSS budgets before opening holdout; report subgroup/worst-decile/error metrics. On failure, optimize only preprocessing, routing, pretrained model selection and inference parameters on a separate development subset; no training, fine-tuning or changes to sealed evaluation gold.
- [ ] M5-07 Implement explicit PP-OCRv6 Tiny/Small/Medium detection+recognition loading through pinned RapidOCR ONNX Runtime; verify actual ID/EN text, coordinates and model pair, not library default.
- [ ] M5-08 Run one controlled four-way benchmark against identical locked pages: Tesseract (eng+ind), PP-OCRv6 Tiny, Small and Medium. Record per-engine CER/WER, detection F1/bbox IoU, reading order and numerals/tables with SAME normalization and independently annotated gold.
- [ ] M5-09 Record for each model/hardware tier 4 vCPU/8 GB CPU, 16 GB CPU, optional accelerated: cold start, p50/p95 warm latency, peak process RSS, CPU use, pages/min, total runtime footprint and failure/timeout counts.
- [ ] M5-10 Decide default by quality-first eligible holdout gates then RAM/latency; provisional Small, Tiny low-resource, Medium quality fallback, Tesseract comparator/fallback; never use uncalibrated confidence alone.
- [ ] M5-11 Add offline artifact presence checks, explicit model selection, idempotent request, bounded workers/timeouts, per-page engine/model/hash provenance and an honest unavailable/partial error.
- [ ] M5-12 Publish reproducible four-model benchmark JSON/Markdown and a release decision; verify no custom training/fine-tuning, no network OCR uploads, no inference-time model download, and no unsupported size-to-RAM claims.
Evidence: OCR_HUMAN_GOLD_REPORT.json, OCR_MODEL_REGISTRY.json, OCR_4WAY_BENCHMARK.json and OCR_RUNTIME_PROFILE.json. Proposed printed-scan thresholds per language: clean CER <=2%, WER <=5%; difficult CER <=8%, WER <=20%; these are proposal gates, not observed results. Four engines must run on the SAME locked evaluation pages. Memory and latency thresholds must be calibrated and frozen BEFORE sealed holdout evaluation. PP-OCRv6 Small is only the initial default candidate. **Current expanded corpus:** 200 locked MDPBench public page images (100 ID + 100 EN), representing 79 source groups (40 ID + 39 EN). This satisfies page-count scale for an external public benchmark but does **not** satisfy M5-01 because the gold is layout annotation, not SuperAgent-owned complete-page dual-adjudicated CER/WER ground truth. Tiny 200-page run complete: annotated-token recall 82.92% EN / 66.17% ID; remaining engines not yet aggregated.
Current evidence: historical Tesseract-only 12-synthetic CER 1.19%, WER 3.65%; newer **same-fixture four-way actual pretrained inference** is at `docs/audits/2026-11-04-pretrained-ocr-fourway-synthetic.json` (Tiny 0.00%/0.00%, Small 0.15%/2.08%, Medium 33.33%/33.33%, Tesseract eng+ind 3.12%/8.14% CER/WER). **External worker+children sampled peak RSS** (10ms intervals) is at `docs/audits/2026-11-05-pretrained-ocr-fourway-ospeak-synthetic.json`: Tiny 360.31 MiB, Small 486.93 MiB, Medium 867.03 MiB, Tesseract 103.19 MiB. These are engineering SMOKE results on one laptop, **NOT** kernel peaks, real independent 200-page human-gold M5 PASS or 4vCPU/8GB capacity certification. OCR/source SHA and details in `docs/audits/2026-11-05-superagent-pdf-continuation-evidence.md`.

### M6 — T-Line installed native PDF editor [P1 / PARTIAL]
- [ ] M6-01 Add true page previews and tool capability matrix, exact original-text selection with page-space coordinate mapping.
- [ ] M6-02 Add before/after overlay diff and explicit undo/redo draft staging.
- [ ] M6-03 Add confirmation/review screens for destructive redaction and certificate signing; prevent password entering UI/chat.
- [ ] M6-04 Preserve existing Assistant session/workspace without hidden reload, cross-project file access, auto-execution or unintended source writes.
- [ ] M6-05 Add cancellation, reopening verified file, keyboard navigation, accessibility tests, large PDF loading and UI regression.
- [ ] M6-06 Validate real installed Tauri flow (not only browser component tests) on supported OS. **Raw Windows release + extracted NSIS payload UI/backend smoke now PASS**, but actual OS install/uninstall/registry acceptance remains open.
Evidence: raw release `app.exe` launched with bundled Bun/backend and reached `Verified backend ready; loading authenticated desktop view.` The no-bundle stale-resource defect was fixed by `scripts/stage-tauri-no-bundle-resources.cjs` with SHA verification. A fresh **NSIS 1.3.752** installer (37,300,018 bytes) was then built. `scripts/check-tauri-bundle.cjs` PASS: extracted Bun ConPTY works without global PATH; extracted backend starts on loopback and protected API returns HTTP 401. A separate UI smoke extracted `app.exe`, backend and Bun directly from that same NSIS archive, launched the extracted app, observed its owned Bun child on `127.0.0.1:5779`, verified `tline-backend-v1` identity proof length 64, then terminated only the smoke process tree and confirmed port 5779 free. This validates installer payload bytes without modifying Windows installation state; **actual installer execution and clean uninstall remain unverified**.

### M7 — Packaging, Windows/Linux and licensing [P0 / PENDING]
- [ ] M7-01 Pin and check licenses/redistribution of all PDF, signature, OCR/font and cryptographic dependencies; reject incompatible unapproved SDK.
- [ ] M7-02 Package isolated Python vector backend; never require global Python or assume test machine venv exists on users' devices.
- [ ] M7-03 Pin and verify OpenSSL binary, Tesseract traineddata, RapidOCR/ONNX Runtime and PP-OCRv6 Tiny/Small/Medium model pairs/dictionaries; package supported CPU-only runtimes and benchmark memory/latency on target hardware.
- [ ] M7-04 Clean install/upgrade/uninstall smoke test on Windows and Linux; verify missing backend fail-closed.
- [ ] M7-05 CI parallel security, vulnerability, memory/performance, crash/interrupt and 100MB/500-page limit tests.
Evidence: PACKAGING_MATRIX.md, SBOM, checksums, reproducible build logs.

### M8 — Live primary authenticated MCP and dynamic discovery [P0 / PARTIAL]
- [ ] M8-01 Inspect active process owners via authenticated lifecycle tools and capture actual build identity; coordinate Muse/tray shared-file changes.
- [x] M8-02 Authenticated live gateway: search/describe/execute all **12** PDF tools with tool-allowed scope. Eleven tools produced successful disposable-fixture results; `pdf_sign` executed and failed closed with `password_missing` because the live owner intentionally has no signing secret configured.
- [ ] M8-03 Prove YOLO OFF denial, Scoped YOLO path protections, OAuth read vs write, project grant, cross-project and dynamic revocation.
- [ ] M8-04 Obtain owner authorization, drain live sessions, reload primary MCP owner without implicit Core restart or duplicated persistent service.
- [ ] M8-05 Live query "pdf" returns **12** exact names, descriptions and expected schemas; signed/vector/redact/searchable PDF test outputs verifiable and safe.
- [ ] M8-06 Prove Muse/tray unaffected, owner version/readiness valid, error rollback works and no stale replay.
Evidence: 2026-11-05 connector `s2000` reports active MCP owner PID 29740, `ownershipVerified=true`, OAuth mode, Cloudflare public URL and 137 visible gateway tools. Live `tool_search("pdf")` returns all 12 PDF tools and each schema was described. Live disposable execution verified inspect/extract/native OCR, edit, exact vector replacement, embedded-subset Unicode replacement, PP-OCRv6 Small OCR, searchable PDF, raster redaction with post-serialization pixel verification, render, split, structural verify and CMS signature verification. Exact vector output SHA `5f25f42217c399888ed9f3992d7bf63d9856bfdd0ef2372b07a43689a7b2c263`; embedded Unicode output SHA `49b7e1c50d438d09dde230ea79bdd5d1d8c9fad6b25ddf958c9d570e4890249e`; searchable output SHA `06d0821fd72131b03ace8d83e5ed0a2bbf94a9ac9cafdbc94e55b98c90ab7775`; raster-redacted output SHA `95b32877d1a6b581f218e9880938589c73f4cf9dc74fe812fb5de1e01072482b`; signed fixture SHA `8e2d58ae71513d37b5ee3460b7d08cff4bee37d30317ceb26c3a05246f352cd5` verified live by `pdf_verify_signature`. A URL-stable MCP reload plan was issued but mutation returned `SERVICE_MCP_RELOAD_UNCERTAIN / MCP_RELOAD_LEGACY_OWNER`; no forced restart, duplicate server or URL rotation was performed. Primary owner build identity and reload migration remain open.

### M9 — Independent security/compatibility audit [P0 / PENDING]
- [ ] M9-01 Run full repository test suite, not just PDF-focused tests; classify prior unrelated failures.
- [ ] M9-02 Run malformed-PDF and malicious content fuzz cases plus external redaction recovery red-team.
- [ ] M9-03 Independent render+extract+signature validator matrix across >=100 diverse PDFs; immutable evidence.
- [ ] M9-04 Penetration test project isolation, SSRF (if revocation enabled), prompt-injection and secret hygiene; no critical/high issues remain.
- [ ] M9-05 Run performance/memory/timeout/cancellation and cross-platform CI under documented machine constraints.
Evidence: SECURITY_REVIEW.md, fuzz crash log, compatibility matrix and independent reviewer sign-off.

### M10 — Product release, docs, migration and rollback [P1 / PENDING]
- [ ] M10-01 Update README, CLI help, Agent dynamic tool descriptions and T-Line bilingual UI help.
- [ ] M10-02 Document feature-supported matrix, explicit refusals, OCR limitations, signature trust classification, backup/rollback.
- [ ] M10-03 Generate reproducible Core/T-Line artifacts with SBOM/SHA-256 and platform installation verification.
- [ ] M10-04 Coordinate permitted Git commit/push using exact PDF-only files; do not stage concurrent Muse/tray changes and reconcile origin divergence.
- [ ] M10-05 Conduct user-accepted demonstrations and verify new output PDFs open on independent viewers.
Evidence: release notes, install guide, artifacts, rollback rehearsal and output acceptance evidence.

### M11 — Final GO/NO-GO [P0 / PENDING]
- [ ] M11-01 Functional completeness F — eligible supported-matrix tests all PASS; unsupported explicitly recorded, no fake success.
- [ ] M11-02 Security/quality completeness S — redaction forensic, signature trust, OCR human-gold and independent regression PASS.
- [ ] M11-03 Production completeness P — live MCP **12-tool** discovery, authorized execution, installed T-Line and rollback PASS.
- [ ] M11-04 Independent reviewer signatures, zero unresolved P0/P1 issues and known limitations disclosed in release.
- [ ] M11-05 Final status DONE is allowed ONLY when M11-01..04 ALL PASS.
Evidence: RELEASE_GO_NO_GO.md with version hashes and links to every gate.

## 3. Progress dashboard (initial, do not overstate)

| Phase | Owner assignment | P0/P1 | Status | Evidence |
| --- | --- | --- | --- | --- |
| M0 Baseline | Lead / QA | P0 | PENDING | Existing audits, frozen matrix pending |
| M1 PDF internals | Core PDF | P0 | PARTIAL | Existing pdfEngine and limited pipeline |
| M2 Text editing | PDF layout | P0/P1 | PARTIAL | Unique ASCII Standard-14 Tj/TJ/multi-Tj plus **restricted Type0 Identity-H embedded-subset Unicode Latin Tj and bounded fragmented TJ replacement** PASS; missing glyph/excessive kerning/Unicode-redaction refusals PASS; paragraph reflow, arbitrary CID CMaps and multi-font runs still open |
| M3 Secure redaction | Security | P0 | PARTIAL | Conservative vector/raster backend; mandatory reviewed preview SHA-256 for EVERY page; raster output re-render verifies exact black pixels + unaffected pixel parity. Fresh image-only object graph now verifies metadata/attachment/JavaScript/form/action/layer/annotation absence and single revision on a dirty positive-control PDF; independent external forensic carving corpus still open |
| M4 PAdES trust | Crypto | P0/P1 | PARTIAL | **13/13 signature tests PASS**: CMS/ByteRange, operator CA, CRL, offline OCSP good/revoked, RFC3161 trusted/untrusted TSA, two incremental signatures, DSS + DocTimeStamp LTA evidence and formal AdES. `B-LTA-like-evidence` is proven on a fixture but structural certification, freshness matrix and production append-sign/HSM policy remain |
| M5 Pretrained OCR (4-way) | OCR integration + human QA (no model training) | P0/P1 | PARTIAL | Four-way synthetic 12-image run + external sampled RSS, then **20 unique MDPBench public real document pages (10 ID, 10 EN) evaluated head-to-head**; source hashes and token-overlap metrics archived; NOT complete-page CER/WER, 200-page independently adjudicated holdout or hardware-tier certification |
| M6 T-Line native | Desktop | P1 | PARTIAL | UI/viewer 15/15 + frontend build PASS; raw release native startup PASS; **NSIS 1.3.752 bundle verifier PASS and app.exe extracted from the installer payload launches its bundled Bun/backend with authenticated desktop identity**. Actual OS install/uninstall/registry acceptance remains open |
| M7 Packaging | Release engineering | P0 | PENDING | Local Windows dependencies only |
| M8 Live MCP | Authenticated runtime owner | P0 | PARTIAL | **All 12 PDF tools live-searchable/describable/executable via s2000**; disposable read/write/vector/Unicode/OCR/searchable/redaction/split/verify/signature-verify smoke PASS. Live sign correctly denies missing host secret. URL-stable reload migration remains unresolved |
| M9 Independent audit | Independent QA/security | P0 | PENDING | Focused suites only |
| M10 Release | Release owner | P1 | PENDING | Docs partial; no authorized deployment |
| M11 Sign-off | All reviewers | P0 | PENDING | F/S/P not all PASS |

Latest audit: `docs/audits/2026-11-05-superagent-pdf-continuation-evidence.md`. **Latest PDF-focused baseline: 99/99 PASS across 14 PDF/security/MCP suites, TypeScript PASS, Core build PASS SHA-256 `03bdecf9c9fd15a79c6bca9c124e9ea41f9649700b745e87b896f5cec7414829`; T-Line PDF/viewer 15/15 PASS and frontend build PASS.** A broader mixed suite is 141/142 because the unrelated concurrent Delegate gateway test still expects `superagent_delegate_list_chats` to remain hidden even though Delegate now advertises it; PDF code is not changed to mask that unrelated regression. **These are not M11 release signoffs.** Progress percentages are intentionally not invented.

## 4. How to update this tracker

For each completed item:
1. Link proof in docs/audits/pdf-full-completion/<execution-id>/; include command, stdout summary, source hash, environment, exact fixture IDs, output hash, independent reviewer.
2. Only then change one checkbox and update this table. A failed check must remain unchecked with FAIL/BLOCKED and next corrective action.
3. No silent scope reduction and no threshold change after opening frozen holdout.
4. Summary reporting must state source READY vs live NOT ACTIVATED separately until M8 is validated.
5. Never rename a partial status to DONE because a subsequent task says "mark done"; repair/verify first.
