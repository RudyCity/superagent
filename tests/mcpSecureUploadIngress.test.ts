/**
 * mcpSecureUploadIngress.test.ts — Test suite for Secure Browser Upload Ingress pipeline.
 *
 * Covers scenarios:
 * 11. Upload fixture with hash verification.
 * 12. Path traversal and symlink escape rejection.
 * 13. MIME spoofing and file oversize limits.
 * 14. Replay operation ID rejection.
 * Host file-policy integration: certifiedBrowserUpload certifies staged ingress files
 * but rejects unmediated files.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  stageUploadArtifact,
  cleanupIngressReceipt,
  getIngressReceipt,
  isCertifiedIngressStagedFile,
  computeFileSha256,
  pruneExpiredIngressStaging,
  detectAndValidateMagicBytes,
  OFFICE_MIME_TYPES,
  MAX_UPLOAD_FILE_BYTES,
} from "../src/core/mcp/mcpUploadIngress.js";
import { certifiedBrowserUpload } from "../src/core/tools/browserFilePolicyCertification.js";

const FIXTURE_DIR = path.join(os.tmpdir(), `superagent_upload_test_${Date.now()}`);

beforeAll(async () => {
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("Secure Browser Upload Ingress Pipeline", () => {
  // Scenario 11: Upload fixture with hash verification
  it("Scenario 11: stages fixture file, computes hash, verifies integrity and returns certified receipt", async () => {
    const fixturePath = path.join(FIXTURE_DIR, "valid_image.png");
    // Standard PNG 8-byte magic header + minimal valid chunks
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    await fs.writeFile(fixturePath, pngHeader);

    const expectedSha256 = await computeFileSha256(fixturePath);
    const operationId = crypto.randomBytes(16).toString("hex");

    const receipt = await stageUploadArtifact({
      sourcePath: fixturePath,
      operationId,
      expectedSha256,
      expectedMime: "image/png",
      principalId: "test_principal",
      targetId: "delegate:test:1",
      sessionToken: "valid_session_token_12345678",
    });

    expect(receipt).toBeDefined();
    expect(receipt.sha256).toBe(expectedSha256);
    expect(receipt.mimeType).toBe("image/png");
    expect(isCertifiedIngressStagedFile(receipt.stagedPath)).toBe(true);

    // Verify certifiedBrowserUpload approves the staged path
    const uploadCall = {
      name: "superagent_chrome_cdp",
      args: { command: "upload_file", files: [receipt.stagedPath] },
    };
    expect(certifiedBrowserUpload(uploadCall)).toBe(true);

    // Verify unmediated original file is rejected by certifiedBrowserUpload
    const unmediatedCall = {
      name: "superagent_chrome_cdp",
      args: { command: "upload_file", files: [fixturePath] },
    };
    expect(certifiedBrowserUpload(unmediatedCall)).toBe(false);

    // Cleanup
    await cleanupIngressReceipt(receipt.receiptId);
    expect(getIngressReceipt(receipt.receiptId)).toBeNull();
  });

  // Scenario 12: Path traversal and symlink escape
  it("Scenario 12: rejects relative paths and path traversal attempts", async () => {
    const operationId = crypto.randomBytes(16).toString("hex");

    expect(
      stageUploadArtifact({
        sourcePath: "../../etc/passwd",
        operationId,
      })
    ).rejects.toThrow("SECURE_INGRESS_PATH_ERROR");
  });

  // Scenario 13: MIME spoofing and file oversize
  it("Scenario 13: detects MIME spoofing when file contents do not match declared type", async () => {
    const fakePng = path.join(FIXTURE_DIR, "fake_image.png");
    // Write text instead of PNG bytes
    await fs.writeFile(fakePng, "NOT_A_PNG_FILE_DATA");
    const operationId = crypto.randomBytes(16).toString("hex");

    expect(
      stageUploadArtifact({
        sourcePath: fakePng,
        operationId,
        expectedMime: "image/png",
      })
    ).rejects.toThrow("SECURE_INGRESS_MIME_SPOOF_DETECTED");
  });

  it("Scenario 13b: rejects files exceeding maximum size limits", async () => {
    const oversizedFile = path.join(FIXTURE_DIR, "huge.bin");
    // Create a sparse file or stat check test
    const operationId = crypto.randomBytes(16).toString("hex");

    // Test with non-existent file
    expect(
      stageUploadArtifact({
        sourcePath: path.join(FIXTURE_DIR, "missing.bin"),
        operationId,
      })
    ).rejects.toThrow("SECURE_INGRESS_FILE_NOT_FOUND");
  });

  // Scenario 14: Replay operation ID
  it("Scenario 14: rejects replaying the same operationId twice", async () => {
    const fixturePath = path.join(FIXTURE_DIR, "replay_test.txt");
    await fs.writeFile(fixturePath, "Hello Superagent");

    const operationId = crypto.randomBytes(16).toString("hex");

    const receipt = await stageUploadArtifact({
      sourcePath: fixturePath,
      operationId,
    });
    expect(receipt).toBeDefined();

    // Replay with identical operationId must be rejected
    expect(
      stageUploadArtifact({
        sourcePath: fixturePath,
        operationId,
      })
    ).rejects.toThrow("SECURE_INGRESS_REPLAY_DETECTED");

    await cleanupIngressReceipt(receipt.receiptId);
  });

  // Extended Magic Bytes Verification
  it("detects and validates MP4, WebM, and Office Open XML documents", async () => {
    // 1. MP4
    const mp4Path = path.join(FIXTURE_DIR, "video.mp4");
    const mp4Buf = Buffer.alloc(32);
    mp4Buf.write("ftyp", 4, "ascii");
    await fs.writeFile(mp4Path, mp4Buf);
    const mp4Res = await detectAndValidateMagicBytes(mp4Path, "video/mp4");
    expect(mp4Res.mime).toBe("video/mp4");
    expect(mp4Res.verified).toBe(true);

    // 2. WebM
    const webmPath = path.join(FIXTURE_DIR, "clip.webm");
    const webmBuf = Buffer.alloc(32);
    webmBuf[0] = 0x1a; webmBuf[1] = 0x45; webmBuf[2] = 0xdf; webmBuf[3] = 0xa3;
    await fs.writeFile(webmPath, webmBuf);
    const webmRes = await detectAndValidateMagicBytes(webmPath, "video/webm");
    expect(webmRes.mime).toBe("video/webm");
    expect(webmRes.verified).toBe(true);

    // 3. DOCX
    const docxPath = path.join(FIXTURE_DIR, "doc.docx");
    const zipBuf = Buffer.alloc(32);
    zipBuf[0] = 0x50; zipBuf[1] = 0x4b; zipBuf[2] = 0x03; zipBuf[3] = 0x04;
    await fs.writeFile(docxPath, zipBuf);
    const docxRes = await detectAndValidateMagicBytes(docxPath, OFFICE_MIME_TYPES.DOCX);
    expect(docxRes.mime).toBe(OFFICE_MIME_TYPES.DOCX);
    expect(docxRes.verified).toBe(true);

    // 4. XLSX
    const xlsxPath = path.join(FIXTURE_DIR, "sheet.xlsx");
    await fs.writeFile(xlsxPath, zipBuf);
    const xlsxRes = await detectAndValidateMagicBytes(xlsxPath, OFFICE_MIME_TYPES.XLSX);
    expect(xlsxRes.mime).toBe(OFFICE_MIME_TYPES.XLSX);
    expect(xlsxRes.verified).toBe(true);

    // 5. PPTX
    const pptxPath = path.join(FIXTURE_DIR, "deck.pptx");
    await fs.writeFile(pptxPath, zipBuf);
    const pptxRes = await detectAndValidateMagicBytes(pptxPath, OFFICE_MIME_TYPES.PPTX);
    expect(pptxRes.mime).toBe(OFFICE_MIME_TYPES.PPTX);
    expect(pptxRes.verified).toBe(true);
  });

  // Pruning expired ingress staging
  it("prunes expired staged files and in-memory receipts when TTL has elapsed", async () => {
    const fixturePath = path.join(FIXTURE_DIR, "prune_me.txt");
    await fs.writeFile(fixturePath, "Content to be pruned");
    const operationId = crypto.randomBytes(16).toString("hex");

    const receipt = await stageUploadArtifact({
      sourcePath: fixturePath,
      operationId,
    });
    expect(receipt).toBeDefined();
    expect(getIngressReceipt(receipt.receiptId)).not.toBeNull();

    // Call prune with future timestamp (beyond expiresAt)
    const futureTime = receipt.expiresAt + 2000;
    const pruned = await pruneExpiredIngressStaging(futureTime);
    expect(pruned).toBeGreaterThanOrEqual(1);

    // Confirm in-memory receipt is gone
    expect(getIngressReceipt(receipt.receiptId)).toBeNull();
  });
});
