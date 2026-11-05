#!/usr/bin/env python3
"""Create a cryptographically valid but expired OCSP GOOD response for tests."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.x509 import ocsp

MAX_REQUEST = 4096


def checked(value: object, label: str) -> Path:
    if not isinstance(value, str) or not os.path.isabs(value):
        raise ValueError(label + " must be absolute")
    path = Path(value)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError(label + " must be a bounded regular file")
    return path


def main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError("request too large")
    req = json.loads(raw.decode("utf-8"))
    ca_cert_path = checked(req.get("caCertPath"), "caCertPath")
    ca_key_path = checked(req.get("caKeyPath"), "caKeyPath")
    leaf_path = checked(req.get("leafCertPath"), "leafCertPath")
    output_value = req.get("outputPath")
    if not isinstance(output_value, str) or not os.path.isabs(output_value):
        raise ValueError("outputPath must be absolute")
    output = Path(output_value)
    if output.exists():
        raise ValueError("output exists")

    ca = x509.load_pem_x509_certificate(ca_cert_path.read_bytes())
    leaf = x509.load_pem_x509_certificate(leaf_path.read_bytes())
    key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    now = datetime.now(timezone.utc)
    builder = ocsp.OCSPResponseBuilder().add_response(
        cert=leaf,
        issuer=ca,
        algorithm=hashes.SHA256(),
        cert_status=ocsp.OCSPCertStatus.GOOD,
        this_update=now - timedelta(days=3),
        next_update=now - timedelta(days=2),
        revocation_time=None,
        revocation_reason=None,
    ).responder_id(ocsp.OCSPResponderEncoding.HASH, ca)
    response = builder.sign(private_key=key, algorithm=hashes.SHA256())
    output.write_bytes(response.public_bytes(serialization.Encoding.DER))
    print(json.dumps({
        "status": "created",
        "bytes": output.stat().st_size,
        "freshness": "expired",
    }))


if __name__ == "__main__":
    main()
