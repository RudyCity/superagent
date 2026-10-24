import type { MotionLayer, MotionComposition, MotionProject } from "../schema/types.js";
import { createMotionProject, updateMotionProject } from "../project/projectStore.js";
import { startDetachedMotionJob, type MotionJob } from "../jobs/motionJobs.js";
import { compileDeviceMockupLayers } from "../mockups/deviceMockups.js";
import { compileCodeCardLayers } from "../code/codeCardCompiler.js";
import { compileMotionChartLayers } from "../charts/motionCharts.js";
import { compileSpecularSheenLayer, applyPaletteToComposition, type MotionPalette } from "../palettes/colorPalettes.js";
import { choreographSceneLayers } from "../choreography/choreographyEngine.js";
import { applyInertialCameraMotion } from "../camera/camera3d.js";
import { synthesizeSpeechWav, autoFitCompositionToVoiceover, compileVoiceoverBurnInSubtitles } from "../voiceover/voiceoverService.js";
import { importMotionAudio } from "../assets/motionAudio.js";

export interface SaaSPromoOptions {
  productName?: string;
  tagline?: string;
  palette?: string;
  device?: "macbook" | "iphone" | "browser";
  codeSnippet?: string;
  width?: number;
  height?: number;
  voiceover?: boolean | string;
  installCommand?: string;
}

/**
 * Generates an end-to-end 4-Act SaaS product promo video following the
 * Linear/Raycast/Apple motion design formula:
 *
 * Act 1: The Hook (0-4s) - Terminal speed & pain point resolution
 * Act 2: The Core Engine (4-14s) - MacBook mockup & syntax typing kinetics
 * Act 3: Telemetry & Proof (14-24s) - Animated benchmark comparison bars
 * Act 4: The Resolution & CTA (24-30s) - Clean brand mark & installation command
 */
export async function generateSaaSPromo(
  workspace: string,
  options: SaaSPromoOptions = {},
): Promise<{ project: MotionProject; job: MotionJob }> {
  const productName = options.productName ?? "Superagent";
  const tagline = options.tagline ?? "Next-Gen Autonomous AI Coding Assistant";
  const paletteId = options.palette ?? "emerald";
  const deviceType = options.device ?? "macbook";
  const installCmd = options.installCommand ?? "npm install -g superagent";
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const fps = { numerator: 30, denominator: 1 };

  // Base 4-Act timing structure (30 seconds = 900 frames at 30fps)
  const act1Frames = 120;  // 0-4s
  const act2Frames = 270;  // 4-13s
  const act3Frames = 270;  // 13-22s
  const act4Frames = 240;  // 22-30s
  const totalFrames = act1Frames + act2Frames + act3Frames + act4Frames; // 900 frames

  const accentColor = "#10B981";
  const layers: MotionLayer[] = [];

  // 1. Persistent Living Background Atmosphere (Z = -200)
  const auraW = Math.round(width * 0.7);
  const auraH = Math.round(height * 0.76);
  const auraR = Math.floor(Math.min(auraW, auraH) / 2);
  layers.push({
    id: "global-living-aura",
    kind: "rect",
    x: Math.round(width * 0.15),
    y: Math.round(height * 0.12),
    width: auraW,
    height: auraH,
    cornerRadius: auraR,
    rotation: 0,
    opacity: 0.09,
    fill: accentColor,
    tracks: [
      {
        property: "scale",
        keyframes: [
          { frame: 0, value: 0.95 },
          { frame: Math.round(totalFrames * 0.3), value: 1.12, easing: "easeInOut" },
          { frame: Math.round(totalFrames * 0.65), value: 0.98, easing: "easeInOut" },
          { frame: totalFrames - 1, value: 1.05 },
        ],
      },
      {
        property: "rotation",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: totalFrames - 1, value: 36, easing: "linear" },
        ],
      },
    ],
  });

  // Top Cinematic Timeline Runner (3px laser progress line)
  layers.push({
    id: "global-timeline-laser",
    kind: "rect",
    x: 0,
    y: 0,
    width,
    height: 3,
    cornerRadius: 0,
    rotation: 0,
    opacity: 0.85,
    fill: accentColor,
    tracks: [
      {
        property: "scaleX",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: totalFrames - 1, value: 1.0, easing: "linear" },
        ],
      },
      {
        property: "x",
        keyframes: [
          { frame: 0, value: -width * 0.5 },
          { frame: totalFrames - 1, value: 0, easing: "linear" },
        ],
      },
    ],
  });

  // ==========================================
  // ACT 1: THE HOOK (0 - 120 frames)
  // ==========================================
  const hookPrompt = `$ ${productName.toLowerCase()} --multi --autonomous`;
  layers.push({
    id: "act1-hook-container",
    kind: "rect",
    x: Math.round(width * 0.2),
    y: Math.round(height * 0.32),
    width: Math.round(width * 0.6),
    height: Math.round(height * 0.36),
    cornerRadius: 20,
    rotation: 0,
    opacity: 1,
    fill: "#0B131F",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 6, value: 1, easing: "apple" },
          { frame: 112, value: 1 },
          { frame: 120, value: 0, easing: "easeInOut" },
        ],
      },
      {
        property: "scale",
        keyframes: [
          { frame: 0, value: 0.92 },
          { frame: 14, value: 1.0, easing: "apple" },
          { frame: 120, value: 1.03 },
        ],
      },
    ],
  });

  layers.push({
    id: "act1-command-chip",
    kind: "text",
    text: hookPrompt,
    x: Math.round(width * 0.24),
    y: Math.round(height * 0.38),
    width: Math.round(width * 0.52),
    height: 32,
    rotation: 0,
    opacity: 1,
    fill: accentColor,
    fontSize: 22,
    fontFamily: "JetBrains Mono",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 10, value: 1, easing: "apple" },
          { frame: 112, value: 1 },
          { frame: 120, value: 0 },
        ],
      },
    ],
  });

  layers.push({
    id: "act1-hero-headline",
    kind: "text",
    text: tagline,
    x: Math.round(width * 0.24),
    y: Math.round(height * 0.46),
    width: Math.round(width * 0.52),
    height: 48,
    rotation: 0,
    opacity: 1,
    fill: "#F8FAFC",
    fontSize: 34,
    fontFamily: "Space Grotesk",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 16, value: 1, easing: "apple" },
          { frame: 112, value: 1 },
          { frame: 120, value: 0 },
        ],
      },
    ],
  });

  // ==========================================
  // ACT 2: THE CORE ENGINE (120 - 390 frames)
  // ==========================================
  const act2Start = 120;
  const act2End = 390;

  const codeString = options.codeSnippet ??
