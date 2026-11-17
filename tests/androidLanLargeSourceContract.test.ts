import { describe, expect, it } from "vitest";
import fs from "node:fs";

const root = "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/";
const source = fs.readFileSync(root + "LanFileSourceV2.java", "utf8");
const server = fs.readFileSync(root + "LanClientServer.java", "utf8");
const activity = fs.readFileSync(root + "MainActivity.java", "utf8");
const foreground = fs.readFileSync(root + "LanTransferForegroundService.java", "utf8");
const controller = fs.readFileSync("src/core/lanRemote/controller.ts", "utf8");
const relay = fs.readFileSync("src/core/lanRemote/fileRelayManager.ts", "utf8");

describe("Android V2 large owner-selected outbound source invariants", () => {
  it("copies SAF content to a private 256-MiB bounded disk file instead of holding full bytes", () => {
    expect(source).toContain('"content".equals(ownerChosen.getScheme())');
    expect(source).toContain("MAX = 256L * 1024 * 1024");
    expect(source).toContain("new File(this.context.getFilesDir()");
    expect(source).toContain("new byte[64 * 1024]");
    expect(source).toContain("out.getFD().sync()");
    expect(source).toContain("MessageDigest.getInstance(\"SHA-256\")");
    expect(source).not.toContain("ByteArrayOutputStream");
    expect(source).not.toContain("getExternalStorageDirectory");
    expect(source).not.toContain("MANAGE_EXTERNAL_STORAGE");
  });
  it("requires owner-picked ACTION_OPEN_DOCUMENT, safe metadata and explicit renewed approval", () => {
    expect(activity).toContain("LARGE_FILE_SELECT_REQUEST = 9006");
    expect(activity).toContain("Select Large File");
    expect(activity).toContain("Intent.ACTION_OPEN_DOCUMENT");
    expect(activity).toContain("largeSource.select(chosen, chosenName)");
    expect(activity).toContain("pending.selectLargeSource(largeSource)");
    expect(server).toContain('approval.ask("file:" + description');
    expect(server).toContain("large.offer(ownerRevision)");
    expect(source).toContain("s.revision != approvedRevision");
    expect(server).toContain('request.has("name")');
    expect(source).toContain("LanFileExchange.name(name)");
  });
  it("routes V2 get/status/finish/abort only to authenticated active Android owners", () => {
    expect(server).toContain('"file_v2_get".equals(op)');
    expect(server).toContain("sourceV2.get(transferId");
    expect(server).toContain("sourceV2.status(transferId)");
    expect(server).toContain("sourceV2.finish(transferId)");
    expect(server).toContain("sourceV2.abort(transferId)");
    expect(server).toContain("isStillAuthorized(active, owner, ip)");
    expect(source).toContain("private final AtomicLong generation");
    expect(source).toContain("seq != a.seq && seq != a.seq - 1");
    expect(foreground).toContain("server.isV2TransferActive()");
    expect(controller).toContain("offerLanFileV2Source");
    expect(relay).toContain("this.api.offerV2Source!");
  });
});
