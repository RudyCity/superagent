import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseIncidentCenter, MuseIncidentDispatcher, configuredIncidentTarget, museIncidentsFile, sendIncidentAlert } from "../src/core/remoteAgent/museIncidentCenter.js";
import { MuseRecoveryIntegrityEvents } from "../src/core/remoteAgent/museRecoveryIntegrityEvents.js";
import { observeIndependentChannelHost } from "../src/core/runtime/museHostWatchdog.js";
import { handleChannelHostCliCommand, runChannelHost } from "../src/core/runtime/channelHost.js";
import { makeMuseRecoveryBackup, restoreMuseRecoveryBackup, verifyMuseRecoveryBackup } from "../src/core/remoteAgent/museRecoveryBackup.js";
import { MuseBatchJournal } from "../src/core/remoteAgent/museBatchJournal.js";
import type { Server } from "node:http";

const dirs: string[] = [];
const servers: Server[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-incident-"));
  dirs.push(root);
  const port = 52883;
  return { root, port, center: new MuseIncidentCenter(port, root) };
}
async function freePort() {
  const server = net.createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Cannot find free port"));
      server.close(() => resolve(addr.port));
    });
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await new Promise<void>(r => server.close(() => r()));
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

describe("phase 4n incident center, durable delivery and independent watchdog", () => {
  it("deduplicates a persisted integrity transition, supports ACK and only resolves after healthy recovery", () => {
    const f = fixture();
    const integrity = new MuseRecoveryIntegrityEvents(f.port, f.root);
    integrity.append(1000, "degraded", "STORAGE_CHECK_FAILED");
    integrity.append(1200, "failed", "STORAGE_CHECK_FAILED");
    expect(f.center.syncIntegrity()).toBe(2);
    expect(f.center.syncIntegrity()).toBe(0);
    expect(f.center.summary()).toMatchObject({
      open: 1, acknowledged: 0, resolved: 0, pending: 2,
    });
    const first = f.center.list()[0];
    expect(first).toMatchObject({ kind: "integrity", status: "open", condition: "failed" });
    expect(() => f.center.acknowledge(first.id, "wrong")).toThrow();
    expect(f.center.acknowledge(first.id, first.id)).toMatchObject({ status: "acknowledged" });
    expect(f.center.summary().acknowledged).toBe(1);
    expect(new MuseIncidentCenter(f.port, f.root).list()[0].status).toBe("acknowledged");
    integrity.append(1400, "healthy", "VALIDATED");
    const rebooted = new MuseIncidentCenter(f.port, f.root);
    expect(rebooted.syncIntegrity()).toBe(1);
    expect(rebooted.list()[0]).toMatchObject({ status: "resolved", condition: "healthy" });
    expect(rebooted.summary()).toMatchObject({
      open: 0, acknowledged: 0, resolved: 1, pending: 3,
    });
    expect(() => rebooted.acknowledge(first.id, first.id)).toThrow(/not open/);
    const file = fs.readFileSync(museIncidentsFile(f.port, f.root), "utf8");
    expect(file).not.toContain("SECRET_INTERNAL_PAYLOAD");
    expect(file).not.toContain(f.root);
    // A partially rewound or replaced source event log fails closed.
    fs.rmSync(path.join(f.root, "muse-integrity-" + f.port + ".jsonl"));
    expect(() => rebooted.syncIntegrity()).toThrow(/rollback/);
  });

  it("watchdog opens once for an offline host, detects recovery and only alerts on transitions", async () => {
    const f = fixture();
    let up = false;
    expect(await observeIndependentChannelHost(f.center, async () => up, 1000)).toBe(false);
    expect(await observeIndependentChannelHost(f.center, async () => up, 2000)).toBe(false);
    expect(f.center.summary()).toMatchObject({ open: 1, pending: 1 });
    const first = f.center.list()[0];
    expect(first).toMatchObject({ kind: "host_unavailable", condition: "offline" });
    up = true;
    expect(await observeIndependentChannelHost(f.center, async () => up, 3000)).toBe(true);
    expect(f.center.summary()).toMatchObject({ resolved: 1, pending: 2 });
    expect(await observeIndependentChannelHost(f.center, async () => up, 4000)).toBe(true);
    expect(f.center.summary().pending).toBe(2);
    up = false;
    await observeIndependentChannelHost(f.center, async () => up, 5000);
    expect(f.center.summary()).toMatchObject({ resolved: 1, open: 1, pending: 3 });
    expect(f.center.list()[1].id).not.toBe(first.id);
    expect(await observeIndependentChannelHost(f.center, async () => {
      throw new Error("SECRET_CONN_ERR");
    }, 6000)).toBe(false);
    expect(JSON.stringify(f.center.list())).not.toContain("SECRET_CONN_ERR");
  });

  it("enforces opt-in provider, HTTPS security, retry/backoff, crash lease and idempotency", async () => {
    const f = fixture();
    f.center.observeHost(false, 1000);
    expect(configuredIncidentTarget({})).toBeNull();
    expect(() => configuredIncidentTarget({ SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "http://localhost:8080" })).toThrow();
    expect(() => configuredIncidentTarget({ SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://127.0.0.1/path" })).toThrow();
    expect(() => configuredIncidentTarget({ SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://metadata.google.internal/path" })).toThrow();
    expect(() => configuredIncidentTarget({
      SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://example.com/alert",
      SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN: "99999:abcdefghi000000000000000000",
    })).toThrow();
    const target = configuredIncidentTarget({ SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://alerts.example.org/v1" })!;
    const requests: Array<{ url: string; options: RequestInit }> = [];
    let succeed = false;
    const fetcher = (async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      return { ok: succeed } as Response;
    }) as typeof fetch;
    expect(await new MuseIncidentDispatcher(f.center, null, fetcher).once()).toBe(false);
    expect(f.center.summary().pending).toBe(1);
    const first = f.center.claim(1000)!;
    expect(first.attempts).toBe(1);
    expect(f.center.claim(1001)).toBeNull(); // crash lease blocks competing dispatchers
    expect(f.center.claim(31_001)?.id).toBe(first.id); // lease expiry => retry
    f.center.complete(first.id, false, 32_000);
    expect(f.center.claim(32_100)).toBeNull(); // exponential delay
    const next = f.center.claim(37_000)!;
    expect(next.attempts).toBe(3);
    const sent = await sendIncidentAlert(next, target, fetcher);
    expect(sent).toBe(false);
    const body = JSON.parse(requests[0].options.body as string);
    expect(body).toMatchObject({ version: 1, port: f.port, condition: "offline" });
    expect(Object.keys(body).sort()).toEqual(["condition", "event_id", "kind", "observed_at", "port", "version"]);
    expect(requests[0].options.headers).toMatchObject({ "Idempotency-Key": next.id });
    expect(requests[0].options.redirect).toBe("error");
    expect(requests[0].url).toBe("https://alerts.example.org/v1");
    succeed = true;
    expect(await sendIncidentAlert(next, target, fetcher)).toBe(true);
    f.center.complete(next.id, true, 38_000);
    expect(f.center.summary()).toMatchObject({ pending: 0, sent: 1 });
    expect(new MuseIncidentCenter(f.port, f.root).claim(50_000)).toBeNull();
    const token = "123456:abcdefghi123456789012345";
    const telegram = configuredIncidentTarget({
      SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN: token,
      SUPERAGENT_MUSE_ALERT_TELEGRAM_CHAT_ID: "-123456789",
    })!;
    const result = await sendIncidentAlert(next, telegram, fetcher);
    expect(result).toBe(true);
    expect(requests.at(-1)?.url).toContain("api.telegram.org/bot");
    const text = JSON.stringify(requests.at(-1)?.options.body);
    expect(text).not.toContain(token);
  });

  it("runs an opt-in dispatcher end to end and stops scheduled sends after shutdown", async () => {
    const f = fixture();
    f.center.observeHost(false, Date.now() - 5000);
    const url = configuredIncidentTarget({
      SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://notify.example.net/events",
    })!;
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return { ok: true } as Response;
    }) as typeof fetch;
    const dispatcher = new MuseIncidentDispatcher(f.center, url, fetcher);
    dispatcher.start(100);
    try {
      await new Promise(resolve => setTimeout(resolve, 270));
      expect(calls).toBe(1);
      expect(f.center.summary()).toMatchObject({ sent: 1, pending: 0 });
      expect(fs.existsSync(museIncidentsFile(f.port, f.root))).toBe(true);
    } finally { dispatcher.stop(); }
    const delivered = calls;
    await new Promise(resolve => setTimeout(resolve, 230));
    expect(calls).toBe(delivered);
  });

  it("a concurrent incident lock or corrupted store is never silently overwritten", () => {
    const f = fixture();
    f.center.observeHost(false, 1000);
    const id = f.center.list()[0].id;
    const lock = museIncidentsFile(f.port, f.root) + ".lock";
    fs.writeFileSync(lock, "OTHER_PROCESS");
    expect(() => f.center.acknowledge(id, id)).toThrow();
    expect(fs.readFileSync(lock, "utf8")).toBe("OTHER_PROCESS");
    fs.rmSync(lock);
    expect(f.center.list()[0].status).toBe("open");
    fs.writeFileSync(museIncidentsFile(f.port, f.root), "not-json");
    expect(() => f.center.summary()).toThrow();
    expect(() => f.center.observeHost(true, 2000)).toThrow();
    expect(fs.readFileSync(museIncidentsFile(f.port, f.root), "utf8")).toBe("not-json");
  });

  it("CLI incident dashboard and watchdog-once show redacted per-port state, including host recovery", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-incident-cli-"));
    dirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const port = await freePort();
    const root = path.join(home, ".superagent-r");
    fs.mkdirSync(root);
    const messages: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { messages.push(args.join(" ")); });
    // Explicit observation when no host is registered => offline, one durable incident.
    await expect(handleChannelHostCliCommand(["watchdog-once", "--port", String(port)])).resolves.toBe(false);
    expect(messages.join(" ")).toContain("offline");
    const center = new MuseIncidentCenter(port, root);
    const incident = center.list()[0];
    expect(incident.condition).toBe("offline");
    await expect(handleChannelHostCliCommand(["incidents", "--port", String(port)])).resolves.toBe(false);
    expect(messages.join(" ")).toContain("Recovery incident overview");
    await expect(handleChannelHostCliCommand(["acknowledge", "--port", String(port),
      "--incident", incident.id, "--confirm", "bad"])).rejects.toThrow();
    await expect(handleChannelHostCliCommand(["acknowledge", "--port", String(port),
      "--incident", incident.id, "--confirm", incident.id])).resolves.toBe(false);
    expect(center.list()[0].status).toBe("acknowledged");
    const host = await runChannelHost({ port, wsPort: 9225, mode: "idle" });
    servers.push(host.server);
    await expect(handleChannelHostCliCommand(["watchdog-once", "--port", String(port)])).resolves.toBe(false);
    expect(center.list()[0].status).toBe("resolved");
    expect(center.summary().pending).toBe(2);
    expect(messages.join("\n")).not.toContain(home);
    const dashboard = await fetch("http://127.0.0.1:" + port + "/_channel/incidents/dashboard");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await dashboard.text();
    expect(html).toContain("Muse Recovery Incidents");
    expect(html).toContain(incident.id);
    expect(html).toContain("Acknowledged");
    expect(html).not.toContain(home);
    expect(html).not.toContain("SECRET");
    const api = await (await fetch("http://127.0.0.1:" + port + "/_channel/incidents")).json();
    expect(api.summary).toMatchObject({ resolved: 1, pending: 2 });
    expect(api.incidents).toHaveLength(1);
    await expect(handleChannelHostCliCommand(["deliver-alerts", "--port", String(port)])).resolves.toBe(false);
    expect(center.summary().pending).toBe(2); // no config, no sends
  });

  it("backup/restore carries ACK, incident queue, watchdog state, and dedupe cursor", () => {
    const f = fixture();
    new MuseBatchJournal(f.port, f.root).claim("protected", "task", 0);
    new MuseRecoveryIntegrityEvents(f.port, f.root).append(1000, "failed", "STORAGE_CHECK_FAILED");
    f.center.syncIntegrity();
    const id = f.center.list()[0].id;
    f.center.acknowledge(id, id);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "muse-incident-archive-"));
    dirs.push(external);
    const bundle = path.join(external, "bundle");
    makeMuseRecoveryBackup(f.port, bundle, f.root);
    expect(verifyMuseRecoveryBackup(bundle, f.port).active).toBe(1);
    const index = JSON.parse(fs.readFileSync(path.join(bundle, "recovery-bundle.json"), "utf8"));
    expect(index.files.map((f: { name: string }) => f.name)).toContain("muse-incidents-" + f.port + ".json");
    const restored = path.join(external, "restored");
    restoreMuseRecoveryBackup(f.port, bundle, restored);
    const recovered = new MuseIncidentCenter(f.port, restored);
    expect(recovered.list()[0]).toMatchObject({ id, status: "acknowledged" });
    expect(recovered.syncIntegrity()).toBe(0); // no redelivery after safe restore
    expect(recovered.summary().pending).toBe(1);
    expect(new MuseBatchJournal(f.port, restored).claim("protected", "different", 0)).toBe(false);
    expect(() => restoreMuseRecoveryBackup(f.port, bundle, restored)).toThrow(/contains per-port history/);
  });
});
