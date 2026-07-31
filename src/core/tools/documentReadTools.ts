import fs from "fs/promises";
import path from "path";
import os from "os";
import { Tool } from "./types.js";
import { resolveFilePathFromArgs } from "./pathHelpers.js";

// Lazy-loaded module references to prevent startup performance drop
let PDFParseCtor: any = null;
let XLSX: any = null;
let mammoth: any = null;

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const OFFICE_CLI_TIMEOUT = 30_000; // 30 seconds

export const readDocumentTool: Tool = {
  name: "read_document",
  description:
    "Read and extract text content from PDF, Excel (.xlsx, .xls), and Word (.docx) document files. Uses officecli when available, falling back to local parsers and PaddleOCR for scanned PDF images.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the document file (PDF, XLSX, XLS, DOCX)",
      },
    },
    required: ["filePath"],
  },
  async execute(args, cwd, signal) {
    const rawPath = args.filePath as string;
    const resolvedPath = resolveFilePathFromArgs(args as Record<string, unknown>, cwd);

    if (!resolvedPath) {
      return `Error: Invalid or missing filePath parameter`;
    }

    // Determine if we are in SSH mode (workspaceMode import is lazy to avoid startup cost).
    let isSsh = false;
    try {
      const { workspaceMode } = await import("../ssh/workspaceMode.js");
      isSsh = workspaceMode.isSsh();
    } catch {
      // Not in SSH env — proceed locally.
    }

    // SSH routing: stat() for size + base64 over shell, parse locally.
    if (isSsh) {
      try {
        const { sshProxy } = await import("../ssh/sshProxy.js");
        const stat = await sshProxy.stat(resolvedPath).catch(() => null);
        if (!stat) {
          return `Error: File not found at ${resolvedPath} (remote)`;
        }
        if (!stat.isFile) {
          return `Error: Path is not a regular file: ${resolvedPath}`;
        }
        if (stat.size > MAX_FILE_SIZE) {
          return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). 100 MB limit.`;
        }
        const esc = (s: string) => sshProxy.escapeShellArg(s);
        const b64Res = await sshProxy.exec(
          `base64 -w 0 ${esc(resolvedPath)} 2>/dev/null || base64 ${esc(resolvedPath)}`,
          undefined,
          600000,
          signal,
        );
        if (b64Res.exitCode !== 0) {
          return `Error: Failed to read remote file at ${resolvedPath}: ${b64Res.stderr || `exit ${b64Res.exitCode}`}`;
        }
        const buffer = Buffer.from(b64Res.stdout.replace(/\s+/g, ""), "base64");
        if (buffer.length === 0) {
          return `Error: File appears empty or unreadable at ${resolvedPath}`;
        }
        return await parseDocumentBuffer(buffer, resolvedPath, signal);
      } catch (err: any) {
        return `Error reading remote document: ${err?.message || err}`;
      }
    }

    // Local file: check existence + size limit before reading.
    try {
      await fs.access(resolvedPath);
    } catch {
      return `Error: File not found at ${resolvedPath}`;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const stat = await fs.stat(resolvedPath);
    if (stat.size > MAX_FILE_SIZE) {
      return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). 100 MB limit.`;
    }
    const buffer = await fs.readFile(resolvedPath);
    return await parseDocumentBuffer(buffer, resolvedPath, signal, ext);
  },
};

/**
 * Parse a document buffer (PDF / XLSX / XLS / DOCX) and return formatted text.
 * Extracted so SSH and local paths can share the same parsing logic.
 */
