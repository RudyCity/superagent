#!/usr/bin/env python3
"""Independent offline PDF signature validation using pinned pyHanko.

Input paths are supplied only by the trusted TypeScript boundary. No network
fetching is permitted. This backend validates PDF/CMS semantics, certificate
trust, embedded revocation evidence and RFC3161 timestamp tokens when present,
but does NOT claim complete structural conformance with every PAdES profile.
"""
from __future__ import annotations
import json
import os
import sys
from pathlib import Path

from pyhanko.keys import load_certs_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.dss import DocumentSecurityStore, NoDSSFoundError
from pyhanko_certvalidator import ValidationContext

MAX_INPUT = 100 * 1024 * 1024
MAX_SIGNATURES = 20

def fail(code: str, message: str):
    print(json.dumps({"status":"failed","code":code,"message":message}))
    raise SystemExit(0)

def checked_file(value, label: str, max_bytes: int):
    if not isinstance(value, str) or not os.path.isabs(value):
        fail("invalid_input", label + " must be an absolute operator-controlled path.")
    p = Path(value)
    try:
        st = p.lstat()
    except OSError:
        fail("not_found", label + " does not exist.")
    if not p.is_file() or p.is_symlink() or st.st_size < 1 or st.st_size > max_bytes:
        fail("invalid_input", label + " must be a bounded regular non-symlink file.")
    return p

def enum_name(value):
    return getattr(value, "name", None) or str(value).split(".")[-1]

def timestamp_status(value):
    if value is None:
        return None
    ts = getattr(value, "timestamp", None)
    return {
        "trusted": bool(getattr(value, "trusted", False)),
        "revoked": bool(getattr(value, "revoked", False)),
        "time": ts.isoformat() if ts is not None else None,
        "summary": str(value.summary())[:300],
    }

