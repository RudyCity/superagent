/**
 * Per-owner-port Muse alert provider configuration, managed via channel-host
 * config commands. Unlike incident state this includes a secret, so encrypt
 * payload at rest and never serialize it in CLI status/health/logs.
 *
 * Key is a private local sidecar: protects accidental JSON exposure, NOT a
 * privileged attacker who can read the key and ciphertext together.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MuseAlertProviderConfig =
  | { mode: "disabled" }
  | { mode: "webhook"; url: string }
  | { mode: "telegram"; token: string; chatId: string };
export type MuseAlertPublicStatus = {
  port: number; mode: "disabled" | "webhook" | "telegram"; source: "config" | "env" | "default";
  credentialConfigured: boolean; restartRequired: false;
};
const maxFileBytes = 8192;
const rootDefault = () => path.join(os.homedir(), ".superagent-r");
const validPort = (port: number) => Number.isSafeInteger(port) && port >= 1 && port <= 65535;
const portPaths = (port: number, root: string) => {
  if (!validPort(port)) throw new Error("Invalid alert config port");
  return {
    file: path.join(root, "muse-alert-config-" + port + ".json"),
    key: path.join(root, "muse-alert-config-" + port + ".key"),
  };
};
function pathExistsStrict(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function safeReadFile(file: string, max: number): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > max) {
    throw new Error("Invalid protected Muse alert config file");
  }
  return fs.readFileSync(file);
}
function validate(config: MuseAlertProviderConfig): MuseAlertProviderConfig {
  if (!config || typeof config !== "object" || !["disabled", "webhook", "telegram"].includes(config.mode)) {
    throw new Error("Invalid Muse alert mode");
  }
  if (config.mode === "disabled") return { mode: "disabled" };
  if (config.mode === "webhook") {
    let u: URL;
    try { u = new URL(config.url); } catch { throw new Error("Invalid Muse alert webhook"); }
    if (u.protocol !== "https:" || u.port || u.username || u.password || u.hash ||
        !u.hostname || u.hostname.length > 253 || u.hostname.length < 4 ||
        u.hostname === "localhost" || /\.(?:localhost|local|internal|test)$/i.test(u.hostname) ||
        /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(":")) {
      throw new Error("Alert webhook requires a public HTTPS DNS endpoint");
    }
    return { mode: "webhook", url: u.toString() };
  }
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,}$/.test(config.token) ||
      !/^-?\d{3,20}$/.test(config.chatId)) throw new Error("Invalid Telegram alert credentials");
  return { mode: "telegram", token: config.token, chatId: config.chatId };
}
function atomic(file: string, data: Buffer, root: string) {
  const parent = fs.lstatSync(root);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Invalid Muse config directory");
  if (pathExistsStrict(file)) {
    const old = fs.lstatSync(file);
    if (!old.isFile() || old.isSymbolicLink()) throw new Error("Unsafe Muse alert config target");
  }
  const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
export function storeMuseAlertConfig(
  port: number, raw: MuseAlertProviderConfig, root = rootDefault(),
): MuseAlertPublicStatus {
  const config = validate(raw);
  const paths = portPaths(port, root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let key: Buffer;
  if (pathExistsStrict(paths.key)) {
    key = safeReadFile(paths.key, 64);
    if (key.length !== 32) throw new Error("Invalid Muse alert config encryption key");
  } else {
    // If the ciphertext exists but key is missing, never silently replace it.
    if (pathExistsStrict(paths.file)) throw new Error("Muse alert config key missing; refusing overwrite");
    key = crypto.randomBytes(32);
    const fd = fs.openSync(paths.key, "wx", 0o600);
    try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("muse-alert-config:" + port));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  const record = JSON.stringify({
    version: 1, port, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
    payload: encrypted.toString("base64"),
  });
  atomic(paths.file, Buffer.from(record), root);
  return { port, mode: config.mode, source: "config", credentialConfigured: config.mode !== "disabled", restartRequired: false };
}
/** Absence means legacy env/default may be used. Invalid/missing keys throw: no fallback. */
export function loadMuseAlertConfig(port: number, root = rootDefault()): MuseAlertProviderConfig | null {
  const paths = portPaths(port, root);
  if (!pathExistsStrict(paths.file)) {
    if (pathExistsStrict(paths.key)) throw new Error("Orphaned Muse alert config key; manual review required");
    return null;
  }
  try {
    const raw = safeReadFile(paths.file, maxFileBytes);
    const key = safeReadFile(paths.key, 64);
    if (key.length !== 32) throw new Error("Invalid key size");
    const envelope = JSON.parse(raw.toString("utf8")) as {
      version: number; port: number; iv: string; tag: string; payload: string;
    };
    if (envelope.version !== 1 || envelope.port !== port ||
        typeof envelope.iv !== "string" || typeof envelope.tag !== "string" ||
        typeof envelope.payload !== "string" || !/^[A-Za-z0-9+/=]+$/.test(envelope.payload)) {
      throw new Error("Invalid envelope");
    }
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const bytes = Buffer.from(envelope.payload, "base64");
    if (iv.length !== 12 || tag.length !== 16 || bytes.length < 1 || bytes.length > maxFileBytes) {
      throw new Error("Invalid encrypted data");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from("muse-alert-config:" + port));
    decipher.setAuthTag(tag);
    return validate(JSON.parse(Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8")));
  } catch {
    throw new Error("Muse alert configuration integrity failed; delivery disabled");
  }
}
export function describeMuseAlertConfig(
  port: number, root = rootDefault(), env: NodeJS.ProcessEnv = process.env,
): MuseAlertPublicStatus {
  const cfg = loadMuseAlertConfig(port, root);
  if (cfg) return { port, mode: cfg.mode, source: "config", credentialConfigured: cfg.mode !== "disabled", restartRequired: false };
  const mode = env.SUPERAGENT_MUSE_ALERT_WEBHOOK_URL ? "webhook" :
    env.SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN ? "telegram" : "disabled";
  return { port, mode, source: mode === "disabled" ? "default" : "env",
    credentialConfigured: mode !== "disabled", restartRequired: false };
}
