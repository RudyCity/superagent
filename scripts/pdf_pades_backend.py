#!/usr/bin/env python3
"""Independent offline PDF signature validation using pinned pyHanko.

Input paths are supplied only by the trusted TypeScript boundary. No network
fetching is permitted. This backend validates PDF/CMS semantics, certificate
trust, embedded revocation evidence and RFC3161 timestamp tokens when present,
but does NOT claim complete structural conformance with every PAdES profile.
"""
from __future__ import annotations
import asyncio
import json
import os
import sys
from pathlib import Path

from pyhanko.keys import load_certs_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import ades, validate_pdf_signature, validate_pdf_timestamp
from pyhanko.sign.validation.dss import DocumentSecurityStore, NoDSSFoundError
from pyhanko.sign.validation.policy_decl import (
    CertificateFetchingRule,
    PdfSignatureValidationSpec,
    RevinfoOnlineFetchingRule,
    RevocationInfoGatheringSpec,
    SignatureValidationSpec,
)
from pyhanko_certvalidator import ValidationContext
from pyhanko_certvalidator.context import CertValidationPolicySpec
from pyhanko_certvalidator.policy_decl import (
    CertRevTrustPolicy,
    NO_REVOCATION,
    REQUIRE_REVINFO,
)
from pyhanko_certvalidator.registry import SimpleTrustManager

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

def ades_status(value):
    sub = getattr(value, "ades_subindic", None)
    status = getattr(sub, "status", None)
    return {
        "status": enum_name(status),
        "subIndication": getattr(sub, "standard_name", None) or str(sub),
        "hasFailureMessage": bool(getattr(value, "failure_msg", None)),
    }