def main():
    raw = sys.stdin.buffer.read(8193)
    if len(raw) > 8192:
        fail("size_limit", "Validation request is too large.")
    try:
        request = json.loads(raw.decode("utf-8"))
    except Exception:
        fail("invalid_input", "Validation request must be UTF-8 JSON.")
    if not isinstance(request, dict):
        fail("invalid_input", "Validation request must be an object.")
    pdf = checked_file(request.get("inputPath"), "inputPath", MAX_INPUT)
    ca = checked_file(request.get("caBundle"), "caBundle", 5 * 1024 * 1024)
    tsa_value = request.get("tsaCaBundle")
    tsa = checked_file(tsa_value, "tsaCaBundle", 5 * 1024 * 1024) if tsa_value else ca
    try:
        signer_roots = list(load_certs_from_pemder([str(ca)]))
        tsa_roots = list(load_certs_from_pemder([str(tsa)]))
    except Exception:
        fail("trust_store_invalid", "Could not parse operator CA certificate bundle.")
    if not signer_roots or not tsa_roots:
        fail("trust_store_invalid", "Operator trust bundle contains no certificates.")

    reports = []
    try:
        with pdf.open("rb") as handle:
            reader = PdfFileReader(handle, strict=True)
            try:
                dss = DocumentSecurityStore.read_dss(reader)
                dss_evidence = {
                    "certificates": len(dss.certs),
                    "ocsps": len(dss.ocsps),
                    "crls": len(dss.crls),
                    "vriEntries": len(dss.vri_entries or {}),
                }
            except NoDSSFoundError:
                dss = None
                dss_evidence = {
                    "certificates": 0, "ocsps": 0, "crls": 0, "vriEntries": 0,
                }
            signatures = list(reader.embedded_signatures)
            if not signatures:
                fail("invalid_signature", "PDF contains no embedded signatures.")
            if len(signatures) > MAX_SIGNATURES:
                fail("signature_limit", "PDF exceeds the independent validation signature limit.")
            for index, sig in enumerate(signatures):
                signer_vc = (
                    dss.as_validation_context({
                        "trust_roots": signer_roots,
                        "allow_fetching": False,
                        "revocation_mode": "soft-fail",
                    })
                    if dss is not None else
                    ValidationContext(
                        trust_roots=signer_roots,
                        allow_fetching=False,
                        revocation_mode="soft-fail",
                    )
                )
                tsa_vc = ValidationContext(trust_roots=tsa_roots, allow_fetching=False)
                status = validate_pdf_signature(
                    sig,
                    signer_validation_context=signer_vc,
                    ts_validation_context=tsa_vc,
                )
                revocation_status = "revoked" if bool(getattr(status, "revoked", False)) else "not_available"
                if revocation_status != "revoked" and dss is not None and (dss_evidence["ocsps"] or dss_evidence["crls"]):
                    try:
                        strict_revocation_vc = dss.as_validation_context({
                            "trust_roots": signer_roots,
                            "allow_fetching": False,
                            "revocation_mode": "require",
                        })
                        strict_status = validate_pdf_signature(
                            sig,
                            signer_validation_context=strict_revocation_vc,
                            ts_validation_context=tsa_vc,
                        )
                        if bool(getattr(strict_status, "revoked", False)):
                            revocation_status = "revoked"
                        elif bool(getattr(strict_status, "trusted", False)):
                            revocation_status = "checked_no_revocation"
                        else:
                            revocation_status = "indeterminate"
                    except Exception:
                        revocation_status = "indeterminate"
                reports.append({
                    "index": index,
                    "fieldName": str(getattr(sig, "field_name", "") or "")[:200],
                    "subFilter": str(getattr(sig, "subfilter", "") or "")[:120],
                    "intact": bool(getattr(status, "intact", False)),
                    "cryptographicallyValid": bool(getattr(status, "valid", False)),
                    "trusted": bool(getattr(status, "trusted", False)),
                    "revoked": bool(getattr(status, "revoked", False)),
                    "revocationStatus": revocation_status,
                    "bottomLine": bool(getattr(status, "bottom_line", False)),
                    "coverage": enum_name(getattr(status, "coverage", "unknown")),
                    "modificationLevel": enum_name(getattr(status, "modification_level", "unknown")),
                    "docmdpOk": bool(getattr(status, "docmdp_ok", False)),
                    "seedValueOk": bool(getattr(status, "seed_value_ok", True)),
                    "signerReportedTime": getattr(status, "signer_reported_dt", None).isoformat()
                        if getattr(status, "signer_reported_dt", None) else None,
                    "signatureTimestamp": timestamp_status(getattr(status, "timestamp_validity", None)),
                    "contentTimestamp": timestamp_status(getattr(status, "content_timestamp_validity", None)),
                    "summary": str(status.summary())[:500],
                })
    except SystemExit:
        raise
    except Exception as exc:
        # Avoid document/certificate contents and full exception text in output.
        fail("independent_validation_failed", type(exc).__name__)

    cryptographic_ok = all(x["intact"] and x["cryptographicallyValid"] for x in reports)
    trust_ok = all(x["trusted"] and not x["revoked"] for x in reports)
    timestamps = [x["signatureTimestamp"] for x in reports if x["signatureTimestamp"] is not None]
    timestamps_ok = all(x["trusted"] and not x["revoked"] for x in timestamps)
    revocation_values = [x["revocationStatus"] for x in reports]
    revocation_validation = (
        "revoked" if "revoked" in revocation_values else
        "checked_no_revocation" if revocation_values and all(x == "checked_no_revocation" for x in revocation_values) else
        "indeterminate" if "indeterminate" in revocation_values else
        "not_available"
    )
    print(json.dumps({
        "status": "verified" if cryptographic_ok and trust_ok and timestamps_ok else "partial",
        "engine": "pyHanko",
        "engineVersion": "0.38.1",
        "offline": True,
        "networkFetching": False,
        "signatureCount": len(reports),
        "cryptographicIntegrity": "valid" if cryptographic_ok else "invalid",
        "certificateTrust": "trusted" if trust_ok else "untrusted_or_revoked",
        "revocationValidation": revocation_validation,
        "embeddedValidationEvidence": dss_evidence,
        "trustedTimestampStatus": "valid" if timestamps and timestamps_ok else ("invalid_or_untrusted" if timestamps else "absent"),
        "padesStructuralConformance": "not_certified",
        "signatures": reports,
        "warnings": [
            "Independent pyHanko validation uses explicit operator trust roots with network fetching disabled.",
            "Revocation is only reported checked when embedded DSS OCSP/CRL evidence survives a second validation pass with revocation_mode=require.",
            "This does not certify all structural requirements of PAdES B-B/B-T/B-LT/B-LTA.",
            *([] if tsa_value else ["No separate TSA trust bundle configured; signer CA roots were also used for timestamp trust."]),
        ],
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
