#!/usr/bin/env node
/**
 * Opt-in local pairing secret provisioning. Never commits or transmits keys.
 * Usage: bun scripts/delegate-auth.mjs init|status|show
 * The show command prints sensitive key ONLY when invoked by the operator.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const file = path.join(os.homedir(), ".superagent-r", "delegate-auth-token");
const action = process.argv[2] || "status";
const verify = () => {
  const meta = fs.statSync(file);
  if (!meta.isFile()) throw new Error("Pairing secret is not a regular file");
  if (process.platform !== "win32" && (meta.mode & 0o077) !== 0) {
    throw new Error("Pairing file must be chmod 0600");
  }
  const token = fs.readFileSync(file, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error("Pairing secret file is invalid (expected 64 hex digits)");
  }
  return token;
};

if (action === "init") {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, token + "\n", { flag: "wx", mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
    console.log("Created new pairing secret. It was not printed.");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    console.log("Pairing secret already exists; not overwritten.");
  }
}
if (!["init", "status", "show"].includes(action)) {
  console.error("Usage: bun scripts/delegate-auth.mjs init|status|show");
  process.exit(2);
}
const secret = verify();
if (action === "show") {
  console.log(secret);
} else {
  const fingerprint = crypto.createHash("sha256").update(secret).digest("hex").slice(0, 16);
  console.log(JSON.stringify({
    configured: true,
    file,
    sha256Prefix: fingerprint,
    secretExposed: false,
    envVar: "SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE",
  }, null, 2));
}
