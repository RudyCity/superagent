/**
 * openaiTunnelClient.ts - OpenAI Secure MCP Tunnel client orchestration.
 *
 * Connects Superagent's local MCP server to ChatGPT, Codex, and the OpenAI Responses API
 * through an outbound-only HTTPS connection to OpenAI's tunnel control plane, keeping the
 * local MCP server off the public internet without opening inbound firewall ports.
 *
 * Leverages OpenAI's official `tunnel-client` binary (https://github.com/openai/tunnel-client).
 * Handles binary discovery, credential resolution, health polling, diagnostics (doctor),
 * child process supervision, state persistence, and formatted snippet generation.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";

import { killProcessTree } from "../tools/helpers.js";
import { getOpenAiMcpTunnelConfig } from "./openaiMcpTunnelConfig.js";

export interface OpenAiTunnelOptions {
  /** OpenAI Tunnel ID (format: "tunnel_..." or alias created in Platform tunnel settings). */
  tunnelId: string;
  /** Port of the local Superagent MCP HTTP server (e.g. 9227). */
  mcpPort: number;
  /** Explicit runtime API key with Tunnels Read + Use permission. */
  apiKey?: string;
  /** Local target MCP URL; defaults to http://127.0.0.1:<mcpPort>/mcp. */
  mcpServerUrl?: string;
  /** Profile name for tunnel-client (default: "superagent-mcp"). */
  profile?: string;
  /** Directory containing profile YAML files (default: %APPDATA%/tunnel-client on Windows or ~/.config/tunnel-client on Unix). */
  profileDir?: string;
  /** Health check and local admin UI listen address (e.g. "127.0.0.1:8080"). */
  healthListenAddr?: string;
  /** Custom path to the tunnel-client binary. */
  binaryPath?: string;
  /** Optional bearer token to supply when calling local MCP server. */
  bearerToken?: string;
  /** Timeout in ms to wait for the tunnel-client to report ready (default: 15000). */
  readyTimeoutMs?: number;
  /** Whether to run in stateless embedded stub mode for testing. */
  embeddedStub?: boolean;
}

export interface OpenAiTunnelStatus {
  isRunning: boolean;
  pid?: number;
  tunnelId: string;
  mcpPort: number;
  localUrl: string;
  adminUrl?: string;
  healthUrl?: string;
  readyUrl?: string;
  healthy?: boolean;
  ready?: boolean;
  startedAt?: number;
  uptimeSeconds?: number;
  profile?: string;
  error?: string;
}

export interface OpenAiTunnelProcess {
  process: ChildProcess;
  tunnelId: string;
  mcpPort: number;
  healthPort: number;
  profile: string;
  startedAt: number;
  localUrl: string;
  adminUrl: string;
  healthUrl: string;
  readyUrl: string;
}

const activeTunnels = new Map<number, OpenAiTunnelProcess>();

/** Returns directory for storing OpenAI tunnel state files. */
export function getOpenAiTunnelStateDir(): string {
  const dir = path.join(os.homedir(), ".superagent-r");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getOpenAiTunnelStateFile(port: number): string {
  return path.join(getOpenAiTunnelStateDir(), `openai-tunnel-${port}.json`);
}

/**
 * Returns default profile directory used by OpenAI tunnel-client:
 * - TUNNEL_CLIENT_PROFILE_DIR environment variable if set
 * - On Windows: %APPDATA%\tunnel-client (e.g. C:\Users\<user>\AppData\Roaming\tunnel-client)
 * - On Unix/macOS: $XDG_CONFIG_HOME/tunnel-client or ~/.config/tunnel-client
 */
export function getDefaultTunnelClientProfileDir(): string {
  if (process.env.TUNNEL_CLIENT_PROFILE_DIR && process.env.TUNNEL_CLIENT_PROFILE_DIR.trim()) {
    return path.resolve(process.env.TUNNEL_CLIENT_PROFILE_DIR.trim());
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "tunnel-client");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "tunnel-client");
}

