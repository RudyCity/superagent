import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listProjectCdpRecordings, locateProjectCdpRecording, deleteProjectCdpRecording,
  stopProjectCdpRecording, exportProjectCdpRecording,
} from "../src/core/tools/chromeCdpRecordingLibrary.js";

const uuid="00000000-0000-4000-8000-000000000123";
let project:string,folder:string;
beforeEach(async()=>{
  project=await mkdtemp(join(tmpdir(),"superagent-recordings-manager-"));
  folder=join(project,".superagent","recordings","cdp",uuid);
  await mkdir(folder,{recursive:true});
  await writeFile(join(folder,"manifest.json"),JSON.stringify({
    recordingId:uuid,status:"saved",startedAt:"2026-11-17T01:02:03Z",
    source:"delegate-cdp-exact-tab",frameCount:4,videoBytes:400,
  }));
  await writeFile(join(folder,"video.mp4"),Buffer.alloc(400,0));
});
afterEach(async()=>{await rm(project,{recursive:true,force:true})});

describe("project-local CDP Recording Manager",()=>{
  test("lists finalized recordings without exporting private payloads",async()=>{
    const inventory=await listProjectCdpRecordings(project);
    expect(inventory.recordings).toEqual([expect.objectContaining({
      recordingId:uuid, status:"saved",hasVideo:true,source:"delegate-cdp-exact-tab",
    })]);
    expect(JSON.stringify(inventory)).not.toContain("manifest.json");
    expect((await locateProjectCdpRecording(project,uuid,"video")).path)
      .toBe(join(folder,"video.mp4"));
  });
  test("exports a valid bounded ZIP with video and verifiable SHA-256 checksums",async()=>{
    await writeFile(join(folder,"transcript.jsonl"),'{"action":"click"}\n');
    const exported=await exportProjectCdpRecording(project,uuid);
    expect(exported.path).toBe(join(folder,"recording.zip"));
    expect(exported.entries).toBeGreaterThanOrEqual(4);
    const zip=await JSZip.loadAsync(await readFile(exported.path),{checkCRC32:true});
    const names=Object.keys(zip.files).sort();
    expect(names).toEqual(["checksums.sha256","manifest.json","transcript.jsonl","video.mp4"].sort());
    const video=await zip.file("video.mp4")!.async("nodebuffer");
    expect(video.byteLength).toBe(400);
    const checksum=await zip.file("checksums.sha256")!.async("string");
    expect(checksum).toContain(createHash("sha256").update(video).digest("hex")+"  video.mp4");
    expect(exported.sha256).toBe(createHash("sha256")
      .update(await readFile(exported.path)).digest("hex"));
    expect((await deleteProjectCdpRecording(project,uuid,true)).deleted).toBe(true);
  });
  test("refuses ZIP export before manifest finalization",async()=>{
    await writeFile(join(folder,"manifest.json"),'{"status":"recording"}');
    await expect(exportProjectCdpRecording(project,uuid)).rejects.toThrow(/Finalize/);
  });
  test.skipIf(process.platform==="win32")("refuses symlinked contents during ZIP export",async()=>{
    await symlink(join(folder,"manifest.json"),join(folder,"README.txt"));
    await expect(exportProjectCdpRecording(project,uuid)).rejects.toThrow(/Unsafe ZIP entry/);
  });
  test("requires explicit confirmation and a valid exact UUID to delete",async()=>{
    await expect(deleteProjectCdpRecording(project,uuid,false)).rejects.toThrow(/approval/);
    await expect(locateProjectCdpRecording(project,"../../secrets","video")).rejects.toThrow(/UUID/);
    await expect(stopProjectCdpRecording(project,uuid)).rejects.toThrow(/no longer active/);
    expect((await deleteProjectCdpRecording(project,uuid,true)).deleted).toBe(true);
    expect((await listProjectCdpRecordings(project)).recordings).toEqual([]);
  });
  test.skipIf(process.platform==="win32")("refuses symlinked recording files",async()=>{
    await rm(join(folder,"video.mp4"));
    await symlink(join(folder,"manifest.json"),join(folder,"video.mp4"));
    await expect(locateProjectCdpRecording(project,uuid,"video")).rejects.toThrow(/invalid/);
    await expect(deleteProjectCdpRecording(project,uuid,true)).rejects.toThrow(/unmanaged/);
  });
  test("rejects filesystem roots and non-absolute projects",async()=>{
    await expect(listProjectCdpRecordings(".")).rejects.toThrow(/absolute/);
    await expect(listProjectCdpRecordings(process.platform==="win32"?"C:\\\\":"/"))
      .rejects.toThrow(/Root directories/);
  });
});
