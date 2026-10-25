import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMuseAlertConfig, loadMuseAlertConfig, storeMuseAlertConfig } from "../src/core/remoteAgent/museAlertConfig.js";
import { MuseIncidentCenter, MuseIncidentDispatcher, resolvedIncidentTarget } from "../src/core/remoteAgent/museIncidentCenter.js";
import { MuseBatchJournal } from "../src/core/remoteAgent/museBatchJournal.js";
import { makeMuseRecoveryBackup, restoreMuseRecoveryBackup, verifyMuseRecoveryBackup } from "../src/core/remoteAgent/museRecoveryBackup.js";
import { handleMuseAlertConfigCommand } from "../src/core/runtime/museAlertConfigCommand.js";
import { handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";
import { museCommand } from "../src/core/commands/museCommand.js";

const homes: string[] = [];
const fixture = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-alert-cmd-"));
  homes.push(home);
  const root = path.join(home, ".superagent-r");
  fs.mkdirSync(root);
  return { home, root, port: 55031 };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of homes.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const token = "9876543:ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678";

describe("Muse alert provider config command, persistent encrypted provider, hot reload", () => {
  it("configures a private per-port webhook, masks status and hot switches to disabled", async () => {
    const { root, port } = fixture();
    const result = await handleMuseAlertConfigCommand(
      ["set-webhook", "https://alerts.example.com/hook?private=secret", "--port", String(port)], { root },
    );
    expect(result).not.toContain("secret");
    expect(result).not.toContain("https://");
    expect(await handleMuseAlertConfigCommand(["status", "--port", String(port)], { root }))
      .toContain('"mode":"webhook"');
    expect(describeMuseAlertConfig(port, root)).toMatchObject({
      port, mode: "webhook", source: "config", credentialConfigured: true, restartRequired: false,
    });
    const file = path.join(root, "muse-alert-config-" + port + ".json");
    const secretKey = path.join(root, "muse-alert-config-" + port + ".key");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(secretKey)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).not.toContain("alerts.example.com");
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret");
    expect(resolvedIncidentTarget(port, root, { SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://old.example.com" }))
      .toMatchObject({ type: "webhook", url: "https://alerts.example.com/hook?private=secret" });

    const center = new MuseIncidentCenter(port, root);
    center.observeHost(false, Date.now() - 5000);
    const sentTo: string[] = [];
    const fakeFetch = (async (url: string) => {
      sentTo.push(url);
      return { ok: true } as Response;
    }) as typeof fetch;
    const dispatcher = new MuseIncidentDispatcher(center, undefined, fakeFetch);
    expect(await dispatcher.once()).toBe(true);
    expect(sentTo).toHaveLength(1);

    await handleMuseAlertConfigCommand(["disable", "--port", String(port)], { root });
    expect(loadMuseAlertConfig(port, root)).toEqual({ mode: "disabled" });
    center.observeHost(true);
    expect(await dispatcher.once()).toBe(false);
    expect(sentTo).toHaveLength(1);
    expect(center.summary().pending).toBe(1);
    expect(resolvedIncidentTarget(port, root, { SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://old.example.com" }))
      .toBeNull();
  });

  it("accepts Telegram secret only on stdin, changes provider without restart and never displays token", async () => {
    const { root, port } = fixture();
    await expect(handleMuseAlertConfigCommand(["set-telegram", "--chat-id", "-123456789", "--port", String(port)], { root }))
      .rejects.toThrow(/token-stdin/);
    const status = await handleMuseAlertConfigCommand(
      ["set-telegram", "--chat-id", "-123456789", "--token-stdin", "--port", String(port)],
      { root, readStdin: async () => token + "\n" },
    );
    expect(status).not.toContain(token);
    expect(status).not.toContain("-123456789");
    expect(loadMuseAlertConfig(port, root)).toEqual({ mode: "telegram", token, chatId: "-123456789" });
    const display = await handleMuseAlertConfigCommand(["status", "--port", String(port)], { root });
    expect(display).toContain('"mode":"telegram"');
    expect(display).not.toContain(token);
    expect(display).not.toContain("-123456789");
    const rootFile = path.join(root, "muse-alert-config-" + port + ".json");
    expect(fs.readFileSync(rootFile, "utf8")).not.toContain(token);
    const center = new MuseIncidentCenter(port, root);
    center.observeHost(false, Date.now() - 5000);
    const sentTo: string[] = [];
    const fakeFetch = (async (url: string, opts: RequestInit) => {
      sentTo.push(url);
      expect(String(opts.body)).not.toContain(token);
      return { ok: true } as Response;
    }) as typeof fetch;
    const dispatcher = new MuseIncidentDispatcher(center, undefined, fakeFetch);
    expect(await dispatcher.once()).toBe(true);
    expect(sentTo[0]).toContain("api.telegram.org/bot" + token);
    // Config replaces Telegram instantly; no restart/new dispatcher.
    await handleMuseAlertConfigCommand(["set-webhook", "https://alerts.example.net/hook", "--port", String(port)], { root });
    center.observeHost(true);
    expect(await dispatcher.once()).toBe(true);
    expect(sentTo[1]).toBe("https://alerts.example.net/hook");
  });

  it("rejects invalid/tampered/unsafe configurations without fallback or sending", async () => {
    const { root, port } = fixture();
    expect(() => storeMuseAlertConfig(port, { mode: "webhook", url: "http://127.0.0.1" }, root)).toThrow();
    expect(() => storeMuseAlertConfig(port, { mode: "webhook", url: "https://localhost/notify" }, root)).toThrow();
    expect(() => storeMuseAlertConfig(port, { mode: "telegram", token: "bad", chatId: "1234" }, root)).toThrow();
    storeMuseAlertConfig(port, { mode: "telegram", token, chatId: "123456" }, root);
    const file = path.join(root, "muse-alert-config-" + port + ".json");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    record.tag = "A".repeat(24);
    fs.writeFileSync(file, JSON.stringify(record));
    expect(() => loadMuseAlertConfig(port, root)).toThrow(/integrity failed/);
    expect(() => describeMuseAlertConfig(port, root)).toThrow();
    expect(() => resolvedIncidentTarget(port, root, {
      SUPERAGENT_MUSE_ALERT_WEBHOOK_URL: "https://old.example.com",
    })).toThrow();
    const center = new MuseIncidentCenter(port, root);
    center.observeHost(false, Date.now() - 5000);
    let calls = 0;
    const d = new MuseIncidentDispatcher(center, undefined, (async () => {
      calls++;
      return { ok: true } as Response;
    }) as typeof fetch);
    expect(await d.once()).toBe(false);
    expect(calls).toBe(0);
    expect(center.summary()).toMatchObject({ pending: 1, sent: 0 });
    expect(() => storeMuseAlertConfig(port, { mode: "disabled" }, root)).not.toThrow();
    expect(loadMuseAlertConfig(port, root)).toEqual({ mode: "disabled" });
  });

  it("the interactive Muse command can change safe config without exposing Telegram secrets", async () => {
    const { home, port } = fixture();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const lines: Array<{ type: string; content: string }> = [];
    const ctx = { addLine: (line: { type: string; content: string }) => { lines.push(line); } } as any;
    await museCommand.execute("host config set-webhook https://alerts.example.com/endpoint --port " + port, ctx);
    await museCommand.execute("host config status --port " + port, ctx);
    await museCommand.execute("host config set-telegram --chat-id 123456 --token-stdin --port " + port, ctx);
    expect(lines.some(l => l.content.includes('"mode":"webhook"'))).toBe(true);
    expect(lines.some(l => l.content.includes("Pipe only the token"))).toBe(true);
    expect(lines.map(l => l.content).join("")).not.toContain("alerts.example.com/endpoint");
    await museCommand.execute("host config disable --port " + port, ctx);
    expect(loadMuseAlertConfig(port)).toEqual({ mode: "disabled" });
  });

  it("CLI status and same-port recovery backup/restore preserve encrypted configuration and fail closed on wrong-port use", async () => {
    const { home, root, port } = fixture();
    vi.spyOn(os, "homedir").mockReturnValue(home);
    new MuseBatchJournal(port, root).claim("checkpoint", "task", 0);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    expect(await handleChannelHostCliCommand(["config", "set-webhook", "https://alerts.example.com/private", "--port", String(port)])).toBe(false);
    expect(await handleChannelHostCliCommand(["config", "status", "--port", String(port)])).toBe(false);
    expect(logs.join("\n")).not.toContain("alerts.example.com/private");
    const archive = fs.mkdtempSync(path.join(os.tmpdir(), "muse-alert-archive-"));
    homes.push(archive);
    const bundle = path.join(archive, "bundle");
    makeMuseRecoveryBackup(port, bundle, root);
    expect(verifyMuseRecoveryBackup(bundle, port).active).toBe(1);
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "recovery-bundle.json"), "utf8"));
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining([
      "muse-alert-config-" + port + ".json",
      "muse-alert-config-" + port + ".key",
    ]));
    const restored = path.join(archive, "restored");
    restoreMuseRecoveryBackup(port, bundle, restored);
    expect(loadMuseAlertConfig(port, restored)).toMatchObject({
      mode: "webhook", url: "https://alerts.example.com/private",
    });
    expect(loadMuseAlertConfig(port + 1, restored)).toBeNull();
  });
});
