import crypto from "node:crypto";

/**
 * Segment tags group discovery traffic; they are NOT authentication.
 * Human-readable names are guessable: pin TLS and require code + physical approval.
 */
export const DISCOVERY_REQUEST_PREFIX = "SUPERAGENT_LAN_DISCOVER_2:";
const SEGMENT_HASH_DOMAIN = "superagent-lan-segment-v1:";

export function normalizeNetworkSegment(input: unknown): string {
  if (typeof input !== "string") throw Error("Network segment name required (3-32 ASCII characters).");
  const normalized = input.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 32 || !/^[a-z0-9 _.-]+$/.test(normalized)) {
    throw Error("Network segment must be 3-32 ASCII letters, digits, spaces, _, ., or -.");
  }
  return normalized;
}

export function networkSegmentTag(name: string): string {
  return crypto.createHash("sha256").update(SEGMENT_HASH_DOMAIN + normalizeNetworkSegment(name), "utf8").digest("hex");
}

export function discoveryRequestForSegment(name: string): string {
  return DISCOVERY_REQUEST_PREFIX + networkSegmentTag(name);
}

export function isSegmentDiscoveryRequest(payload: Buffer | string, expectedTag: string): boolean {
  return /^[0-9a-f]{64}$/.test(expectedTag)
    && payload.toString() === DISCOVERY_REQUEST_PREFIX + expectedTag;
}

export interface SegmentDiscoveryResponse {
  version: 2;
  segmentTag: string;
  address: string;
  port: number;
  name: string;
  fingerprint: string;
  platform: "windows" | "android";
}

/** Datagram is untrusted: require exact v2, expected tag and source-address equality. */
export function parseSegmentDiscoveryResponse(
  packet: unknown, sourceAddress: string, expectedTag: string,
): SegmentDiscoveryResponse | null {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)
    || !/^[0-9a-f]{64}$/.test(expectedTag)) return null;
  const value = packet as Record<string, unknown>;
  if (value.version !== 2 || value.segmentTag !== expectedTag
      || value.address !== sourceAddress || typeof value.address !== "string"
      || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65534
      || typeof value.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.fingerprint)
      || typeof value.name !== "string" || value.name.length > 60
      || !/^[^\x00-\x1f\x7f]*$/.test(value.name)
      || (value.platform !== "android" && value.platform !== "windows")) return null;
  return {
    version: 2, segmentTag: expectedTag, address: value.address, port: Number(value.port),
    fingerprint: value.fingerprint, name: value.name, platform: value.platform,
  };
}
