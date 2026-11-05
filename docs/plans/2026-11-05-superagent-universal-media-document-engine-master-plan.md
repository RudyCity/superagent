# Universal Media & Document Engine — Master Plan & Execution

Date: 2026-11-05
Repository: SuperAgent, primary branch `main`; no new branch/worktree.
Status: CORE IMPLEMENTED + VERIFIED IN SOURCE, deployment acceptance pending.

## Objective

Add native, local-first image and document operations accessible to SuperAgent agents and MCP, without introducing a second daemon or bypassing existing project authorization.

## Implemented architecture

1. `src/core/media/mediaEngine.ts`: typed workspace-scoped input verification; format detection; raster operations; conversion dispatch; batch; attestation; create-only output publication using exclusive hardlink from a staged artifact; cleanup on partial failure.
2. `scripts/media_backend.py`: opt-in Python adapter for PyMuPDF, Pillow, python-docx, python-pptx, openpyxl, rembg, LibreOffice headless and separately owned read-only Windows Office COM PDF export.
3. `scripts/setup_media_backends.py`: explicit portable Real-ESRGAN installer (fixed official upstream release, safe bounded extraction, recorded digest). Installed binaries live under the user's config directory, not the Git repository.
4. `src/core/tools/mediaTools.ts`: five discoverable agent tools (`media_inspect`, `media_capabilities`, `media_transform`, `media_convert`, `media_batch`).
5. `src/core/mcp/tools/mediaMcpTools.ts`: five matching `superagent_*` MCP tools. Inspection/capability tools are classified safe; transform/convert/batch are dangerous.
6. Integrations into `toolsets.ts`, MCP server tool catalog and dispatcher, MCP workspace policy, tool classification, and project access capability routing.

### Supported conversion routes

- Raster PNG/JPEG/WebP/AVIF/TIFF/BMP/GIF to other supported raster outputs via Sharp (animated/multi-page sources require frame selection).
- Resize, rotate from EXIF, crop, quality adjustment and JPEG alpha flattening.
- Local rembg/U2NetP background removal to transparent PNG (model must be provisioned).
- Portable Real-ESRGAN NCNN Vulkan upscale 2x/3x/4x to PNG (backend and Vulkan capability required).
- One/many images to PDF, DOCX, XLSX, PPTX. DOCX/XLSX/PPTX retain images as embedded objects, not editable text or table cells.
- PDF to raster image for a selected page or all pages (bounded, suffix -p001 etc.).
- PDF to DOCX linear editable text extraction, PDF to XLSX detected tables (fails if no structurally detected table), PDF to PPTX raster visual slides. Scanned PDFs require separate OCR before textual reconstruction.
- DOCX/XLSX/PPTX to PDF and rendered image via installed LibreOffice or isolated Windows Office read-only COM export.
- CSV/TSV to XLSX and first worksheet to CSV/TSV.

### Constraints

- Input size <=100 MiB; output size <=200 MiB; Sharp/image render <=40 megapixels; up to 50 input images and 20 batch jobs per invocation.
- Authorized local project only. Canonical real-path checks for inputs, output-parent symlinks, no file overwrite, bounded output count, SHA-256 verification.
- No cloud upload, unapproved destructive operation, or implicit model/binary download during conversion.
- MCP write operations require dangerous tool exposure, active local YOLO policy, OAuth write scope where applicable, and project write access. SAFE-only MCP must not call mutating operations.
- Conversions may lose exact layout, formulas, animations or editability. Report backend and limitations rather than inventing equivalence.
- The Python model and Office/NCNN binary are optional dependencies and must report missing-backend errors rather than silently substituting a non-AI filter.

## Executed verification

- `bun run build`: PASS on source version 1.14.63.
- `bun --bun x vitest run tests/mediaEngine.test.ts`: 8/8 PASS.
- `bun --bun x vitest run tests/mediaAiAdapters.test.ts`: 4/4 PASS, including actual U2NetP inference and Vulkan Real-ESRGAN output.
- `bun --bun x vitest run tests/mediaOfficeExport.test.ts`: 1/1 PASS. Actual Word, Excel and PowerPoint to PDF + DOCX to PNG.
- Installed python-docx 1.2.0 and rembg 2.0.67 in the operator's user-level Python 3.12.7 environment, downloaded U2NetP with rembg's model provider, and installed pinned Real-ESRGAN portable release to the operator config directory.

## Follow-up release gates

- Run a full-repository regression suite once concurrent changes in tray, Delegate and runtime stabilize; source build and targeted suites are not production deployment certification.
- Validate installed MCP owner tool discovery after a controlled, authorized restart; do not restart shared Core/MCP during another agent's work.
- Optional: T-Line/tray batch UI, persistent cancellable queue, advanced document layout scoring, font fidelity, signed-PDF warnings, sandboxed Office renderer on headless deployments.
- Office COM requires an interactive Windows Office installation; Linux/headless deployments should provision LibreOffice.
- Add sustained/malicious input corpus, zip decompression bounds, document encryption/signature regression, and negative tests before opening this service to untrusted uploads.

## Ownership notes

This implementation touched only new media modules and the small MCP/toolset registration changes. Existing user/other-agent modifications in the tray, Delegate, PDF, runtime, package manifest, and changelog were preserved; no new worktree created.


## 2026-11-05 continuation: input hardening, visual operations and route planning

- `src/core/media/mediaFormatGuard.ts`: strict per-extension magic byte checks, OpenXML ZIP32 central-directory inspection, maximum entry count, decompression limits, malicious/duplicate path rejection, encrypted/archive method rejection, and required Office document part validation.
- `src/core/media/mediaPlanner.ts`: non-mutating route selection and installed-backend readiness with semantic fidelity warnings; `media_plan` available to Agent/MCP as safe/read access.
- Extended `media_transform` with compress, rotate, vertical/horizontal flip, grayscale, and workspace-scoped image watermark; background removal and upscale unchanged.
- Extended `media_batch` with stop-on-error, explicit cancellation status, per-job successes/failures and summary fields.
- Added input image pixel budgets and limits for PDF-to-PPTX raster, PDF text extraction length, and extracted spreadsheet cell count.
- New suites: `tests/mediaFormatGuard.test.ts`, `tests/mediaTransforms.test.ts`, `tests/mediaPlanner.test.ts`, `tests/mediaLimits.test.ts`.
- Build and focused tests passed, pending consolidated regression execution/commit and active MCP owner refresh verification.

Remaining production gates: isolated sandbox for truly untrusted Office documents, full PDF signature/privacy review, native async job queue with real progress/cancel, integration into currently actively edited tray/T-Line UI, and an authorized MCP lifecycle refresh/live client probe.

### Consolidated verification and deployment boundary

- 2026-11-05: 39/39 focused media tests PASS across seven suites. All image, Office, PDF, plan, archive, batch and memory-limit tests passed.
- Primary MCP currently advertises five older media tools and has not yet picked up the new media_plan tool. Source integration is compiled but runtime refresh remains pending; do not claim live activation without an authorized MCP owner lifecycle transition.
- Package version and shared changelog are concurrently modified by another agent; do not stage or overwrite those files as part of this media-only change.
