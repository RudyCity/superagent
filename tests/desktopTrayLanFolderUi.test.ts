import { describe, expect, it } from "vitest";
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
const deviceId = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const transferId = "e21956a1-daa6-4f62-a4bd-c31a6c3b105e";
const sha = (bytes: Uint8Array) => nodeCrypto.createHash("sha256").update(bytes).digest("hex");

type ArchiveEntry = { path: string; bytes: Buffer; sha256?: string };
function makeArchive(entries: ArchiveEntry[]): Buffer {
  const manifest = Buffer.from(JSON.stringify({
    version: 1,
    files: entries.map((e) => ({ path: e.path, size: e.bytes.length, sha256: e.sha256 ?? sha(e.bytes) })),
  }), "utf8");
  const head = Buffer.alloc(13);
  head.write("SAFOLDER1", 0, "ascii");
  head.writeUInt32BE(manifest.length, 9);
  return Buffer.concat([head, manifest, ...entries.map((e) => e.bytes)]);
}
const folderFile = (path: string, contents: string | Buffer) => {
  const bytes = Buffer.from(contents);
  return {
    name: path.split("/").at(-1), size: bytes.length, webkitRelativePath: path,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
};

function setup({ incoming, name = "remote.safolder", supported = true, connected = true }:
  { incoming?: Buffer; name?: string; supported?: boolean; connected?: boolean } = {}) {
  const nodes = new Map<string, any>();
  const get = (id: string): any => {
    if (!nodes.has(id)) {
      const el: any = {
        value: "", disabled: false, files: [], listeners: new Map<string, Function>(),
        textContent: "", addEventListener(type: string, cb: Function) { this.listeners.set(type, cb); },
      };
      nodes.set(id, el);
    }
    return nodes.get(id);
  };
  if (supported) {
    get("lan-folder-source").webkitdirectory = true;
    get("lan-folder-source").multiple = true;
  }
  const requests: Array<{ action: string; payload: any }> = [];
  const saves: Array<{ command: string; input: any }> = [];
  const chunks: Buffer[] = [];
  const inbound = incoming ?? makeArchive([{ path: "photos/a.txt", bytes: Buffer.from("example") }]);
  const target = { id: deviceId, label: "Approved Android", platform: "android", connected };
  const invoke = async (command: string, input: any) => {
    if (command === "lan_file_save" || command === "lan_folder_save") {
      saves.push({ command, input });
      return { saved: true };
    }
    expect(command).toBe("lan_support_action");
    const { action, payload } = input;
    requests.push({ action, payload });
    if (action === "file_offer") return { success: true, file: {
      name: payload.direction === "upload" ? payload.name : name,
      size: payload.direction === "upload" ? payload.size : inbound.length,
      sha256: payload.direction === "upload" ? payload.sha256 : sha(inbound),
      transferId, chunkBytes: 4096,
    } };
    if (action === "file_put") {
      chunks.push(Buffer.from(payload.data, "base64"));
      return { success: true, result: {
        seq: payload.seq + 1, received: Buffer.concat(chunks).length,
      } };
    }
    if (action === "file_get") {
      const offset = payload.seq * 4096;
      const data = inbound.subarray(offset, offset + 4096);
      return { success: true, result: {
        seq: payload.seq, received: offset + data.length, data: data.toString("base64"),
      } };
    }
    if (action === "file_finish") return { success: true, result: {
      ok: true, bytes: chunks.length ? Buffer.concat(chunks).length : inbound.length,
    } };
    if (action === "file_abort") return { success: true };
    throw Error("Unexpected LAN request: " + action);
  };
  const window: any = {
    __superagentLanGetSelected: () => target, __TAURI__: { core: { invoke } }, confirm: () => true,
  };
  vm.runInNewContext(source, {
    window, document: { readyState: "complete", getElementById: get },
    crypto: nodeCrypto.webcrypto, TextEncoder, TextDecoder, DataView,
    btoa: (binary: string) => Buffer.from(binary, "binary").toString("base64"),
    atob: (b64: string) => Buffer.from(b64, "base64").toString("binary"),
    Uint8Array, Array, String, Number, Boolean, Error, Math, Set, Object,
  });
  const choose = (files: any[]) => {
    get("lan-folder-source").files = files;
    get("lan-folder-source").listeners.get("change")?.();
  };
  const click = (id: string) => get(id).listeners.get("click")?.();
  return { choose, click, get, requests, saves, chunks, target, window };
}
async function until(predicate: () => boolean, count = 300) {
  for (let i = 0; i < count; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw Error("Timed out waiting for isolated folder UI operation.");
}
const message = (ui: ReturnType<typeof setup>) => ui.get("lan-file-info").textContent;

describe("LAN Tray SAFOLDER1 user-selected directory exchange", () => {
  it("exposes a required network segment and native folder picker separately from file selection", () => {
    expect(html).toMatch(/id="lan-segment-name"[^>]*minlength="3"[^>]*maxlength="32"/);
    expect(html).toContain('pattern="[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}"');
    expect(html).toMatch(/id="lan-folder-source"[^>]*webkitdirectory multiple/);
    expect(html).toContain('id="lan-folder-send"');
    expect(html).toContain('id="lan-file-source"');
    expect(html.indexOf('id="lan-segment-name"')).toBeLessThan(html.indexOf('id="lan-discovery-scan"'));
  });
  it("packages exact magic, big-endian manifest, hashes and ordered payload through existing transfer actions", async () => {
    const ui = setup();
    ui.choose([folderFile("photos/z.txt", "Z"), folderFile("photos/sub/a.txt", "HELLO")]);
    expect(ui.get("lan-folder-send").disabled).toBe(false);
    ui.click("lan-folder-send");
    await until(() => message(ui).startsWith("Folder package sent"));
    const archive = Buffer.concat(ui.chunks);
    expect(archive.subarray(0, 9).toString()).toBe("SAFOLDER1");
    const length = archive.readUInt32BE(9);
    const manifest = JSON.parse(archive.subarray(13, 13 + length).toString("utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.files.map((f: any) => f.path)).toEqual(["sub/a.txt", "z.txt"]);
    expect(manifest.files.map((f: any) => f.size)).toEqual([5, 1]);
    expect(manifest.files.map((f: any) => f.sha256)).toEqual([sha(Buffer.from("HELLO")), sha(Buffer.from("Z"))]);
    expect(archive.subarray(13 + length).toString()).toBe("HELLOZ");
    expect(ui.requests[0].action).toBe("file_offer");
    expect(ui.requests[0].payload).toMatchObject({
      direction: "upload", name: "photos.safolder", sha256: sha(archive), size: archive.length,
    });
    expect(ui.requests.filter((r) => r.action === "file_finish")).toHaveLength(1);
    expect(ui.saves).toHaveLength(0);
  });
  it.each([
    ["traversal", "photos/../secrets.txt"],
    ["absolute", "/photos/secrets.txt"],
    ["backslash", "photos\\evil.txt"],
    ["hidden", "photos/.env"],
    ["nested hidden", "photos/.git/config"],
    ["reserved device", "photos/CON.txt"],
    ["reserved device with space", "photos/CON .txt"],
    ["trailing dot", "photos/file."],
    ["non-ASCII", "photos/é.txt"],
  ])("refuses unsafe local %s path without sending an offer", async (_label, path) => {
    const ui = setup();
    ui.choose([folderFile(path, "secret")]);
    ui.click("lan-folder-send");
    await until(() => message(ui).startsWith("Folder send failed:"));
    expect(ui.requests.filter((r) => r.action === "file_offer")).toHaveLength(0);
  });
  it("rejects more than 64 files and total size greater than 4 MiB", async () => {
    const many = setup();
    many.choose(Array.from({ length: 65 }, (_, i) => folderFile("photos/f" + i, "x")));
    many.click("lan-folder-send");
    await until(() => message(many).includes("1–64"));
    expect(many.requests).toHaveLength(0);
    const huge = setup();
    huge.choose([folderFile("photos/big.bin", Buffer.alloc(4 * 1024 * 1024))]);
    huge.click("lan-folder-send");
    await until(() => message(huge).startsWith("Folder send failed:"));
    expect(huge.requests.filter((r) => r.action === "file_offer")).toHaveLength(0);
  });
  it("refuses case-insensitive duplicates", async () => {
    const ui = setup();
    ui.choose([folderFile("photos/A.txt", "A"), folderFile("photos/a.txt", "B")]);
    ui.click("lan-folder-send");
    await until(() => message(ui).startsWith("Folder send failed:"));
    expect(ui.requests).toHaveLength(0);
  });
  it("fails closed if directory picker is unsupported and never falls back to files", async () => {
    const ui = setup({ supported: false });
    ui.choose([folderFile("photos/ok.txt", "OK")]);
    expect(ui.get("lan-folder-send").disabled).toBe(true);
    ui.click("lan-folder-send");
    expect(message(ui)).toContain("Directory picker is unavailable");
    expect(ui.requests).toHaveLength(0);
  });
  it("receives and validates member SHA-256 and routes only .safolder to native lan_folder_save", async () => {
    const bytes = makeArchive([
      { path: "photos/a.txt", bytes: Buffer.from("A") },
      { path: "photos/nested/b.txt", bytes: Buffer.from("BB") },
    ]);
    const ui = setup({ incoming: bytes });
    ui.click("lan-file-receive");
    await until(() => ui.saves.length > 0 && message(ui).startsWith("Folder received and verified"));
    expect(ui.saves.map((s) => s.command)).toEqual(["lan_folder_save"]);
    expect(ui.saves[0].input.name).toBe("remote.safolder");
    expect(ui.saves[0].input.sha256).toBe(sha(bytes));
    expect(Buffer.from(ui.saves[0].input.data, "base64")).toEqual(bytes);
  });
  it.each([
    ["member hash mismatch", makeArchive([{ path: "photos/a.txt", bytes: Buffer.from("A"), sha256: "0".repeat(64) }])],
    ["path traversal", makeArchive([{ path: "../bad.txt", bytes: Buffer.from("X") }])],
    ["hidden entry", makeArchive([{ path: ".config/key", bytes: Buffer.from("X") }])],
    ["duplicate names", makeArchive([{ path: "a.txt", bytes: Buffer.from("X") }, { path: "A.txt", bytes: Buffer.from("Y") }])],
    ["file/directory path collision", makeArchive([{ path: "photos/a", bytes: Buffer.from("X") }, { path: "photos/a/b", bytes: Buffer.from("Y") }])],
    ["incorrect magic", Buffer.from("NOTFOLDER000000")],
  ])("does not save a malformed received folder: %s", async (_reason, bytes) => {
    const ui = setup({ incoming: bytes });
    ui.click("lan-file-receive");
    await until(() => message(ui).startsWith("Receive failed:"));
    expect(ui.saves).toHaveLength(0);
    expect(ui.requests.map((r) => r.action)).toContain("file_abort");
    expect(ui.requests.map((r) => r.action)).not.toContain("file_finish");
  });
  it("keeps ordinary files on existing lan_file_save path", async () => {
    const ui = setup({ incoming: Buffer.from("normal file"), name: "report.txt" });
    ui.click("lan-file-receive");
    await until(() => ui.saves.length > 0);
    expect(ui.saves.map((s) => s.command)).toEqual(["lan_file_save"]);
  });
  it("requires active approved session before folder sending", async () => {
    const ui = setup({ connected: false });
    ui.choose([folderFile("photos/ok.txt", "OK")]);
    expect(ui.get("lan-folder-send").disabled).toBe(true);
  });
});