export interface OpenAiTunnelProfileOptions {
  profileDir?: string;
  profile?: string;
  tunnelId?: string;
  mcpServerUrl?: string;
  healthListenAddr?: string;
  apiKeyRef?: string;
  force?: boolean;
}

export interface OpenAiTunnelProfileResult {
  profileDir: string;
  profileFile: string;
  profileName: string;
  created: boolean;
}

/**
 * Ensures that the OpenAI tunnel-client profile directory exists and that
 * the requested profile YAML file is present. If it doesn't exist or if force is true,
 * writes a standard profile YAML compatible with OpenAI tunnel-client.
 */
export function ensureOpenAiTunnelProfile(opts: OpenAiTunnelProfileOptions = {}): OpenAiTunnelProfileResult {
  const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : getDefaultTunnelClientProfileDir();
  const profileName = (opts.profile || "superagent-mcp").trim();
  const profileFile = path.join(profileDir, `${profileName}.yaml`);

  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const exists = fs.existsSync(profileFile);
  if (exists && !opts.force && !opts.tunnelId && !opts.mcpServerUrl) {
    return {
      profileDir,
      profileFile,
      profileName,
      created: false,
    };
  }

  const tunnelId = opts.tunnelId || "tunnel_00000000000000000000000000000000";
  const mcpServerUrl = opts.mcpServerUrl || "http://127.0.0.1:9227/mcp";
  const healthListenAddr = opts.healthListenAddr || "127.0.0.1:10227";
  const apiKeyRef = opts.apiKeyRef || "env:CONTROL_PLANE_API_KEY";

  const lines = [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${tunnelId}"`,
    `  api_key: "${apiKeyRef}"`,
    "health:",
    `  listen_addr: "${healthListenAddr}"`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "  format: json",
    `  file: "${path.join(getOpenAiTunnelStateDir(), "tunnel-client.log").replace(/\\/g, "/")}"`,
    "mcp:",
    "  server_urls:",
    "    - channel: main",
    `      url: "${mcpServerUrl}"`,
    "",
  ];

  fs.writeFileSync(profileFile, lines.join("\n"), "utf-8");

  return {
    profileDir,
    profileFile,
    profileName,
    created: true,
  };
}

/**
 * Searches for the `tunnel-client` binary in:
 * 1. Explicit path parameter
 * 2. TUNNEL_CLIENT_PATH environment variable
 * 3. System PATH (via where.exe on Windows or which on Unix)
 * 4. ~/.superagent-r/bin/tunnel-client(.exe)
 * 5. Common system install paths (e.g. /opt/homebrew/bin/tunnel-client on macOS)
 */
