import { DesktopUiError } from "./errors.js";
import type { DesktopVisionDetector, VisionDetection } from "./types.js";

interface UiDetrResponse {
  success?: boolean;
  elements?: Array<{
    label?: unknown;
    score?: unknown;
    box?: unknown;
  }>;
  error?: unknown;
}

export interface LocalUiDetrVisionOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  allowScreenshotUpload?: boolean;
  authorizationToken?: string;
  minimumConfidence?: number;
}

const DEFAULT_MINIMUM_CONFIDENCE = 0.75;
const SAFE_VISUAL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "input",
  "link",
  "menuitem",
  "radiobutton",
  "slider",
  "switch",
  "tab",
  "textfield",
]);

function validateLoopbackEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (url.protocol !== "http:" || !loopback.has(url.hostname)) {
    throw new DesktopUiError(
      "VISION_UNAVAILABLE",
      "UI-DETR endpoint must use plain HTTP on a loopback host.",
    );
  }
  return url;
}

export function createLocalUiDetrVisionDetector(
  options: LocalUiDetrVisionOptions = {},
): DesktopVisionDetector {
  if (options.allowScreenshotUpload !== true && !options.authorizationToken) {
    throw new DesktopUiError(
      "VISION_UNAVAILABLE",
      "UI-DETR screenshot delivery is disabled until the caller explicitly opts in or configures local endpoint authentication.",
    );
  }

  const endpoint = options.endpoint ?? "http://127.0.0.1:8095";
  const fetchImpl = options.fetchImpl ?? fetch;
  const minimumConfidence = options.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new DesktopUiError("VISION_UNAVAILABLE", "UI-DETR minimumConfidence must be between 0 and 1.");
  }
  const base = validateLoopbackEndpoint(endpoint);

  return {
    async detect(image) {
      let response: Response;
      try {
        response = await fetchImpl(new URL("/detect", base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(options.authorizationToken ? { Authorization: `Bearer ${options.authorizationToken}` } : {}),
          },
          body: JSON.stringify({ image_base64: Buffer.from(image).toString("base64") }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DesktopUiError("VISION_UNAVAILABLE", `UI-DETR request failed: ${message}`);
      }

      if (!response.ok) {
        throw new DesktopUiError(
          "VISION_UNAVAILABLE",
          `UI-DETR returned HTTP ${response.status}.`,
        );
      }

      const payload = (await response.json()) as UiDetrResponse;
      if (payload.success !== true || !Array.isArray(payload.elements)) {
        throw new DesktopUiError(
          "VISION_UNAVAILABLE",
          `UI-DETR returned an invalid detection payload${payload.error ? `: ${String(payload.error)}` : "."}`,
        );
      }

      const detections: VisionDetection[] = [];
      for (const element of payload.elements) {
        if (
          typeof element.label !== "string"
          || typeof element.score !== "number"
          || !Array.isArray(element.box)
          || element.box.length !== 4
          || !element.box.every((value) => typeof value === "number" && Number.isFinite(value))
        ) {
          continue;
        }

        const [x1, y1, x2, y2] = element.box as number[];
        if (x2 <= x1 || y2 <= y1) continue;
        const role = element.label.trim().toLowerCase();
        if (!SAFE_VISUAL_ROLES.has(role) || element.score < minimumConfidence) continue;

        detections.push({
          role,
          score: Math.max(0, Math.min(1, element.score)),
          box: [x1, y1, x2, y2],
        });
      }
      return detections;
    },
  };
}
