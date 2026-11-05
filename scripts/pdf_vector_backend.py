#!/usr/bin/env python3
"""Conservative pikepdf (MPL-2.0) content-stream operations for SuperAgent.

This is deliberately NOT a general-purpose text editor. It supports ONE unique
verified text line in an unrotated, uncropped, noninteractive PDF page: a
restricted Standard-14 Tj/TJ/multi-Tj path or an embedded Type0 Identity-H
Latin Tj/TJ path using existing glyphs. Simple sequential ToUnicode bfrange,
untouched Image XObjects, preserved graphics-state/Tr=0 operators and explicit
bounded fit geometry are supported for replacement. Form/unknown XObjects,
arbitrary reflow, complex CMaps, signed/encrypted PDFs and ambiguous geometry
still fail closed. No source edits are made; the TypeScript caller independently
verifies extraction, integrity and publication.
"""
from __future__ import annotations

import hashlib
import json
import decimal
import math
import os
import re
import sys
import unicodedata
from pathlib import Path

import pikepdf
from pdfminer.high_level import extract_pages, extract_text
from pdfminer.layout import LTTextBox, LTTextContainer, LTTextLine

UNSAFE_OPERATORS = {"'", '"', "BI", "EI", "BDC", "BMC", "EMC", "Tz", "Ts"}
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