export function findTunnelClientBinary(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }

  const envPath = process.env.TUNNEL_CLIENT_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return path.resolve(envPath);
  }

  const isWin = process.platform === "win32";
  const binaryName = isWin ? "tunnel-client.exe" : "tunnel-client";

  // Check ~/.superagent-r/bin/
  const superagentBin = path.join(os.homedir(), ".superagent-r", "bin", binaryName);
  if (fs.existsSync(superagentBin)) {
    return superagentBin;
  }

  // Check PATH via which / where
  try {
    const cmd = isWin ? `where.exe ${binaryName}` : `which ${binaryName}`;
    const output = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (output) {
      const firstLine = output.split(/\r?\n/)[0].trim();
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine;
      }
    }
  } catch {}

  // Check macOS Homebrew common paths
  if (process.platform === "darwin") {
    const brewPaths = [
      "/opt/homebrew/bin/tunnel-client",
      "/usr/local/bin/tunnel-client",
    ];
    for (const p of brewPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

/**
 * Step-by-step instructions for downloading and installing `tunnel-client`.
 */
export function getTunnelClientInstallGuide(): string {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";

  const lines = [
    "OpenAI Secure MCP Tunnel Client (tunnel-client) is required but was not found.",
    "",
    "Installation options:",
  ];

  if (isMac) {
    lines.push(
      "1. Homebrew (macOS official tap):",
      "   brew install openai/tools/tunnel-client",
      ""
    );
  }

  lines.push(
    "2. Download latest binary from GitHub Releases:",
    "   https://github.com/openai/tunnel-client/releases/latest",
    "",
    "3. Download from OpenAI Platform Tunnel Settings:",
    "   https://platform.openai.com/settings/organization/tunnels",
    ""
  );

  if (isWin) {
    lines.push(
      "Place tunnel-client.exe in your PATH, or in:",
      `   ${path.join(os.homedir(), ".superagent-r", "bin", "tunnel-client.exe")}`,
      "or specify path via environment variable: TUNNEL_CLIENT_PATH"
    );
  } else {
    lines.push(
      "Place tunnel-client in your PATH or in:",
      `   ${path.join(os.homedir(), ".superagent-r", "bin", "tunnel-client")}`,
      "and ensure it is executable (chmod +x)."
    );
  }

  return lines.join("\n");
}

function isValidApiKeyCandidate(key?: string): key is string {
  if (!key || typeof key !== "string") return false;
  const cleaned = key.replace(/[\r\n\s]+/g, "");
  return cleaned.length >= 15 && !cleaned.startsWith("-");
}

/**
 * Resolves the dedicated OpenAI Secure MCP Tunnel runtime API key from:
 * 1. Explicit argument
 * 2. CONTROL_PLANE_API_KEY environment variable
 *
 * Deliberately does not fall back to OPENAI_API_KEY or the model provider
 * credential: those keys may not have Tunnels Read + Use permission.
 */
export function resolveOpenAiControlPlaneKey(explicitKey?: string): string | undefined {
  // Malformed explicit credentials fail closed rather than silently using
  // an unrelated saved/environment credential.
  if (explicitKey !== undefined) {
    return isValidApiKeyCandidate(explicitKey) ? explicitKey.replace(/[\r\n\s]+/g, "") : undefined;
  }

  const envKey = process.env.CONTROL_PLANE_API_KEY;
  if (isValidApiKeyCandidate(envKey)) return envKey.replace(/[\r\n\s]+/g, "");

  const savedKey = getOpenAiMcpTunnelConfig().apiKey;
  if (isValidApiKeyCandidate(savedKey)) return savedKey.replace(/[\r\n\s]+/g, "");
  return undefined;
}

/**
 * Validates tunnel identifier format.
 */
export function isValidTunnelId(tunnelId: string): boolean {
  if (!tunnelId || typeof tunnelId !== "string") return false;
  const clean = tunnelId.trim();
  return clean.length >= 8 && /^[a-zA-Z0-9_\-.:]+$/.test(clean);
}

/**
 * Runs `tunnel-client doctor --profile <profile> --explain` for preflight verification.
 */
export async function runTunnelClientDoctor(opts: {
  binaryPath?: string;
  profile?: string;
  profileDir?: string;
  tunnelId?: string;
  apiKey?: string;
  mcpServerUrl?: string;
  healthListenAddr?: string;
}): Promise<{ success: boolean; output: string }> {
  let binary = findTunnelClientBinary(opts.binaryPath);
  if (!binary && !opts.binaryPath) {
    try {
      const { ensureTunnelClientInstalled } = await import("../setup/tunnelClientSetup.js");
      await ensureTunnelClientInstalled();
      binary = findTunnelClientBinary();
    } catch {}
  }
  if (!binary) {
    return {
      success: false,
      output: getTunnelClientInstallGuide(),
    };
  }

  const profile = opts.profile || "superagent-mcp";
  const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : getDefaultTunnelClientProfileDir();
  const profileInfo = ensureOpenAiTunnelProfile({
    profileDir,
    profile,
    tunnelId: opts.tunnelId,
    mcpServerUrl: opts.mcpServerUrl,
    healthListenAddr: opts.healthListenAddr,
    force: Boolean(opts.tunnelId || opts.mcpServerUrl),
  });

  const apiKey = resolveOpenAiControlPlaneKey(opts.apiKey);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TUNNEL_CLIENT_PROFILE_DIR: profileInfo.profileDir,
    ...(apiKey ? { CONTROL_PLANE_API_KEY: apiKey } : {}),
    ...(opts.tunnelId ? { CONTROL_PLANE_TUNNEL_ID: opts.tunnelId } : {}),
  };

  return new Promise((resolve) => {
    try {
      const doctorArgs = [
        "doctor",
        "--profile",
        profileInfo.profileName,
        "--profile-dir",
        profileInfo.profileDir,
        "--health.listen-addr",
        opts.healthListenAddr || "127.0.0.1:0",
        "--explain",
      ];
      const child = spawn(binary, doctorArgs, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => { stdout += data.toString(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });

      const timeout = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        resolve({
          success: false,
          output: `Doctor check timed out after 10s.\n${stdout}\n${stderr}`.trim(),
        });
      }, 10000);

      child.on("close", (code) => {
        clearTimeout(timeout);
        const combined = (stdout + "\n" + stderr).trim();
        resolve({
          success: code === 0,
          output: combined || (code === 0 ? "Doctor check passed." : `Doctor check exited with code ${code}`),
        });
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          output: `Failed to execute tunnel-client doctor: ${err.message}`,
        });
      });
    } catch (err: any) {
      resolve({
        success: false,
        output: `Error launching doctor: ${err?.message || String(err)}`,
      });
    }
  });
}