def ades_lta_status(value):
    result = ades_status(value)
    evidence = getattr(value, "oldest_evidence_record_timestamp", None)
    result["oldestEvidenceRecordTimestamp"] = (
        evidence.isoformat() if evidence is not None else None
    )
    result["hasDocumentTimestampEvidenceRecord"] = evidence is not None
    return result


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
    ocsp_value = request.get("operatorOcspResponse")
    operator_ocsp = checked_file(ocsp_value, "operatorOcspResponse", 2 * 1024 * 1024) if ocsp_value else None
    operator_ocsp_bytes = operator_ocsp.read_bytes() if operator_ocsp else None
    try:
        signer_roots = list(load_certs_from_pemder([str(ca)]))
        tsa_roots = list(load_certs_from_pemder([str(tsa)]))
    except Exception:
        fail("trust_store_invalid", "Could not parse operator CA certificate bundle.")
    if not signer_roots or not tsa_roots:
        fail("trust_store_invalid", "Operator trust bundle contains no certificates.")

    signer_policy = CertValidationPolicySpec(
        trust_manager=SimpleTrustManager.build(trust_roots=signer_roots),
        revinfo_policy=CertRevTrustPolicy(NO_REVOCATION),
    )
    tsa_policy = CertValidationPolicySpec(
        trust_manager=SimpleTrustManager.build(trust_roots=tsa_roots),
        revinfo_policy=CertRevTrustPolicy(NO_REVOCATION),
    )
    local_gathering = RevocationInfoGatheringSpec(
        online_fetching_rule=RevinfoOnlineFetchingRule.LOCAL_ONLY,
        certificate_fetching_rule=CertificateFetchingRule.NEVER_FETCH,
    )
    formal_spec = SignatureValidationSpec(
        cert_validation_policy=signer_policy,
        ts_cert_validation_policy=tsa_policy,
        revinfo_gathering_policy=local_gathering,
    )
    lta_spec = PdfSignatureValidationSpec(
        signature_validation_spec=SignatureValidationSpec(
            cert_validation_policy=CertValidationPolicySpec(
                trust_manager=SimpleTrustManager.build(trust_roots=signer_roots),
                revinfo_policy=CertRevTrustPolicy(REQUIRE_REVINFO),
            ),
            ts_cert_validation_policy=CertValidationPolicySpec(
                trust_manager=SimpleTrustManager.build(trust_roots=tsa_roots),
                revinfo_policy=CertRevTrustPolicy(REQUIRE_REVINFO),
            ),
            revinfo_gathering_policy=local_gathering,
        )
    )
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
            signatures = list(getattr(reader, "embedded_regular_signatures", reader.embedded_signatures))
            document_timestamps = list(getattr(reader, "embedded_timestamp_signatures", []))
            if not signatures and not document_timestamps:
                fail("invalid_signature", "PDF contains no embedded signatures or document timestamps.")
            if len(signatures) + len(document_timestamps) > MAX_SIGNATURES:
                fail("signature_limit", "PDF exceeds the independent validation signature limit.")
            for index, sig in enumerate(signatures):
                base_vc_kwargs = {
                    "trust_roots": signer_roots,
                    "allow_fetching": False,
                    "revocation_mode": "soft-fail",
                    **({"ocsps": [operator_ocsp_bytes]} if operator_ocsp_bytes else {}),
                }
                signer_vc = (
                    dss.as_validation_context(base_vc_kwargs)
                    if dss is not None else
                    ValidationContext(**base_vc_kwargs)
                )
                tsa_vc = ValidationContext(trust_roots=tsa_roots, allow_fetching=False)
                status = validate_pdf_signature(
                    sig,
                    signer_validation_context=signer_vc,
                    ts_validation_context=tsa_vc,
                )
                revocation_status = "revoked" if bool(getattr(status, "revoked", False)) else "not_available"
                revocation_source = "none"
                has_embedded_revinfo = dss is not None and (dss_evidence["ocsps"] or dss_evidence["crls"])
                if revocation_status != "revoked" and (has_embedded_revinfo or operator_ocsp_bytes):
                    try:
                        strict_kwargs = {
                            "trust_roots": signer_roots,
                            "allow_fetching": False,
                            "revocation_mode": "require",
                            **({"ocsps": [operator_ocsp_bytes]} if operator_ocsp_bytes else {}),
                        }
                        strict_revocation_vc = dss.as_validation_context(strict_kwargs) if dss is not None else ValidationContext(**strict_kwargs)
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
                        revocation_source = (
                            "embedded_dss+operator_ocsp" if has_embedded_revinfo and operator_ocsp_bytes
                            else "operator_ocsp" if operator_ocsp_bytes else "embedded_dss"
                        )
                    except Exception:
                        revocation_status = "indeterminate"
                        revocation_source = (
                            "embedded_dss+operator_ocsp" if has_embedded_revinfo and operator_ocsp_bytes
                            else "operator_ocsp" if operator_ocsp_bytes else "embedded_dss"
                        )
                elif revocation_status == "revoked":
                    revocation_source = "signature_status"
                raw_digest = sig.compute_digest()
                formal_basic = asyncio.run(ades.ades_basic_validation(
                    sig.signed_data,
                    formal_spec,
                    raw_digest=raw_digest,
                ))
                formal_with_time = asyncio.run(ades.ades_with_time_validation(
                    sig.signed_data,
                    formal_spec,
                    raw_digest=raw_digest,
                ))
                formal_lta = asyncio.run(ades.ades_lta_validation(sig, lta_spec))
                sig_object = getattr(sig, "sig_object", None)
                subfilter = sig_object.get("/SubFilter") if sig_object is not None else ""
                reports.append({
                    "index": index,
                    "fieldName": str(getattr(sig, "field_name", "") or "")[:200],
                    "subFilter": str(subfilter or "")[:120],
                    "subFilterName": "PADES" if str(subfilter or "") == "/ETSI.CAdES.detached" else enum_name(subfilter),
                    "intact": bool(getattr(status, "intact", False)),
                    "cryptographicallyValid": bool(getattr(status, "valid", False)),
                    "trusted": bool(getattr(status, "trusted", False)),
                    "revoked": bool(getattr(status, "revoked", False)),
                    "revocationStatus": revocation_status,
                    "revocationSource": revocation_source,
                    "bottomLine": bool(getattr(status, "bottom_line", False)),
                    "coverage": enum_name(getattr(status, "coverage", "unknown")),
                    "modificationLevel": enum_name(getattr(status, "modification_level", "unknown")),
                    "docmdpOk": bool(getattr(status, "docmdp_ok", False)),
                    "seedValueOk": bool(getattr(status, "seed_value_ok", True)),
                    "signerReportedTime": getattr(status, "signer_reported_dt", None).isoformat()
                        if getattr(status, "signer_reported_dt", None) else None,
                    "signatureTimestamp": timestamp_status(getattr(status, "timestamp_validity", None)),
                    "contentTimestamp": timestamp_status(getattr(status, "content_timestamp_validity", None)),
                    "adesBasic": ades_status(formal_basic),
                    "adesWithTime": ades_status(formal_with_time),
                    "adesLta": ades_lta_status(formal_lta),
                    "summary": str(status.summary())[:500],
                })
            document_timestamp_reports = []
            for index, doc_ts in enumerate(document_timestamps):
                tsa_vc = ValidationContext(
                    trust_roots=tsa_roots,
                    allow_fetching=False,
                    **({"ocsps": [operator_ocsp_bytes]} if operator_ocsp_bytes else {}),
                )
                ts_status = validate_pdf_timestamp(
                    doc_ts,
                    validation_context=tsa_vc,
                )
                ts_time = getattr(ts_status, "timestamp", None)
                document_timestamp_reports.append({
                    "index": index,
                    "fieldName": str(getattr(doc_ts, "field_name", "") or "")[:200],
                    "intact": bool(getattr(ts_status, "intact", False)),
                    "cryptographicallyValid": bool(getattr(ts_status, "valid", False)),
                    "trusted": bool(getattr(ts_status, "trusted", False)),
                    "revoked": bool(getattr(ts_status, "revoked", False)),
                    "time": ts_time.isoformat() if ts_time is not None else None,
                    "coverage": enum_name(getattr(ts_status, "coverage", "unknown")),
                    "summary": str(ts_status.summary())[:500],
                })
    except SystemExit:
        raise
    except Exception as exc:
        # Avoid document/certificate contents and full exception text in output.
        fail("independent_validation_failed", type(exc).__name__)

    regular_crypto_ok = all(x["intact"] and x["cryptographicallyValid"] for x in reports)
    document_timestamp_crypto_ok = all(
        x["intact"] and x["cryptographicallyValid"] for x in document_timestamp_reports
    )
    cryptographic_ok = regular_crypto_ok and document_timestamp_crypto_ok
    regular_trust_ok = all(x["trusted"] and not x["revoked"] for x in reports)
    document_timestamp_trust_ok = all(
        x["trusted"] and not x["revoked"] for x in document_timestamp_reports
    )
    trust_ok = regular_trust_ok and document_timestamp_trust_ok
    timestamps = [x["signatureTimestamp"] for x in reports if x["signatureTimestamp"] is not None]
    timestamps_ok = all(x["trusted"] and not x["revoked"] for x in timestamps)
    all_time_evidence_valid = timestamps_ok and document_timestamp_trust_ok
    revocation_values = [x["revocationStatus"] for x in reports]
    revocation_sources = sorted({x["revocationSource"] for x in reports})
    revocation_validation = (
        "revoked" if "revoked" in revocation_values else
        "checked_no_revocation" if revocation_values and all(x == "checked_no_revocation" for x in revocation_values) else
        "indeterminate" if "indeterminate" in revocation_values else
        "not_available"
    )
    cades_detached = all(
        x["subFilterName"] == "PADES"
        or "ETSI.CAdES.detached" in x["subFilter"]
        for x in reports
    )
    trusted_sig_timestamps = (
        len(timestamps) == len(reports) and len(timestamps) > 0 and timestamps_ok
    )
    has_validation_material = (
        revocation_validation == "checked_no_revocation"
        and (
            dss_evidence["ocsps"] > 0 or dss_evidence["crls"] > 0
            or operator_ocsp is not None
        )
    )
    has_lta_evidence_record = all(
        bool(x["adesLta"].get("hasDocumentTimestampEvidenceRecord"))
        for x in reports
    )
    profile_evidence = {
        "cadesDetached": cades_detached,
        "trustedSignatureTimestampPerSignature": trusted_sig_timestamps,
        "validatedRevocationMaterial": has_validation_material,
        "documentTimestampEvidenceRecordPerSignature": has_lta_evidence_record,
    }
    evidence_level = (
        "B-LTA-like-evidence"
        if cryptographic_ok and trust_ok and cades_detached and trusted_sig_timestamps
           and has_validation_material and has_lta_evidence_record
        else "B-LT-like-evidence"
        if cryptographic_ok and trust_ok and cades_detached and trusted_sig_timestamps
           and has_validation_material
        else "B-T-like-evidence"
        if cryptographic_ok and trust_ok and cades_detached and trusted_sig_timestamps
        else "B-B-like-evidence"
        if cryptographic_ok and trust_ok and cades_detached
        else "none"
    )
    print(json.dumps({
        "status": "verified" if cryptographic_ok and trust_ok and all_time_evidence_valid else "partial",
        "engine": "pyHanko",
        "engineVersion": "0.38.1",
        "offline": True,
        "networkFetching": False,
        "signatureCount": len(reports),
        "documentTimestampCount": len(document_timestamp_reports),
        "embeddedSignatureObjectCount": len(reports) + len(document_timestamp_reports),
        "cryptographicIntegrity": "valid" if cryptographic_ok else "invalid",
        "certificateTrust": "trusted" if trust_ok else "untrusted_or_revoked",
        "revocationValidation": revocation_validation,
        "revocationSources": revocation_sources,
        "embeddedValidationEvidence": dss_evidence,
        "operatorOcspEvidence": {
            "configured": operator_ocsp is not None,
            "bytes": len(operator_ocsp_bytes) if operator_ocsp_bytes is not None else 0,
        },
        "trustedTimestampStatus": (
            "valid"
            if (timestamps or document_timestamp_reports) and timestamps_ok and document_timestamp_trust_ok
            else "invalid_or_untrusted"
            if (timestamps or document_timestamp_reports)
            else "absent"
        ),
        "padesEvidenceLevelCandidate": evidence_level,
        "padesProfileEvidence": profile_evidence,
        "formalAdesPolicy": {
            "standard": "ETSI EN 319 102-1",
            "basicSection": "5.3",
            "withTimeSection": "5.5",
            "ltaSection": "5.6.3",
            "networkFetching": False,
            "certificateFetching": False,
            "revocation": "separate_from_formal_pass",
        },
        "padesStructuralConformance": "not_certified",
        "signatures": reports,
        "documentTimestamps": document_timestamp_reports,
        "warnings": [
            "Independent pyHanko validation uses explicit operator trust roots with network fetching disabled.",
            "Formal AdES Basic, With-Time and LTA results follow ETSI EN 319 102-1 sections 5.3, 5.5 and 5.6.3. A PASSED LTA algorithm result does not by itself prove PAdES B-LTA structure; oldestEvidenceRecordTimestamp separately reports whether a later document-timestamp Evidence Record exists.",
            "Revocation is only reported checked when embedded DSS OCSP/CRL evidence and/or an operator-provisioned offline OCSP DER response survives a second validation pass with revocation_mode=require.",
            "padesEvidenceLevelCandidate is an evidence summary only. It is NOT structural PAdES B-B/B-T/B-LT/B-LTA certification.",
            "This does not certify all structural requirements of PAdES B-B/B-T/B-LT/B-LTA.",
            *([] if tsa_value else ["No separate TSA trust bundle configured; signer CA roots were also used for timestamp trust."]),
        ],
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
