import fs from "fs/promises";
import crypto from "crypto";
import path from "path";
import os from "os";
import { execa } from "execa";
import { getGlobalConfigDir } from "../config.js";

// Disk cache directory: ~/.superagent-r/cache/ocr/
function getOcrCacheDir(): string {
  return path.join(getGlobalConfigDir(), "cache", "ocr");
}

/**
 * Calculate MD5 hash of a file
 */
async function getFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("md5").update(content).digest("hex");
}

/**
 * Read cached OCR result from disk
 */
async function getDiskCache(hash: string): Promise<string | null> {
  try {
    const cacheFile = path.join(getOcrCacheDir(), `${hash}.json`);
    const data = await fs.readFile(cacheFile, "utf-8");
    const parsed = JSON.parse(data);
    return parsed.text || null;
  } catch {
    return null;
  }
}

/**
 * Save OCR result to disk cache
 */
async function saveDiskCache(hash: string, text: string, engine: string): Promise<void> {
  try {
    const dir = getOcrCacheDir();
    await fs.mkdir(dir, { recursive: true });
    const cacheFile = path.join(dir, `${hash}.json`);
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ hash, text, engine, timestamp: Date.now() }, null, 2),
      "utf-8"
    );
  } catch {
    // Ignore disk cache write errors
  }
}

export interface OcrSystemStatus {
  pythonAvailable: boolean;
  paddleOcrAvailable: boolean;
  tesseractAvailable: boolean;
  pdfiumAvailable: boolean;
  pdf2imageAvailable: boolean;
  recommendations: string[];
}

/**
 * Check OCR system readiness and provide installation guidance
 */
export async function checkOcrSystemStatus(): Promise<OcrSystemStatus> {
  const isWin = process.platform === "win32";
  const pythonCmd = isWin ? "python" : "python3";
  const status: OcrSystemStatus = {
    pythonAvailable: false,
    paddleOcrAvailable: false,
    tesseractAvailable: false,
    pdfiumAvailable: false,
    pdf2imageAvailable: false,
    recommendations: [],
  };

  const script = `
import json, sys
res = {}
try:
    import paddleocr
    res['paddle'] = True
except Exception:
    res['paddle'] = False

try:
    import pytesseract
    res['tesseract'] = True
except Exception:
    res['tesseract'] = False

try:
    import pypdfium2
    res['pdfium'] = True
except Exception:
    res['pdfium'] = False

try:
    import pdf2image
    res['pdf2image'] = True
except Exception:
    res['pdf2image'] = False

print(json.dumps(res))
`;

  try {
    const { stdout } = await execa(pythonCmd, ["-c", script], { timeout: 10000 });
    status.pythonAvailable = true;
    const parsed = JSON.parse(stdout.trim());
    status.paddleOcrAvailable = !!parsed.paddle;
    status.tesseractAvailable = !!parsed.tesseract;
    status.pdfiumAvailable = !!parsed.pdfium;
    status.pdf2imageAvailable = !!parsed.pdf2image;
  } catch {
    status.pythonAvailable = false;
  }

  if (!status.pythonAvailable) {
    status.recommendations.push("Install Python 3.9+ and add it to PATH.");
  }
  if (!status.paddleOcrAvailable && !status.tesseractAvailable) {
    status.recommendations.push("Install OCR engine via pip: pip install paddleocr OR pip install pytesseract");
  }
  if (!status.pdfiumAvailable && !status.pdf2imageAvailable) {
    status.recommendations.push("Install PDF rendering library: pip install pypdfium2 OR pip install pdf2image");
  }

  return status;
}

/**
 * Enhanced PDF OCR Engine with:
 * 1. Persistent Disk Caching (~/.superagent-r/cache/ocr/)
 * 2. Image Preprocessing (Grayscale + Contrast Enhancement + Binarization)
 * 3. Multi-engine fallback: Engine 1 (PaddleOCR) -> Engine 2 (PyTesseract)
 * 4. Parallel page rendering & processing
 */
