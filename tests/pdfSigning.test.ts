import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { signPdf, verifyPdfSignature } from "../src/core/pdf/pdfSigning.js";
import { editPdf, inspectPdf } from "../src/core/pdf/pdfEngine.js";

let root = "";
const previousSecret = process.env.SUPERAGENT_PDF_P12_PASSWORD;
const previousCA = process.env.SUPERAGENT_PDF_CA_BUNDLE;
const previousCRL = process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE;
const previousTSA = process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE;
const previousOCSP = process.env.SUPERAGENT_PDF_OCSP_RESPONSE;
const padesPython = path.join(os.homedir(), ".superagent-r", "venvs", "pdf-pades",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const padesAvailable = fsSync.existsSync(padesPython);
function openssl(args: string[]): void {
  const result = spawnSync("openssl", args, { cwd: root, windowsHide: true, encoding: "utf8", timeout: 20_000 });
  if (result.error || result.status !== 0) throw new Error("OpenSSL fixture failure: " + String(result.error || result.stderr).slice(0, 300));
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-pdf-sign-qa-"));
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", "ephemeral-private.key", "-out", "ephemeral-public.crt",
    "-subj", "/CN=SuperAgent Temporary Signing Test"]);
  openssl(["pkcs12", "-export", "-out", "ephemeral-certificate.p12",
    "-inkey", "ephemeral-private.key", "-in", "ephemeral-public.crt", "-passout", "pass:temporary-test-only"]);
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", "untrusted-private.key", "-out", "untrusted-public.crt",
    "-subj", "/CN=Not in operator trust store"]);
  openssl(["req","-x509","-newkey","rsa:2048","-nodes","-days","1",
    "-keyout","pades-private.key","-out","pades-public.crt",
    "-subj","/CN=SuperAgent Independent PAdES Test",
    "-addext","keyUsage=critical,digitalSignature,nonRepudiation",
    "-addext","basicConstraints=critical,CA:TRUE"]);
  openssl(["pkcs12","-export","-out","pades-certificate.p12",
    "-inkey","pades-private.key","-in","pades-public.crt","-passout","pass:temporary-test-only"]);
  openssl(["req","-x509","-newkey","rsa:2048","-nodes","-days","1",
    "-keyout","tsa-private.key","-out","tsa-public.crt",
    "-subj","/CN=SuperAgent Temporary RFC3161 TSA",
    "-addext","keyUsage=critical,digitalSignature",
    "-addext","extendedKeyUsage=critical,timeStamping",
    "-addext","basicConstraints=critical,CA:TRUE"]);
  const base = root.replace(/\\/g, "/");
  await fs.mkdir(path.join(root,"ocsp-newcerts"));
  await fs.writeFile(path.join(root,"ocsp-index.txt"),"");
  await fs.writeFile(path.join(root,"ocsp-serial"),"2000\n");
  openssl(["req","-x509","-newkey","rsa:2048","-nodes","-days","1",
    "-keyout","ocsp-ca.key","-out","ocsp-ca.crt",
    "-subj","/CN=SuperAgent Offline OCSP Root",
    "-addext","basicConstraints=critical,CA:TRUE",
    "-addext","keyUsage=critical,keyCertSign,cRLSign,digitalSignature"]);
  await fs.writeFile(path.join(root,"ocsp-ca.conf"),[
    "[ ca ]","default_ca = local_ca",
    "[ local_ca ]","database = " + base + "/ocsp-index.txt",
    "serial = " + base + "/ocsp-serial","new_certs_dir = " + base + "/ocsp-newcerts",
    "private_key = " + base + "/ocsp-ca.key","certificate = " + base + "/ocsp-ca.crt",
    "default_md = sha256","default_days = 1","policy = policy_default",
    "unique_subject = no","x509_extensions = leaf_ext","copy_extensions = copy",
    "[ policy_default ]","commonName = supplied",
    "[ leaf_ext ]","basicConstraints = critical,CA:FALSE",
    "keyUsage = critical,digitalSignature,nonRepudiation",
    "authorityInfoAccess = OCSP;URI:http://127.0.0.1:9/ocsp",
    "subjectKeyIdentifier = hash","authorityKeyIdentifier = keyid,issuer",
  ].join("\n")+"\n");
  openssl(["req","-new","-newkey","rsa:2048","-nodes",
    "-keyout","ocsp-leaf.key","-out","ocsp-leaf.csr",
    "-subj","/CN=SuperAgent Offline OCSP Leaf"]);
  openssl(["ca","-batch","-config","ocsp-ca.conf","-in","ocsp-leaf.csr","-out","ocsp-leaf.crt","-notext"]);
  openssl(["pkcs12","-export","-out","ocsp-leaf.p12",
    "-inkey","ocsp-leaf.key","-in","ocsp-leaf.crt","-certfile","ocsp-ca.crt",
    "-passout","pass:temporary-test-only"]);
  openssl(["ocsp","-index","ocsp-index.txt","-rsigner","ocsp-ca.crt","-rkey","ocsp-ca.key",
    "-CA","ocsp-ca.crt","-issuer","ocsp-ca.crt","-cert","ocsp-leaf.crt",
    "-respout","ocsp-good.der","-ndays","1"]);
  openssl(["ca","-config","ocsp-ca.conf","-revoke","ocsp-leaf.crt"]);
  openssl(["ocsp","-index","ocsp-index.txt","-rsigner","ocsp-ca.crt","-rkey","ocsp-ca.key",
    "-CA","ocsp-ca.crt","-issuer","ocsp-ca.crt","-cert","ocsp-leaf.crt",
    "-respout","ocsp-revoked.der","-ndays","1"]);
  if (padesAvailable) {
    const staleFixture=spawnSync(padesPython,[path.resolve("tests/fixtures/pdf_ocsp_stale_fixture.py")],{
      cwd:root,windowsHide:true,encoding:"utf8",timeout:10000,
      input:JSON.stringify({
        caCertPath:path.join(root,"ocsp-ca.crt"),
        caKeyPath:path.join(root,"ocsp-ca.key"),
        leafCertPath:path.join(root,"ocsp-leaf.crt"),
        outputPath:path.join(root,"ocsp-stale.der"),
      }),
    });
    if (staleFixture.status !== 0) {
      throw new Error("Stale OCSP fixture failure: " + String(staleFixture.stderr).slice(0,300));
    }
  }
  await fs.writeFile(path.join(root, "ca-index.txt"), "");
  await fs.writeFile(path.join(root, "ca-serial"), "1000\n");
  await fs.writeFile(path.join(root, "ca-crlnumber"), "1000\n");
  await fs.writeFile(path.join(root, "ca.conf"), [
    "[ ca ]", "default_ca = local_ca",
    "[ local_ca ]", `database = ${base}/ca-index.txt`,
    `serial = ${base}/ca-serial`,
    `crlnumber = ${base}/ca-crlnumber`,
    `new_certs_dir = ${base}`,
    `private_key = ${base}/ephemeral-private.key`,
    `certificate = ${base}/ephemeral-public.crt`,
    "default_md = sha256", "default_crl_days = 1", "default_days = 1",
    "policy = policy_default", "unique_subject = no",
    "[ policy_default ]", "commonName = supplied",
  ].join("\n") + "\n");
  openssl(["ca","-gencrl","-config","ca.conf","-out","empty.crl"]);
  await fs.writeFile(path.join(root,"trusted-with-crl.pem"), Buffer.concat([
    await fs.readFile(path.join(root,"ephemeral-public.crt")),
    await fs.readFile(path.join(root,"empty.crl")),
  ]));
  // Create a second CRL signed by the SAME issuer with the test certificate
  // explicitly revoked, to distinguish a revoked signer from missing evidence.
  openssl(["ca","-config","ca.conf","-revoke","ephemeral-public.crt"]);
  openssl(["ca","-gencrl","-config","ca.conf","-out","revoked.crl"]);
  await fs.writeFile(path.join(root,"revoked-with-crl.pem"), Buffer.concat([
    await fs.readFile(path.join(root,"ephemeral-public.crt")),
    await fs.readFile(path.join(root,"revoked.crl")),
  ]));
  process.env.SUPERAGENT_PDF_P12_PASSWORD = "temporary-test-only";
});
afterAll(async () => {
  if (previousSecret === undefined) delete process.env.SUPERAGENT_PDF_P12_PASSWORD;
  else process.env.SUPERAGENT_PDF_P12_PASSWORD = previousSecret;
  if (previousCA === undefined) delete process.env.SUPERAGENT_PDF_CA_BUNDLE;
  else process.env.SUPERAGENT_PDF_CA_BUNDLE = previousCA;
  if (previousCRL === undefined) delete process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE;
  else process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE = previousCRL;
  if (previousTSA === undefined) delete process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE;
  else process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE = previousTSA;
  if (previousOCSP === undefined) delete process.env.SUPERAGENT_PDF_OCSP_RESPONSE;
  else process.env.SUPERAGENT_PDF_OCSP_RESPONSE = previousOCSP;
  if (root) await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 560]);
  page.drawText("Original digital signature fixture", { x: 25, y: 500, font, size: 12 });
  await fs.writeFile(path.join(root, "input.pdf"), await doc.save({ useObjectStreams: false }));
});
afterEach(async () => {
  if (previousCA === undefined) delete process.env.SUPERAGENT_PDF_CA_BUNDLE;
  else process.env.SUPERAGENT_PDF_CA_BUNDLE = previousCA;
  if (previousCRL === undefined) delete process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE;
  else process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE = previousCRL;
  if (previousTSA === undefined) delete process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE;
  else process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE = previousTSA;
  if (previousOCSP === undefined) delete process.env.SUPERAGENT_PDF_OCSP_RESPONSE;
  else process.env.SUPERAGENT_PDF_OCSP_RESPONSE = previousOCSP;
  for (const file of ["signed.pdf", "ocsp-signed.pdf", "multi-signed.pdf", "lta-signed.pdf", "bad-byte-range.pdf", "timestamped.pdf", "no-sig.pdf", "bad.pdf", "wrong.pdf"]) {
    await fs.rm(path.join(root, file), { force: true }).catch(() => undefined);
  }
});

