import * as fs from "fs/promises";
import * as path from "path";

export interface CdpPdfResult {
  savedPath: string;
  byteSize: number;
}

/** Save a bounded CDP PDF artifact without returning its binary contents to the model. */
export async function saveCdpPdfArtifact(base64: string, outputPath?: string): Promise<CdpPdfResult> {
  if (!base64) throw new Error("CDP PDF data is empty.");
  const estimatedBytes = Math.floor(base64.length * 3 / 4);
  if (estimatedBytes > 25 * 1024 * 1024) {
    throw new Error("PDF exceeds the 25 MiB output limit; reduce page size or split the document.");
  }

  const savedPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(process.cwd(), `cdp_document_${Date.now()}.pdf`);
  const root = path.resolve(process.cwd());
  const relative = path.relative(root, savedPath);
  if ((relative.startsWith("..") || path.isAbsolute(relative)) && process.env.SUPERAGENT_CDP_ALLOW_EXTERNAL_OUTPUT !== "true") {
    throw new Error("PDF outputPath must remain inside the current workspace. Set SUPERAGENT_CDP_ALLOW_EXTERNAL_OUTPUT=true only when external output paths are intentional.");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > 25 * 1024 * 1024) throw new Error("PDF exceeds the 25 MiB output limit.");
  await fs.mkdir(path.dirname(savedPath), { recursive: true });
  await fs.writeFile(savedPath, buffer);
  return { savedPath, byteSize: buffer.byteLength };
}
