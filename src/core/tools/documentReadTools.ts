import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { Tool } from "./types.js";
import { resolveFilePathFromArgs } from "./pathHelpers.js";
import { getLocalOfficeCliPath, isOfficeCliInstalledLocally } from "../androidSetup.js";
import { isPaddleOcrAvailable, runPaddleOcrOnPdf } from "../setup/ocrSetup.js";

// Lazy-loaded imports to prevent startup performance drop
let pdfParse: any = null;
let XLSX: any = null;
let mammoth: any = null;

export const readDocumentTool: Tool = {
  name: "read_document",
  description: "Read and extract text content from PDF, Excel (.xlsx, .xls), and Word (.docx) document files. Uses officecli when available, falling back to local parsers and PaddleOCR for scanned PDF images.",
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

    try {
      await fs.access(resolvedPath);
    } catch {
      return `Error: File not found at ${resolvedPath}`;
    }

    const ext = path.extname(resolvedPath).toLowerCase();

    // Primary Path: Try to use officecli for Office files (.docx, .xlsx, .xls)
    if (ext === ".docx" || ext === ".xlsx" || ext === ".xls") {
      try {
        const bin = (await isOfficeCliInstalledLocally()) ? getLocalOfficeCliPath() : "officecli";
        const { stdout } = await execa(bin, ["view", "text", resolvedPath], {
          cwd,
          signal,
        });
        if (stdout && stdout.trim()) {
          return `--- Document Content (${path.basename(resolvedPath)} via OfficeCLI) ---\n\n${stdout}`;
        }
      } catch (e) {
        // Fallback to local parsers on error or if officecli is not installed
      }
    }

    // Fallback Path / PDF parser
    const buffer = await fs.readFile(resolvedPath);

    try {
      if (ext === ".pdf") {
        if (!pdfParse) {
          const pdfModule = await import("pdf-parse");
          pdfParse = typeof pdfModule === "function" ? pdfModule : (pdfModule as any).default;
        }
        let text = "";
        try {
          const data = await pdfParse(buffer);
          text = data.text ? data.text.trim() : "";
        } catch {
          text = "";
        }

        if (text) {
          return `--- PDF Document Content (${path.basename(resolvedPath)}) ---\n\n${text}`;
        }

        // Attempt 2: Try officecli text extraction for PDF if available
        try {
          const bin = (await isOfficeCliInstalledLocally()) ? getLocalOfficeCliPath() : "officecli";
          const { stdout } = await execa(bin, ["view", "text", resolvedPath], {
            cwd,
            cancelSignal: signal,
          });
          if (stdout && stdout.trim()) {
            return `--- PDF Document Content (${path.basename(resolvedPath)} via OfficeCLI) ---\n\n${stdout.trim()}`;
          }
        } catch {
          // Continue to OCR fallback
        }

        // Attempt 3: Enhanced OCR (PaddleOCR + PyTesseract) fallback for scanned/image PDFs
        if (await isPaddleOcrAvailable()) {
          try {
            const ocrText = await runPaddleOcrOnPdf(resolvedPath, signal);
            if (ocrText && ocrText.trim()) {
              return `--- PDF Document Content (${path.basename(resolvedPath)} via OCR Engine) ---\n\n${ocrText.trim()}`;
            }
          } catch (ocrErr: any) {
            return `Error extracting text via OCR Engine: ${ocrErr?.message || ocrErr}`;
          }
        }

        return `--- PDF Document Content (${path.basename(resolvedPath)}) ---\n\nNo text content found (PDF may be scanned image or protected). ${await isPaddleOcrAvailable() ? '' : 'Install PaddleOCR via superagent setup for OCR support.'}`;
      } 
      
      if (ext === ".xlsx" || ext === ".xls") {
        if (!XLSX) {
          XLSX = await import("xlsx");
        }
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const results: string[] = [];

        workbook.SheetNames.forEach((sheetName: string) => {
          const worksheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(worksheet);
          if (csv && csv.trim()) {
            results.push(`Sheet: ${sheetName}\n${csv}`);
          }
        });

        return `--- Excel Document Content (${path.basename(resolvedPath)} [Fallback]) ---\n\n${results.join("\n\n") || "No spreadsheet content found."}`;
      }

      if (ext === ".docx") {
        if (!mammoth) {
          mammoth = await import("mammoth");
        }
        const { value: markdown } = await mammoth.convertToMarkdown({ buffer });
        return `--- Word Document Content (${path.basename(resolvedPath)} [Fallback]) ---\n\n${markdown || "No text content found."}`;
      }

      return `Error: Unsupported document type "${ext}". Supported formats are: .pdf, .xlsx, .xls, .docx`;
    } catch (error: any) {
      return `Error parsing document: ${error.message}`;
    }
  }
};