def normalize_visible_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def load_bbox(path: str, page_number: int, target: str, collapse_whitespace: bool = False):
    found = []
    expected = normalize_visible_text(target) if collapse_whitespace else target
    for page_layout in extract_pages(path, page_numbers=[page_number - 1]):
        for line in each_line(page_layout):
            actual = line.get_text().strip()
            if collapse_whitespace:
                actual = normalize_visible_text(actual)
            if actual == expected:
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
    if re.search(r"usecmap", cmap_text, re.IGNORECASE):
        reject("unsupported_font", "Inherited CID CMaps need a separate font engine.")
    if not re.search(r"<0000>\s*<FFFF>", cmap_text, re.IGNORECASE):
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
    for block in re.findall(r"beginbfrange\s*(.*?)\s*endbfrange", cmap_text, re.DOTALL):
        for line in block.splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(
                r"\s*<([0-9A-Fa-f]{4})>\s+<([0-9A-Fa-f]{4})>\s+<([0-9A-Fa-f]{4,8})>\s*",
                line,
            )
            if not match:
                reject("unsupported_font", "Only simple sequential CID bfrange mappings are supported.")
            start = int(match.group(1), 16)
            end = int(match.group(2), 16)
            if end < start or end - start > 255:
                reject("unsupported_font", "CID bfrange is invalid or too large.")
            destination = bytes.fromhex(match.group(3))
            destination_value = int.from_bytes(destination, "big")
            for offset, code in enumerate(range(start, end + 1)):
                src = code.to_bytes(2, "big")
                try:
                    decoded = (destination_value + offset).to_bytes(len(destination), "big").decode("utf-16-be")
                except (OverflowError, UnicodeDecodeError):
                    reject("unsupported_font", "CID bfrange contains invalid Unicode code points.")
                if len(decoded) != 1 or src in mappings:
                    reject("unsupported_font", "CID bfrange has ambiguous one-to-one mappings.")
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
    fit_bounds = request.get("fitBounds")
    if fit_bounds is not None:
        if mode != "replace_exact" or font_policy != "embedded_subset" or not isinstance(fit_bounds, dict):
            reject("invalid_input", "fitBounds is only supported for embedded-subset text replacement.")
        if set(fit_bounds) != {"x0", "y0", "x1", "y1"}:
            reject("invalid_input", "fitBounds requires exactly x0,y0,x1,y1 in bottom-left PDF points.")
        if not all(type(fit_bounds[k]) in (int, float) and math.isfinite(fit_bounds[k]) for k in fit_bounds):
            reject("invalid_input", "fitBounds must contain finite numeric page coordinates.")
        x0, y0, x1, y1 = (float(fit_bounds[k]) for k in ("x0", "y0", "x1", "y1"))
        if not (10 <= x1 - x0 <= 450 and 6 <= y1 - y0 <= 120):
            reject("invalid_input", "fitBounds must be a bounded visible page region.")
        fit_bounds = (x0, y0, x1, y1)
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
        xobjects = resources.get("/XObject", {})
        if mode == "redact_exact" and len(xobjects) > 0:
            reject("unsupported_content", "Exact vector redaction still refuses XObjects; use reviewed raster redaction.")
        image_xobjects = set()
        for xobject_name, xobject in xobjects.items():
            if str(xobject.get("/Subtype", "")) != "/Image":
                reject("unsupported_content", "Only untouched Image XObjects are supported for exact text replacement.")
            image_xobjects.add(str(xobject_name))
        ext_states = resources.get("/ExtGState", {})
        if len(ext_states) > 64:
            reject("unsupported_content", "ExtGState dictionary is too large for restricted exact editing.")
        if mode == "redact_exact":
            for state in ext_states.values():
                # Redaction adds new opaque paint and therefore remains strict:
                # any pre-existing transparency/blend state requires a broader
                # renderer-aware sanitization path.
                if (float(state.get("/ca", 1)) != 1.0
                    or float(state.get("/CA", 1)) != 1.0
                    or str(state.get("/BM", "/Normal")) != "/Normal"
                    or any(str(key) not in {"/Type", "/ca", "/CA", "/BM"} for key in state.keys())):
                    reject("unsupported_content", "Nontrivial transparency or graphics state cannot be certified for exact redaction.")
        if len(resources.get("/Pattern", {})) > 0 or len(resources.get("/Shading", {})) > 0:
            reject("unsupported_content", "Nonempty patterns and shadings are not supported for verified local editing.")

        original_ops = list(pikepdf.parse_content_stream(page))
        if not original_ops or len(original_ops) > 12000:
            reject("unsupported_content", "Empty or overly complex content stream.")
        for operands, op in original_ops:
            name = str(op)
            if name == "Tr" and mode == "replace_exact":
                if len(operands) == 1 and float(operands[0]) == 0:
                    continue  # Ordinary fill text rendering; preserved unchanged.
            if name in UNSAFE_OPERATORS:
                reject("unsupported_content", "Unsupported text state, inline image or marked-content operators cannot be safely mapped.")
        image_do_sequence = []
        graphics_state_sequence = []
        text_render_mode_sequence = []
        ext_state_names = {str(k) for k in ext_states.keys()}
        for operands, op in original_ops:
            if str(op) == "Tr":
                if len(operands) != 1 or float(operands[0]) != 0.0:
                    reject("unsupported_content", "Only normal fill text rendering mode Tr=0 is supported.")
                text_render_mode_sequence.append(0)
                continue
            name = str(op)
            if name == "gs":
                if len(operands) != 1 or str(operands[0]) not in ext_state_names:
                    reject("unsupported_content", "Graphics-state invocation does not resolve to page ExtGState.")
                graphics_state_sequence.append(str(operands[0]))
                continue
            if name != "Do":
                continue
            if len(operands) != 1 or str(operands[0]) not in image_xobjects:
                reject("unsupported_content", "XObject invocation does not resolve to an approved Image XObject.")
            image_do_sequence.append(str(operands[0]))

        # Restricted multi-run support: several consecutive literal Tj shows in
        # ONE BT..ET object may form a single visual line. There must be no
        # positioning/state/operator between the fragments. This preserves the
        # original font/text matrix and replaces only the first show while
        # removing the remaining source fragments.
        multi_tj_candidate = None
        if font_policy == "standard14":
            in_text = False
            block_shows = []
            block_between = []
            previous_show_idx = None
            for idx, (operands, operator) in enumerate(original_ops):
                name = str(operator)
                if name == "BT":
                    in_text = True
                    block_shows = []
                    block_between = []
                    previous_show_idx = None
                    continue
                if name == "ET":
                    if len(block_shows) >= 2 and all(item[1] == "Tj" for item in block_shows):
                        combined = "".join(item[2] for item in block_shows)
                        if combined == target:
                            if block_between:
                                reject("unsupported_content", "Multi-run target has intervening text/layout operators; refuse ambiguous geometry.")
                            if multi_tj_candidate is not None:
                                reject("ambiguous_text", "Target maps to more than one multi-run text object.")
                            multi_tj_candidate = [item[0] for item in block_shows]
                    in_text = False
                    continue
                if not in_text:
                    continue
                if name in ("Tj", "TJ"):
                    if name != "Tj" or len(operands) != 1 or not isinstance(operands[0], pikepdf.String):
                        block_shows.append((idx, name, ""))
                    else:
                        value = str(operands[0])
                        if not value or not all(32 <= ord(c) <= 126 for c in value):
                            reject("unsupported_content", "Multi-run Tj fragments must be printable ASCII.")
                        block_shows.append((idx, name, value))
                    previous_show_idx = idx
                elif previous_show_idx is not None:
                    # Any operator after the first show and before ET makes
                    # relative placement/state ambiguous for multi-run editing.
                    block_between.append(idx)

        collapse_whitespace = mode == "replace_exact"
        expected_visible = normalize_visible_text(target) if collapse_whitespace else target
        original_text = extract_text(str(source))
        matching_lines = sum(
            1 for line in original_text.splitlines()
            if (normalize_visible_text(line) if collapse_whitespace else line.strip()) == expected_visible
        )
        if matching_lines != 1:
            reject("ambiguous_text", "Target must map to exactly one extracted visual line.")
        bbox = load_bbox(str(source), page_num, target, collapse_whitespace)
        if fit_bounds is not None:
            media = [float(v) for v in page.obj.MediaBox]
            if (not media[0] <= fit_bounds[0] < fit_bounds[2] <= media[2] or
                not media[1] <= fit_bounds[1] < fit_bounds[3] <= media[3]):
                reject("invalid_input", "fitBounds must lie inside the source page MediaBox.")
            if (bbox[0] < fit_bounds[0] - 0.5 or bbox[1] < fit_bounds[1] - 0.5 or
                bbox[2] > fit_bounds[2] + 0.5 or bbox[3] > fit_bounds[3] + 0.5):
                reject("fit_bounds_invalid", "Original target line is not inside the approved fitBounds.")

        font_refs = resources.get("/Font", {})
        embedded_maps = {}
        if font_policy == "embedded_subset":
            if not font_refs or len(font_refs) > 16:
                reject("unsupported_font", "Embedded Unicode editing requires a bounded page font resource dictionary.")
            for font_name, font in font_refs.items():
                try:
                    embedded_maps[str(font_name)] = embedded_subset_cmap(font)
                except Unsupported:
                    # Preserve unrelated fonts verbatim. The font actually
                    # active for the unique target must pass the strict parser.
                    embedded_maps[str(font_name)] = None
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
        active_font_name = None
        count_text_shows = 0
        seen_targets = []
        replacement_ops = []
        replacement_show_index = None
        multi_first = multi_tj_candidate[0] if multi_tj_candidate else None
        multi_rest = set(multi_tj_candidate[1:]) if multi_tj_candidate else set()
        for op_index, (operands, operator) in enumerate(original_ops):
            name = str(operator)
            if name == "BT":
                active_text = True
                active_font_name = None
                count_text_shows = 0
            if name == "Tf":
                if len(operands) != 2:
                    reject("unsupported_content", "Tf must contain a font resource and size.")
                active_font_name = str(operands[0])
            if name in ("Tj", "TJ"):
                count_text_shows += 1
                if multi_tj_candidate and op_index == multi_first:
                    seen_targets.append(len(replacement_ops))
                    if mode == "replace_exact":
                        replacement_ops.append(([pikepdf.String(new_text)], operator))
                    continue
                if multi_tj_candidate and op_index in multi_rest:
                    continue
                if len(operands) != 1:
                    reject("unsupported_content", "Text-show must have exactly one operand.")
                if name == "Tj":
                    if not isinstance(operands[0], pikepdf.String):
                        reject("unsupported_content", "Tj must contain one literal string.")
                    if font_policy == "embedded_subset":
                        active_mapping = embedded_maps.get(active_font_name)
                        if active_mapping is None:
                            shown = None
                        else:
                            cid_map, _ = active_mapping
                            raw = bytes(operands[0])
                            if not raw or len(raw) % 2:
                                shown = None
                                raw = b""
                            try:
                                shown = "".join(cid_map[raw[i:i+2]] for i in range(0, len(raw), 2))
                            except KeyError:
                                shown = None
                    else:
                        shown = str(operands[0])
                else:
                    # A single TJ array may fragment one line over strings
                    # and bounded numeric kerning adjustments. Embedded
                    # Identity-H fragments are decoded through the exact same
                    # verified ToUnicode map as a Tj operator.
                    if not isinstance(operands[0], pikepdf.Array):
                        reject("unsupported_content", "TJ must contain one simple array.")
                    pieces = []
                    for fragment in operands[0]:
                        if isinstance(fragment, pikepdf.String):
                            if font_policy == "embedded_subset":
                                active_mapping = embedded_maps.get(active_font_name)
                                if active_mapping is None:
                                    pieces = []
                                    break
                                cid_map, _ = active_mapping
                                raw = bytes(fragment)
                                if not raw or len(raw) % 2:
                                    pieces = []
                                    break
                                try:
                                    chunk = "".join(
                                        cid_map[raw[i:i+2]]
                                        for i in range(0, len(raw), 2)
                                    )
                                except KeyError:
                                    pieces = []
                                    break
                            else:
                                chunk = str(fragment)
                                if not chunk or not all(32 <= ord(c) <= 126 for c in chunk):
                                    reject("unsupported_content", "TJ fragments must be printable ASCII.")
                            pieces.append(chunk)
                        elif isinstance(fragment, (int, float, decimal.Decimal)) and not isinstance(fragment, bool):
                            if not -100 <= float(fragment) <= 100:
                                if font_policy == "embedded_subset":
                                    pieces = []
                                    break
                                reject("unsupported_content", "TJ kerning offset exceeds bounded safe range.")
                        else:
                            if font_policy == "embedded_subset":
                                pieces = []
                                break
                            reject("unsupported_content", "TJ contains unsupported encoded objects.")
                    if not pieces:
                        shown = None
                    elif sum(map(len, pieces)) > 200:
                        reject("unsupported_content", "TJ operand is oversized.")
                    else:
                        shown = "".join(pieces)
                shown_matches_target = (
                    shown is not None and
                    (normalize_visible_text(shown) if collapse_whitespace else shown) == expected_visible
                )
                if shown_matches_target:
                    if not active_text or count_text_shows != 1:
                        reject("unsupported_content", "Target must be the only text-show in its text object.")
                    seen_targets.append(len(replacement_ops))
                    replacement_show_index = len(replacement_ops)
                    if mode == "replace_exact":
                        if font_policy == "embedded_subset":
                            active_mapping = embedded_maps.get(active_font_name)
                            if active_mapping is None:
                                reject("unsupported_font", "Target uses an unsupported embedded font mapping.")
                            _, cid_reverse = active_mapping
                            if any(character not in cid_reverse for character in new_text):
                                reject("missing_glyph", "A replacement glyph is not in the target embedded font subset.")
                            encoded = b"".join(cid_reverse[char] for char in new_text)
                        else:
                            encoded = new_text
                        if name == "TJ":
                            replacement_ops.append(([pikepdf.Array([pikepdf.String(encoded)])], operator))
                        else:
                            replacement_ops.append(([pikepdf.String(encoded)], operator))
                    # Removing TJ removes all original target text fragments;
                    # preserving the rest of the BT object and vector artwork.
                    continue
            if name == "ET":
                if active_text and seen_targets and count_text_shows > 1 and not multi_tj_candidate:
                    reject("unsupported_content", "Multiple shows in a target BT object are ambiguous.")
                active_text = False
            replacement_ops.append((operands, operator))
        if len(seen_targets) != 1:
            reject("ambiguous_text", "Target did not map to one unique literal Tj operator.")

        stroke_count = count_vector_strokes(original_ops)
        page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(replacement_ops))
        fitted_horizontal_scale = 100
        if fit_bounds is not None:
            # Measure the replacement using an independent PDF layout reader.
            # Only the single matched text-show may be horizontally compressed.
            # Restore Tz=100 immediately afterward so later text stays intact.
            measure_path = output.with_name(output.name + ".measure.pdf")
            if measure_path.exists():
                reject("already_exists", "Temporary layout measurement already exists.")
            try:
                pdf.save(str(measure_path), object_stream_mode=pikepdf.ObjectStreamMode.disable)
                provisional = load_bbox(str(measure_path), page_num, new_text, True)
                if abs(provisional[0] - bbox[0]) > 0.75 or abs(provisional[1] - bbox[1]) > 0.75:
                    reject("layout_mismatch", "Replacement moved before bounded fit was applied.")
                width = provisional[2] - provisional[0]
                available = fit_bounds[2] - provisional[0] - 1.0
                if width <= 0 or available <= 0:
                    reject("fit_overflow", "Approved fitBounds have no usable text width.")
                if width > available:
                    fitted_horizontal_scale = math.floor(99.0 * available / width)
                    if fitted_horizontal_scale < 65:
                        reject("fit_overflow", "Text requires excessive horizontal compression.")
                    if replacement_show_index is None:
                        reject("verification_failed", "Target text-show index unavailable.")
                    replacement_ops.insert(replacement_show_index,
                        ([int(fitted_horizontal_scale)], pikepdf.Operator("Tz")))
                    replacement_ops.insert(replacement_show_index + 2,
                        ([100], pikepdf.Operator("Tz")))
                    page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(replacement_ops))
            finally:
                measure_path.unlink(missing_ok=True)
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
    remaining_target_lines = sum(
        1 for line in after_text.splitlines()
        if (normalize_visible_text(line) if collapse_whitespace else line.strip()) == expected_visible
    )
    if remaining_target_lines:
        reject("verification_failed", "Original target is still extractable after rewrite; do not publish.")
    if mode == "replace_exact":
        replacement_visible = normalize_visible_text(new_text)
        replacement_count = sum(
            1 for line in after_text.splitlines()
            if normalize_visible_text(line) == replacement_visible
        )
        if replacement_count != 1:
            reject("verification_failed", "Replacement is not extractable exactly once.")
        after_box = load_bbox(str(output), page_num, new_text, True)
        # Do not claim perfect layout: no reflow takes place; the replacement
        # baseline starts at the exact source operator position, and other
        # drawing operators remain in the same order.
        if abs(after_box[0] - bbox[0]) > 0.75 or abs(after_box[1] - bbox[1]) > 0.75:
            reject("layout_mismatch", "Replacement moved the text baseline.")
        if fit_bounds is not None:
            if (after_box[0] < fit_bounds[0] - 0.75 or after_box[1] < fit_bounds[1] - 0.75 or
                after_box[2] > fit_bounds[2] + 0.75 or after_box[3] > fit_bounds[3] + 0.75):
                reject("fit_overflow", "Replacement leaves approved fitBounds after independent PDF extraction.")
        elif font_policy == "embedded_subset" and (after_box[2] > bbox[2] + 0.5 or after_box[3] > bbox[3] + 0.5):
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
        final_image_do_sequence = [
            str(operands[0]) for operands, op in final_ops
            if str(op) == "Do" and len(operands) == 1
        ]
        if final_image_do_sequence != image_do_sequence:
            reject("verification_failed", "Image XObject invocation sequence changed unexpectedly.")
        final_graphics_state_sequence = [
            str(operands[0]) for operands, op in final_ops
            if str(op) == "gs" and len(operands) == 1
        ]
        if final_graphics_state_sequence != graphics_state_sequence:
            reject("verification_failed", "Graphics-state invocation sequence changed unexpectedly.")
        final_text_render_mode_sequence = [
            float(operands[0]) for operands, op in final_ops
            if str(op) == "Tr" and len(operands) == 1
        ]
        if final_text_render_mode_sequence != text_render_mode_sequence:
            reject("verification_failed", "Text rendering mode sequence changed unexpectedly.")
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
        "imageXObjectsPreserved": bool(image_do_sequence),
        "selectableTextOutsideTargetPreserved": True,
        "verificationScopes": {
            "matchedTextOperator": (
                "unique_consecutive_multi_Tj_sequence" if multi_tj_candidate
                else "unique_Tj_or_bounded_TJ" if font_policy == "standard14"
                else "unique_embedded_Type0_IdentityH_Tj_or_bounded_TJ"
            ),
            "fontPolicy": font_policy,
            "approvedFitBounds": list(fit_bounds) if fit_bounds is not None else None,
            "horizontalScalePercent": fitted_horizontal_scale,
            "imageXObjects": "preserved_verbatim" if image_do_sequence else "none",
            "graphicsStateOperators": "preserved_verbatim" if graphics_state_sequence else "none",
            "textRenderMode": "Tr=0_preserved" if text_render_mode_sequence else "default",
            "originalTextAbsentInExtraction": True,
            "sourceWhitespaceMatch": "collapsed_unique_visual_line" if collapse_whitespace else "exact",
            "targetOperatorRemoved": True,
            "vectorPaintOperatorCount": "preserved" if mode == "replace_exact" else "preserved_plus_black_rectangle",
            "fullLayoutPixelParity": "not_certified",
            "hiddenMetadataOrOtherSensitiveInfo": "unsupported_containers_refused_not_forensically_certified",
        },
        "warnings": [
            "Supports one exact Standard-14 Tj/bounded TJ/multi-Tj or one embedded Type0 Identity-H Tj/bounded TJ run; untouched Image XObjects are allowed only for replacement, while Form/unknown XObjects fail closed.",
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