/**
 * Pings an HTTP endpoint on localhost with timeout.
 */
function probeHttp(urlStr: string, timeoutMs = 1500): Promise<{ ok: boolean; status?: number; data?: string }> {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: "GET",
          timeout: timeoutMs,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => {
            resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode, data: body });
          });
        }
      );
      req.on("error", () => resolve({ ok: false }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false });
      });
      req.end();
    } catch {
      resolve({ ok: false });
    }
  });
}

function parseHealthPort(listenAddr: string, defaultPort: number): number {
  try {
    if (listenAddr.includes(":")) {
      const parts = listenAddr.split(":");
      const parsed = parseInt(parts[parts.length - 1], 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
    }
  } catch {}
  return defaultPort;
}

/**
 * Launches `tunnel-client run` in the background for an active Superagent MCP server.
 */
export async function startOpenAiTunnel(opts: OpenAiTunnelOptions): Promise<OpenAiTunnelStatus> {
  const { mcpPort, tunnelId } = opts;

  if (!isValidTunnelId(tunnelId)) {
    throw new Error(
      `Invalid tunnel ID "${tunnelId}". Expected format like "tunnel_0123456789abcdef..." as generated in OpenAI Platform tunnel settings.`
    );
  }

  // Check if already running in-memory
  const existingInMemory = activeTunnels.get(mcpPort);
  if (existingInMemory) {
    const isAlive = isProcessAlive(existingInMemory.process.pid);
    if (isAlive) {
      return getOpenAiTunnelStatus(mcpPort);
    }
    activeTunnels.delete(mcpPort);
  }

  // Check persisted state file
  const stateFile = getOpenAiTunnelStateFile(mcpPort);
  if (fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as OpenAiTunnelStatus;
      if (saved.pid && isProcessAlive(saved.pid)) {
        return {
          ...saved,
          isRunning: true,
          uptimeSeconds: Math.floor((Date.now() - (saved.startedAt || Date.now())) / 1000),
        };
      }
    } catch {}
    try { fs.unlinkSync(stateFile); } catch {}
  }

  let binary = findTunnelClientBinary(opts.binaryPath);
  if (!binary && !opts.binaryPath) {
    try {
      const { ensureTunnelClientInstalled } = await import("../setup/tunnelClientSetup.js");
      await ensureTunnelClientInstalled();
      binary = findTunnelClientBinary();
    } catch {}
  }
  if (!binary) {
    throw new Error(getTunnelClientInstallGuide());
  }

  const apiKey = resolveOpenAiControlPlaneKey(opts.apiKey);
  if (!apiKey) {
    throw new Error(
      "Missing OpenAI runtime API key for tunnel control plane.\n" +
      "Provide via --api-key, CONTROL_PLANE_API_KEY, or save it with /mcp tunnel config set-key <key> (or set CONTROL_PLANE_API_KEY and run /mcp tunnel config set-key-env)."
    );
  }

  process.env.CONTROL_PLANE_API_KEY = apiKey;

  const profile = opts.profile || "superagent-mcp";
  const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : getDefaultTunnelClientProfileDir();
  const mcpServerUrl = opts.mcpServerUrl || `http://127.0.0.1:${mcpPort}/mcp`;
  const healthPort = opts.healthListenAddr
    ? parseHealthPort(opts.healthListenAddr, mcpPort + 1000)
    : mcpPort + 1000;
  const healthListenAddr = `127.0.0.1:${healthPort}`;

  const adminUrl = `http://${healthListenAddr}/ui`;
  const healthUrl = `http://${healthListenAddr}/healthz`;
  const readyUrl = `http://${healthListenAddr}/readyz`;

  // Materialize profile directory and config YAML prior to launching daemon
  const profileInfo = ensureOpenAiTunnelProfile({
    profileDir,
    profile,
    tunnelId,
    mcpServerUrl,
    healthListenAddr,
    force: true,
  });

  const args: string[] = ["run"];
  if (opts.embeddedStub) {
    args.push("--embedded-stateless-mcp-stub");
  } else {
    args.push("--mcp.server-url", mcpServerUrl);
  }
  args.push("--health.listen-addr", healthListenAddr);
  if (profileInfo.profileName) {
    args.push("--profile", profileInfo.profileName);
    args.push("--profile-dir", profileInfo.profileDir);
  }
  if (opts.bearerToken) {
    args.push("--mcp.extra-headers", `Authorization: Bearer ${opts.bearerToken}`);
    args.push("--mcp.discovery-extra-headers", `Authorization: Bearer ${opts.bearerToken}`);
  }
  args.push("--harpoon.allow-plaintext-http");
  args.push("--control-plane.poll-channel", "main");
  args.push("--control-plane.poll-channel", "harpoon");
  args.push("--log.file", path.join(getOpenAiTunnelStateDir(), "tunnel-client.log"));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TUNNEL_CLIENT_PROFILE_DIR: profileInfo.profileDir,
    CONTROL_PLANE_API_KEY: apiKey,
    CONTROL_PLANE_TUNNEL_ID: tunnelId,
    HARPOON_ALLOW_PLAINTEXT_HTTP: "true",
  };

  let startupError = "";
  const maxStartupErrorChars = 8000;
  const appendStartupError = (value: string) => {
    startupError = (startupError + value).slice(-maxStartupErrorChars);
  };
  const safeStartupError = () => {
    let value = startupError.trim().slice(-maxStartupErrorChars);
    for (const secret of [apiKey, opts.bearerToken]) {
      if (secret) value = value.split(secret).join("[REDACTED]");
    }
    return value;
  };
  const child = spawn(binary, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (chunk) => {
    const output = chunk.toString();
    if (output.toLowerCase().includes("error") || output.includes("FATAL") || output.toLowerCase().includes("failed")) {
      appendStartupError(output);
    }
  });

  child.stderr?.on("data", (chunk) => {
    appendStartupError(chunk.toString());
  });

  child.on("error", (err) => {
    appendStartupError(`Process spawn error: ${err.message}`);
  });

  // A healthy process and a ready tunnel are separate states; require both.
  const timeoutMs = Math.max(1000, opts.readyTimeoutMs ?? 15000);
  const startWait = Date.now();
  let isHealthy = false;
  let isReady = false;
  let lastHealthProbe: { ok: boolean; status?: number; data?: string } = { ok: false };
  let lastReadyProbe: { ok: boolean; status?: number; data?: string } = { ok: false };

  while (Date.now() - startWait < timeoutMs) {
    if (!isProcessAlive(child.pid)) {
      throw new Error(
        `tunnel-client exited unexpectedly with error:\n${safeStartupError() || "Process exited immediately"}`
      );
    }

    lastReadyProbe = await probeHttp(readyUrl, 1000);
    lastHealthProbe = await probeHttp(healthUrl, 1000);
    isReady = lastReadyProbe.ok;
    isHealthy = lastHealthProbe.ok;
    if (isReady && isHealthy) break;
    await new Promise((r) => setTimeout(r, 600));
  }

  if (!isReady || !isHealthy) {
    // Do not leave a live but unready tunnel-client behind when startup fails.
    try {
      if (child.pid) await killProcessTree(child.pid);
      else child.kill("SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }

    const describeProbe = (name: string, probe: { ok: boolean; status?: number }) =>
      `${name}: ${probe.ok ? "OK" : "unavailable"}${probe.status ? ` (HTTP ${probe.status})` : ""}`;
    const details = [
      `Startup deadline: ${timeoutMs}ms`,
      describeProbe("healthz", lastHealthProbe),
      describeProbe("readyz", lastReadyProbe),
      safeStartupError(),
    ].filter(Boolean).join("\n");
    throw new Error(
      `OpenAI Secure MCP Tunnel did not become healthy and ready. The tunnel-client process was stopped.\n${details}`
    );
  }

  const now = Date.now();
  const tunnelProcess: OpenAiTunnelProcess = {
    process: child,
    tunnelId,
    mcpPort,
    healthPort,
    profile,
    startedAt: now,
    localUrl: mcpServerUrl,
    adminUrl,
    healthUrl,
    readyUrl,
  };

  activeTunnels.set(mcpPort, tunnelProcess);

  const status: OpenAiTunnelStatus = {
    isRunning: true,
    pid: child.pid,
    tunnelId,
    mcpPort,
    localUrl: mcpServerUrl,
    adminUrl,
    healthUrl,
    readyUrl,
    healthy: true,
    ready: isReady,
    startedAt: now,
    uptimeSeconds: 0,
    profile,
  };

  // Persist state (NO secrets or keys written to disk)
  try {
    fs.writeFileSync(stateFile, JSON.stringify(status, null, 2), "utf-8");
  } catch {}

  return status;
}

/**
 * Stops an active OpenAI tunnel process on the specified MCP port.
 */
export async function stopOpenAiTunnel(mcpPort: number): Promise<boolean> {
  let stopped = false;

  // In-memory stop
  const inMemory = activeTunnels.get(mcpPort);
  if (inMemory) {
    activeTunnels.delete(mcpPort);
    if (inMemory.process.pid) {
      try {
        await killProcessTree(inMemory.process.pid);
        stopped = true;
      } catch {
        try { inMemory.process.kill("SIGTERM"); stopped = true; } catch {}
      }
    }
  }

  // Check state file for PID in case owned by another process
  const stateFile = getOpenAiTunnelStateFile(mcpPort);
  if (fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as OpenAiTunnelStatus;
      if (saved.pid && isProcessAlive(saved.pid)) {
        await killProcessTree(saved.pid);
        stopped = true;
      }
    } catch {}
    try { fs.unlinkSync(stateFile); } catch {}
  }

  return stopped;
}

