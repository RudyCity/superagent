# SuperAgent PDF tools — Primary MCP, prompt, OCR, Unicode and T-Line integration audit

> **Historical baseline**, before advanced PDF signing/vector work. Latest advanced source/test evidence: `docs/audits/2026-11-04-pdf-advanced-signatures-vector-ocr.md`. Benchmark outputs: `docs/audits/2026-11-04-pdf-ocr-real-benchmark-v2.json` and `-v2.md`.

Date: 2026-11-04
Status: **Source implemented and verified; live owner/installed desktop not activated**
Repo: `superagent`; current branch `feat/muse-file-transfer-20261104`
Desktop repo: `t-line`; branch `main`.

## Implemented in SuperAgent

1. Eight PDF tools: `pdf_inspect`, `pdf_extract`, `pdf_ocr`, `pdf_render`, `pdf_edit`, `pdf_split`, `pdf_redact_raster`, `pdf_verify`. Same exact names prefixed `superagent_` in MCP.
2. `src/core/mcp/superagentMcpServer.ts`: `PDF_MCP_TOOL_DEFS` registered in main catalog; `PDF_MCP_TOOL_NAMES` dispatched through existing authenticated workspace, provider, OAuth, YOLO and project grant path. No new public MCP bypass.
3. `src/core/mcp/mcpToolPolicy.ts`, `mcpWorkspacePolicy.ts`, `src/core/project/projectAccessPolicy.ts`: explicit read/write classifications, workspace scoping and project capabilities. PDF mutations fail when YOLO OFF, OAuth write scope absent, project write grant absent, or provider is SSH/chain.
4. `src/core/prompts.ts`, `src/core/config/base.ts`: capability-driven PDF workflow via list/describe, inspect -> edit -> verify, new-file publication, explicit destructive consent and honest unsupported-operation handling. No hardcoded user requests or fixed PDF content.
5. `src/core/tools/documentReadTools.ts`: scanned PDF detection uses actual per-page text, not pdf-parse page separator markers. PDF skips incompatible OfficeCLI fast path and reaches local OCR fallback without the observed 30-second stall.
6. `src/core/tools/pdfTools.ts`: returns `backend: "local_ocr_fallback"` instead of falsely naming PaddleOCR when the existing OCR engine may use Tesseract. `ocrPerformed` is true only when the OCR fallback path is actually used.
7. `src/core/pdf/pdfEngine.ts`: optional `fontPath` from existing workspace TTF/OTF files for Unicode text overlays; powered by locally installed `@pdf-lib/fontkit@1.1.1` (no font files committed or distributed). File scoped, file size capped. Original text rewrite and native vector-preserving redaction remain intentionally unsupported rather than faked.

## Implemented in T-Line desktop source

- `frontend/src/components/PdfEditorPanel.tsx`: existing FileViewer PDF side inspector; safe typed operations for rotation, page numbering, text/watermark, visual highlighting, form filling and page deletion; explicit confirmation for page deletion; new output path; optional workspace font for Unicode.
- `frontend/src/components/FileViewerTab.tsx`: `Edit PDF` control toggles side inspector beside existing embedded PDF preview.
- `frontend/src/App.tsx`: route PDF request only to an already registered local workspace and existing SuperAgent Assistant tab.
- `frontend/src/components/SuperAgentConsole.tsx`: one-time handoff to existing authorized Core chat toolset with session/socket/preset readiness checks, preserving draft, no duplicate backend, no direct file mutation from UI.

## Verification

- Core `bun run build`: PASS. Latest command `cmd_1793793389981_8nemb`.
- Core 11-suite targeted regression: **94/94 PASS**; includes primary MCP OAuth/YOLO/project grants, local MCP, PDF structural tests, Unicode overlays, OCR fallback mocked backend, tool-discovery/tier and previous document reader tests. Command `cmd_1793793420723_12n0c`.
- T-Line frontend `bun run build:frontend`: PASS. Command `cmd_1793793023460_hisag`. There are existing Vite chunk-size and mixed dynamic import warnings, not build failures.
- T-Line UI targeted tests **6/6 PASS**, type check PASS. Latest command `cmd_1793793442092_553cn`.
- `git diff --check` PASS for changed tracked files in both projects.
- Live current `superagent_tool_search({query:"superagent_pdf"})`: **NO TOOLS** — this verifies the already-running @s1000 gateway still uses old process code; source build is not hot-deployed.
- No existing T-Line / SuperAgent runtime owner processes stopped/restarted; no commit or push; no worktrees. Concurrent Muse/tray changes were not reset, stashed, overwritten or staged.

## Remaining production/research gaps

1. **Owner activation**: coordinated operator-approved reload/build deployment of the primary MCP and installed T-Line to expose new tools/UI in the user's running environment. Current s1000 gateway cannot invoke PDF tools until this happens; do not claim otherwise.
2. **Installed UI E2E**: run genuine installed desktop PDF viewer -> Assistant -> tool -> verified output -> open result flow after runtime owner certification; source-only UI tests do not prove this.
3. **Real OCR benchmark**: evaluate a frozen independent scanned corpus (ID/EN) across engine versions and record CER/WER, confidence, page coordinates. Current OCR flow regression mocks only success path.
4. **Advanced PDF edit fidelity**: arbitrary original text replacement, true annotations with interactive objects, vector-preserving redaction, robust form-XFA/fill appearances, signing, RTL/CJK shaping, bookmarks and named links preservation, malicious PDFs, signed/encrypted matrix, large-file and Linux compatibility are not production certified. Failure/unsupported responses must remain explicit.
5. **Output delivery**: remote Muse binary transfer and independent recipient hash check not exercised in this PDF task; if user asks for PDF file in chat, use approved file-transfer path after certification, never tool text envelopes.
6. **Release metadata**: T-Line root/front-end version bump, CHANGELOG and repository commits intentionally deferred until installed release authorization; both repositories remain with uncommitted changes. The unrelated T-Line audit `docs/audits/2026-10-28-final-independent-reaudit.md` remained untouched.

## Usage

Agent: `list_tools({query:"pdf"})`, `describe_tool({names:["pdf_inspect","pdf_edit","pdf_verify"]})`, then inspect/operate/verify.

Primary MCP source: `superagent_pdf_inspect`, `superagent_pdf_edit`, `superagent_pdf_verify`, etc., with `projectId`/optional `workspace` and normal OAuth/YOLO/grant requirements. **Live s1000 tools are not yet available**.

Local-only CLI: `bun scripts/pdf-cli.ts inspect <file.pdf>` and `bun scripts/pdf-cli.ts edit <typed-request.json>`.

T-Line source UI: open local PDF -> `Edit PDF` -> choose operation -> `Edit with SuperAgent`; the Assistant inspects the file and requests existing permissions, creates a new PDF, and verifies its output.

**Release verdict:** source-level integration PASS; production activation and advanced editing capabilities not yet approved/certified.