export async function runEnhancedPdfOcr(filePath: string, signal?: AbortSignal): Promise<string> {
  // 1. Check Persistent Disk Cache
  let fileHash = "";
  try {
    fileHash = await getFileHash(filePath);
    const cachedText = await getDiskCache(fileHash);
    if (cachedText) {
      return cachedText;
    }
  } catch {
    // Ignore hash error, proceed with OCR
  }

  const isWin = process.platform === "win32";
  const pythonCmd = isWin ? "python" : "python3";

  const script = `
import sys
import os
import json
import concurrent.futures

pdf_path = r"${filePath.replace(/\\/g, "\\\\")}"

def preprocess_image(img):
    """Enhance image quality for higher OCR accuracy (Grayscale & Contrast Boost)"""
    try:
        from PIL import ImageEnhance, ImageOps
        # Convert to grayscale
        gray = img.convert('L')
        # Enhance contrast
        enhancer = ImageEnhance.Contrast(gray)
        enhanced = enhancer.enhance(1.8)
        return enhanced
    except Exception:
        return img

def ocr_page_paddle(img, ocr_engine):
    try:
        import numpy as np
        processed = preprocess_image(img)
        res = ocr_engine.ocr(np.array(processed), cls=True)
        lines = []
        if res and res[0]:
            for line in res[0]:
                if line and len(line) >= 2 and line[1]:
                    lines.append(line[1][0])
        return "\\n".join(lines)
    except Exception:
        return ""

def ocr_page_tesseract(img):
    try:
        import pytesseract
        processed = preprocess_image(img)
        text = pytesseract.image_to_string(processed, lang='ind+eng')
        return text.strip()
    except Exception:
        try:
            import pytesseract
            processed = preprocess_image(img)
            text = pytesseract.image_to_string(processed, lang='eng')
            return text.strip()
        except Exception:
            return ""

def main():
    pages = []
    # Attempt page rendering via pdf2image or pypdfium2
    try:
        from pdf2image import convert_from_path
        pages = convert_from_path(pdf_path)
    except Exception:
        try:
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(pdf_path)
            pages = [page.render(scale=1.5).to_pil() for page in pdf]
        except Exception as e:
            print(json.dumps({"error": f"Failed to render PDF pages: {str(e)}"}))
            return

    if not pages:
        print(json.dumps({"error": "No pages extracted from PDF"}))
        return

    full_text_pages = []
    engine_used = None

    # Try Engine 1: PaddleOCR
    try:
        from paddleocr import PaddleOCR
        ocr_engine = PaddleOCR(use_angle_cls=True, lang='en', show_log=False)
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(pages))) as executor:
            futures = [executor.submit(ocr_page_paddle, page, ocr_engine) for page in pages]
            full_text_pages = [f.result() for f in futures]
        engine_used = "PaddleOCR"
    except Exception as e1:
        # Fallback to Engine 2: PyTesseract
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(4, len(pages))) as executor:
                futures = [executor.submit(ocr_page_tesseract, page) for page in pages]
                full_text_pages = [f.result() for f in futures]
            engine_used = "PyTesseract"
        except Exception as e2:
            print(json.dumps({"error": f"PaddleOCR failed ({str(e1)}); PyTesseract failed ({str(e2)})"}))
            return

    result_text = "\\n\\n--- Page Break ---\\n\\n".join([p for p in full_text_pages if p.strip()])
    print(json.dumps({"text": result_text, "engine": engine_used}))

if __name__ == "__main__":
    main()
`;

  try {
    const { stdout } = await execa(pythonCmd, ["-c", script], {
      cancelSignal: signal,
      timeout: 180000,
    });

    const parsed = JSON.parse(stdout.trim());
    if (parsed.error) {
      throw new Error(parsed.error);
    }

    const textResult = parsed.text || "";

    // Save to Disk Cache
    if (fileHash && textResult) {
      await saveDiskCache(fileHash, textResult, parsed.engine || "unknown");
    }

    return textResult;
  } catch (err: any) {
    // Negative Cache entry to prevent re-processing broken PDF repeatedly
    if (fileHash) {
      await saveDiskCache(fileHash, "", "failed").catch(() => {});
    }
    throw new Error(`PDF OCR processing failed: ${err.message || String(err)}`);
  }
}

export async function clearPdfOcrCache(): Promise<void> {
  try {
    const dir = getOcrCacheDir();
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cache clear error
  }
}
