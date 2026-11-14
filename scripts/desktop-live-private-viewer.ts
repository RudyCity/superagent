/**
 * Explicit opt-in on the REMOTE VIEWER machine only.
 *
 * Usage (PowerShell):
 *   Get-Content -Raw -LiteralPath 'C:\restricted\viewer-config.json' |
 *     bun scripts/desktop-live-private-viewer.ts --config-stdin
 *
 * The stdin JSON contains privateAddress, port, pinnedServerCertSha256,
 * credential, clientCertPem, clientKeyPem and trustedCaPem.
 *
 * No secrets in argv, environment, URL, HTML or persistent logs.
 * Do not launch this on the remote-controlled host.
 */
import { startRemotePrivateViewerLocalUi } from "../src/core/desktopUi/remotePrivateViewerLocalUi.js";
import type { RemotePrivateViewerCredential } from "../src/core/desktopUi/remotePrivateTransport.js";

const MAX_CONFIG_BYTES = 128 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

async function readConfigPipe(): Promise<unknown> {
  if (process.stdin.isTTY) throw new Error("A private stdin pipe is required.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const piece = Buffer.from(chunk);
    size += piece.length;
    if (size > MAX_CONFIG_BYTES) throw new Error("Input is too large.");
    chunks.push(piece);
  }
  if (size === 0) throw new Error("Empty input pipe.");
  const bytes = Buffer.concat(chunks);
  try { return JSON.parse(bytes.toString("utf8")); }
  finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedPem(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 48_000 &&
    value.includes("-----BEGIN ") && value.includes("-----END ");
}

export async function runRemotePrivateViewerCli(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== "--config-stdin") {
    throw new Error("Usage: bun scripts/desktop-live-private-viewer.ts --config-stdin (pipe JSON on stdin)");
  }
  const raw = await readConfigPipe();
  if (!record(raw) || !record(raw.credential) ||
      !boundedPem(raw.clientCertPem) || !boundedPem(raw.clientKeyPem) ||
      !boundedPem(raw.trustedCaPem) || typeof raw.privateAddress !== "string" ||
      !Number.isInteger(raw.port) || Number(raw.port) < 1 || Number(raw.port) > 65535 ||
      typeof raw.pinnedServerCertSha256 !== "string" ||
      !HEX64.test(raw.pinnedServerCertSha256)) {
    throw new Error("Invalid private viewer configuration.");
  }
  const credential = raw.credential as unknown as RemotePrivateViewerCredential;
  if (!Number.isSafeInteger(credential.expiresAt) ||
      credential.expiresAt <= Date.now() || credential.expiresAt > Date.now() + 120_000 ||
      !HEX64.test(credential.sessionId) || !HEX64.test(credential.viewerKey) ||
      !HEX64.test(credential.viewerChallenge) ||
      !HEX64.test(credential.pinnedViewerCertSha256)) {
    throw new Error("Invalid or expired native viewer grant.");
  }
  // Key copies remain only in this viewer process; never sent over HTTP.
  const cert = Buffer.from(raw.clientCertPem);
  const key = Buffer.from(raw.clientKeyPem);
  const ca = Buffer.from(raw.trustedCaPem);
  const ui = await startRemotePrivateViewerLocalUi({
    privateOptions: {
      privateAddress: raw.privateAddress,
      port: Number(raw.port),
      pinnedServerCertSha256: raw.pinnedServerCertSha256,
      credential,
      clientCert: cert,
      clientKey: key,
      trustedCa: ca,
    },
  });
  let finishing = false;
  const shutdown = (): void => {
    if (finishing) return;
    finishing = true;
    void ui.close().finally(() => {
      cert.fill(0);
      key.fill(0);
      ca.fill(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdout.write("Private viewer (viewer machine only): " + ui.url + "\n");
  process.stdout.write("Local browser access secret: " + ui.accessSecret + "\n");
  process.stdout.write("Open URL manually and enter the secret. No host connection until Start view.\n");
  process.stdout.write("Native approval for the exact host window is independently required.\n");
  process.stdout.write("Viewer grant expires: " + new Date(credential.expiresAt).toISOString() + "\n");
  process.stdout.write("Press Ctrl+C to stop. Do not share the access secret.\n");
}

if (import.meta.main) {
  runRemotePrivateViewerCli(process.argv.slice(2)).catch(() => {
    // Errors are intentionally generic: no secret, path or PEM string in logs.
    process.stderr.write("Private viewer could not start. Check stdin config, grant, and local permissions.\n");
    process.exitCode = 1;
  });
}
