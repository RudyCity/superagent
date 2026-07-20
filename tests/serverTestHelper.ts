/**
 * serverTestHelper.ts
 *
 * Shared fixture module for server.test.ts and server2.test.ts.
 * Exports re-usable fetch helpers and the server port/workspace variables.
 *
 * NOTE: The actual server is started once (in server.test.ts beforeAll).
 * server2.test.ts imports the helpers and port from this module.
 * Both files run in the SAME Vitest worker process (single-threaded pool),
 * so the ES-module singleton for server.ts is shared between them.
 */
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";

// ─── Isolated config dir (set before any config module loads) ─────────────────
export const tmpConfigDir = path.join(os.tmpdir(), `sa-server-test-${Date.now()}`);
process.env.SUPERAGENT_CONFIG_DIR = tmpConfigDir;

// ─── Shared workspace ─────────────────────────────────────────────────────────
export const testWorkspace = path.join(os.tmpdir(), `sa-server-ws-${Date.now()}`);
fs.mkdirSync(testWorkspace, { recursive: true });

// ─── Test file ────────────────────────────────────────────────────────────────
export const testFileName = "hello.txt";
export const testFileContent = "Hello, SuperAgent!";
fs.writeFileSync(path.join(testWorkspace, testFileName), testFileContent);

// ─── Port shared across both test files ───────────────────────────────────────
export let sharedPort = 0;
export function setSharedPort(p: number) { sharedPort = p; }

// ─── Free port finder ─────────────────────────────────────────────────────────
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
export function apiUrl(port: number, urlPath: string) {
  return `http://127.0.0.1:${port}${urlPath}`;
}

export async function getJSON(port: number, urlPath: string, headers: Record<string, string> = {}) {
  const res = await fetch(apiUrl(port, urlPath), { headers });
  const body = await res.json();
  return { status: res.status, body };
}

export async function postJSON(
  port: number,
  urlPath: string,
  data: unknown = {},
  headers: Record<string, string> = {}
) {
  const res = await fetch(apiUrl(port, urlPath), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

export async function deleteJSON(
  port: number,
  urlPath: string,
  data: unknown = {},
  headers: Record<string, string> = {}
) {
  const res = await fetch(apiUrl(port, urlPath), {
    method: "DELETE",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  return { status: res.status, body };
}

export async function optionsReq(port: number, urlPath: string) {
  const res = await fetch(apiUrl(port, urlPath), { method: "OPTIONS" });
  return { status: res.status, headers: res.headers };
}
