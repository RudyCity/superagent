import QRCode from "qrcode";

export interface DeviceTunnelQrInput {
  baseUrl: string;
  inviteId: string;
  code: string;
  expiresAt: number;
}

export interface DeviceTunnelQrPayload {
  k: "sat";
  v: 1;
  u: string;
  i: string;
  c: string;
  e: number;
}

export function buildDeviceTunnelQrPayload(input: DeviceTunnelQrInput): string {
  const url = new URL(input.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Device Tunnel QR requires a clean HTTPS base URL.");
  if (!/^[a-f0-9-]{36}$/i.test(input.inviteId) || !/^[0-9]{10}$/.test(input.code))
    throw new Error("Device Tunnel QR invitation is invalid.");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()
      || input.expiresAt > Date.now() + 11 * 60_000)
    throw new Error("Device Tunnel QR expiry is invalid.");

  const payload: DeviceTunnelQrPayload = {
    k: "sat",
    v: 1,
    u: url.origin,
    i: input.inviteId,
    c: input.code,
    e: input.expiresAt,
  };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 1024)
    throw new Error("Device Tunnel QR payload exceeded bound.");
  return encoded;
}

export async function renderDeviceTunnelQrDataUrl(payload: string): Promise<string> {
  if (!payload || Buffer.byteLength(payload, "utf8") > 1024)
    throw new Error("Device Tunnel QR payload is invalid.");
  const dataUrl = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 320,
    type: "image/png",
  });
  if (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > 180_000)
    throw new Error("Device Tunnel QR rendering failed.");
  return dataUrl;
}

export interface DeviceTunnelQrMatrix {
  size: number;
  cells: string;
}

export function renderDeviceTunnelQrMatrix(payload: string): DeviceTunnelQrMatrix {
  if (!payload || Buffer.byteLength(payload, "utf8") > 2048)
    throw new Error("Device Tunnel QR payload is invalid.");
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  if (!Number.isInteger(size) || size < 21 || size > 177 || qr.modules.data.length !== size * size)
    throw new Error("Device Tunnel QR matrix is invalid.");
  let cells = "";
  for (const value of qr.modules.data) cells += value ? "1" : "0";
  return { size, cells };
}
