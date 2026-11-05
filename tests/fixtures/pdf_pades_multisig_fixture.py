#!/usr/bin/env python3
"""Test-only helper: create a PDF with two incremental PAdES signatures.

No network or external credentials. The same ephemeral PKCS#12 test signer may
be reused twice; the purpose is to exercise multi-signature revision handling,
not signer-identity diversity.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers
from pyhanko.sign.fields import SigSeedSubFilter
from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata

MAX_REQUEST = 8192


def checked_file(value: object, label: str) -> Path:
    if not isinstance(value, str) or not os.path.isabs(value):
        raise ValueError(label + " must be absolute")
    path = Path(value)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError(label + " must be a bounded regular file")
    return path


def sign_once(source: Path, output: Path, signer, field_name: str) -> None:
    metadata = PdfSignatureMetadata(
        field_name=field_name,
        subfilter=SigSeedSubFilter.PADES,
    )
    with source.open("rb") as source_handle:
        writer = IncrementalPdfFileWriter(source_handle)
        with output.open("xb") as output_handle:
            signers.PdfSigner(metadata, signer).sign_pdf(writer, output=output_handle)


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("request too large")
    request = json.loads(raw.decode("utf-8"))
    source = checked_file(request.get("inputPath"), "inputPath")
    p12 = checked_file(request.get("p12Path"), "p12Path")
    output_value = request.get("outputPath")
    if not isinstance(output_value, str) or not os.path.isabs(output_value):
        raise ValueError("outputPath must be absolute")
    output = Path(output_value)
    if output.exists():
        raise ValueError("output must not already exist")

    signer = signers.SimpleSigner.load_pkcs12(
        str(p12), passphrase=b"temporary-test-only"
    )
    if signer is None:
        raise ValueError("test signer could not be loaded")

    with tempfile.TemporaryDirectory(prefix="superagent-pdf-multisig-") as temp:
        intermediate = Path(temp) / "first-signed.pdf"
        sign_once(source, intermediate, signer, "FirstSignature")
        sign_once(intermediate, output, signer, "SecondSignature")

    print(json.dumps({
        "status": "created",
        "signatureCount": 2,
        "outputBytes": output.stat().st_size,
    }))


if __name__ == "__main__":
    main()
