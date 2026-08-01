import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import os from "os";
import {
  isImageFilePath,
  mimeForExtension,
  readImageFromPath,
  attachmentToImagePart,
  formatFileSize,
} from "../src/utils/imageUtils.js";

describe("imageUtils", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isImageFilePath", () => {
    it("should return true for valid image file paths", () => {
      expect(isImageFilePath("C:\\Users\\user\\Pictures\\test.png")).toBe(true);
      expect(isImageFilePath("/home/user/images/photo.jpg")).toBe(true);
      expect(isImageFilePath("./relative/path/image.webp")).toBe(true);
      expect(isImageFilePath("../parent/img.gif")).toBe(true);
    });

    it("should return false for simple filenames without path components", () => {
      expect(isImageFilePath("test.png")).toBe(false);
    });

    it("should return false for unsupported extensions", () => {
      expect(isImageFilePath("/path/to/doc.pdf")).toBe(false);
      expect(isImageFilePath("/path/to/text.txt")).toBe(false);
      expect(isImageFilePath("/path/to/no-extension")).toBe(false);
    });
  });

  describe("mimeForExtension", () => {
    it("should return correct mime types", () => {
      expect(mimeForExtension(".png")).toBe("image/png");
      expect(mimeForExtension(".jpg")).toBe("image/jpeg");
      expect(mimeForExtension(".jpeg")).toBe("image/jpeg");
      expect(mimeForExtension(".webp")).toBe("image/webp");
      expect(mimeForExtension(".gif")).toBe("image/gif");
      expect(mimeForExtension(".bmp")).toBe("image/bmp");
      expect(mimeForExtension(".tiff")).toBe("image/tiff");
      expect(mimeForExtension(".tif")).toBe("image/tiff");
    });

    it("should return null for unsupported extensions", () => {
      expect(mimeForExtension(".pdf")).toBeNull();
      expect(mimeForExtension(".txt")).toBeNull();
    });
  });

  describe("formatFileSize", () => {
    it("should format sizes correctly", () => {
      expect(formatFileSize(500)).toBe("500B");
      expect(formatFileSize(1024)).toBe("1KB");
      expect(formatFileSize(1536)).toBe("2KB");
      expect(formatFileSize(1024 * 1024)).toBe("1.0MB");
      expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5MB");
    });
  });

  describe("readImageFromPath and attachmentToImagePart", () => {
    it("should read a file from disk and convert to attachment and image part", async () => {
      const tempFilePath = path.join(os.tmpdir(), `superagent-test-${Date.now()}.png`);
      const dummyData = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      
      // Write dummy PNG to disk
      await fs.writeFile(tempFilePath, dummyData);

      try {
        const attachment = await readImageFromPath(tempFilePath);
        
        expect(attachment.id).toBeDefined();
        expect(attachment.filename).toBe(path.basename(tempFilePath));
        expect(attachment.mimeType).toBe("image/png");
        expect(attachment.base64Data).toBe(dummyData.toString("base64"));
        expect(attachment.sizeBytes).toBe(dummyData.byteLength);
        expect(attachment.sourcePath).toBe(tempFilePath);

        const part = attachmentToImagePart(attachment);
        expect(part.type).toBe("image");
        expect(part.image).toBe(attachment.base64Data);
        expect(part.mimeType).toBe(attachment.mimeType);
      } finally {
        // Clean up
        await fs.unlink(tempFilePath).catch(() => {});
      }
    });

    it("should throw for non-existent files", async () => {
      await expect(readImageFromPath("/non/existent/path/image.png")).rejects.toThrow();
    });

    it("should throw for unsupported extensions", async () => {
      const tempFilePath = path.join(os.tmpdir(), `superagent-test-${Date.now()}.txt`);
      await fs.writeFile(tempFilePath, "hello");
      try {
        await expect(readImageFromPath(tempFilePath)).rejects.toThrow(/Unsupported image extension/);
      } finally {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    });
  });
});

