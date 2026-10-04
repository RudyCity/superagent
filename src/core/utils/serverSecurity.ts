import crypto from "crypto";
import path from "path";
import fs from "fs";
import os from "os";
import type http from "http";

const ALLOWED_ORIGIN_PATTERN = /^https?:\/\/((localhost|127\.0\.0\.1)(:\d+)?|[a-zA-Z0-9-]+\.trycloudflare\.com)$/i;

export function resolveCorsOrigin(origin: string | string[] | undefined): string | undefined {
  const value = Array.isArray(origin) ? origin[0] : origin;
  return value && ALLOWED_ORIGIN_PATTERN.test(value) ? value : undefined;
}

export function buildCorsHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-workspace-path, x-auth-token",
    "Vary": "Origin"
  };
  const allowOrigin = resolveCorsOrigin(req.headers.origin as string | undefined);
  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }
  return headers;
}

let serverAuthToken = "";

export function ensureServerAuthToken(): string {
  if (!serverAuthToken) {
    serverAuthToken = crypto.randomBytes(24).toString("hex");
  }
  return serverAuthToken;
}

export function getServerAuthToken(port?: number): string {
  if (port) {
    try {
      const portServerInfoPath = path.join(os.homedir(), ".superagent-r", `server-info-${port}.json`);
      if (fs.existsSync(portServerInfoPath)) {
        const data = JSON.parse(fs.readFileSync(portServerInfoPath, "utf-8"));
        if (data?.authToken) {
          return data.authToken;
        }
      }
    } catch {}
  }
  if (serverAuthToken) return serverAuthToken;
  try {
    const serverInfoPath = path.join(os.homedir(), ".superagent-r", "server-info.json");
    if (fs.existsSync(serverInfoPath)) {
      const data = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
      if (data?.authToken) {
        if (!port || data.port === port) {
          serverAuthToken = data.authToken;
          return serverAuthToken;
        }
      }
    }
  } catch {}
  return ensureServerAuthToken();
}

function tokenMatches(supplied: string): boolean {
  if (!supplied || !serverAuthToken) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(serverAuthToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isRequestAuthorized(req: http.IncomingMessage, parsedUrl?: URL): boolean {
  const authHeader = (req.headers["authorization"] as string) || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const headerToken = ((req.headers["x-auth-token"] as string) || "").trim();
  let queryToken = "";
  if (!bearer && !headerToken) {
    const url = parsedUrl || new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    queryToken = (url.searchParams.get("token") || "").trim();
  }
  return tokenMatches(bearer) || tokenMatches(headerToken) || tokenMatches(queryToken);
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(base: string, target: string): boolean {
  const rel = path.relative(normalizeForCompare(base), normalizeForCompare(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isPathInsideOrEqual(base: string, target: string): boolean {
  return normalizeForCompare(base) === normalizeForCompare(target) || isPathInside(base, target);
}
