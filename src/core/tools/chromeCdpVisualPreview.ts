/**
 * Consent-gated, transient local preview of an exact registered managed Chrome tab.
 *
 * No screenshots are persisted, cached, logged, or attached to a browser event.
 * Native Core credentials stay inside Rust; the WebView only receives the
 * downscaled JPEG the operator explicitly requested for that exact tab.
 */
import { withCdpTargetCoordination, listCdpSessions } from "./chromeCdpSessionManager.js";
import {
  listManagedBrowserRegistrations, browserFingerprintForPort,
} from "./managedBrowserRegistry.js";
import { captureLocalCdpJpeg, getLocalCdpTargetUrlDigest } from "./chromeCdpTools.js";

const cooldown = new Map<string, number>();
const previewAnchors = new Map<string, {
  key: string; generation: string; revision: number; browser: string; urlDigest: string; at: number;
}>();
const MAX_ANCHORS = 32;
const ANCHOR_TTL_MS = 5 * 60_000;
function pruneAnchors(now: number) {
  for (const [id, anchor] of previewAnchors) {
    if (anchor.at + ANCHOR_TTL_MS <= now) previewAnchors.delete(id);
  }
}
const CAPTURE_INTERVAL_MS = 1000;
const MAX_PREVIEW_BASE64 = 640_000;

export type PreviewRequest = {
  port: number;
  targetId: string;
  expectedRevision: number;
  consent: true;
  previewId: string;
};

export function validatePreviewRequest(raw: unknown): PreviewRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Preview request must be an object.");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key =>
      !["port", "targetId", "expectedRevision", "consent", "previewId"].includes(key)) ||
    !Number.isInteger(input.port) || Number(input.port) < 1024 ||
    Number(input.port) > 65535 ||
    typeof input.targetId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.targetId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    Number(input.expectedRevision) < 0 || input.consent !== true ||
    typeof input.previewId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.previewId)) {
    throw new Error("Explicit consent and a verified target revision are required.");
  }
  return input as PreviewRequest;
}

export async function captureQualifiedManagedPreview(
  raw: unknown,
  deps: {
    capture?: typeof captureLocalCdpJpeg;
    fingerprint?: typeof browserFingerprintForPort;
    urlDigest?: typeof getLocalCdpTargetUrlDigest;
    now?: () => number;
  } = {},
): Promise<{ format: "jpeg"; jpeg: string; capturedAt: number; targetId: string; revision: number }> {
  const request = validatePreviewRequest(raw);
  const now = deps.now ?? Date.now;
  const capture = deps.capture ?? captureLocalCdpJpeg;
  const fingerprint = deps.fingerprint ?? browserFingerprintForPort;
  const getUrlDigest = deps.urlDigest ?? getLocalCdpTargetUrlDigest;
  return withCdpTargetCoordination(request.port, request.targetId, async () => {
    const registration = listManagedBrowserRegistrations().find(row =>
      row.port === request.port && row.targetId === request.targetId);
    if (!registration || registration.expiresAt <= now())
      throw new Error("Preview denied: no live managed browser registration.");
    if (await fingerprint(request.port) !== registration.browserFingerprint)
      throw new Error("Preview denied: managed browser fingerprint changed.");
    const lease = (await listCdpSessions()).find(row =>
      row.port === request.port && row.targetId === request.targetId);
    if (!lease || lease.revision !== request.expectedRevision ||
        lease.expiresAt <= now())
      throw new Error("Preview denied: CDP claim or revision changed.");

    const key = request.port + ":" + request.targetId;
    pruneAnchors(now());
    const anchor = previewAnchors.get(request.previewId);
    const beforeUrlDigest = await getUrlDigest(request.port, request.targetId);
    if (!/^[a-f0-9]{64}$/.test(beforeUrlDigest))
      throw new Error("Preview URL identity unavailable.");
    if (anchor && (anchor.key !== key || anchor.generation !== lease.generation ||
      anchor.revision !== request.expectedRevision ||
      anchor.browser !== registration.browserFingerprint ||
      anchor.urlDigest !== beforeUrlDigest)) {
      throw new Error("Preview document changed; obtain fresh explicit consent.");
    }
    if (!anchor && previewAnchors.size >= MAX_ANCHORS)
      throw new Error("Preview consent capacity reached.");
    const last = cooldown.get(key) ?? 0;
    if (now() - last < CAPTURE_INTERVAL_MS)
      throw new Error("Preview rate limit: at most one frame per second.");
    // Reserve before capture: simultaneous native UI requests cannot pile up.
    cooldown.set(key, now());
    const jpeg = await capture(request.port, request.targetId);
    const afterUrlDigest = await getUrlDigest(request.port, request.targetId);
    if (beforeUrlDigest !== afterUrlDigest)
      throw new Error("Preview document navigated during capture; frame discarded.");
    if (typeof jpeg !== "string" || jpeg.length < 64 ||
        jpeg.length > MAX_PREVIEW_BASE64 || jpeg.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(jpeg))
      throw new Error("Preview returned an invalid or oversized JPEG.");
    // Validate magic bytes; do not accept arbitrary base64 disguised as an image.
    const sample = Buffer.from(jpeg.slice(0, 16), "base64");
    if (sample[0] !== 0xff || sample[1] !== 0xd8 || sample[2] !== 0xff)
      throw new Error("Preview payload is not a JPEG.");
    if (!anchor) previewAnchors.set(request.previewId, {
      key, generation: lease.generation, revision: request.expectedRevision,
      browser: registration.browserFingerprint, urlDigest: beforeUrlDigest, at: now(),
    });
    return {
      format: "jpeg", jpeg, capturedAt: now(), targetId: request.targetId,
      revision: request.expectedRevision,
    };
  });
}

/** Tests only: isolated core state used to enforce per-target preview pacing. */
export function resetManagedPreviewRateLimitForTests() {
  cooldown.clear();
  previewAnchors.clear();
}
