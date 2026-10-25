import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { renderStudioEditableReactComponent } from "../src/core/motion/code/studioEditableReactExporter.js";
import { renderStudioReactComponent } from "../src/core/motion/code/studioReactCodeExporter.js";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import type { MotionProject, PathLayer, TextLayer } from "../src/core/motion/schema/types.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";

function project(): MotionProject {
  const now = "2026-10-25T00:00:00.000Z";
  return {
    schemaVersion: 1, id: "studio-" + "a".repeat(20), revision: 2, name: "Reconstruction <safe>",
    workspaceRoot: "D:/fake/reconstruction", createdAt: now, updatedAt: now,
    composition: {
      width: 640, height: 360, background: "#121522",
      fps: { numerator: 30, denominator: 1 }, durationFrames: 90,
      layers: [
        {
          id: "shape-1", kind: "path", x: 25, y: 30, width: 40, height: 40,
          opacity: 1, rotation: 0, fill: "#ffaadd",
          d: "M0 0 L40 0 L40 40 Z", stroke: "#ffffff", strokeWidth: 2,
          strokeDasharray: [4, 2], strokeDashoffset: 1, tracks: [
            { property: "x", keyframes: [
              { frame: 0, value: 25 }, { frame: 60, value: 200, easing: "linear" },
            ] },
          ],
        },
        {
          id: "caption-2", kind: "text", x: 100, y: 100, width: 300, height: 55,
          opacity: 1, rotation: 0, fill: "#fafafa", fontSize: 48,
          fontFamily: "Arial", text: "</text><script>alert('oops')</script>",
          tracks: [{ property: "opacity", keyframes: [
            { frame: 0, value: 0, easing: "step" },
            { frame: 30, value: 1, easing: "step" },
            { frame: 60, value: 0, easing: "step" },
          ] }],
        } satisfies TextLayer,
        {
          id: "rect-3", kind: "rect", x: 320, y: 140, width: 88, height: 54,
          opacity: .8, rotation: 15, fill: "#ffcc22", cornerRadius: 8, tracks: [],
        },
      ],
    },
  };
}

describe("Video-to-Code: native editable React JSX output", () => {
  it.each(["autoplay", "click", "hover", "scroll"] as const)(
    "produces standalone direct SVG source with supported %s controls", trigger => {
      const source = renderStudioEditableReactComponent(project(), trigger);
      expect(source).toMatch(/^"use client";/);
      expect(source).toContain("<svg");
      expect(source).toContain("<path");
      expect(source).toContain("<text");
      expect(source).toContain("<rect");
      expect(source).toContain('data-studio-id={"shape-1"}');
      expect(source).toContain('data-studio-id={"caption-2"}');
      expect(source).toContain('data-studio-id={"rect-3"}');
      expect(source).not.toContain("<iframe");
      expect(source).not.toContain("srcDoc");
      expect(source).not.toContain("dangerouslySetInnerHTML");
      expect(source).not.toContain("cdn.jsdelivr.net");
      const output = transformSync(source, { loader: "tsx", format: "esm", jsx: "automatic" });
      expect(output.code).toContain("studio-stage");
      expect(output.code).not.toContain("iframe");
      expect(output.code).toContain("requestAnimationFrame");
    },
  );

  it("preserves vector positions, x/y tracks and OCR step-visibility while escaping unsafe user text", () => {
    const source = renderStudioEditableReactComponent(project());
    const nativeFrame = evaluateFrame(project(), 45);
    const shapeX = nativeFrame.layers[0].values.x;
    expect(shapeX).toBeCloseTo(156.25, 1);
    const match = source.match(/const SCENE_LAYERS: StudioLayer\[\] = (\[.*\]);/);
    expect(match).not.toBeNull();
    const layers = JSON.parse(match![1]) as Array<{
      id: string; tracks: Array<{property: string; keyframes: Array<{frame:number;value:number;easing?:string}>}>;
    }>;
    expect(layers[0].tracks[0].keyframes).toHaveLength(2);
    expect(layers[1].tracks[0].keyframes.map(frame => frame.value)).toEqual([0, 1, 0]);
    expect(source).not.toContain("</text><script>");
    expect(source).not.toContain("<script>alert");
    expect(source).toContain("\\u003c/script\\u003e");
    expect(() => transformSync(source, { loader: "tsx", format: "esm" })).not.toThrow();
    expect(source).toContain('strokeDashoffset={layer0.strokeDashoffset}');
    expect(source).toContain('rx={8}');
  });

  it("keeps iframe adapter backwards-compatible and fails closed for unsupported media or graph", () => {
    const before = renderStudioReactComponent(project());
    expect(before).toContain('sandbox="allow-scripts"');
    const original = project();
    original.composition.audioTracks = [{
      assetId: "audio-" + "a".repeat(64), startFrame: 0, volume: 1,
    }];
    expect(() => renderStudioEditableReactComponent(original)).toThrow(/does not embed audio/);
    const unsupported = project();
    unsupported.composition.layers[0] = {
      ...unsupported.composition.layers[0], kind: "image",
      assetId: "asset-" + "a".repeat(64),
    } as any;
    expect(() => renderStudioEditableReactComponent(unsupported)).toThrow();
    const graph = project();
    graph.composition.interactionGraph = {
      version: 1, bindings: [{
        id: "on-ready", event: "ready", action: "replay", target: "stage",
      }],
    };
    expect(() => renderStudioEditableReactComponent(graph)).toThrow(/Interaction Graph/);
  });
});
