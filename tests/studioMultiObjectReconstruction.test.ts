import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { importMotionVideo } from "../src/core/motion/assets/motionVideoClips.js";
import {
  associateStudioObjects, findStudioBrightComponents, findStudioForegroundComponents,
  reconstructMultiObjectStudioVideo, studioBaseSampleFrames, studioBoundedRotationSamples,
  inspectStudioOcclusionEvidence,
} from "../src/core/motion/code/videoMultiObjectReconstruction.js";
import { getMotionProject, listMotionProjects, studioStorageRoot } from "../src/core/motion/project/projectStore.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { renderStudioNativeHtml } from "../src/core/motion/code/studioNativeCodeExporter.js";
import { renderStudioEditableReactComponent } from "../src/core/motion/code/studioEditableReactExporter.js";
import { transformSync } from "esbuild";

const run = promisify(execFile);
const workspaces: string[] = [];
async function ws() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-multi-test-"));
  workspaces.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
function candidate(x: number, y = 4) {
  return { x, y, width: 20, height: 20, count: 400, r: 255, g: 255, b: 255 };
}

describe("multi-object reference video prototype", () => {
  it("plans 5-9 strictly increasing duration-aware sample frames", () => {
    for (const [duration, count] of [[30, 5], [90, 5], [180, 7], [300, 9]]) {
      const frames = studioBaseSampleFrames(duration);
      expect(frames).toHaveLength(count);
      expect(frames[0]).toBe(0);
      expect(frames.at(-1)).toBeLessThan(duration);
      expect(frames.at(-1)!).toBeGreaterThan(duration * .9);
      expect(frames.every((frame, i) => !i || frame > frames[i - 1])).toBe(true);
    }
    expect(() => studioBaseSampleFrames(29)).toThrow(/Invalid/);
    expect(() => studioBaseSampleFrames(361)).toThrow(/Invalid/);
  });

  it("extracts separated components and rejects unbounded frame geometry", () => {
    const pixels = new Uint8ClampedArray(60 * 40 * 4);
    for (let y = 5; y < 20; y++) {
      for (let x = 5; x < 18; x++) {
        let i = (y * 60 + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
      for (let x = 32; x < 45; x++) {
        let i = (y * 60 + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
    }
    const found = findStudioBrightComponents(pixels, 60, 40);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ x: 5, y: 5, width: 13, height: 15 });
    expect(found[1]).toMatchObject({ x: 32, y: 5, width: 13, height: 15 });
    expect(() => findStudioBrightComponents(pixels, 6000, 4000)).toThrow();
  });

  it("detects dark and saturated foreground on a light solid backdrop", () => {
    const pixels = new Uint8ClampedArray(80 * 50 * 4);
    for (let i = 0; i < 80 * 50; i++) {
      const at = i * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 245;
      pixels[at + 3] = 255;
    }
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) {
      const i = (y * 80 + x) * 4;
      pixels[i] = 15; pixels[i + 1] = 20; pixels[i + 2] = 45;
    }
    for (let y = 15; y < 35; y++) for (let x = 50; x < 70; x++) {
      const i = (y * 80 + x) * 4;
      pixels[i] = 215; pixels[i + 1] = 25; pixels[i + 2] = 65;
    }
    const components = findStudioForegroundComponents(pixels, 80, 50, [245, 245, 245]);
    expect(components).toHaveLength(2);
    expect(components[0]).toMatchObject({ x: 10, y: 10, width: 20, height: 20 });
    expect(components[1]).toMatchObject({ x: 50, y: 15, width: 20, height: 20 });
    expect(() => findStudioForegroundComponents(pixels, 80, 50, [999, 0, 0]))
      .toThrow(/Invalid bounded/);
  });

  it("reconstructs colored and dark shapes on a stable light background to offline SVG", async () => {
    const workspace = await ws();
    for (let f = 0; f < 30; f++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#f0f0f0";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "#181b3e";
      ctx.fillRect(14 + f, 15, 20, 22);
      ctx.fillStyle = "#c6255e";
      ctx.fillRect(102 + Math.floor(f / 5), 52, 22, 19);
      await fs.writeFile(path.join(workspace, "light" + String(f).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "light%03d.png"), "-y",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(workspace, "light.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace, await fs.readFile(path.join(workspace, "light.mp4")));
    const result = await reconstructMultiObjectStudioVideo(workspace, imported.id);
    expect(result.objects).toHaveLength(2);
    expect(result.measuredForegroundIoU.every(score => score >= .6)).toBe(true);
    expect(result.interpolationCheckIoU.every(score => score >= .6)).toBe(true);
    const reconstructed = await getMotionProject(workspace, result.projectId);
    const bg = reconstructed.composition.background.toLowerCase();
    expect(bg).toMatch(/^#[0-9a-f]{6}$/);
    for (const start of [1, 3, 5])
      expect(Math.abs(parseInt(bg.slice(start, start + 2), 16) - 240)).toBeLessThanOrEqual(8);
    expect(reconstructed.composition.layers[0].kind).toBe("path");
    const fill = reconstructed.composition.layers[0].fill!.toLowerCase();
    expect(fill).toMatch(/^#[0-9a-f]{6}$/);
    for (const [channel, value] of [[1, 24], [3, 27], [5, 62]]) {
      const part = parseInt(fill.slice(channel, channel + 2), 16);
      expect(Math.abs(part - value)).toBeLessThanOrEqual(25);
    }
    expect(renderStudioNativeHtml(reconstructed)).not.toContain("cdn.jsdelivr.net");
  }, 65000);

  it("detects an object disappearing near the final 5% of a reference clip", async () => {
    const workspace = await ws();
    for (let f = 0; f < 30; f++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#f8f8f8";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "#16263c";
      ctx.fillRect(12 + f, 14, 20, 20);
      if (f < 26) {
        ctx.fillStyle = "#ba165a";
        ctx.fillRect(101, 52, 20, 20);
      }
      await fs.writeFile(path.join(workspace, "late" + String(f).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "late%03d.png"), "-y",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(workspace, "late.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "late.mp4")));
    await expect(reconstructMultiObjectStudioVideo(workspace, imported.id))
      .rejects.toThrow(/object count/);
    expect(await listMotionProjects(workspace)).toEqual([]);
  }, 65000);

  it("rejects transient occlusion between the original five parity checks without saving a fake project", async () => {
    const workspace = await ws();
    for (let f=0;f<30;f++) {
      const canvas=createCanvas(160,90);
      const ctx=canvas.getContext("2d");
      ctx.fillStyle="#101010";ctx.fillRect(0,0,160,90);
      // Objects join only on original video frames 17-19 (timeline frames
      // 51-59): the five P5 QA frames do not cover this transient overlap.
      const occluded=f>=17&&f<=19;
      ctx.fillStyle="#ffcc66";ctx.fillRect(occluded?52:18,18,22,20);
      ctx.fillStyle="#22ddff";ctx.fillRect(occluded?64:101,18,22,20);
      await fs.writeFile(path.join(workspace,"occlude"+String(f).padStart(3,"0")+".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg",["-hide_banner","-loglevel","error","-framerate","10",
      "-i",path.join(workspace,"occlude%03d.png"),"-y","-c:v","libx264",
      "-pix_fmt","yuv420p",path.join(workspace,"occluded.mp4")],
      {timeout:30000,maxBuffer:4096,windowsHide:true});
    const imported=await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace,"occluded.mp4")));
    await expect(reconstructMultiObjectStudioVideo(workspace,imported.id))
      .rejects.toThrow(/transient occlusion|object disappearance/);
    expect(await listMotionProjects(workspace)).toEqual([]);
    const evidence=await inspectStudioOcclusionEvidence(workspace,imported.id,54);
    expect(evidence.status).toBe("review-only");
    expect(evidence.observations.map(item=>item.objectCount)).toEqual([2,1,2]);
    expect(evidence.observations.map(item=>item.frame)).toEqual([42,54,66]);
    expect(Buffer.from(evidence.previewPngBase64,"base64").subarray(0,8).toString("hex"))
      .toBe("89504e470d0a1a0a");
    expect(evidence.previewPngBase64.length).toBeLessThan(2*1024*1024*4/3);
    expect(JSON.stringify(evidence)).not.toContain(workspace);
    expect(await listMotionProjects(workspace)).toEqual([]);
  },65000);

  it("previews and explicitly approves a short verifiable merge without bypassing standard P6 checks",async()=>{
    const workspace=await ws();
    for(let f=0;f<30;f++){
      const canvas=createCanvas(160,90),ctx=canvas.getContext("2d");
      ctx.fillStyle="#101010";ctx.fillRect(0,0,160,90);
      ctx.fillStyle="#ffcc66";ctx.fillRect(35,18,20,20);
      ctx.fillStyle="#22ddff";ctx.fillRect(f>=17&&f<=19?54:70,18,20,20);
      await fs.writeFile(path.join(workspace,"merge"+String(f).padStart(3,"0")+".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg",["-hide_banner","-loglevel","error","-framerate","10",
      "-i",path.join(workspace,"merge%03d.png"),"-y","-c:v","libx264",
      "-pix_fmt","yuv420p",path.join(workspace,"merge.mp4")],
      {timeout:30000,maxBuffer:4096,windowsHide:true});
    const media=await importMotionVideo(workspace,await fs.readFile(path.join(workspace,"merge.mp4")));
    await expect(reconstructMultiObjectStudioVideo(workspace,media.id))
      .rejects.toThrow(/occlusion/);
    const {validateStudioOcclusionMapping}=await import("../src/core/motion/code/studioOcclusionIdentityMapping.js");
    const evidence=await inspectStudioOcclusionEvidence(workspace,media.id,54);
    const checked=validateStudioOcclusionMapping(
      evidence.observations[0].objects,evidence.observations[2].objects,[0,1],
      evidence.dimensions.width,evidence.dimensions.height);
    expect(checked.beforeToAfter).toEqual([0,1]);
    const candidate=await reconstructMultiObjectStudioVideo(workspace,media.id,{
      frame:54,beforeToAfter:[0,1],previewOnly:true,
    });
    expect(candidate.status).toBe("recovery-candidate");
    if(candidate.status!=="recovery-candidate") throw new Error("Missing candidate");
    expect(candidate.flaggedForegroundIoU).toBeGreaterThan(.38);
    expect(candidate.mergedProbeFrames.length).toBeGreaterThan(0);
    expect(await listMotionProjects(workspace)).toEqual([]);
    await expect(reconstructMultiObjectStudioVideo(workspace,media.id,{
      frame:54,beforeToAfter:[0,1],previewOnly:false,
      candidateToken:"0".repeat(64),acknowledgement:"APPROVE_MANUAL_RECOVERY",
    })).rejects.toThrow(/changed/);
    expect(await listMotionProjects(workspace)).toEqual([]);
    const committed=await reconstructMultiObjectStudioVideo(workspace,media.id,{
      frame:54,beforeToAfter:[0,1],previewOnly:false,
      candidateToken:candidate.token,acknowledgement:"APPROVE_MANUAL_RECOVERY",
    });
    expect(committed.status).toBe("experimental-multi");
    if(committed.status!=="experimental-multi") throw new Error("Missing approved reconstruction");
    expect(committed.recovery?.manuallyConfirmed).toBe(true);
    expect(committed.timelineValidation.status).toBe("manual-recovery-reviewed");
    expect((await listMotionProjects(workspace)).length).toBe(1);
    const root=await studioStorageRoot(workspace);
    const marker=await fs.readFile(path.join(root,"code",
      committed.projectId+"-r"+committed.revision+"-multi-recovery.json"),"utf8");
    expect(JSON.parse(marker)).toMatchObject({
      frame:54,beforeToAfter:[0,1],sourceVideoId:media.id,
      projectId:committed.projectId,
    });
    expect(marker).toContain("hidden objects not recovered");
    expect(marker).not.toContain(workspace);
    expect((await getMotionProject(workspace,committed.projectId)).name)
      .toContain("inferred motion");
  },65000);

  it("rejects changing background colors before creating a project", async () => {
    const workspace = await ws();
    for (let f = 0; f < 30; f++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = f < 12 ? "#f0f0f0" : "#111111";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = f < 12 ? "#161d3f" : "#e8d9c1";
      ctx.fillRect(14 + f, 15, 20, 22);
      ctx.fillStyle = "#c6255e";
      ctx.fillRect(102, 52, 22, 19);
      await fs.writeFile(path.join(workspace, "flash" + String(f).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "flash%03d.png"), "-y",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(workspace, "flash.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace, await fs.readFile(path.join(workspace, "flash.mp4")));
    await expect(reconstructMultiObjectStudioVideo(workspace, imported.id))
      .rejects.toThrow(/Background changed/);
    expect(await listMotionProjects(workspace)).toEqual([]);
  }, 65000);

  it("matches identities deterministically and rejects uncertain or mismatched assignments", () => {
    const reference = [candidate(10), candidate(120)];
    const observed = [candidate(122), candidate(14)];
    const assigned = associateStudioObjects(reference, observed, 160, 90);
    expect(assigned.indices).toEqual([1, 0]);
    expect(assigned.gap).toBeGreaterThan(.045);
    expect(() => associateStudioObjects(reference, observed.slice(0, 1), 160, 90))
      .toThrow(/object count/);
    expect(() => associateStudioObjects([candidate(5), candidate(5)],
      [candidate(10), candidate(20)], 160, 90)).toThrow(/Ambiguous/);
  });

  it("creates two editable SVG layers with separate x/y tracks from a local 3s MP4", async () => {
    const workspace = await ws();
    for (let frame = 0; frame < 30; frame++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(12 + frame, 16, 19, 20);
      ctx.fillStyle = "#fff3aa";
      ctx.fillRect(95 + Math.round(frame * .22), 50, 21, 18);
      await fs.writeFile(path.join(workspace, "frame" + String(frame).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10", "-i",
      path.join(workspace, "frame%03d.png"), "-y", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", path.join(workspace, "clip.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });

    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "clip.mp4")));
    const built = await reconstructMultiObjectStudioVideo(workspace, imported.id);
    expect(built.status).toBe("experimental-multi");
    expect(built.objects).toHaveLength(2);
    expect(built.confidence).toBeGreaterThan(.4);
    expect(built.measuredForegroundIoU).toHaveLength(3);
    expect(built.timelineValidation.status).toBe("passed-sampled");
    expect(built.timelineValidation.checks.length).toBeGreaterThanOrEqual(14);
    expect(built.timelineValidation.checks.length).toBeLessThanOrEqual(20);
    expect(built.timelineValidation.checks.at(-1)!.frame).toBeGreaterThanOrEqual(85);
    expect(built.timelineValidation.minimumForegroundIoU).toBeGreaterThan(.38);
    expect(built.timelineValidation.minIdentityGap).toBeGreaterThan(.045);
    expect(built.measuredForegroundIoU.every(score => score >= .38)).toBe(true);
    expect(built.interpolationCheckIoU).toHaveLength(2);
    expect(built.interpolationCheckIoU.every(score => score >= .38)).toBe(true);
    const preview = await fs.readFile(built.reviewPng);
    expect(preview.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(preview.length).toBeLessThan(2 * 1024 * 1024);
    const diff = await fs.readFile(built.diffPng);
    expect(diff.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(diff.length).toBeLessThan(2 * 1024 * 1024);
    expect(built.sampleTimes.length).toBeGreaterThanOrEqual(5);
    expect(built.sampleTimes.length).toBeLessThanOrEqual(9);
    expect(built.objects.every(obj => obj.boxes.length === built.sampleTimes.length)).toBe(true);
    expect(built.objects[0].boxes.at(-1)!.x)
      .toBeGreaterThan(built.objects[0].boxes[0].x + 30);

    const project = await getMotionProject(workspace, built.projectId);
    expect(project.revision).toBe(2);
    expect(project.composition.layers).toHaveLength(2);
    expect(project.composition.layers.every(layer => layer.kind === "path")).toBe(true);
    expect(project.composition.layers.map(layer => layer.id)).toEqual([
      "reconstructed-object-1", "reconstructed-object-2",
    ]);
    for (const layer of project.composition.layers) {
      expect(layer.tracks.map(track => track.property)).toEqual(["x", "y", "scaleX", "scaleY"]);
      expect(layer.tracks.every(track => track.keyframes.length === built.sampleTimes.length)).toBe(true);
    }
    const actual = evaluateFrame(project, built.objects[0].boxes[1].frame);
    expect(actual.layers[0].values.x).toBeCloseTo(built.objects[0].boxes[1].x - 2, 0);
    const html = renderStudioNativeHtml(project);
    expect(html).toContain('data-studio-id="reconstructed-object-1"');
    expect(html).toContain('data-studio-id="reconstructed-object-2"');
    expect(html).not.toContain("cdn.jsdelivr.net");
    // End-to-end: encoded video -> detected objects -> native editable JSX.
    const jsx = renderStudioEditableReactComponent(project);
    expect(jsx.match(/data-studio-id=\{/g)).toHaveLength(2);
    expect(jsx.match(/<path /g)).toHaveLength(2);
    expect(jsx).toContain("reconstructed-object-1");
    expect(jsx).toContain("reconstructed-object-2");
    expect(jsx).not.toContain("<iframe");
    expect(jsx).toContain("SCENE_LAYERS:");
    expect(() => transformSync(jsx, {loader: "tsx", format: "esm"})).not.toThrow();
  }, 65000);

  it("tracks bounded object resize as editable scaleX/scaleY, preserving sampled and holdout parity", async () => {
    const workspace = await ws();
    for (let frame = 0; frame < 30; frame++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#101010";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "#fff4d9";
      ctx.fillRect(18 + Math.floor(frame / 4), 13,
        16 + Math.round(frame * .4), 17 + Math.round(frame * .36));
      ctx.fillStyle = "#40cfff";
      ctx.fillRect(106, 55, 19, 18);
      await fs.writeFile(path.join(workspace,"scale"+String(frame).padStart(3,"0")+".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace,"scale%03d.png"), "-y", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", path.join(workspace,"scale.mp4"),
    ], {timeout:30000,maxBuffer:4096,windowsHide:true});
    const media = await importMotionVideo(workspace,await fs.readFile(path.join(workspace,"scale.mp4")));
    const result = await reconstructMultiObjectStudioVideo(workspace,media.id);
    const project = await getMotionProject(workspace,result.projectId);
    const growing = project.composition.layers[0];
    expect(growing.tracks.map(track=>track.property)).toEqual(["x","y","scaleX","scaleY"]);
    expect(growing.tracks.find(track=>track.property==="scaleX")?.keyframes.at(-1)?.value).toBeGreaterThan(1.3);
    expect(growing.tracks.find(track=>track.property==="scaleY")?.keyframes.at(-1)?.value).toBeGreaterThan(1.3);
    expect(result.parityReport).toHaveLength(5);
    expect(result.parityReport.filter(item=>item.sampleType==="holdout")).toHaveLength(2);
    expect(result.parityReport.every(item=>item.foregroundIoU>.5 &&
      item.foregroundPrecision>.5 && item.foregroundRecall>.5 &&
      item.foregroundF1>.6 && item.rgbMeanAbsoluteError<.15)).toBe(true);
    const end = result.objects[0].boxes.at(-1)!;
    const evaluated = evaluateFrame(project,end.frame).layers[0].values;
    expect(evaluated.scaleX).toBeGreaterThan(1.3);
    expect(evaluated.scaleY).toBeGreaterThan(1.3);
    const jsx = renderStudioEditableReactComponent(project);
    expect(jsx).toContain('"property":"scaleX"');
    expect(jsx).toContain('"property":"scaleY"');
    expect(() => transformSync(jsx,{loader:"tsx",format:"esm"})).not.toThrow();
  }, 65000);

  it("recovers bounded clockwise rotation of a distinctive elongated object from an encoded video", async () => {
    const workspace = await ws();
    for (let f=0; f<30; f++) {
      const canvas=createCanvas(160,90), ctx=canvas.getContext("2d");
      ctx.fillStyle="#101010"; ctx.fillRect(0,0,160,90);
      ctx.save();
      ctx.translate(57,42);
      ctx.rotate(f/29 * 25 * Math.PI/180);
      ctx.fillStyle="#f9de6a";
      ctx.fillRect(-27,-6,54,12);
      ctx.restore();
      ctx.fillStyle="#34caff";ctx.fillRect(121,60,16,16);
      await fs.writeFile(path.join(workspace,"spin"+String(f).padStart(3,"0")+".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg",["-hide_banner","-loglevel","error","-framerate","10",
      "-i",path.join(workspace,"spin%03d.png"),"-y","-c:v","libx264",
      "-pix_fmt","yuv420p",path.join(workspace,"spin.mp4")],
      {timeout:30000,maxBuffer:4096,windowsHide:true});
    const imported=await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace,"spin.mp4")));
    const built=await reconstructMultiObjectStudioVideo(workspace,imported.id);
    const scene=await getMotionProject(workspace,built.projectId);
    const rotation=scene.composition.layers[0].tracks.find(t=>t.property==="rotation");
    expect(rotation).toBeDefined();
    expect(rotation!.keyframes.at(-1)!.value).toBeGreaterThan(18);
    expect(rotation!.keyframes.at(-1)!.value).toBeLessThan(32);
    expect(scene.composition.layers[1].tracks.some(t=>t.property==="rotation")).toBe(false);
    expect(built.parityReport.every(p=>p.foregroundIoU>=.38)).toBe(true);
    const jsx=renderStudioEditableReactComponent(scene);
    expect(jsx).toContain('"property":"rotation"');
    expect(()=>transformSync(jsx,{loader:"tsx",format:"esm"})).not.toThrow();
  },65000);

  it("rejects symmetric and discontinuous orientation tracks instead of fabricating rotation",()=>{
    const baseline={width:54,height:12,principalAngle:0,principalRatio:4.4,
      majorVariance:240,minorVariance:11,centroidX:60,centroidY:40};
    expect(studioBoundedRotationSamples([baseline,{...baseline,principalAngle:5},
      {...baseline,principalAngle:17}])).toEqual([0,5,17]);
    expect(studioBoundedRotationSamples([baseline,{...baseline,principalRatio:1.01,
      principalAngle:10}])).toBeNull();
    expect(studioBoundedRotationSamples([baseline,{...baseline,principalAngle:29}]))
      .toBeNull();
    expect(studioBoundedRotationSamples([{...baseline,width:17,height:17},baseline]))
      .toBeNull();
  });

  it("tracks direction reversals with more than three editable keyframes", async () => {
    const workspace = await ws();
    for (let f = 0; f < 30; f++) {
      const canvas = createCanvas(160, 90);
      const context = canvas.getContext("2d");
      context.fillStyle = "#000";
      context.fillRect(0, 0, 160, 90);
      const oscillating = 20 + Math.round(12 * Math.sin(f * Math.PI / 8));
      context.fillStyle = "#fff";
      context.fillRect(oscillating, 15, 20, 20);
      context.fillStyle = "#ffffaa";
      context.fillRect(105, 50, 20, 18);
      await fs.writeFile(path.join(workspace, "wave" + String(f).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "wave%03d.png"),
      "-y", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(workspace, "wave.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "wave.mp4")));
    const result = await reconstructMultiObjectStudioVideo(workspace, imported.id);
    const project = await getMotionProject(workspace, result.projectId);
    const x = project.composition.layers[0].tracks.find(track => track.property === "x")!
      .keyframes.map(key => key.value);
    expect(x.length).toBeGreaterThan(3);
    const differences = x.slice(1).map((value, i) => value - x[i]);
    expect(differences.some(delta => delta > 3)).toBe(true);
    expect(differences.some(delta => delta < -3)).toBe(true);
    expect(result.interpolationCheckIoU.every(score => score >= .38)).toBe(true);
  }, 65000);

  it("rejects disappearing objects without creating a misleading Studio project", async () => {
    const workspace = await ws();
    for (let f = 0; f < 30; f++) {
      const canvas = createCanvas(160, 90);
      const context = canvas.getContext("2d");
      context.fillStyle = "#000000";
      context.fillRect(0, 0, 160, 90);
      context.fillStyle = "#ffffff";
      context.fillRect(12 + f, 14, 20, 21);
      if (f < 12) {
        context.fillStyle = "#fff2a0";
        context.fillRect(100, 48, 20, 20);
      }
      await fs.writeFile(path.join(workspace, "vanish" + String(f).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "vanish%03d.png"),
      "-y", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path.join(workspace, "vanish.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "vanish.mp4")));
    await expect(reconstructMultiObjectStudioVideo(workspace, imported.id))
      .rejects.toThrow(/object count/);
    expect(await listMotionProjects(workspace)).toEqual([]);
  }, 65000);
  it("fails invalid/missing imported IDs without leaving Studio projects", async () => {
    const workspace = await ws();
    await expect(reconstructMultiObjectStudioVideo(workspace, "../../untrusted.mp4"))
      .rejects.toThrow(/Invalid Motion video ID/);
    await expect(reconstructMultiObjectStudioVideo(workspace, "video-" + "f".repeat(64)))
      .rejects.toThrow();
    expect(await listMotionProjects(workspace)).toEqual([]);
  });
});
