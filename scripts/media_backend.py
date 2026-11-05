"""Bounded optional Python adapter for SuperAgent's local media engine.
Input is a JSON argument from the typed TypeScript dispatcher. Never execute arbitrary shell text.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def fail(code, message):
    raise RuntimeError(code + ": " + str(message)[:300])


def result(paths, backend, notes=None):
    return {"outputs": [str(p) for p in paths], "backend": backend, "warnings": notes or []}


def ensure_new(paths):
    for p in paths:
        if Path(p).exists():
            fail("output_exists", str(p))


def write_picture_document(sources, output, suffix):
    from PIL import Image
    ensure_new([output])
    if suffix == ".docx":
        try:
            from docx import Document
            from docx.shared import Inches
        except ImportError:
            fail("backend_unavailable", "python-docx is not installed")
        doc = Document()
        for source in sources:
            with Image.open(source) as image:
                pixels = image.size
            doc.add_picture(str(source), width=Inches(min(6.5, pixels[0] / 110)))
        doc.save(output)
        return result([output], "python-docx", ["Images are embedded, not reconstructed as editable text."])
    if suffix == ".xlsx":
        try:
            from openpyxl import Workbook
            from openpyxl.drawing.image import Image as XLImage
        except ImportError:
            fail("backend_unavailable", "openpyxl is not installed")
        book = Workbook()
        sheet = book.active
        for ix, source in enumerate(sources):
            sheet.add_image(XLImage(str(source)), f"A{1 + ix * 35}")
        book.save(output)
        return result([output], "openpyxl", ["Embedded images are not extracted spreadsheet cells."])
    if suffix == ".pptx":
        try:
            from pptx import Presentation
        except ImportError:
            fail("backend_unavailable", "python-pptx is not installed")
        prs = Presentation()
        blank = prs.slide_layouts[6]
        for source in sources:
            slide = prs.slides.add_slide(blank)
            with Image.open(source) as image:
                iw, ih = image.size
            sw, sh = prs.slide_width, prs.slide_height
            factor = min(sw / iw, sh / ih)
            w, h = int(iw * factor), int(ih * factor)
            slide.shapes.add_picture(str(source), int((sw - w) / 2), int((sh - h) / 2), width=w, height=h)
        prs.save(output)
        return result([output], "python-pptx", ["Slide contains a raster image rather than editable shapes."])
    fail("unsupported_format", suffix)


def render_pdf(source, output, all_pages, page, dpi):
    import fitz
    from PIL import Image
    document = fitz.open(source)
    if document.needs_pass:
        fail("encrypted_pdf", "Password-protected PDFs are not supported")
    if document.page_count > 500:
        fail("limit_exceeded", "PDF exceeds 500 pages")
    if page < 1 or page > document.page_count:
        fail("invalid_page", "Page is out of bounds")
    pages = range(document.page_count) if all_pages else [page - 1]
    if all_pages and document.page_count > 100:
        fail("limit_exceeded", "All-pages render limited to 100 pages")
    dest = Path(output)
    outputs = [dest.with_name(f"{dest.stem}-p{index + 1:03d}{dest.suffix}") if all_pages else dest for index in pages]
    ensure_new(outputs)
    try:
        for ix, output_file in zip(pages, outputs):
            pdf_page = document.load_page(ix)
            w = pdf_page.rect.width * dpi / 72
            h = pdf_page.rect.height * dpi / 72
            if w * h > 40_000_000:
                fail("limit_exceeded", "Page render exceeds 40 megapixels")
            pix = pdf_page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
            image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            image.save(output_file)
    except Exception:
        for output_file in outputs:
            Path(output_file).unlink(missing_ok=True)
        raise
    finally:
        document.close()
    return result(outputs, "PyMuPDF")


def pdf_to_editable(source, output, ext):
    import fitz
    document = fitz.open(source)
    if document.needs_pass:
        fail("encrypted_pdf", "Password-protected PDFs are not supported")
    if document.page_count > 100:
        fail("limit_exceeded", "Editable extraction supports at most 100 pages")
    ensure_new([output])
    if ext == ".docx":
        try:
            from docx import Document
        except ImportError:
            fail("backend_unavailable", "python-docx is not installed")
        doc = Document()
        total_text = 0
        for index, page in enumerate(document):
            if index:
                doc.add_page_break()
            lines = page.get_text(sort=True).splitlines()
            for line in lines:
                if line.strip():
                    total_text += len(line)
                    if total_text > 2_000_000:
                        fail("limit_exceeded", "PDF contains more than 2 million characters for DOCX reconstruction")
                    doc.add_paragraph(line)
        doc.save(output)
        return result([output], "PyMuPDF + python-docx", ["Text-based reconstruction; original fonts, tables and layout are not guaranteed. Scanned pages need OCR first."])
    if ext == ".xlsx":
        try:
            from openpyxl import Workbook
        except ImportError:
            fail("backend_unavailable", "openpyxl is not installed")
        book = Workbook()
        total_cells = 0
        for ix, page in enumerate(document):
            sheet = book.active if ix == 0 else book.create_sheet()
            sheet.title = "Page " + str(ix + 1)
            finder = getattr(page, "find_tables", None)
            if not callable(finder):
                fail("backend_unavailable", "PyMuPDF table extraction is unavailable")
            tables = finder().tables
            if not tables:
                fail("no_structured_tables", "No tables found on page " + str(ix + 1))
            row_index = 1
            for table in tables:
                for values in table.extract():
                    total_cells += len(values)
                    if total_cells > 200_000:
                        fail("limit_exceeded", "Extracted PDF tables exceed 200,000 worksheet cells")
                    for column_index, value in enumerate(values, 1):
                        if value is not None and len(str(value)) > 32_767:
                            fail("limit_exceeded", "Extracted table cell exceeds Excel's cell text limit")
                        sheet.cell(row_index, column_index, value)
                    row_index += 1
                row_index += 2
        book.save(output)
        return result([output], "PyMuPDF + openpyxl", ["Only detected tables are reconstructed; verify cells against source."])
    if ext == ".pptx":
        try:
            from pptx import Presentation
            from PIL import Image
        except ImportError:
            fail("backend_unavailable", "python-pptx/Pillow are required")
        prs = Presentation()
        blank = prs.slide_layouts[6]
        for page in document:
            if page.rect.width * page.rect.height * 1.5 * 1.5 > 40_000_000:
                fail("limit_exceeded", "PDF page to PowerPoint raster would exceed 40 megapixels")
            pix = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
            png = pix.tobytes("png")
            slide = prs.slides.add_slide(blank)
            slide.shapes.add_picture(io.BytesIO(png), 0, 0, width=prs.slide_width, height=prs.slide_height)
        prs.save(output)
        return result([output], "PyMuPDF + python-pptx", ["Slides preserve visual appearance as images, not editable elements."])
    fail("unsupported_format", ext)


def office_to_pdf_win32(source, output):
    """Use separately owned, read-only Office automation; never attach to a user's open Office instance."""
    if os.name != "nt":
        fail("backend_unavailable", "Windows Office automation is unavailable")
    try:
        import pythoncom
        from win32com.client import DispatchEx
    except ImportError:
        fail("backend_unavailable", "pywin32 is not installed")
    ensure_new([output])
    suffix = Path(source).suffix.lower()
    pythoncom.CoInitialize()
    app = None
    document = None
    try:
        if suffix == ".docx":
            app = DispatchEx("Word.Application")
            app.Visible = False
            app.DisplayAlerts = 0
            app.AutomationSecurity = 3
            document = app.Documents.Open(str(Path(source).resolve()), ReadOnly=True,
                                           ConfirmConversions=False, AddToRecentFiles=False,
                                           NoEncodingDialog=True)
            document.ExportAsFixedFormat(str(Path(output).resolve()), 17)
        elif suffix == ".xlsx":
            app = DispatchEx("Excel.Application")
            app.Visible = False
            app.DisplayAlerts = False
            app.AutomationSecurity = 3
            document = app.Workbooks.Open(str(Path(source).resolve()), UpdateLinks=0,
                                          ReadOnly=True, IgnoreReadOnlyRecommended=True,
                                          AddToMru=False)
            document.ExportAsFixedFormat(0, str(Path(output).resolve()))
        elif suffix == ".pptx":
            app = DispatchEx("PowerPoint.Application")
            app.AutomationSecurity = 3
            document = app.Presentations.Open(str(Path(source).resolve()), ReadOnly=True, Untitled=False, WithWindow=False)
            document.SaveAs(str(Path(output).resolve()), 32)
        else:
            fail("unsupported_format", suffix)
        if not Path(output).is_file():
            fail("office_conversion_failed", "Office did not produce a PDF")
        return result([output], "Microsoft Office read-only COM export")
    except Exception:
        Path(output).unlink(missing_ok=True)
        raise
    finally:
        if document is not None:
            try:
                if suffix == ".xlsx":
                    document.Close(SaveChanges=False)
                else:
                    document.Close()
            except Exception:
                pass
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass
        pythoncom.CoUninitialize()