`import { superagent } from "superagent";

const master = await superagent.spawn({
  mode: "multi",
  workers: 4,
  isolation: "worktree",
});
await master.execute("Architect & Deploy");`;

  const mockupLayers = compileDeviceMockupLayers({
    device: deviceType,
    x: Math.round(width * 0.16),
    y: Math.round(height * 0.14),
    width: Math.round(width * 0.68),
    height: Math.round(height * 0.72),
    startFrame: act2Start,
    endFrame: act2End,
    title: `${productName} Autonomous Orchestration`,
    accentColor,
    parallaxTilt: true,
  });

  const codeCardLayers = compileCodeCardLayers({
    code: codeString,
    filename: "masterAgent.ts",
    language: "TypeScript",
    x: Math.round(width * 0.22),
    y: Math.round(height * 0.26),
    width: Math.round(width * 0.56),
    height: Math.round(height * 0.48),
    startFrame: act2Start + 8,
    endFrame: act2End - 8,
    accentColor,
  });

  layers.push(...mockupLayers, ...codeCardLayers);

  // ==========================================
  // ACT 3: TELEMETRY & PROOF (390 - 660 frames)
  // ==========================================
  const act3Start = 390;
  const act3End = 660;

  const chartLayers = compileMotionChartLayers({
    type: "benchmark",
    x: Math.round(width * 0.18),
    y: Math.round(height * 0.2),
    width: Math.round(width * 0.64),
    height: Math.round(height * 0.6),
    startFrame: act3Start,
    endFrame: act3End,
    title: "Autonomous Velocity Telemetry",
    subtitle: "End-to-End Feature Execution Speed",
    accentColor,
    items: [
      { label: `${productName} 3-Tier Multi-Agent`, value: 0.38, displayValue: "0.38s (7x Faster ⚡)", isHero: true, accent: accentColor },
      { label: "Traditional Monolithic Assistant", value: 2.75, displayValue: "2.75s", accent: "#64748B" },
      { label: "Sequential Single-Thread Agent", value: 3.90, displayValue: "3.90s", accent: "#475569" },
    ],
  });

  layers.push(...chartLayers);

  // ==========================================
  // ACT 4: THE RESOLUTION & CTA (660 - 900 frames)
  // ==========================================
  const act4Start = 660;
  const act4End = totalFrames - 1;

  // Final Hero CTA Card
  const ctaWidth = Math.round(width * 0.54);
  const ctaHeight = Math.round(height * 0.44);
  const ctaX = Math.round((width - ctaWidth) / 2);
  const ctaY = Math.round((height - ctaHeight) / 2);

  layers.push({
    id: "act4-cta-card",
    kind: "rect",
    x: ctaX,
    y: ctaY,
    width: ctaWidth,
    height: ctaHeight,
    cornerRadius: 24,
    rotation: 0,
    opacity: 1,
    fill: "#0B111E",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: act4Start, value: 0 },
          { frame: act4Start + 8, value: 1, easing: "apple" },
          { frame: act4End, value: 1 },
        ],
      },
      {
        property: "scale",
        keyframes: [
          { frame: 0, value: 0.94 },
          { frame: act4Start, value: 0.94 },
          { frame: act4Start + 16, value: 1.0, easing: "apple" },
          { frame: act4End, value: 1.01 },
        ],
      },
    ],
  });

  // Brand Headline
  layers.push({
    id: "act4-brand-headline",
    kind: "text",
    text: productName.toUpperCase(),
    x: ctaX + 48,
    y: ctaY + 48,
    width: ctaWidth - 96,
    height: 52,
    rotation: 0,
    opacity: 1,
    fill: "#FFFFFF",
    fontSize: 44,
    fontFamily: "Space Grotesk",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: act4Start + 10, value: 1, easing: "apple" },
          { frame: act4End, value: 1 },
        ],
      },
    ],
  });

  // Tagline
  layers.push({
    id: "act4-brand-sub",
    kind: "text",
    text: "Experience the next standard of autonomous developer acceleration.",
    x: ctaX + 48,
    y: ctaY + 112,
    width: ctaWidth - 96,
    height: 28,
    rotation: 0,
    opacity: 0.85,
    fill: "#94A3B8",
    fontSize: 18,
    fontFamily: "Inter",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: act4Start + 14, value: 0.85, easing: "apple" },
          { frame: act4End, value: 0.85 },
        ],
      },
    ],
  });

  // Install Command Pill
  const pillW = Math.min(ctaWidth - 96, 440);
  layers.push({
    id: "act4-install-pill",
    kind: "rect",
    x: ctaX + 48,
    y: ctaY + 168,
    width: pillW,
    height: 48,
    cornerRadius: 12,
    rotation: 0,
    opacity: 0.95,
    fill: "#102336",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: act4Start + 18, value: 0.95, easing: "apple" },
          { frame: act4End, value: 0.95 },
        ],
      },
    ],
  });

  layers.push({
    id: "act4-install-txt",
    kind: "text",
    text: `$ ${installCmd}`,
    x: ctaX + 68,
    y: ctaY + 182,
    width: pillW - 40,
    height: 22,
    rotation: 0,
    opacity: 1,
    fill: accentColor,
    fontSize: 16,
    fontFamily: "JetBrains Mono",
    tracks: [
      {
        property: "opacity",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: act4Start + 22, value: 1, easing: "apple" },
          { frame: act4End, value: 1 },
        ],
      },
    ],
  });

  // Specular Sheen Sweep across CTA card
  const ctaSheen = compileSpecularSheenLayer({
    cardX: ctaX,
    cardY: ctaY,
    cardWidth: ctaWidth,
    cardHeight: ctaHeight,
    startFrame: act4Start + 20,
    endFrame: act4Start + 70,
  });
  layers.push(ctaSheen);

  // Apply Cascade Choreography & Inertial 3D Camera Mechanics
  const choreographed = choreographSceneLayers(layers, {
    staggerIntervalFrames: 3,
    defaultEasing: "apple",
    applyMicroDrift: true,
    durationFrames: totalFrames,
  });

  const withCameraMotion = applyInertialCameraMotion(choreographed, "cinematic-push", {
    durationFrames: totalFrames,
    intensity: 0.8,
  });

  let composition: MotionComposition = {
    width,
    height,
    fps,
    durationFrames: totalFrames,
    background: "#061A14",
    layers: withCameraMotion,
  };

  // Apply Palette Preset
  const dummyProject = {
    schemaVersion: 1 as const,
    id: "temp",
    workspaceRoot: workspace,
    name: `${productName} SaaS Promo`,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    composition,
  };
  composition = applyPaletteToComposition(dummyProject, paletteId).composition;

  // Synthesize Autonomous AI Voiceover if requested
  if (options.voiceover) {
    const narrationScript =
      `Introducing ${productName}. ${tagline}. Orchestrate autonomous parallel agents inside isolated worktrees with instant speed. Validated 7x faster than legacy tools. Get started with ${installCmd}.`;

    const voice = typeof options.voiceover === "string" ? options.voiceover : undefined;
    const wavBytes = await synthesizeSpeechWav(narrationScript, { voiceName: voice, tryEdgeTts: true });
    const audioAsset = await importMotionAudio(workspace, wavBytes);

    // Auto-fit timeline to audio duration
    composition = autoFitCompositionToVoiceover(composition, wavBytes.length / (16000 * 2));
    const voiceTrack = {
      assetId: audioAsset.id,
      startFrame: 0,
      volume: 1.0,
      role: "voiceover" as const,
    };
    composition.audioTracks = [voiceTrack];

    // Burn-in subtitles
    const subs = compileVoiceoverBurnInSubtitles(
      narrationScript,
      composition.width,
      composition.height,
      0,
      composition.durationFrames - 1,
      accentColor,
    );
    composition.layers.push(...subs);
  }

  // Commit Project to Store
  const project = await createMotionProject(workspace, `${productName} SaaS Promo`);
  const updatedProject = await updateMotionProject(workspace, project.id, project.revision, [
    { type: "replace-composition", composition },
  ]);

  // Dispatch detached render job
  const job = await startDetachedMotionJob(workspace, updatedProject.id, { width: Math.min(width, 1080) });

  return { project: updatedProject, job };
}
