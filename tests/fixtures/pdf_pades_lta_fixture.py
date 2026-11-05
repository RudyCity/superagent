#!/usr/bin/env python3
"""Test-only helper: create offline PAdES long-term validation evidence.

Uses an ephemeral signer, an operator-style local OCSP response and a local
DummyTimeStamper. No network access. The output is evidence for exercising
DSS + document timestamp validation, not a production PAdES certificate.
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from pyhanko.keys import (
    load_cert_from_pemder,
    load_certs_from_pemder,
    load_private_key_from_pemder,
)
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign import signers, timestamps
from pyhanko.sign.fields import SigSeedSubFilter
from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata
from pyhanko_certvalidator import ValidationContext

MAX_REQUEST = 8192


def checked_file(value: object, label: str, max_bytes: int = 10 * 1024 * 1024) -> Path:
    if not isinstance(value, str) or not os.path.isabs(value):
        raise ValueError(label + " must be absolute")
    path = Path(value)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > max_bytes:
        raise ValueError(label + " must be a bounded regular file")
    return path


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("request too large")
    request = json.loads(raw.decode("utf-8"))

    source = checked_file(request.get("inputPath"), "inputPath")
    p12 = checked_file(request.get("p12Path"), "p12Path")
    signer_ca = checked_file(request.get("signerCaPath"), "signerCaPath")
    ocsp = checked_file(request.get("ocspPath"), "ocspPath", 2 * 1024 * 1024)
    tsa_cert_path = checked_file(request.get("tsaCertPath"), "tsaCertPath")
    tsa_key_path = checked_file(request.get("tsaKeyPath"), "tsaKeyPath")
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

    tsa_cert = load_cert_from_pemder(str(tsa_cert_path))
    tsa_key = load_private_key_from_pemder(str(tsa_key_path), passphrase=None)
    timestamper = timestamps.DummyTimeStamper(
        tsa_cert=tsa_cert,
        tsa_key=tsa_key,
        fixed_dt=datetime(2026, 11, 5, 2, 34, 56, tzinfo=timezone.utc),
    )

    roots = list(load_certs_from_pemder([str(signer_ca), str(tsa_cert_path)]))
    vc = ValidationContext(
        trust_roots=roots,
        ocsps=[ocsp.read_bytes()],
        allow_fetching=False,
        revocation_mode="soft-fail",
    )
    metadata = PdfSignatureMetadata(
        field_name="LongTermSignature",
        subfilter=SigSeedSubFilter.PADES,
        validation_context=vc,
        embed_validation_info=True,
        use_pades_lta=True,
        timestamp_field_name="ArchiveTimestamp",
    )

    with source.open("rb") as source_handle:
        writer = IncrementalPdfFileWriter(source_handle)
        with output.open("xb") as output_handle:
            signers.PdfSigner(
                metadata,
                signer,
                timestamper=timestamper,
            ).sign_pdf(writer, output=output_handle)

    print(json.dumps({
        "status": "created",
        "outputBytes": output.stat().st_size,
        "networkFetching": False,
    }))


if __name__ == "__main__":
    main()