/**
 * Returns current status of an OpenAI tunnel on the given MCP port.
 */
export function getOpenAiTunnelStatus(mcpPort: number): OpenAiTunnelStatus {
  const inMemory = activeTunnels.get(mcpPort);
  if (inMemory) {
    const isAlive = isProcessAlive(inMemory.process.pid);
    if (!isAlive) {
      activeTunnels.delete(mcpPort);
    } else {
      const uptime = Math.floor((Date.now() - inMemory.startedAt) / 1000);
      return {
        isRunning: true,
        pid: inMemory.process.pid,
        tunnelId: inMemory.tunnelId,
        mcpPort,
        localUrl: inMemory.localUrl,
        adminUrl: inMemory.adminUrl,
        healthUrl: inMemory.healthUrl,
        readyUrl: inMemory.readyUrl,
        healthy: true,
        ready: true,
        startedAt: inMemory.startedAt,
        uptimeSeconds: Math.max(0, uptime),
        profile: inMemory.profile,
      };
    }
  }

  const stateFile = getOpenAiTunnelStateFile(mcpPort);
  if (fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as OpenAiTunnelStatus;
      if (saved.pid && isProcessAlive(saved.pid)) {
        const uptime = Math.floor((Date.now() - (saved.startedAt || Date.now())) / 1000);
        return {
          ...saved,
          isRunning: true,
          uptimeSeconds: Math.max(0, uptime),
        };
      }
    } catch {}
    try { fs.unlinkSync(stateFile); } catch {}
  }

  return {
    isRunning: false,
    tunnelId: "",
    mcpPort,
    localUrl: `http://127.0.0.1:${mcpPort}/mcp`,
  };
}

