# SuperAgent Media & Document Workflows

## Discovery

Use Agent tools `media_capabilities`, `media_inspect` and the read-only `media_plan` before conversion. `media_plan` returns supported route, required backend, readiness, predicted fidelity and warnings, without creating an output. MCP equivalents are `superagent_media_capabilities`, `superagent_media_inspect`, `superagent_media_plan`, `superagent_media_transform`, `superagent_media_convert` and `superagent_media_batch`.

All file paths are relative to an authorized local workspace. The parent output folder must already exist. Outputs are **create-only**; renaming/extending the output path is required for another run.

### Agent examples

```json
{"inputPath":"images/product.png","outputPath":"images/product-transparent.png","operation":"remove_background","model":"u2netp"}
{"inputPath":"images/product.png","outputPath":"images/product-upscale.png","operation":"upscale_ai","scale":2}
{"inputPath":"images/product.png","outputPath":"images/product.webp","operation":"resize","width":1200,"quality":82}
{"inputPath":"images/product.png","outputPath":"images/product-watermarked.png","operation":"watermark","watermarkPath":"images/logo.png","watermarkWidth":240}
{"inputPath":"images/product.png","outputPath":"images/product-rotated.png","operation":"rotate","degrees":90}
{"inputPath":"images/product.png","outputPath":"images/product-gray.png","operation":"grayscale"}
{"inputPath":"images/product.png","outputPath":"images/product-compressed.webp","operation":"compress","quality":68}
{"inputPath":"images/product.png","outputPath":"images/product.pdf","mode":"convert"}
{"inputPaths":["images/a.png","images/b.jpg"],"outputPath":"documents/catalog.pdf"}
{"inputPath":"documents/manual.pdf","outputPath":"images/manual.png","allPages":true,"dpi":144}
{"inputPath":"documents/manual.pdf","outputPath":"documents/manual.docx"}
{"inputPath":"presentation/report.pptx","outputPath":"exports/report.pdf"}
{"inputPath":"sheets/data.csv","outputPath":"sheets/data.xlsx"}
```

For a pipeline, pass `media_batch` a `jobs` list (1 to 20), each with `mode: "transform"` or `mode: "convert"`; each job needs its own outputPath. Optional `stopOnError: true` stops after the first failure. A cancelled batch reports `status: "failed"` with `code: "cancelled"`; partial completion reports `completed`, `total`, `succeeded` and per-item results.

Read-only preflight example:

```json
{"inputPath":"documents/manual.pdf","outputPath":"documents/manual.docx","mode":"convert"}
```

Use this JSON with `media_plan` before calling `media_convert` with the same input/output. `media_plan` does not create the document.

### Optional local runtime setup

Windows environment used for first verification: Python 3.12.7 with Pillow, PyMuPDF, python-docx 1.2.0, python-pptx, openpyxl, win32com/pywin32, rembg 2.0.67 and ONNX Runtime. Actual availability varies by workstation.

```shell
python -m pip install --user python-docx==1.2.0 rembg==2.0.67
python -c "from rembg import new_session; new_session('u2netp')"
python scripts/setup_media_backends.py --install-realesrgan
python scripts/setup_media_backends.py
```

The explicit `new_session` setup command downloads rembg's pinned U2NetP model; normal conversions do not download missing models. The portable Real-ESRGAN setup uses the official `v0.2.5.0` Windows bundle, limits ZIP size, and writes a local source/digest lock under `~/.superagent-r/media-backends/realesrgan`. Do not commit downloaded binaries, model weights, or user settings.

Office -> PDF/image first uses LibreOffice headless when installed. On Windows where LibreOffice is unavailable, a separately launched Microsoft Office automation instance opens the document read-only with macros disabled and exports PDF. This route requires an interactive Office installation and may fail in headless services. Normalization, pagination and font fidelity vary by renderer.

### Result and failure handling

Successful output includes `status: "ok"`, backend name and an `outputs` array (path, sizeBytes, sha256). Unavailable or malformed conversions fail with a typed code; an absent model never masquerades as an AI result.

`media_inspect` is read-only. MCP conversion and transformation require dangerous-tool authorization; never enable YOLO automatically. Avoid processing untrusted Office files until the document decompression/sandbox regression gate is complete.

When a scanned document needs editable Word/Excel content, use existing `pdf_ocr` / `pdf_ocr_searchable` first and independently review the reconstructed text/tables. A PDF-to-PPTX slide is a rendered image, not an editable diagram.


### Untrusted file limits and output guarantees

Input files are limited to 100 MiB, outputs to 200 MiB. Raster decode/rendering is limited to 40 megapixels per image; multi-image documents are limited to 100 megapixels combined. ZIP32 OpenXML archives are checked for valid central directory, expected document root, zip-slip traversal, symlinks, duplicate paths, encrypted entries, macros, external-link artifacts, high expansion ratio and uncompressed-size budget before Office automation.

Exports publish create-only files after signature verification and return a SHA-256 and byte size. Original inputs are not modified. For advanced threats, Office documents should be processed in a dedicated sandbox rather than a privileged interactive user session.

The full MCP catalog is available in source, but primary MCP runtime availability must be checked after its operator-approved owner lifecycle; a build alone does not refresh connected clients.
