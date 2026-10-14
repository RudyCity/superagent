import * as fs from "fs/promises";
import * as path from "path";
import { CdpTarget } from "./chromeCdpHelpers.js";

export interface CdpScreenshotOptions {
  outputPath?: string;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
  fullPage?: boolean;
}

export interface CdpScreenshotResult {
  base64: string;
  dataUrl: string;
  savedPath: string;
  byteSize: number;
}

/**
 * Capture a visual screenshot from a CDP target tab, save it to disk,
 * and return structured base64, dataUrl, and file metadata.
 */
export async function captureCdpScreenshot(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: CdpTarget,
  options?: CdpScreenshotOptions
): Promise<CdpScreenshotResult> {
  const format = options?.format === "jpeg" || options?.format === "webp" ? options.format : "png";
  const params: Record<string, unknown> = {
    format,
  };
  if (options?.quality !== undefined && (format === "jpeg" || format === "webp")) {
    params.quality = Math.max(0, Math.min(100, Math.round(options.quality)));
  }
  if (options?.fullPage) {
    params.captureBeyondViewport = true;
  }

  const res: any = await cdpSend(target, "Page.captureScreenshot", params);
  const rawData = String((res && res.data) || "");
  if (!rawData) {
    throw new Error("CDP Page.captureScreenshot returned empty data.");
  }

  const ext = format === "jpeg" ? "jpg" : format;
  let savedPath: string;
  if (options?.outputPath) {
    savedPath = path.resolve(options.outputPath);
    const root = path.resolve(process.cwd());
    const relative = path.relative(root, savedPath);
    if ((relative.startsWith("..") || path.isAbsolute(relative)) && process.env.SUPERAGENT_CDP_ALLOW_EXTERNAL_OUTPUT !== "true") {
      throw new Error("Screenshot outputPath must remain inside the current workspace. Set SUPERAGENT_CDP_ALLOW_EXTERNAL_OUTPUT=true only when external output paths are intentional.");
    }
  } else {
    savedPath = path.resolve(process.cwd(), "screenshots", `cdp_screenshot_${Date.now()}.${ext}`);
  }

  const buf = Buffer.from(rawData, "base64");
  if (buf.byteLength > 25 * 1024 * 1024) throw new Error("Screenshot exceeds the 25 MiB output limit; use a smaller viewport or a compressed format.");
  await fs.mkdir(path.dirname(savedPath), { recursive: true });
  await fs.writeFile(savedPath, buf);

  const mimeType = format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
  const dataUrl = `data:${mimeType};base64,${rawData}`;

  return {
    base64: rawData,
    dataUrl,
    savedPath,
    byteSize: buf.length,
  };
}

/**
 * Format screenshot result string for the CLI / agent tool output.
 */
export function formatScreenshotResult(result: CdpScreenshotResult, prefix = "control_chrome_cdp:", includeImageData = false): string {
  const metadata = `${prefix} screenshot captured (${result.byteSize} bytes) and saved to ${result.savedPath}`;
  return includeImageData ? `${metadata}\n${result.dataUrl}` : `${metadata}. Pass includeImageData: true to include inline image data.`;
}

/**
 * Conditionally capture and attach a screenshot to an existing action result.
 * Default is enabled for navigation, optional for interactive actions.
 */
export async function attachScreenshotIfRequested(
  cdpSend: (target: CdpTarget, method: string, params?: Record<string, unknown>) => Promise<any>,
  target: CdpTarget,
  payload: Record<string, unknown>,
  baseResult: string,
  defaultEnabled = false
): Promise<string> {
  const enabled = defaultEnabled
    ? payload.screenshot !== false && payload.auto_screenshot !== false && payload.autoScreenshot !== false
    : Boolean(payload.screenshot || payload.auto_screenshot || payload.autoScreenshot);

  if (!enabled) {
    return baseResult;
  }

  try {
    const outPath = payload.outputPath || payload.output_path;
    const format = payload.format as "png" | "jpeg" | "webp" | undefined;
    const quality = payload.quality !== undefined ? Number(payload.quality) : undefined;
    const fullPage = Boolean(payload.full_page || payload.fullPage);

    const shot = await captureCdpScreenshot(cdpSend, target, {
      outputPath: outPath ? String(outPath) : undefined,
      format,
      quality,
      fullPage,
    });
    const suffix = payload.includeImageData === true || payload.include_image_data === true ? `\n${shot.dataUrl}` : ". Set includeImageData: true to include inline image data.";
    return `${baseResult}\n\nScreenshot saved: ${shot.savedPath}${suffix}`;
  } catch {
    // If screenshot capture fails, preserve the original action result
    return baseResult;
  }
}