/**
 * Lists all active OpenAI tunnels across this process and disk state files.
 */
export function listActiveOpenAiTunnels(): OpenAiTunnelStatus[] {
  const list: OpenAiTunnelStatus[] = [];
  const portsSeen = new Set<number>();

  for (const [port] of activeTunnels.entries()) {
    const s = getOpenAiTunnelStatus(port);
    if (s.isRunning) {
      list.push(s);
      portsSeen.add(port);
    }
  }

  const dir = getOpenAiTunnelStateDir();
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const m = f.match(/^openai-tunnel-(\d+)\.json$/);
      if (!m) continue;
      const port = parseInt(m[1], 10);
      if (portsSeen.has(port)) continue;
      const s = getOpenAiTunnelStatus(port);
      if (s.isRunning) {
        list.push(s);
        portsSeen.add(port);
      }
    }
  } catch {}

  return list.sort((a, b) => a.mcpPort - b.mcpPort);
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Generates ready-to-use curl and payload snippet for OpenAI Responses API.
 */
export function generateResponsesApiSnippet(tunnelId: string, model = "gpt-4o"): string {
  const payload = {
    model,
    input: "Use the private MCP server to answer my request.",
    tools: [
      {
        type: "mcp",
        server_label: "superagent_mcp",
        tunnel_id: tunnelId,
      },
    ],
  };

  return [
    `curl https://api.openai.com/v1/responses \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Authorization: Bearer $OPENAI_API_KEY" \\`,
    `  -d '${JSON.stringify(payload, null, 2)}'`,
  ].join("\n");
}

