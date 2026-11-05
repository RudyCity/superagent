#!/usr/bin/env python3
"""Conservative pikepdf (MPL-2.0) content-stream operations for SuperAgent.

This is deliberately NOT a general-purpose text editor. It supports ONE exact
ASCII text-show operator in ONE simple, noninteractive, unrotated PDF page.
Reject complex font encodings, XObjects, marked content, reused/ambiguous text,
encrypted/signed PDFs, suspicious graphics/text state, or missing bbox.
No source edits are made. The TypeScript caller verifies and publishes output.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import unicodedata
from pathlib import Path

import pikepdf
from pdfminer.high_level import extract_pages, extract_text
from pdfminer.layout import LTTextBox, LTTextContainer, LTTextLine

UNSAFE_OPERATORS = {"'", '"', "Do", "BI", "EI", "BDC", "BMC", "EMC", "Tz", "Tr", "Ts"}
TEXT_SHOW = {"Tj", "TJ", "'", '"'}


class Unsupported(Exception):
    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code


def reject(code: str, message: str):
    raise Unsupported(code, message)


def each_line(layout):
    for item in layout:
        if isinstance(item, LTTextLine):
            yield item
        elif isinstance(item, LTTextContainer) or hasattr(item, "__iter__"):
            try:
                yield from each_line(item)
            except TypeError:
                continue


def load_bbox(path: str, page_number: int, target: str):
    found = []
    for page_layout in extract_pages(path, page_numbers=[page_number - 1]):
        for line in each_line(page_layout):
            if line.get_text().strip() == target:
                found.append(tuple(float(round(v, 3)) for v in line.bbox))
    if len(found) != 1:
        reject("ambiguous_text_geometry", "Expected one unique visible text line with exactly the target string.")
    return found[0]


def check_ascii(value: object, field: str):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        reject("invalid_text", field + " must be nonempty ASCII text up to 200 chars.")
    if not all(32 <= ord(ch) <= 126 for ch in value):
        reject("unsupported_unicode", "Exact content-stream modification currently supports printable ASCII only.")
    return value


def check_embedded_unicode(value: object, field: str):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        reject("invalid_text", field + " must contain 1..200 Unicode characters.")
    if value != unicodedata.normalize("NFC", value):
        reject("unsupported_unicode", "Normalize Unicode text to NFC before editing.")
    # This first increment supports Latin Indonesian/English punctuation and
    # diacritics only. RTL shaping/combining marks, ligatures and CJK
    # replacement are deliberately NOT claimed or silently guessed.
    for char in value:
        cp = ord(char)
        if not (32 <= cp <= 0x024F or cp in (0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026)):
            reject("unsupported_unicode", "Embedded Unicode exact edit supports Latin ID/EN glyphs and selected punctuation only.")
        if unicodedata.category(char).startswith(("C", "M")):
            reject("unsupported_unicode", "Complex Unicode shaping or control sequences are not supported.")
    return value


def embedded_subset_cmap(font):
    if str(font.get("/Subtype", "")) != "/Type0" or str(font.get("/Encoding", "")) != "/Identity-H":
        reject("unsupported_font", "Embedded Unicode editing requires Identity-H Type0 CID font.")
    descendants = font.get("/DescendantFonts", [])
    if len(descendants) != 1:
        reject("unsupported_font", "Expected one embedded CID descendant font.")
    descriptor = descendants[0].get("/FontDescriptor", {})
    if not any(name in descriptor for name in ("/FontFile2", "/FontFile3")):
        reject("unsupported_font", "Original embedded CID font data is missing.")
    if "/ToUnicode" not in font:
        reject("unsupported_font", "Embedded CID font lacks an explicit ToUnicode mapping.")
    cmap_bytes = font["/ToUnicode"].read_bytes()
    if not cmap_bytes or len(cmap_bytes) > 1_000_000:
        reject("unsupported_font", "CID CMap is missing or too large.")
    try:
        cmap_text = cmap_bytes.decode("ascii")
    except UnicodeError:
        reject("unsupported_font", "CID CMap must be bounded ASCII syntax.")
    if re.search(r"beginbfrange|usecmap", cmap_text, re.IGNORECASE):
        reject("unsupported_font", "Ranged/inherited CID CMaps need a separate font engine.")
    if "<0000><ffff>" not in cmap_text.replace(" ", ""):
        reject("unsupported_font", "Expected a fixed two-byte Identity-H character code space.")
    mappings = {}
    for block in re.findall(r"beginbfchar\s*(.*?)\s*endbfchar", cmap_text, re.DOTALL):
        for line in block.splitlines():
            match = re.fullmatch(r"\s*<([0-9A-Fa-f]{4})>\s+<([0-9A-Fa-f]{4,8})>\s*", line)
            if not match:
                continue
            src = bytes.fromhex(match.group(1))
            try:
                decoded = bytes.fromhex(match.group(2)).decode("utf-16-be")
            except UnicodeDecodeError:
                reject("unsupported_font", "CID CMap contains invalid Unicode code points.")
            if len(decoded) != 1 or src in mappings:
                reject("unsupported_font", "CID CMap has ambiguous one-to-one mappings.")
            mappings[src] = decoded
    if not 1 <= len(mappings) <= 256:
        reject("unsupported_font", "CID mapping size is unsupported.")
    reverse = {}
    for cid, character in mappings.items():
        if character in reverse:
            reject("unsupported_font", "Multiple CIDs map to one Unicode glyph; refuse ambiguous edits.")
        reverse[character] = cid
    return mappings, reverse


def count_vector_strokes(stream):
    return sum(1 for _, op in stream if str(op) in {"S", "s", "f", "F", "f*", "B", "B*"})


def edit(request: dict) -> dict:
    source = Path(request["inputPath"]).resolve(strict=True)
    output = Path(request["stagingPath"]).resolve()
    if output.exists():
        reject("already_exists", "Staging output already exists.")
    if not source.is_file() or source.stat().st_size > 100_000_000:
        reject("invalid_input", "Source must be a regular PDF no larger than 100 MB.")
    expected_hash = request.get("expectedInputSha256", "")
    current_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if current_hash != expected_hash:
        reject("hash_mismatch", "Input changed before vector edit.")
    page_num = request.get("page")
    if type(page_num) is not int or page_num < 1:
        reject("invalid_input", "page must be a 1-based integer.")
    mode = request.get("mode")
    if mode not in ("replace_exact", "redact_exact"):
        reject("invalid_input", "Mode must be replace_exact or redact_exact.")
    font_policy = request.get("fontPolicy", "standard14")
    if font_policy not in ("standard14", "embedded_subset"):
        reject("invalid_input", "fontPolicy must be standard14 or embedded_subset.")
    if mode == "redact_exact" and font_policy != "standard14":
        reject("unsupported_content", "Embedded Unicode redaction is not independently forensically certified; use approved raster redaction.")
    validate = check_embedded_unicode if font_policy == "embedded_subset" else check_ascii
    target = validate(request.get("targetText"), "targetText")
    new_text = validate(request.get("replacementText"), "replacementText") if mode == "replace_exact" else None
    if new_text == target:
        reject("invalid_input", "Replacement must differ from target.")
    original_text = extract_text(str(source))
    if original_text.count(target) != 1:
        reject("ambiguous_text", "Target must appear exactly once across the extracted document.")
    bbox = load_bbox(str(source), page_num, target)
    # Incremental updates can preserve old, recoverable revision bytes.
    # A normalized rewrite normally drops them, but this restricted backend
    # refuses to certify removal without a complete historical object audit.
    if mode == "redact_exact" and b"/Prev" in source.read_bytes():
        reject("unsupported_revision", "PDF has an incremental revision history; scoped redaction is not independently certified.")
    with pikepdf.Pdf.open(source) as pdf:
        if pdf.is_encrypted:
            reject("password_required", "Encrypted PDFs cannot be modified.")
        if page_num > len(pdf.pages) or len(pdf.pages) > 500:
            reject("invalid_input", "Unsupported PDF page count.")
        # Redacting the visible text operator MUST NOT be certified if
        # additional PDF structures could retain sensitive source bytes.
        # Restricting input now is safer than pretending to support global scrub.
        if mode == "redact_exact":
            if "/Names" in pdf.Root or "/Metadata" in pdf.Root or "/AF" in pdf.Root:
                reject("unsupported_sensitive_container", "Attachments, names or XMP metadata require all-object redaction and independent forensic verification.")
            if "/OpenAction" in pdf.Root or "/AA" in pdf.Root or "/OCProperties" in pdf.Root or "/StructTreeRoot" in pdf.Root:
                reject("unsupported_sensitive_container", "Actions, optional layers or tagged content cannot be securely sanitized in exact-redact mode.")
            try:
                info = pdf.docinfo
                if any(target.casefold() in str(v).casefold() for v in info.values()):
                    reject("metadata_target", "Selected sensitive text also appears in document metadata; single-operator redaction refused.")
            except (TypeError, AttributeError):
                reject("unsupported_metadata", "Cannot independently scan PDF document metadata.")
        page = pdf.pages[page_num - 1]
        if mode == "redact_exact" and "/Metadata" in page.obj:
            reject("unsupported_sensitive_container", "Page XMP metadata may preserve sensitive text.")
        if int(page.obj.get("/Rotate", 0)) % 360 != 0:
            reject("unsupported_geometry", "Rotated pages are not supported.")
        if "/CropBox" in page.obj and list(page.obj.CropBox) != list(page.obj.MediaBox):
            reject("unsupported_geometry", "Cropped pages are not supported.")
        if ("/Annots" in page.obj and len(page.obj.Annots) > 0) or (
            "/AcroForm" in pdf.Root and len(pdf.Root.AcroForm.get("/Fields", [])) > 0
        ):
            reject("unsupported_interactive", "Nonempty AcroForms and annotations cannot be preserved safely in exact-edit mode.")
        resources = page.obj.get("/Resources", pikepdf.Dictionary())
        if len(resources.get("/XObject", {})) > 0:
            reject("unsupported_content", "XObjects require an advanced geometry engine.")
        for state in resources.get("/ExtGState", {}).values():
            # pdf-lib uses GS objects for normal opacity=1. Preserve those
            # verbatim; fail on any transparency, blend or advanced state.
            if (float(state.get("/ca", 1)) != 1.0
                or float(state.get("/CA", 1)) != 1.0
                or str(state.get("/BM", "/Normal")) != "/Normal"
                or any(str(key) not in {"/Type", "/ca", "/CA", "/BM"} for key in state.keys())):
                reject("unsupported_content", "Nontrivial transparency or graphics state cannot be verified.")
        if "/Pattern" in resources or "/Shading" in resources:
            reject("unsupported_content", "Patterns and shadings are not supported for verified local editing.")

        original_ops = list(pikepdf.parse_content_stream(page))
        if not original_ops or len(original_ops) > 12000:
            reject("unsupported_content", "Empty or overly complex content stream.")
        if any(str(op) in UNSAFE_OPERATORS for _, op in original_ops):
            reject("unsupported_content", "Text state, XObject or marked-content operators cannot be safely mapped.")

        font_refs = resources.get("/Font", {})
        cid_map = None
        cid_reverse = None
        if font_policy == "embedded_subset":
            if len(font_refs) != 1:
                reject("unsupported_font", "Unicode editing currently needs exactly one embedded font resource.")
            cid_map, cid_reverse = embedded_subset_cmap(next(iter(font_refs.values())))
            if any(character not in cid_reverse for character in new_text):
                reject("missing_glyph", "A replacement glyph is not in the original embedded font subset.")
        else:
            if not font_refs or len(font_refs) > 2:
                reject("unsupported_font", "Exactly one or two simple Standard-14 font resources are supported.")
            for font in font_refs.values():
                if str(font.get("/Subtype", "")) != "/Type1":
                    reject("unsupported_font", "Subsetted/embedded fonts require an explicit font-aware editing policy.")
                base_name = str(font.get("/BaseFont", ""))
                if base_name not in {"/Helvetica", "/Helvetica-Bold", "/Times-Roman", "/Times-Bold", "/Courier", "/Courier-Bold"}:
                    reject("unsupported_font", "Only unembedded standard fonts with known encodings are supported.")
                if "/ToUnicode" in font or "/FontDescriptor" in font:
                    reject("unsupported_font", "Complex font mappings and embedded glyphs require explicit policy.")
        active_text = False
        count_text_shows = 0
        seen_targets = []
        replacement_ops = []
        for operands, operator in original_ops:
            name = str(operator)
            if name == "BT":
                active_text = True
                count_text_shows = 0
            if name in ("Tj", "TJ"):
                count_text_shows += 1
                if len(operands) != 1:
                    reject("unsupported_content", "Text-show must have exactly one operand.")
                if name == "Tj":
                    if not isinstance(operands[0], pikepdf.String):
                        reject("unsupported_content", "Tj must contain one literal string.")
                    if font_policy == "embedded_subset":
                        raw = bytes(operands[0])
                        if not raw or len(raw) % 2:
                            reject("unsupported_font", "CID operator has invalid two-byte glyph encoding.")
                        try:
                            shown = "".join(cid_map[raw[i:i+2]] for i in range(0, len(raw), 2))
                        except KeyError:
                            reject("unsupported_font", "Original glyph code is absent from ToUnicode mapping.")
                    else:
                        shown = str(operands[0])
                else:
                    if font_policy == "embedded_subset":
                        reject("unsupported_content", "Embedded CID Unicode editing currently supports a single Tj operator, not TJ.")
                    # A single TJ array may fragment one line over strings
                    # and bounded numeric kerning adjustments. Refuse CID,
                    # nested objects and large offsets rather than guessing.
                    if not isinstance(operands[0], pikepdf.Array):
                        reject("unsupported_content", "TJ must contain one simple array.")
                    pieces = []
                    for fragment in operands[0]:
                        if isinstance(fragment, pikepdf.String):
                            chunk = str(fragment)
                            if not chunk or not all(32 <= ord(c) <= 126 for c in chunk):
                                reject("unsupported_content", "TJ fragments must be printable ASCII.")
                            pieces.append(chunk)
                        elif isinstance(fragment, (int, float)) and not isinstance(fragment, bool):
                            if not -100 <= float(fragment) <= 100:
                                reject("unsupported_content", "TJ kerning offset exceeds bounded safe range.")
                        else:
                            reject("unsupported_content", "TJ contains unsupported encoded objects.")
                    if not pieces or sum(map(len, pieces)) > 200:
                        reject("unsupported_content", "TJ operand is empty or oversized.")
                    shown = "".join(pieces)
                if shown == target:
                    if not active_text or count_text_shows != 1:
                        reject("unsupported_content", "Target must be the only text-show in its text object.")
                    seen_targets.append(len(replacement_ops))
                    if mode == "replace_exact":
                        if name == "TJ":
                            replacement_ops.append(([pikepdf.Array([pikepdf.String(new_text)])], operator))
                        else:
                            encoded = b"".join(cid_reverse[char] for char in new_text) if font_policy == "embedded_subset" else new_text
                            replacement_ops.append(([pikepdf.String(encoded)], operator))
                    # Removing TJ removes all original target text fragments;
                    # preserving the rest of the BT object and vector artwork.
                    continue
            if name == "ET":
                if active_text and seen_targets and count_text_shows > 1:
                    reject("unsupported_content", "Multiple shows in a target BT object are ambiguous.")
                active_text = False
            replacement_ops.append((operands, operator))
        if len(seen_targets) != 1:
            reject("ambiguous_text", "Target did not map to one unique literal Tj operator.")

        stroke_count = count_vector_strokes(original_ops)
        page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(replacement_ops))
        if mode == "redact_exact":
            x0, y0, x1, y1 = bbox
            # Add a non-raster vector rectangle precisely around the original
            # visible text bbox plus a modest anti-alias margin.
            margin = 1.25
            rect = (
                f"\nq 0 0 0 rg {x0-margin:.3f} {y0-margin:.3f} "
                f"{x1-x0+2*margin:.3f} {y1-y0+2*margin:.3f} re f Q\n"
            ).encode("ascii")
            page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(replacement_ops) + rect)
        pdf.save(str(output), object_stream_mode=pikepdf.ObjectStreamMode.disable)

    # Independent rendering/text decoding step from pdfminer.six.
    after_text = extract_text(str(output))
    if target in after_text:
        reject("verification_failed", "Original target is still extractable after rewrite; do not publish.")
    if mode == "replace_exact":
        if after_text.count(new_text) != 1:
            reject("verification_failed", "Replacement is not extractable exactly once.")
        after_box = load_bbox(str(output), page_num, new_text)
        # Do not claim perfect layout: no reflow takes place; the replacement
        # baseline starts at the exact source operator position, and other
        # drawing operators remain in the same order.
        if abs(after_box[0] - bbox[0]) > 0.75 or abs(after_box[1] - bbox[1]) > 0.75:
            reject("layout_mismatch", "Replacement moved the text baseline.")
        if font_policy == "embedded_subset" and (after_box[2] > bbox[2] + 0.5 or after_box[3] > bbox[3] + 0.5):
            reject("layout_overflow", "Embedded-font replacement exceeds the original text bounding box; refuse unapproved reflow.")
    with pikepdf.Pdf.open(str(output)) as after:
        target_page = after.pages[page_num - 1]
        final_ops = list(pikepdf.parse_content_stream(target_page))
        for operands, op in final_ops:
            if str(op) == "Tj" and any(str(v) == target for v in operands):
                reject("verification_failed", "Original text still exists in a Tj operator.")
            if str(op) == "TJ" and len(operands) == 1 and isinstance(operands[0], pikepdf.Array):
                remaining = "".join(str(v) for v in operands[0] if isinstance(v, pikepdf.String))
                if target in remaining:
                    reject("verification_failed", "Original text still exists in fragmented TJ content.")
        if mode == "replace_exact" and count_vector_strokes(final_ops) != stroke_count:
            reject("verification_failed", "Nontext vector painting operators changed unexpectedly.")
        if mode == "redact_exact" and count_vector_strokes(final_ops) != stroke_count + 1:
            reject("verification_failed", "Vector redaction rectangle missing.")
    raw = output.read_bytes()
    if len(raw) > 100_000_000:
        reject("size_limit", "Resulting PDF exceeds size limit.")
    # Avoid claiming complete privacy for arbitrary PDFs; only one literal source
    # operator is removed, other PDF structures may still have related content.
    return {
        "status": "verified", "stagingSha256": hashlib.sha256(raw).hexdigest(),
        "mode": mode, "page": page_num, "originalText": target if mode == "replace_exact" else None,
        "replacementText": new_text if mode == "replace_exact" else None,
        "originalBoundingBox": bbox,
        "vectorGraphicsPreserved": True,
        "selectableTextOutsideTargetPreserved": True,
        "verificationScopes": {
            "matchedTextOperator": "unique_Tj_or_bounded_TJ" if font_policy == "standard14" else "unique_embedded_Type0_IdentityH_Tj",
            "fontPolicy": font_policy,
            "originalTextAbsentInExtraction": True,
            "targetOperatorRemoved": True,
            "vectorPaintOperatorCount": "preserved" if mode == "replace_exact" else "preserved_plus_black_rectangle",
            "fullLayoutPixelParity": "not_certified",
            "hiddenMetadataOrOtherSensitiveInfo": "unsupported_containers_refused_not_forensically_certified",
        },
        "warnings": [
            "Supports only one exact ASCII Standard-14 Tj or bounded fragmented TJ text operator; other PDF structures fail closed.",
            "No document reflow; replacement may differ in width and visual fit. Review render before use.",
            "Vector redaction removes the exact content stream operator, but cannot independently certify all sensitive information in metadata or linked objects.",
        ],
    }


def main():
    try:
        content = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(content) > 16 * 1024:
            reject("size_limit", "Backend JSON request too large.")
        request = json.loads(content.decode("utf-8"))
        if not isinstance(request, dict):
            reject("invalid_input", "Expected JSON object.")
        print(json.dumps(edit(request), ensure_ascii=False))
    except Unsupported as err:
        print(json.dumps({"status": "failed", "code": err.code, "message": str(err)}))
    except Exception:
        # Do not leak document contents, paths or secret strings in error output.
        print(json.dumps({"status": "failed", "code": "advanced_backend_failed", "message": "Unable to safely process this PDF with the restricted vector backend."}))


if __name__ == "__main__":
    main()
