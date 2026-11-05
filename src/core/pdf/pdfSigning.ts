/**
 * Strict detached CMS signatures for local PDFs.
 * Cert chain trust / long-term PAdES validation is NOT claimed.
 *
 * Uses a user-provided .p12/.pfx file within the authorized workspace,
 * with its password sourced solely from a protected host environment variable.
 * The bundle and password never appear in tool results.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { extractSignature, SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import {
  bytesFromPdf, hash, inputPath, isSigned, outputPath, PdfOperationError,
  pdfDoc, publish, rootDir,
} from "./pdfEngine.js";

function reject(code: string, message: string): never { throw new PdfOperationError(code, message); }
function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) reject("invalid_input", field + " must be a non-empty string.");
  return value;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) reject("cancelled", "Signature operation cancelled.");
}
function bounded(value: unknown, field: string, max = 250): string {
  if (value === undefined) return "";
  const str = required(value, field);
  if (str.length > max) reject("invalid_input", field + " is too long.");
  return str;
}
type SignatureParts = { ranges: [number, number, number, number]; cms: Buffer; signedData: Buffer; signedLength: number };
function extractAndValidate(bytes: Buffer): SignatureParts {
  const text = bytes.toString("latin1");
  const count = (text.match(/\/ByteRange\s*\[/g) || []).length;
  if (count === 0) reject("invalid_signature", "PDF has no cryptographic signature.");
  if (count !== 1) reject("unsupported_signature", "Only a single nonincremental CMS signature is supported.");
  let data: ReturnType<typeof extractSignature>;
  try { data = extractSignature(bytes); }
  catch { return reject("invalid_signature", "Could not parse CMS signature and ByteRange."); }
  const ranges = data.ByteRange as [number, number, number, number];
  if (!Array.isArray(ranges) || ranges.length !== 4 || ranges.some(v => !Number.isSafeInteger(v) || v < 0)) {
    reject("invalid_signature", "Invalid signature ByteRange values.");
  }
  const [a, b, c, d] = ranges;
  const gapStart = a + b;
  const gapEnd = c;
  if (a !== 0 || gapStart >= gapEnd || gapEnd + d !== bytes.length || b < 16 || d < 16) {
    reject("invalid_signature", "ByteRange must cover the entire file except one signature payload.");
  }
  const gap = bytes.subarray(gapStart, gapEnd).toString("latin1");
  if (!/^<[\da-fA-F]+>$/.test(gap) || gap.length % 2 !== 0) {
    reject("invalid_signature", "ByteRange gap does not contain exactly one hex CMS container.");
  }
  const cms = Buffer.from(data.signature as string, "latin1");
  if (cms.length < 100 || cms.length > 65536 || cms[0] !== 0x30) reject("invalid_signature", "Invalid CMS DER container.");
  return { ranges, cms, signedData: Buffer.from(data.signedData), signedLength: bytes.length };
}
async function runOpenSsl(args: string[], signal?: AbortSignal): Promise<void> {
  const names = process.platform === "win32"
    ? ["openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"]
    : ["openssl"];
  let lastError = "";
  for (const executable of names) {
    checkAbort(signal);
    try {
      const success = await new Promise<{ ok: boolean; unavailable: boolean; error: string }>((resolve) => {
        const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"], signal });
        let error = "";
        child.stderr.on("data", chunk => { error = (error + String(chunk)).slice(-1500); });
        child.on("error", e => resolve({ ok: false, unavailable: (e as NodeJS.ErrnoException).code === "ENOENT", error: e.message }));
        child.on("close", code => resolve({ ok: code === 0, unavailable: false, error }));
      });
      if (success.ok) return;
      if (!success.unavailable) {
        if (/certificate revoked/i.test(success.error)) {
          reject("certificate_revoked", "OpenSSL certificate/CRL verification reports a revoked signer.");
        }
        reject("invalid_signature", "CMS signature verification failed: " + success.error.slice(-180));
      }
      lastError = success.error;
    } catch (error) {
      if (error instanceof PdfOperationError) throw error;
      if (signal?.aborted) reject("cancelled", "Signature validation cancelled.");
      lastError = String((error as Error)?.message || error);
    }
  }
  reject("verification_unavailable", "OpenSSL executable is not available for independent CMS validation: " + lastError.slice(0, 120));
}

type SignatureTrustOptions = {
  verifyTrustedChain?: boolean;
  verifyOfflineCrl?: boolean;
};
async function verifiedOperatorBundle(envName: string, label: string): Promise<string> {
  const bundle = process.env[envName];
  if (!bundle || !path.isAbsolute(bundle)) {
    reject("trust_store_missing", "An operator-configured absolute " + label + " path is required in " + envName + ".");
  }
  const stat = await fs.lstat(bundle).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024 || stat.size < 256) {
    reject("trust_store_invalid", "An operator " + label + " must be a regular PEM file smaller than 5 MB.");
  }
  return bundle;
}
async function verifyBytes(bytes: Buffer, signal?: AbortSignal, trust: SignatureTrustOptions = {}) {
  checkAbort(signal);
  const parts = extractAndValidate(bytes);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-sign-"));
  try {
    await fs.chmod(temp, 0o700).catch(() => undefined);
    const cmsPath = path.join(temp, "signed.der");
    const contentPath = path.join(temp, "document.bin");
    const verifiedPath = path.join(temp, "verified.bin");
    await fs.writeFile(cmsPath, parts.cms, { mode: 0o600 });
    await fs.writeFile(contentPath, parts.signedData, { mode: 0o600 });
    // -noverify skips certificate trust-chain validation but NOT the CMS signature
    // and signed-message integrity; -binary disables newline transformations.
    await runOpenSsl(["cms", "-verify", "-inform", "DER", "-binary", "-noverify",
      "-in", cmsPath, "-content", contentPath, "-out", verifiedPath], signal);
    const output = await fs.readFile(verifiedPath);
    if (!output.equals(parts.signedData)) reject("invalid_signature", "OpenSSL verification returned different signed data.");
    let certificateTrusted: "not_checked" | "trusted_by_operator_store" | "untrusted_or_unverifiable" = "not_checked";
    let certificateRevocation: "not_checked" | "valid_by_operator_offline_crl" | "revoked" | "indeterminate" = "not_checked";
    if (trust.verifyTrustedChain || trust.verifyOfflineCrl) {
      // A document or model prompt cannot supply its own trust anchors.
      const caBundle = await verifiedOperatorBundle("SUPERAGENT_PDF_CA_BUNDLE", "trusted CA bundle");
      // No -noverify: independently check signer certificate chain, validity
      // period, and OpenSSL's standard CMS certificate purpose checks.
      // CRL, OCSP and trusted RFC3161 timestamps are NOT checked.
      try {
        await runOpenSsl(["cms", "-verify", "-inform", "DER", "-binary",
          "-CAfile", caBundle, "-in", cmsPath, "-content", contentPath,
          "-out", path.join(temp, "chain-checked.bin")], signal);
        const checked = await fs.readFile(path.join(temp, "chain-checked.bin"));
        if (!checked.equals(parts.signedData)) {
          reject("invalid_signature", "Certificate verification changed the signed message.");
        }
        certificateTrusted = "trusted_by_operator_store";
      } catch (error) {
        if (error instanceof PdfOperationError && error.code === "invalid_signature") {
          // Cryptographic integrity is valid, but independent CA validation
          // was not. Return the distinction rather than faking trust.
          certificateTrusted = "untrusted_or_unverifiable";
        } else {
          throw error;
        }
      }
    }
    if (trust.verifyOfflineCrl) {
      const crlFile = await verifiedOperatorBundle("SUPERAGENT_PDF_CA_CRL_BUNDLE", "trusted CA+CRL bundle");
      // Operator CA and CRL must be distributed together as a trusted PEM
      // bundle; loading untrusted CRLs from the signed PDF would be unsafe.
      const content = await fs.readFile(crlFile, "utf8").catch(() => "");
      if (!content.includes("-----BEGIN CERTIFICATE-----") ||
          !content.includes("-----BEGIN X509 CRL-----")) {
        reject("trust_store_invalid", "Offline CRL bundle must contain operator-approved PEM CA certificate and X509 CRL.");
      }
      try {
        await runOpenSsl(["cms", "-verify", "-inform", "DER", "-binary",
          "-CAfile", crlFile, "-crl_check", "-in", cmsPath,
          "-content", contentPath, "-out", path.join(temp, "crl-checked.bin")], signal);
        const checked = await fs.readFile(path.join(temp, "crl-checked.bin"));
        if (!checked.equals(parts.signedData)) {
          reject("invalid_signature", "Offline CRL verification altered signed content.");
        }
        certificateRevocation = "valid_by_operator_offline_crl";
      } catch (error) {
        if (error instanceof PdfOperationError && error.code === "certificate_revoked") {
          certificateRevocation = "revoked";
        } else if (error instanceof PdfOperationError && error.code === "invalid_signature") {
          certificateRevocation = "indeterminate";
        } else {
          throw error;
        }
      }
    }
    const subFilter = bytes.toString("latin1").match(/\/SubFilter\s*\/([A-Za-z.0-9]+)/g) || [];
    const cadesSubFilter = subFilter.some(value => value.includes("/ETSI.CAdES.detached"));
    return {
      cryptographicSignatureValid: true,
      signedByteLength: parts.signedLength,
      signatureAlgorithm: "detached CMS/PKCS#7",
      byteRange: parts.ranges,
      certificateTrusted,
      certificateRevocation,
      ocspStatus: "not_checked",
      timestampAuthority: "not_checked",
      padesProfile: "not_independently_validated",
      padesStructuralIndicators: {
        etsiCadesDetachedSubFilter: cadesSubFilter,
        signedDocumentFullyCovered: parts.signedLength === bytes.length,
      },
      warning: certificateRevocation === "revoked"
        ? "Certificate REVOKED by operator CRL: do not trust this signature, despite valid CMS content integrity."
        : certificateRevocation === "indeterminate"
          ? "Offline CRL check was inconclusive (missing/expired/invalid chain or CRL). Do not claim trusted status."
          : "Cryptographic CMS integrity verified separately. CA and offline CRL statuses only when requested; OCSP, trusted TSA, PAdES B-B/B-T/B-LT/B-LTA and qualified legal status NOT certified.",
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function verifyPdfSignature(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  const root = await rootDir(cwd);
  const input = await bytesFromPdf(required(args.inputPath, "inputPath"), root);
  for (const field of ["verifyTrustedChain", "verifyOfflineCrl", "verifyIndependentPades"] as const) {
    if (args[field] !== undefined && typeof args[field] !== "boolean") {
      reject("invalid_input", field + " must be a boolean.");
    }
  }
  if (args.verifyIndependentPades === true) {
    const independent = await (await import("./pdfPades.js")).verifyPdfPadesIndependent(input.file, signal);
    if (independent.cryptographicIntegrity !== "valid") {
      reject("invalid_signature", "Independent PDF signature validator reported invalid cryptographic integrity.");
    }
    const revocationValidation = String(independent.revocationValidation || "not_available");
    const evidence = (independent.embeddedValidationEvidence && typeof independent.embeddedValidationEvidence === "object")
      ? independent.embeddedValidationEvidence as Record<string, unknown> : {};
    const operatorOcsp = (independent.operatorOcspEvidence && typeof independent.operatorOcspEvidence === "object")
      ? independent.operatorOcspEvidence as Record<string, unknown> : {};
    const ocspCount = Number(evidence.ocsps || 0);
    const operatorOcspConfigured = operatorOcsp.configured === true;
    return {
      status: independent.status === "verified" ? "verified" : "partial",
      path: input.file,
      inputSha256: input.sha256,
      cryptographicSignatureValid: true,
      certificateTrusted: independent.certificateTrust === "trusted"
        ? "trusted_by_operator_store" : "untrusted_or_unverifiable",
      certificateRevocation: revocationValidation === "revoked" ? "revoked"
        : revocationValidation === "checked_no_revocation" ? "valid_by_revocation_evidence"
          : revocationValidation === "indeterminate" ? "indeterminate"
            : "not_available",
      timestampAuthority: independent.trustedTimestampStatus,
      ocspStatus: operatorOcspConfigured
        ? (revocationValidation === "checked_no_revocation"
          ? "operator_ocsp_evidence_checked"
          : revocationValidation === "revoked"
            ? "operator_ocsp_evidence_reports_revoked"
            : "operator_ocsp_evidence_indeterminate")
        : ocspCount > 0
          ? (revocationValidation === "checked_no_revocation"
            ? "embedded_ocsp_evidence_checked"
            : revocationValidation === "revoked"
              ? "embedded_ocsp_evidence_reports_revoked"
              : "embedded_ocsp_evidence_present_indeterminate")
          : "not_available",
      padesProfile: "not_structurally_certified",
      embeddedValidationEvidence: evidence,
      independentValidation: independent,
      warning: "Independent pyHanko validation evaluated PDF/CMS integrity and explicit operator trust offline. Revocation is only claimed checked when embedded DSS OCSP/CRL evidence passes a revocation-required validation pass; timestamp tokens are reported separately. Full structural PAdES profile conformance is NOT certified.",
    };
  }
  const crlRequested = args.verifyOfflineCrl === true;
  const trustRequested = args.verifyTrustedChain === true || crlRequested;
  const report = await verifyBytes(Buffer.from(input.bytes), signal, {
    verifyTrustedChain: trustRequested, verifyOfflineCrl: crlRequested,
  });
  return {
    status: (trustRequested && report.certificateTrusted !== "trusted_by_operator_store") ||
      (crlRequested && report.certificateRevocation !== "valid_by_operator_offline_crl")
      ? "partial" : "verified",
    path: input.file, inputSha256: input.sha256, ...report,
  };
}

export async function signPdf(args: Record<string, unknown>, cwd: string, signal?: AbortSignal) {
  if (args.confirmSign !== true) reject("confirmation_required", "Explicit confirmSign=true is required before cryptographic signing.");
  const root = await rootDir(cwd);
  const source = await bytesFromPdf(required(args.inputPath, "inputPath"), root);
  if (isSigned(source.bytes)) reject("already_signed", "Existing signatures cannot be modified or replaced.");
  if (source.sha256 !== required(args.expectedInputSha256, "expectedInputSha256").toLowerCase()) {
    reject("hash_mismatch", "Source hash changed or does not match expectedInputSha256.");
  }
  const output = await outputPath(required(args.outputPath, "outputPath"), root);
  if (output === source.file) reject("path_denied", "Signed PDF must be published to a new path.");
  const certPath = await inputPath(required(args.certificatePath, "certificatePath"), root);
  if (!/\.(p12|pfx)$/i.test(certPath)) reject("invalid_input", "Certificate file must be a PKCS#12 .p12/.pfx bundle.");
  const certStat = await fs.stat(certPath);
  if (certStat.size < 256 || certStat.size > 2 * 1024 * 1024) reject("invalid_input", "Invalid or oversized PKCS#12 bundle.");
  const envName = args.passwordEnv === undefined ? "SUPERAGENT_PDF_P12_PASSWORD" : required(args.passwordEnv, "passwordEnv");
  if (envName !== "SUPERAGENT_PDF_P12_PASSWORD") reject("secret_policy", "Only the dedicated signing password environment variable is allowed.");
  if (typeof process.env[envName] !== "string") reject("password_missing", "Protected signing password is not configured in host environment.");
  const reason = bounded(args.reason, "reason") || "Document approval";
  const signerName = bounded(args.signerName, "signerName") || "Authorized signer";
  const location = bounded(args.location, "location") || "Local";
  const expectedCertHash = args.expectedCertificateSha256;
  let certBytes = Buffer.alloc(0);
  try {
    certBytes = await fs.readFile(certPath);
    if (expectedCertHash && hash(certBytes) !== String(expectedCertHash).toLowerCase()) reject("certificate_hash_mismatch", "Certificate bundle SHA-256 changed.");
    checkAbort(signal);
    const doc: PDFDocument = await pdfDoc(source.bytes);
    // PDF objects still contain no actual signature at this point.
    pdflibAddPlaceholder({
      pdfDoc: doc,
      reason, contactInfo: "", name: signerName, location,
      subFilter: SUBFILTER_ETSI_CADES_DETACHED,
      signatureLength: 8192,
    });
    const docToSign = Buffer.from(await doc.save({ useObjectStreams: false, addDefaultPage: false }));
    const signer = new P12Signer(certBytes, { passphrase: process.env[envName]! });
    let signed: Buffer;
    try {
      signed = await signpdf.sign(docToSign, signer);
    } catch {
      reject("signing_failed", "PKCS#12 signing failed. Validate the bundle, secret, and key algorithm. No output published.");
    }
    checkAbort(signal);
    await pdfDoc(signed); // ensure valid PDF structure
    const report = await verifyBytes(signed, signal);
    if (hash(await fs.readFile(source.file)) !== source.sha256) reject("hash_mismatch", "Source changed while signing; output not published.");
    const sha256 = await publish(output, signed, signal);
    return {
      status: "verified", inputSha256: source.sha256, outputSha256: sha256, outputPath: output,
      ...report,
      signatureCount: 1,
    };
  } finally {
    // Best-effort cleanup of our certificate buffer (no claim of full VM zeroization).
    certBytes.fill(0);
  }
}
