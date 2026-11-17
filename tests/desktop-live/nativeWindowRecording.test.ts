import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeWindowPreviewManager } from "../../src/core/desktopUi/livePreview.js";
import {
  inspectNativeWindowRecordingPreview, startApprovedNativeWindowRecording,
} from "../../src/core/desktopUi/nativeWindowRecorder.js";
import {
  getCdpSessionArchiveStatus, stopCdpSessionArchive,
  resetCdpSessionArchivesForTests,
} from "../../src/core/tools/chromeCdpSessionArchive.js";

const validWindow={
  pid:54321,nativeId:"win:recording-001",
  title:"Operator-approved document",application:"Fixture editor",
  bounds:{x:15,y:25,width:960,height:540},
};
const previewToken="d".repeat(64);
const scope={
  targetKey:"native:54321:win:recording-001",
  actorId:"local-tray-native-recording",
  generation:requireGeneration(),
};
function requireGeneration():string {
  // Use the same generation scheme, never return or persist the raw capability.
  return (awaitHash(previewToken)).slice(0,40);
}
function awaitHash(value:string):string {
  const crypto=requireHash();
  return crypto.createHash("sha256").update(value).digest("hex");
}
function requireHash() {
  // Included through a normal module import in the ESM host.
  return {createHash:(input:string)=>createHash(input)};
}
import { createHash } from "node:crypto";

const ffmpeg=spawnSync("ffmpeg",["-version"],{stdio:"ignore",timeout:3000}).status===0;
let project:string,jpeg:string;
let active:typeof validWindow|null;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

beforeEach(async()=>{
  project=await mkdtemp(join(tmpdir(),"superagent-native-record-e2e-"));
  const picture=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi",
    "-i","color=c=green:s=320x180:d=0.1","-frames:v","1",
    "-f","image2pipe","-vcodec","mjpeg","pipe:1"],{maxBuffer:1_000_000});
  if(!ffmpeg)return;
  if(picture.status!==0)throw Error("Fixture JPEG failed.");
  jpeg=picture.stdout.toString("base64");
  active=validWindow;
  vi.spyOn(nativeWindowPreviewManager,"getActiveSession").mockImplementation((token)=>
    token===previewToken ? active : null);
  vi.spyOn(nativeWindowPreviewManager,"frame").mockImplementation(async()=>({
    unchanged:false as const,format:"jpeg" as const,
    jpeg,width:320,height:180,hash:"a".repeat(64),
    capturedAt:new Date().toISOString(),nextPollMs:16,
  }));
});
afterEach(async()=>{
  resetCdpSessionArchivesForTests();
  vi.restoreAllMocks();
  if(project)await rm(project,{recursive:true,force:true});
});

describe.skipIf(!ffmpeg)("native-window recording in real FFmpeg and project archives",()=>{
  const request=()=>({
    action:"start-native",pid:validWindow.pid,nativeId:validWindow.nativeId,
    expectedTitle:validWindow.title,expectedApplication:validWindow.application,
    expectedBounds:validWindow.bounds,projectDirectory:project,consent:true,
    previewToken,videoPreset:"compact",
  });
  test("records approved exact window, finalizes MP4, and fingerprints native source",async()=>{
    expect(inspectNativeWindowRecordingPreview(previewToken)).toEqual(validWindow);
    const started=await startApprovedNativeWindowRecording(request());
    expect(started).toMatchObject({status:"recording",source:"native-window-exact-window",
      videoPreset:"compact",fps:3,videoWidth:640,videoHeight:360});
    await sleep(480);
    const saved=await stopCdpSessionArchive(scope);
    expect(saved.status).toBe("saved");
    const manifest=JSON.parse(await readFile(saved.manifestFile,"utf8"));
    expect(manifest.source).toBe("native-window-exact-window");
    expect(manifest.includesAudio).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain(previewToken);
    const video=spawnSync("ffprobe",["-v","error","-show_entries",
      "stream=codec_name,width,height","-of","json",saved.videoFile],
      {encoding:"utf8",timeout:10000});
    expect(video.status).toBe(0);
    expect(JSON.parse(video.stdout).streams[0])
      .toMatchObject({codec_name:"h264",width:640,height:360});
  },30000);
  test("refuses a swapped native window before any recorder starts",async()=>{
    await expect(startApprovedNativeWindowRecording({...request(),expectedTitle:"Other window"}))
      .rejects.toThrow(/changed/);
    expect(()=>getCdpSessionArchiveStatus(scope)).toThrow(/not available/);
  });
  test("auto-finalizes when the exact preview capability is revoked",async()=>{
    const started=await startApprovedNativeWindowRecording(request());
    active=null;
    let status="recording";
    for(let n=0;n<50;n++){
      await sleep(150);
      status=getCdpSessionArchiveStatus(scope).status;
      if(status==="saved"||status==="failed")break;
    }
    expect(status).toBe("saved");
    const manifest=JSON.parse(await readFile(started.manifestFile,"utf8"));
    expect(manifest.status).toBe("saved");
  },30000);
});
