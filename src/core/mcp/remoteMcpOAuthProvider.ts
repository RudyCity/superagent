import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { getRootConfigDir } from "../config/paths.js";
import { decryptSecret, encryptSecret } from "../config/secretStore.js";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface StoredOAuthEntry {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

interface StoredOAuthFile {
  version: 1;
  entries: Record<string, StoredOAuthEntry>;
}

function credentialFilePath(): string {
  return path.join(getRootConfigDir(), "mcp-oauth-credentials.enc");
}

function loadCredentialFile(): StoredOAuthFile {
  const filePath = credentialFilePath();
  if (!fs.existsSync(filePath)) return { version: 1, entries: {} };
  const encoded = fs.readFileSync(filePath, "utf8");
  if (!encoded.startsWith("enc:v1:")) {
    throw new Error("MCP OAuth credential store is not encrypted; refusing to read it.");
  }
  const decrypted = decryptSecret(encoded);
  if (!decrypted) throw new Error("MCP OAuth credential store could not be decrypted.");
  const parsed = JSON.parse(decrypted) as Partial<StoredOAuthFile>;
  if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
    throw new Error("MCP OAuth credential store has an unsupported format.");
  }
  return parsed as StoredOAuthFile;
}

function saveCredentialFile(file: StoredOAuthFile): void {
  const filePath = credentialFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, encryptSecret(JSON.stringify(file)), { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
  }
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows */ }
}

export function getRemoteMcpOAuthServerKey(name: string, serverUrl: string): string {
  return crypto.createHash("sha256").update(`${name.toLowerCase()}\n${new URL(serverUrl).toString()}`).digest("hex").slice(0, 32);
}

/** Stable per-server loopback port so an existing DCR registration remains usable across restarts. */
export function getRemoteMcpOAuthCallbackPort(serverKey: string): number {
  const value = Number.parseInt(serverKey.slice(0, 8), 16);
  return 41000 + (Number.isFinite(value) ? value : 0) % 14000;
}

export function openSystemBrowser(url: URL): Promise<void> {
  return new Promise((resolve, reject) => {
    let command: string;
    let args: string[];
    if (process.platform === "win32") {
      // Avoid a shell so query parameters cannot be interpreted as shell syntax.
      command = "rundll32.exe";
      args = ["url.dll,FileProtocolHandler", url.toString()];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [url.toString()];
    } else {
      command = "xdg-open";
      args = [url.toString()];
    }
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class PersistentMcpOAuthProvider implements OAuthClientProvider {
  private pendingState?: string;
  private authorizationPending = false;
  private _pendingAuthorizationUrl?: URL;
  private readonly storeKey: string;

  constructor(
    storeKey: string,
    private readonly callbackUrl: string,
    private readonly configuredClientName = "SuperAgent MCP client",
    private readonly openBrowser: (url: URL) => Promise<void> = openSystemBrowser,
  ) {
    this.storeKey = storeKey;
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.callbackUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.configuredClientName,
    };
  }

  get hasPendingAuthorization(): boolean {
    return this.authorizationPending;
  }

  get currentState(): string | undefined {
    return this.pendingState;
  }

  get pendingAuthorizationUrl(): URL | undefined {
    return this._pendingAuthorizationUrl;
  }

  state(): string {
    this.pendingState = crypto.randomBytes(32).toString("base64url");
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const entry = this.getEntry();
    const info = entry.clientInformation;
    if (!info) return undefined;
    const redirectUris = (info as { redirect_uris?: unknown }).redirect_uris;
    if (Array.isArray(redirectUris) && redirectUris.includes(this.callbackUrl)) {
      return info;
    }
    // Dynamic registrations are bound to exact redirect URIs. Force a new
    // registration if a previous version used another local callback address.
    delete entry.clientInformation;
    this.saveEntry(entry);
    return undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    const entry = this.getEntry();
    entry.clientInformation = clientInformation;
    this.saveEntry(entry);
  }

  tokens(): OAuthTokens | undefined {
    return this.getEntry().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const entry = this.getEntry();
    entry.tokens = tokens;
    this.saveEntry(entry);
    this.authorizationPending = false;
    this._pendingAuthorizationUrl = undefined;
    this.pendingState = undefined;
  }

  redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.authorizationPending = true;
    this._pendingAuthorizationUrl = new URL(authorizationUrl.toString());
    return this.openBrowser(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    const entry = this.getEntry();
    entry.codeVerifier = codeVerifier;
    this.saveEntry(entry);
  }

  codeVerifier(): string {
    const verifier = this.getEntry().codeVerifier;
    if (!verifier) throw new Error("MCP OAuth PKCE verifier is missing; restart authorization.");
    return verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const entry = this.getEntry();
    entry.discoveryState = state;
    this.saveEntry(entry);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.getEntry().discoveryState;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const store = loadCredentialFile();
    const entry = store.entries[this.storeKey] ?? {};
    if (scope === "all") {
      delete store.entries[this.storeKey];
    } else {
      if (scope === "client") delete entry.clientInformation;
      if (scope === "tokens") delete entry.tokens;
      if (scope === "verifier") delete entry.codeVerifier;
      if (scope === "discovery") delete entry.discoveryState;
      store.entries[this.storeKey] = entry;
    }
    saveCredentialFile(store);
  }

  private getEntry(): StoredOAuthEntry {
    return loadCredentialFile().entries[this.storeKey] ?? {};
  }

  private saveEntry(entry: StoredOAuthEntry): void {
    const store = loadCredentialFile();
    store.entries[this.storeKey] = entry;
    saveCredentialFile(store);
  }
}

export interface McpOAuthCallbackReceiver {
  redirectUrl: string;
  waitForAuthorizationCode(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Receives the OAuth redirect on loopback only. It validates state before
 * returning the authorization code to the in-process MCP SDK; neither code
 * nor state is written to logs or disk.
 */
export async function startMcpOAuthCallbackReceiver(options: {
  port: number;
  getExpectedState: () => string | undefined;
}): Promise<McpOAuthCallbackReceiver> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The promise can reject during shutdown before a waiter starts observing it.
  void codePromise.catch(() => undefined);

  const server = http.createServer((req, res) => {
    const callbackUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method !== "GET" || callbackUrl.pathname !== "/oauth/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Not found.");
      return;
    }
    if (settled) {
      res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("This authorization attempt has already finished.");
      return;
    }

    const oauthError = callbackUrl.searchParams.get("error");
    if (oauthError) {
      settled = true;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><title>Authorization not completed</title><p>Authorization was not completed. Return to SuperAgent.</p>");
      rejectCode(new Error("OAuth authorization was denied or cancelled."));
      return;
    }

    const expectedState = options.getExpectedState();
    const returnedState = callbackUrl.searchParams.get("state");
    const code = callbackUrl.searchParams.get("code");
    if (!expectedState || !returnedState || returnedState !== expectedState || !code) {
      settled = true;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><title>Authorization failed</title><p>Authorization response could not be validated. Return to SuperAgent and retry.</p>");
      rejectCode(new Error("OAuth callback state validation failed."));
      return;
    }

    settled = true;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end("<!doctype html><title>Authorization complete</title><p>Authorization completed. You can return to SuperAgent.</p>");
    resolveCode(code);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : options.port;
  return {
    redirectUrl: `http://127.0.0.1:${boundPort}/oauth/callback`,
    waitForAuthorizationCode: () => codePromise,
    close: async () => {
      if (!settled) {
        settled = true;
        rejectCode(new Error("OAuth callback receiver was closed."));
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