async function parseDocumentBuffer(
  buffer: Buffer,
  resolvedPath: string,
  signal?: AbortSignal,
  precomputedExt?: string,
): Promise<string> {
  const ext = (precomputedExt || path.extname(resolvedPath).toLowerCase()).replace(/^\./, "");

  // Office files: try officecli on local binary with fetched buffer saved to temp file.
  if (ext === "docx" || ext === "xlsx" || ext === "xls" || ext === "pdf") {
    try {
      const { isOfficeCliInstalledLocally, getLocalOfficeCliPath } = await import("../androidSetup.js");
      const bin = (await isOfficeCliInstalledLocally()) ? getLocalOfficeCliPath() : "officecli";
      const tmp = path.join(os.tmpdir(), `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      try {
        await fs.writeFile(tmp, buffer);
        const { execa } = await import("execa");
        const result = await execa(bin, ["view", "text", tmp], {
          cancelSignal: signal,
          timeout: OFFICE_CLI_TIMEOUT,
        });
        const stdout = String(result.stdout ?? "");
        if (stdout && stdout.trim()) {
          return `--- Document Content (${path.basename(resolvedPath)} via OfficeCLI) ---\n\n${stdout}`;
        }
      } catch (err) {
        console.warn(`[readDocument] officecli failed for ${path.basename(resolvedPath)}:`, (err as Error).message);
      } finally {
        await fs.unlink(tmp).catch(() => {});
      }
    } catch (err) {
      console.warn(`[readDocument] officecli setup error for ${path.basename(resolvedPath)}:`, (err as Error).message);
    }
  }

  try {
    if (ext === "pdf") {
      if (!PDFParseCtor) {
        const pdfModule = await import("pdf-parse");
        PDFParseCtor = typeof pdfModule === "function" ? pdfModule : (pdfModule as any).default || (pdfModule as any).PDFParse;
      }
      let text = "";
      try {
        if (PDFParseCtor.name === "PDFParse") {
          // New v2.x class-based API
          const instance = new PDFParseCtor({ data: buffer });
          const result = await instance.getText();
          text = result.text ? result.text.trim() : "";
          await instance.destroy();
        } else {
          // Old v1.x function-based API
          const data = await PDFParseCtor(buffer);
          text = data.text ? data.text.trim() : "";
        }
      } catch (err) {
        console.warn(`[readDocument] pdf-parse failed for ${path.basename(resolvedPath)}:`, (err as Error).message);
        text = "";
      }
      if (text) {
        return `--- PDF Document Content (${path.basename(resolvedPath)}) ---\n\n${text}`;
      }
      // OCR fallback (PDF only, local env)
      try {
        const ocrSetup = await import("../setup/ocrSetup.js");
        if (await ocrSetup.isPaddleOcrAvailable()) {
          const tmp = path.join(os.tmpdir(), `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
          try {
            await fs.writeFile(tmp, buffer);
            const ocrText = await ocrSetup.runPaddleOcrOnPdf(tmp, signal);
            if (ocrText && ocrText.trim()) {
              return `--- PDF Document Content (${path.basename(resolvedPath)} via OCR Engine) ---\n\n${ocrText.trim()}`;
            }
          } finally {
            await fs.unlink(tmp).catch(() => {});
          }
        }
      } catch (err) {
        console.warn(`[readDocument] OCR failed for ${path.basename(resolvedPath)}:`, (err as Error).message);
      }
      return `--- PDF Document Content (${path.basename(resolvedPath)}) ---\n\nNo text content found (PDF may be scanned image or protected).`;
    }

    if (ext === "xlsx" || ext === "xls") {
      if (!XLSX) {
        XLSX = await import("xlsx");
      }
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const results: string[] = [];
      workbook.SheetNames.forEach((sheetName: string) => {
        const worksheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(worksheet);
        if (csv && csv.trim()) results.push(`Sheet: ${sheetName}\n${csv}`);
      });
      return `--- Excel Document Content (${path.basename(resolvedPath)}) ---\n\n${results.join("\n\n") || "No spreadsheet content found."}`;
    }

    if (ext === "docx") {
      if (!mammoth) {
        mammoth = await import("mammoth");
      }
      const { value: markdown } = await mammoth.convertToMarkdown({ buffer });
      return `--- Word Document Content (${path.basename(resolvedPath)}) ---\n\n${markdown || "No text content found."}`;
    }

    return `Error: Unsupported document type "${ext}". Supported formats are: .pdf, .xlsx, .xls, .docx`;
  } catch (error: any) {
    return `Error parsing document: ${error.message}`;
  }
}