describe("Strict PDF CMS signature", () => {
  it("cryptographically signs a new PDF and validates the CMS with independent OpenSSL", async () => {
    const source = await inspectPdf({ inputPath: "input.pdf" }, root);
    const signed = await signPdf({
      inputPath: "input.pdf", outputPath: "signed.pdf", certificatePath: "ephemeral-certificate.p12",
      expectedInputSha256: source.sha256, confirmSign: true,
      reason: "Temporary local test only", signerName: "Test Signer",
    }, root);
    expect(signed.status).toBe("verified");
    expect(signed.cryptographicSignatureValid).toBe(true);
    expect(signed.certificateTrusted).toBe("not_checked");
    const data = await fs.readFile(path.join(root, "signed.pdf"));
    expect(data.subarray(0, 5).toString()).toBe("%PDF-");
    const inspected = await verifyPdfSignature({ inputPath: "signed.pdf" }, root);
    expect(inspected).toMatchObject({ status: "verified", cryptographicSignatureValid: true, certificateTrusted: "not_checked" });
    expect(await fs.readFile(path.join(root, "input.pdf"))).toBeDefined();
    await expect(editPdf({
      inputPath: "signed.pdf", outputPath: "wrong.pdf", operations: [{ op: "page_numbers" }],
    }, root)).rejects.toMatchObject({ code: "signed_document" });
  });
  it("optionally validates CMS signer chain against host-controlled CA only", async () => {
    const source = await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"signed.pdf",certificatePath:"ephemeral-certificate.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    delete process.env.SUPERAGENT_PDF_CA_BUNDLE;
    await expect(verifyPdfSignature({inputPath:"signed.pdf",verifyTrustedChain:true},root))
      .rejects.toMatchObject({code:"trust_store_missing"});
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"ephemeral-public.crt");
    const trusted = await verifyPdfSignature({inputPath:"signed.pdf",verifyTrustedChain:true},root);
    expect(trusted).toMatchObject({
      status:"verified",cryptographicSignatureValid:true,
      certificateTrusted:"trusted_by_operator_store",
      certificateRevocation:"not_checked",timestampAuthority:"not_checked",
    });
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"untrusted-public.crt");
    const untrusted=await verifyPdfSignature({inputPath:"signed.pdf",verifyTrustedChain:true},root);
    expect(untrusted).toMatchObject({
      status:"partial",cryptographicSignatureValid:true,
      certificateTrusted:"untrusted_or_unverifiable",
    });
    // Tool-supplied trust store path must not be honored.
    const noPromptAuthority=await verifyPdfSignature({
      inputPath:"signed.pdf",verifyTrustedChain:true,caBundlePath:"ephemeral-public.crt"
    },root);
    expect(noPromptAuthority.certificateTrusted).toBe("untrusted_or_unverifiable");
  },20000);

  it.skipIf(!padesAvailable)("runs pinned pyHanko independent PDF validation offline without claiming PAdES profile certification",async()=>{
    const source=await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"signed.pdf",certificatePath:"pades-certificate.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"pades-public.crt");
    const report=await verifyPdfSignature({
      inputPath:"signed.pdf",verifyIndependentPades:true,
      caBundlePath:"untrusted-public.crt",
    },root);
    expect(report).toMatchObject({
      status:"verified",cryptographicSignatureValid:true,
      certificateTrusted:"trusted_by_operator_store",
      padesProfile:"not_structurally_certified",
      timestampAuthority:"absent",
    });
    const independent=report.independentValidation as any;
    expect(independent).toMatchObject({
      engine:"pyHanko",engineVersion:"0.38.1",offline:true,networkFetching:false,
      signatureCount:1,cryptographicIntegrity:"valid",certificateTrust:"trusted",
      padesStructuralConformance:"not_certified",
      padesEvidenceLevelCandidate:"B-B-like-evidence",
      padesProfileEvidence:{
        cadesDetached:true,
        trustedSignatureTimestampPerSignature:false,
        validatedRevocationMaterial:false,
        documentTimestampEvidenceRecordPerSignature:false,
      },
    });
    expect(independent.signatures[0]).toMatchObject({
      intact:true,cryptographicallyValid:true,trusted:true,revoked:false,
      bottomLine:true,coverage:"ENTIRE_FILE",modificationLevel:"NONE",
    });
  },30000);

  it.skipIf(!padesAvailable)("validates two incremental PDF signatures independently and refuses ambiguous single-signature OpenSSL mode",async()=>{
    const fixtureScript=path.resolve("tests/fixtures/pdf_pades_multisig_fixture.py");
    const generated=spawnSync(padesPython,[fixtureScript],{
      cwd:root,windowsHide:true,encoding:"utf8",timeout:20000,
      input:JSON.stringify({
        inputPath:path.join(root,"input.pdf"),
        outputPath:path.join(root,"multi-signed.pdf"),
        p12Path:path.join(root,"pades-certificate.p12"),
      }),
    });
    expect(generated.status).toBe(0);
    expect(JSON.parse(generated.stdout.trim())).toMatchObject({status:"created",signatureCount:2});

    await expect(verifyPdfSignature({
      inputPath:"multi-signed.pdf",
    },root)).rejects.toMatchObject({code:"unsupported_signature"});

    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"pades-public.crt");
    const report=await verifyPdfSignature({
      inputPath:"multi-signed.pdf",verifyIndependentPades:true,
    },root);
    expect(report).toMatchObject({
      status:"verified",
      cryptographicSignatureValid:true,
      certificateTrusted:"trusted_by_operator_store",
      padesProfile:"not_structurally_certified",
    });
    const independent=report.independentValidation as any;
    expect(independent.signatureCount).toBe(2);
    expect(independent.cryptographicIntegrity).toBe("valid");
    expect(independent.certificateTrust).toBe("trusted");
    expect(independent.signatures).toHaveLength(2);
    for(const signature of independent.signatures){
      expect(signature).toMatchObject({
        intact:true,
        cryptographicallyValid:true,
        trusted:true,
        revoked:false,
      });
    }
    expect(independent.signatures[1].coverage).toBe("ENTIRE_FILE");
    expect(independent.signatures[0].coverage).not.toBe("UNCLEAR");
  },30000);

  it.skipIf(!padesAvailable)("validates an actual RFC3161 signature timestamp offline and rejects the wrong TSA trust root",async()=>{
    const fixtureScript=path.resolve("tests/fixtures/pdf_pades_timestamp_fixture.py");
    const generated=spawnSync(padesPython,[fixtureScript],{
      cwd:root,windowsHide:true,encoding:"utf8",timeout:20000,
      input:JSON.stringify({
        inputPath:path.join(root,"input.pdf"),
        outputPath:path.join(root,"timestamped.pdf"),
        p12Path:path.join(root,"pades-certificate.p12"),
        tsaCertPath:path.join(root,"tsa-public.crt"),
        tsaKeyPath:path.join(root,"tsa-private.key"),
      }),
    });
    expect(generated.status).toBe(0);
    expect(JSON.parse(generated.stdout.trim())).toMatchObject({status:"created"});
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"pades-public.crt");
    process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE=path.join(root,"tsa-public.crt");
    const trusted=await verifyPdfSignature({
      inputPath:"timestamped.pdf",verifyIndependentPades:true,
    },root);
    expect(trusted).toMatchObject({
      status:"verified",cryptographicSignatureValid:true,
      certificateTrusted:"trusted_by_operator_store",
      certificateRevocation:"not_available",
      timestampAuthority:"valid",
      ocspStatus:"not_available",
    });
    expect(trusted.embeddedValidationEvidence).toMatchObject({ocsps:0,crls:0});
    const report=trusted.independentValidation as any;
    expect(report.revocationValidation).toBe("not_available");
    expect(report.formalAdesPolicy).toMatchObject({
      standard:"ETSI EN 319 102-1",basicSection:"5.3",withTimeSection:"5.5",
      networkFetching:false,certificateFetching:false,
    });
    expect(report.signatures[0].adesBasic).toMatchObject({status:"PASSED"});
    expect(report.signatures[0].adesWithTime).toMatchObject({status:"PASSED"});
    expect(report.signatures[0].adesLta).toMatchObject({
      status:"PASSED",hasDocumentTimestampEvidenceRecord:false,
      oldestEvidenceRecordTimestamp:null,
    });
    expect(report.signatures[0].signatureTimestamp).toMatchObject({
      trusted:true,revoked:false,time:"2026-11-05T01:23:45+00:00",
    });
    expect(report.padesEvidenceLevelCandidate).toBe("B-T-like-evidence");
    expect(report.padesProfileEvidence).toMatchObject({
      cadesDetached:true,
      trustedSignatureTimestampPerSignature:true,
      validatedRevocationMaterial:false,
      documentTimestampEvidenceRecordPerSignature:false,
    });

    process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE=path.join(root,"untrusted-public.crt");
    const wrongTsa=await verifyPdfSignature({
      inputPath:"timestamped.pdf",verifyIndependentPades:true,
    },root);
    expect(wrongTsa.status).toBe("partial");
    expect(wrongTsa.cryptographicSignatureValid).toBe(true);
    expect(wrongTsa.timestampAuthority).toBe("invalid_or_untrusted");
    const wrongReport=wrongTsa.independentValidation as any;
    expect(wrongReport.signatures[0].adesBasic.status).toBe("PASSED");
    expect(wrongReport.signatures[0].adesWithTime.status).not.toBe("PASSED");
  },30000);

  it.skipIf(!padesAvailable)("validates offline DSS plus document timestamp evidence without falsely certifying structural PAdES",async()=>{
    const fixtureScript=path.resolve("tests/fixtures/pdf_pades_lta_fixture.py");
    const generated=spawnSync(padesPython,[fixtureScript],{
      cwd:root,windowsHide:true,encoding:"utf8",timeout:30000,
      input:JSON.stringify({
        inputPath:path.join(root,"input.pdf"),
        outputPath:path.join(root,"lta-signed.pdf"),
        p12Path:path.join(root,"ocsp-leaf.p12"),
        signerCaPath:path.join(root,"ocsp-ca.crt"),
        ocspPath:path.join(root,"ocsp-good.der"),
        tsaCertPath:path.join(root,"tsa-public.crt"),
        tsaKeyPath:path.join(root,"tsa-private.key"),
      }),
    });
    expect(generated.status).toBe(0);
    expect(JSON.parse(generated.stdout.trim())).toMatchObject({
      status:"created",networkFetching:false,
    });

    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"ocsp-ca.crt");
    process.env.SUPERAGENT_PDF_TSA_CA_BUNDLE=path.join(root,"tsa-public.crt");
    process.env.SUPERAGENT_PDF_OCSP_RESPONSE=path.join(root,"ocsp-good.der");
    const report=await verifyPdfSignature({
      inputPath:"lta-signed.pdf",verifyIndependentPades:true,
    },root);
    expect(report).toMatchObject({
      status:"verified",
      cryptographicSignatureValid:true,
      certificateTrusted:"trusted_by_operator_store",
      certificateRevocation:"valid_by_revocation_evidence",
      timestampAuthority:"valid",
      padesProfile:"not_structurally_certified",
    });
    const independent=report.independentValidation as any;
    expect(independent.signatureCount).toBe(1);
    expect(independent.documentTimestampCount).toBeGreaterThanOrEqual(1);
    expect(independent.embeddedSignatureObjectCount).toBeGreaterThanOrEqual(2);
    expect(independent.embeddedValidationEvidence.ocsps).toBeGreaterThan(0);
    expect(independent.documentTimestamps.length).toBeGreaterThanOrEqual(1);
    expect(independent.documentTimestamps.every((ts:any)=>
      ts.intact===true&&ts.cryptographicallyValid===true&&ts.trusted===true&&ts.revoked===false
    )).toBe(true);
    expect(independent.padesProfileEvidence.validatedRevocationMaterial).toBe(true);
    expect(independent.padesProfileEvidence.documentTimestampEvidenceRecordPerSignature).toBe(true);
    expect(independent.padesStructuralConformance).toBe("not_certified");
    expect(independent.padesEvidenceLevelCandidate).toBe("B-LTA-like-evidence");
  },40000);

  it.skipIf(!padesAvailable)("uses operator-controlled offline OCSP DER evidence and distinguishes good from revoked",async()=>{
    const source=await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"ocsp-signed.pdf",certificatePath:"ocsp-leaf.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"ocsp-ca.crt");
    process.env.SUPERAGENT_PDF_OCSP_RESPONSE=path.join(root,"ocsp-good.der");
    const good=await verifyPdfSignature({
      inputPath:"ocsp-signed.pdf",verifyIndependentPades:true,
    },root);
    expect(good).toMatchObject({
      cryptographicSignatureValid:true,
      certificateTrusted:"trusted_by_operator_store",
      certificateRevocation:"valid_by_revocation_evidence",
      ocspStatus:"operator_ocsp_evidence_checked",
    });
    const goodIndependent=good.independentValidation as any;
    expect(goodIndependent.operatorOcspEvidence).toMatchObject({configured:true});
    expect(goodIndependent.revocationValidation).toBe("checked_no_revocation");
    expect(goodIndependent.revocationSources).toContain("operator_ocsp");
    expect(goodIndependent.padesEvidenceLevelCandidate).toBe("B-B-like-evidence");
    expect(goodIndependent.padesProfileEvidence.validatedRevocationMaterial).toBe(true);

    process.env.SUPERAGENT_PDF_OCSP_RESPONSE=path.join(root,"ocsp-revoked.der");
    const revoked=await verifyPdfSignature({
      inputPath:"ocsp-signed.pdf",verifyIndependentPades:true,
    },root);
    expect(revoked.status).toBe("partial");
    expect(revoked.cryptographicSignatureValid).toBe(true);
    expect(revoked.certificateRevocation).toBe("revoked");
    expect(revoked.ocspStatus).toBe("operator_ocsp_evidence_reports_revoked");
    expect((revoked.independentValidation as any).revocationValidation).toBe("revoked");
  },30000);

  it.skipIf(!padesAvailable)("downgrades cryptographically valid but expired operator OCSP evidence",async()=>{
    const source=await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"ocsp-signed.pdf",certificatePath:"ocsp-leaf.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"ocsp-ca.crt");
    process.env.SUPERAGENT_PDF_OCSP_RESPONSE=path.join(root,"ocsp-stale.der");
    const stale=await verifyPdfSignature({
      inputPath:"ocsp-signed.pdf",verifyIndependentPades:true,
    },root);
    expect(stale.status).toBe("partial");
    expect(stale.cryptographicSignatureValid).toBe(true);
    expect(stale.certificateTrusted).toBe("untrusted_or_unverifiable");
    expect(stale.certificateRevocation).toBe("indeterminate");
    expect(stale.ocspStatus).toBe("operator_ocsp_evidence_indeterminate");
    const independent=stale.independentValidation as any;
    expect(independent.revocationValidation).toBe("indeterminate");
    expect(independent.padesProfileEvidence.validatedRevocationMaterial).toBe(false);
  },30000);

  it("checks offline operator CRLs without network and distinguishes verified from absent evidence", async () => {
    const source = await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"signed.pdf",
      certificatePath:"ephemeral-certificate.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    process.env.SUPERAGENT_PDF_CA_BUNDLE=path.join(root,"ephemeral-public.crt");
    delete process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE;
    await expect(verifyPdfSignature({
      inputPath:"signed.pdf",verifyOfflineCrl:true,
    },root)).rejects.toMatchObject({code:"trust_store_missing"});
    process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE=path.join(root,"trusted-with-crl.pem");
    const certified=await verifyPdfSignature({
      inputPath:"signed.pdf",verifyOfflineCrl:true,
    },root);
    expect(certified.certificateTrusted).toBe("trusted_by_operator_store");
    expect(certified.certificateRevocation).toBe("valid_by_operator_offline_crl");
    expect(certified.ocspStatus).toBe("not_checked");
    expect(certified.timestampAuthority).toBe("not_checked");
    expect(certified.padesProfile).toBe("not_independently_validated");
    expect(certified.padesStructuralIndicators.etsiCadesDetachedSubFilter).toBe(true);
    process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE=path.join(root,"revoked-with-crl.pem");
    const revoked=await verifyPdfSignature({
      inputPath:"signed.pdf",verifyOfflineCrl:true,
    },root);
    expect(revoked.status).toBe("partial");
    expect(revoked.cryptographicSignatureValid).toBe(true);
    expect(revoked.certificateRevocation).toBe("revoked");
    // A trust/CRL path supplied by the model should never change verification.
    process.env.SUPERAGENT_PDF_CA_CRL_BUNDLE=path.join(root,"ephemeral-public.crt");
    await expect(verifyPdfSignature({
      inputPath:"signed.pdf",verifyOfflineCrl:true,
      crlBundlePath:"trusted-with-crl.pem",
    },root)).rejects.toMatchObject({code:"trust_store_invalid"});
  },25000);

  it("rejects signing without explicit approval or a matching source hash", async () => {
    const source = await inspectPdf({ inputPath: "input.pdf" }, root);
    await expect(signPdf({inputPath:"input.pdf",outputPath:"bad.pdf",certificatePath:"ephemeral-certificate.p12",expectedInputSha256:source.sha256},root))
      .rejects.toMatchObject({code:"confirmation_required"});
    await expect(signPdf({inputPath:"input.pdf",outputPath:"bad.pdf",certificatePath:"ephemeral-certificate.p12",expectedInputSha256:"fake",confirmSign:true},root))
      .rejects.toMatchObject({code:"hash_mismatch"});
    await expect(fs.stat(path.join(root, "bad.pdf"))).rejects.toMatchObject({code:"ENOENT"});
  });
  it("denies certificate reads outside workspace and arbitrary password environment names", async () => {
    const source = await inspectPdf({inputPath:"input.pdf"},root);
    const base={inputPath:"input.pdf",outputPath:"bad.pdf",expectedInputSha256:source.sha256,confirmSign:true};
    await expect(signPdf({...base,certificatePath:"../ephemeral-certificate.p12"},root))
      .rejects.toMatchObject({code:"path_denied"});
    await expect(signPdf({...base,certificatePath:"ephemeral-certificate.p12",passwordEnv:"HOME"},root))
      .rejects.toMatchObject({code:"secret_policy"});
  });
  it("rejects malformed ByteRange coverage before trusting CMS contents", async () => {
    const source=await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"signed.pdf",certificatePath:"ephemeral-certificate.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    const bytes=await fs.readFile(path.join(root,"signed.pdf"));
    const text=bytes.toString("latin1");
    const mutated=text.replace(/\/ByteRange\s*\[\s*0\b/, match=>match.replace(/0(?=\s*$|\s)/,"1"));
    expect(mutated).not.toBe(text);
    await fs.writeFile(path.join(root,"bad-byte-range.pdf"),Buffer.from(mutated,"latin1"));
    await expect(verifyPdfSignature({inputPath:"bad-byte-range.pdf"},root))
      .rejects.toMatchObject({code:"invalid_signature"});
  });

  it("detects a tampered post-signature PDF and reports invalid signature", async () => {
    const source = await inspectPdf({inputPath:"input.pdf"},root);
    await signPdf({
      inputPath:"input.pdf",outputPath:"signed.pdf",certificatePath:"ephemeral-certificate.p12",
      expectedInputSha256:source.sha256,confirmSign:true,
    },root);
    const bytes = await fs.readFile(path.join(root,"signed.pdf"));
    // Change an original signed byte without changing byte range or PDF structure.
    const label = Buffer.from("Original digital signature fixture");
    const pos = bytes.indexOf(label);
    if (pos >= 0) bytes[pos] = "Z".charCodeAt(0);
    else {
      // Preserve structure and alter a signed metadata byte in a printable string.
      const idx = bytes.indexOf(Buffer.from("/Producer"));
      if (idx < 0) throw new Error("No safe tamper location");
      bytes[idx] = "X".charCodeAt(0);
    }
    await fs.writeFile(path.join(root,"signed.pdf"),bytes);
    await expect(verifyPdfSignature({inputPath:"signed.pdf"},root)).rejects.toMatchObject({code:"invalid_signature"});
  });
  it("refuses to treat an unsigned PDF as a valid signature", async () => {
    await expect(verifyPdfSignature({inputPath:"input.pdf"},root)).rejects.toMatchObject({code:"invalid_signature"});
  });
});