/**
 * Generates instructions for connecting from ChatGPT Plugins / Custom MCP Server.
 */
export function generateChatGptInstructions(tunnelId: string, authMode: string = "static-bearer"): string[] {
  const authStep = authMode === "oauth"
    ? "5. Set Authentication to: OAuth (and provide bootstrap code if prompted)"
    : "5. Set Authentication to: No authentication (the local tunnel-client handles authorization)";

  return [
    "ChatGPT Custom MCP Server Setup:",
    "1. In ChatGPT, open Settings -> Connectors or ChatGPT Plugins.",
    "2. Select Add Custom MCP Server.",
    "3. Set Connection to: Tunnel",
    `4. Enter Tunnel ID: ${tunnelId}`,
    "   IMPORTANT: Click the suggestion chip below the input (e.g. [ SuperAgent One ]) to select and bind the tunnel!",
    authStep,
    "6. Check 'I understand and want to continue' and select Create as a plugin.",
    "7. Keep this Superagent terminal window open while using the connector.",
  ];
}

/**
 * Generates Codex verification prompt snippet according to OpenAI guide.
 */
export function generateCodexVerificationPrompt(tunnelId: string, profile = "superagent-mcp"): string {
  return [
    `Verify and connect the private Secure MCP Tunnel (${tunnelId}) from this machine to ChatGPT or Codex:`,
    `- Profile: ${profile}`,
    `- Tunnel ID: ${tunnelId}`,
    `- Runtime command: tunnel-client run --profile ${profile}`,
    `- Doctor check: tunnel-client doctor --profile ${profile} --explain`,
  ].join("\n");
}