def office_to_pdf(source, output):
    binary = shutil.which("soffice") or shutil.which("libreoffice")
    if not binary:
        return office_to_pdf_win32(source, output)
    ensure_new([output])
    with tempfile.TemporaryDirectory(prefix="superagent-office-") as directory:
        profile = Path(directory) / "profile"
        args = [binary, "-env:UserInstallation=" + profile.as_uri(), "--headless", "--convert-to", "pdf", "--outdir", directory, source]
        completed = subprocess.run(args, capture_output=True, text=True, timeout=100, check=False)
        candidate = Path(directory) / (Path(source).stem + ".pdf")
        if completed.returncode != 0 or not candidate.exists():
            fail("office_conversion_failed", completed.stderr or completed.stdout)
        shutil.move(str(candidate), output)
    return result([output], "LibreOffice")


def main(task):
    kind = task["kind"]
    source = task.get("source")
    output = task.get("output")
    if kind == "render_pdf":
        return render_pdf(source, output, bool(task.get("allPages")), int(task.get("page", 1)), int(task.get("dpi", 144)))
    if kind == "image_document":
        return write_picture_document(task["sources"], output, task["targetExt"])
    if kind == "pdf_editable":
        return pdf_to_editable(source, output, task["targetExt"])
    if kind == "office_pdf":
        return office_to_pdf(source, output)
    if kind == "office_image":
        suffix = Path(output).suffix
        with tempfile.TemporaryDirectory(prefix="superagent-office-render-") as folder:
            temp_pdf = str(Path(folder) / (Path(source).stem + ".pdf"))
            office_to_pdf(source, temp_pdf)
            return render_pdf(temp_pdf, output, bool(task.get("allPages")), int(task.get("page", 1)), int(task.get("dpi", 144)))
    if kind == "remove_background":
        try:
            from rembg import remove, new_session
        except ImportError:
            fail("backend_unavailable", "rembg is not installed. Install the pinned optional local rembg runtime and model.")
        model = task.get("model", "u2netp")
        if model not in ("u2net", "u2netp", "isnet-general-use"):
            fail("invalid_model", "Model is not on the local adapter allowlist")
        home = Path.home() / ".u2net"
        if not (home / (model + ".onnx")).exists():
            fail("model_unavailable", "Model weights are not provisioned locally; no automatic download permitted")
        ensure_new([output])
        with open(source, "rb") as stream:
            source_bytes = stream.read()
        processed = remove(source_bytes, session=new_session(model))
        with open(output, "xb") as stream:
            stream.write(processed)
        return result([output], "rembg:" + model)
    fail("unsupported_operation", kind)


if __name__ == "__main__":
    try:
        print(json.dumps({"status": "ok", **main(json.loads(sys.argv[1]))}))
    except Exception as error:
        message = str(error)[:400]
        code = message.split(":", 1)[0] if ":" in message else "backend_error"
        print(json.dumps({"status": "failed", "code": code, "message": message}))
        sys.exit(1)
