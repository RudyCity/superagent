import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { startCdpSessionArchive, stopCdpSessionArchive,
  getCdpSessionArchiveStatus, recordCdpSessionCommand,
  recordCdpSessionDiagnostic, resetCdpSessionArchivesForTests,
} from "../src/core/tools/chromeCdpSessionArchive.js";
import { getPackageRootDir, getRootConfigDir } from "../src/core/config/paths.js";

const scope = {targetKey:"managed:9222:FIXTURE_PAGE",actorId:"owner",generation:"gen-a"};
let projectRoot: string;
let encodedJpeg: string;
const sleep = (ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const mediaToolsInstalled = spawnSync("ffmpeg",["-version"],{stdio:"ignore",timeout:3000}).status===0 &&
  spawnSync("ffprobe",["-version"],{stdio:"ignore",timeout:3000}).status===0;

beforeEach(async()=>{
  projectRoot=await mkdtemp(join(tmpdir(),"cdp-project-archive-"));
  const png=spawnSync("ffmpeg",[
    "-hide_banner","-loglevel","error","-f","lavfi","-i",
    "color=c=blue:s=320x180:d=0.1","-frames:v","1",
    "-f","image2pipe","-vcodec","mjpeg","pipe:1",
  ],{maxBuffer:2*1024*1024});
  if(png.status!==0 || !png.stdout?.length) throw Error("Test JPEG source failed");
  encodedJpeg=png.stdout.toString("base64");
});
afterEach(async()=>{
  resetCdpSessionArchivesForTests();
  await rm(projectRoot,{recursive:true,force:true});
});

describe.skipIf(!mediaToolsInstalled)("project-scoped MP4 session archives",()=>{
  test("rejects recording without explicit sensitive-video consent and a verified lease",async()=>{
    const deps={projectDirectory:projectRoot,captureFrame:async()=>encodedJpeg,
      checkLease:async()=>true};
    await expect(startCdpSessionArchive(scope,{...deps,confirmSensitiveVideo:false}))
      .rejects.toThrow(/confirmSensitiveVideo:true/);
    await expect(startCdpSessionArchive(scope,{...deps,confirmSensitiveVideo:true,
      checkLease:async()=>false})).rejects.toThrow(/lease/);
    await expect(startCdpSessionArchive(scope,{...deps,confirmSensitiveVideo:true,
      projectDirectory:"relative/project"})).rejects.toThrow(/explicit active project directory/);
    expect(()=>getCdpSessionArchiveStatus(scope)).toThrow(/not available/);
  });

  test("defaults to MP4 in CURRENT PROJECT and saves separated, redacted transcripts",async()=>{
    const recording=await startCdpSessionArchive(scope,{
      projectDirectory:projectRoot,confirmSensitiveVideo:true,
      captureFrame:async()=>encodedJpeg,checkLease:async()=>true,
    });
    expect(recording.status).toBe("recording");
    expect(relative(projectRoot,recording.directory)).toMatch(/^\.superagent[\\/]recordings[\\/]cdp[\\/]/);
    expect(isAbsolute(relative(projectRoot,recording.directory))).toBe(false);
    recordCdpSessionCommand(scope,"click_cursor","control_chrome_cdp: native mouse click dispatched once");
    recordCdpSessionCommand(scope,"type","control_chrome_cdp failed: password=SECRET token=abc123 https://secret.test/login?token=123");
    recordCdpSessionDiagnostic(scope.targetKey,{at:new Date().toISOString(),kind:"console",
      details:{level:"error",values:["token=TOP_SECRET"],executionContextId:1}});
    recordCdpSessionDiagnostic(scope.targetKey,{at:new Date().toISOString(),kind:"response",
      details:{status:503,method:"GET",url:"https://example.test/error?token=TOP_SECRET"}});
    await sleep(1200);
    const saved=await stopCdpSessionArchive(scope,{events:[{sequence:1,action:"click",status:"dispatched"}]});
    expect(saved.status).toBe("saved");
    expect(saved.frameCount).toBeGreaterThanOrEqual(2);
    expect((await stat(saved.videoFile)).size).toBeGreaterThan(1000);
    expect((await readFile(join(projectRoot,".superagent","recordings",".gitignore"),"utf8"))).toBe("*\n");
    const metadata=JSON.parse(await readFile(saved.manifestFile,"utf8"));
    expect(metadata.videoBytes).toBeGreaterThan(1000);
    expect(metadata.includesAudio).toBe(false);
    expect(metadata.source).toBe("managed-cdp-exact-tab");
    const transcript=await readFile(saved.transcriptFile,"utf8");
    const errors=await readFile(saved.errorsFile,"utf8");
    const consoleLog=await readFile(saved.consoleFile,"utf8");
    const network=await readFile(saved.networkFile,"utf8");
    const diagnostic=await readFile(saved.diagnosticsFile,"utf8");
    expect(transcript).toContain('"action":"click_cursor"');
    expect(transcript).toContain('"outcome":"failed"');
    expect(errors).toContain('"status":503');
    expect(consoleLog).toContain('"kind":"console"');
    expect(network).toContain('"kind":"response"');
    expect(diagnostic).toContain('"kind":"response"');
    for(const text of [transcript,errors,consoleLog,network,diagnostic]){
      expect(text).not.toContain("TOP_SECRET");
      expect(text).not.toContain("password=SECRET");
      expect(text).not.toContain("https://secret.test");
    }
    const probe=spawnSync("ffprobe",["-v","error","-show_entries","stream=codec_name,width,height",
      "-of","json",saved.videoFile],{encoding:"utf8",timeout:15000});
    expect(probe.status).toBe(0);
    const streams=JSON.parse(probe.stdout).streams;
    expect(streams[0]).toMatchObject({codec_name:"h264",width:960,height:540});
    expect(getCdpSessionArchiveStatus(scope).status).toBe("saved");
  },25000);

  test("refuses SuperAgent source/runtime paths and supports multiple saved recordings",async()=>{
    const deps={confirmSensitiveVideo:true,captureFrame:async()=>encodedJpeg,
      checkLease:async()=>true};
    await expect(startCdpSessionArchive(scope,{...deps,projectDirectory:getPackageRootDir()}))
      .rejects.toThrow(/SuperAgent runtime\/configuration\/source/);
    await expect(startCdpSessionArchive(scope,{...deps,projectDirectory:getRootConfigDir()}))
      .rejects.toThrow(/SuperAgent runtime\/configuration\/source/);
    const first=await startCdpSessionArchive(scope,{...deps,projectDirectory:projectRoot});
    const one=await stopCdpSessionArchive(scope);
    expect(one.status).toBe("saved");
    const second=await startCdpSessionArchive(scope,{...deps,projectDirectory:projectRoot});
    expect(second.recordingId).not.toBe(first.recordingId);
    const two=await stopCdpSessionArchive(scope);
    expect(two.status).toBe("saved");
    expect((await stat(one.videoFile)).size).toBeGreaterThan(1000);
    expect((await stat(two.videoFile)).size).toBeGreaterThan(1000);
  },25000);

  test("concurrent stop requests share one finalizer and repeated stop is idempotent",async()=>{
    const started=await startCdpSessionArchive(scope,{
      projectDirectory:projectRoot,confirmSensitiveVideo:true,
      captureFrame:async()=>encodedJpeg,checkLease:async()=>true,
    });
    await sleep(420);
    const [first,second,third]=await Promise.all([
      stopCdpSessionArchive(scope,{events:[{sequence:1,action:"click_cursor"}]}),
      stopCdpSessionArchive(scope,{events:[{sequence:2,action:"move_cursor"}]}),
      stopCdpSessionArchive(scope),
    ]);
    expect(first).toMatchObject({recordingId:started.recordingId,status:"saved"});
    expect(second.recordingId).toBe(first.recordingId);
    expect(third.recordingId).toBe(first.recordingId);
    const actions=JSON.parse(await readFile(join(first.directory,"actions.json"),"utf8"));
    expect(actions.recordedCount).toBe(1);
    expect(actions.events[0].action).toBe("click_cursor");
    expect((await stat(first.videoFile)).size).toBeGreaterThan(1000);
    const again=await stopCdpSessionArchive(scope);
    expect(again.status).toBe("saved");
    expect(again.recordingId).toBe(first.recordingId);
  },25000);

  test("brief navigation-detached screenshots recover without ending video",async()=>{
    let reads=0;
    const saved=await startCdpSessionArchive(scope,{
      projectDirectory:projectRoot,confirmSensitiveVideo:true,checkLease:async()=>true,
      captureFrame:async()=>{
        reads++;
        if(reads===2||reads===3)
          throw Error("CDP 'Page.captureScreenshot' error: Not attached to an active page");
        return encodedJpeg;
      },
    });
    await sleep(1350);
    const result=await stopCdpSessionArchive(scope);
    expect(saved.status).toBe("recording");
    expect(result.status).toBe("saved");
    expect(result.droppedFrames).toBe(2);
    expect(result.frameCount).toBeGreaterThanOrEqual(4);
    const errors=await readFile(result.errorsFile,"utf8");
    expect(errors.match(/video_frame_capture_failed/g)?.length).toBe(2);
    const probe=spawnSync("ffprobe",["-v","error","-show_entries","stream=codec_name",
      "-of","json",result.videoFile],{encoding:"utf8",timeout:8000});
    expect(probe.status).toBe(0);
    expect(JSON.parse(probe.stdout).streams[0].codec_name).toBe("h264");
  },25000);

  test("persistent screenshot failure stops bounded capture",async()=>{
    let calls=0;
    await startCdpSessionArchive(scope,{
      projectDirectory:projectRoot,confirmSensitiveVideo:true,checkLease:async()=>true,
      captureFrame:async()=>{
        calls++;
        if(calls>1)throw Error("CDP 'Page.captureScreenshot' error: Not attached to an active page");
        return encodedJpeg;
      },
    });
    await sleep(2450);
    const record=await stopCdpSessionArchive(scope);
    expect(record.status).toBe("saved");
    expect(record.droppedFrames).toBeGreaterThanOrEqual(9);
    expect(calls).toBeLessThanOrEqual(11);
  },25000);

  test("cannot read another actor's or generation's archive",async()=>{
    await startCdpSessionArchive(scope,{projectDirectory:projectRoot,
      confirmSensitiveVideo:true,captureFrame:async()=>encodedJpeg,
      checkLease:async()=>true});
    expect(()=>getCdpSessionArchiveStatus({...scope,actorId:"intruder"})).toThrow(/not available/);
    await expect(stopCdpSessionArchive({...scope,generation:"other"})).rejects.toThrow(/not available/);
    const saved=await stopCdpSessionArchive(scope);
    expect(saved.status).toBe("saved");
  },25000);
});
