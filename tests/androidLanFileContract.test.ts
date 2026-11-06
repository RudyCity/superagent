import { describe, expect, it } from "vitest";
import fs from "node:fs";

const androidRoot = "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/";
const android = (name: string) => fs.readFileSync(androidRoot + name + ".java", "utf8");
const exchange = android("LanFileExchange");
const activity = android("MainActivity");
const server = android("LanClientServer");
const transport = fs.readFileSync("src/core/lanRemote/transport.ts", "utf8");
const lanCli = fs.readFileSync("src/lanClient.ts", "utf8");
const bridge = fs.readFileSync("src/core/runtime/trayLanBridge.ts", "utf8");
const native = fs.readFileSync("apps/superagent-tray/src-tauri/src/lan_file_save.rs", "utf8");
const tray = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");

describe("Android + Windows LAN file transfer security and interoperability contract", () => {
  it("uses identical message names, 4 KiB chunks and 4 MiB cap on both targets", () => {
    expect(exchange).toContain("MAX_BYTES = 4 * 1024 * 1024");
    expect(exchange).toContain("CHUNK_BYTES = 4096");
    expect(transport).toContain("LanTargetFiles");
    expect(server).toContain('"file_offer".equals(op)');
    for (const op of ["file_offer", "file_put", "file_get", "file_finish", "file_abort"]) {
      expect(server).toContain('"' + op + '"');
      expect(transport).toContain('"' + op + '"');
      expect(bridge).toContain('"' + op + '"');
    }
    expect(tray).toContain("const MAX = 4 * 1024 * 1024");
    expect(tray).toContain("const CHUNK = 4096");
  });
  it("Android can only share a document explicitly selected by its owner", () => {
    expect(activity).toContain("Intent.ACTION_OPEN_DOCUMENT");
    expect(activity).toContain("Intent.CATEGORY_OPENABLE");
    expect(activity).toContain('setType("*/*")');
    expect(activity).toContain("getContentResolver().openInputStream(uri)");
    expect(activity).toContain("file.size() + n > LanFileExchange.MAX_BYTES");
    expect(activity).toContain("pending.selectLocalFile(sharedFileName, sharedFileBytes)");
    expect(activity).toContain("Clear selected file or folder");
    expect(exchange).toContain("Select a file on the Android phone first.");
    expect(exchange).not.toContain("MANAGE_EXTERNAL_STORAGE");
    expect(exchange).not.toContain("getExternalStorageDirectory()");
    expect(exchange).not.toContain("getPath()");
  });
  it("Android requires a fresh per-file local approval and saves only after SHA-256 check", () => {
    expect(server).toContain('approval.ask("file:" + description');
    expect(activity).toContain('kind.startsWith("file:")');
    expect(exchange).toContain('MessageDigest.getInstance("SHA-256")');
    expect(exchange).toContain("MessageDigest.isEqual");
    expect(exchange).toContain("MediaStore.Downloads.EXTERNAL_CONTENT_URI");
    expect(exchange).toContain("Environment.DIRECTORY_DOWNLOADS");
    expect(exchange).toContain("MediaStore.Downloads.IS_PENDING");
    expect(exchange).toContain("context.getContentResolver().delete(uri, null, null)");
    expect(exchange).toContain("UUID.randomUUID()");
    expect(exchange).toContain("public void clear()");
    expect(exchange).toContain("revocationGeneration.incrementAndGet()");
  });
  it("Windows requires explicit local selection and target APPROVE before sharing", () => {
    expect(lanCli).toContain('command.startsWith("share ")');
    expect(lanCli).toContain("client.shareSelectedFile(chosen)");
    expect(lanCli).toContain('if (request.detail) console.log("File: " + request.detail)');
    expect(transport).toContain('kind: direction === "upload" ? "file-upload" : "file-download"');
    expect(transport).toContain("await options.onApproval");
    expect(transport).toContain("files.clear()");
  });
  it("Tray uses native Save As with path picked by recipient, SHA-256 and no overwrite", () => {
    expect(tray).toContain('invoke("file_offer"');
    expect(tray).toContain('invoke("file_put"');
    expect(tray).toContain('invoke("file_get"');
    expect(tray).toContain('invoke("file_abort"');
    expect(tray).toContain('const name = isFolder ? "lan_folder_save" : "lan_file_save"');
    expect(tray).toContain('crypto.subtle.digest("SHA-256"');
    expect(native).toContain("blocking_save_file()");
    expect(native).toContain("create_new(true)");
    expect(native).toContain('format!("{:x}", Sha256::digest(&bytes))');
    expect(native).not.toContain("set_directory");
    expect(native).not.toContain("std::process::Command");
    expect(html).toContain('id="lan-file-source"');
    expect(html).toContain('id="lan-file-send"');
    expect(html).toContain('id="lan-file-receive"');
    expect(html).toContain('id="lan-file-progress"');
  });
  it("does not expose a LAN path or credential arbitrary file browser", () => {
    expect(tray).not.toContain("innerHTML");
    expect(bridge).not.toContain("listDirectory(");
    expect(exchange).not.toContain("FileInputStream(");
    expect(exchange).not.toContain("shell");
    expect(server).toContain('isStillAuthorized(active, owner, ip)');
    expect(server).toContain("fileExchange.clear()");
  });
});
