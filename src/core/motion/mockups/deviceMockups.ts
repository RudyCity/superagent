import type { MotionLayer, MotionTrack, RectLayer, TextLayer, MotionProject, MotionEdit } from "../schema/types.js";

export type DeviceType = "macbook" | "iphone" | "browser";

export interface DeviceMockupPreset {
  id: DeviceType;
  name: string;
  description: string;
  aspectRatio: string;
  defaultWidth: number;
  defaultHeight: number;
}

export const DEVICE_PRESETS: DeviceMockupPreset[] = [
  {
    id: "macbook",
    name: "MacBook Pro Aluminum",
    description: "Sleek dark titanium display lid, camera notch, base hinge lip, and glass reflection",
    aspectRatio: "16:10",
    defaultWidth: 1080,
    defaultHeight: 675,
  },
  {
    id: "iphone",
    name: "iPhone Pro Titanium",
    description: "Curved smartphone chassis, Dynamic Island pill, home indicator bar, and floating tilt",
    aspectRatio: "9:19.5",
    defaultWidth: 420,
    defaultHeight: 880,
  },
  {
    id: "browser",
    name: "Modern Browser Viewport",
    description: "Clean Arc/Chrome window chrome, macOS traffic lights, and secure HTTPS pill bar",
    aspectRatio: "16:9",
    defaultWidth: 1120,
    defaultHeight: 680,
  },
];

export interface DeviceMockupOptions {
  device: DeviceType;
  x: number;
  y: number;
  width: number;
  height: number;
  startFrame: number;
  endFrame: number;
  title?: string;
  url?: string;
  accentColor?: string;
  screenColor?: string;
  parallaxTilt?: boolean;
}

function cleanKeyframes(
  raw: { frame: number; value: number; easing?: any }[],
  maxAllowedFrame: number,
): { frame: number; value: number; easing?: any }[] {
  const bounded = raw
    .map(k => ({ ...k, frame: Math.max(0, Math.min(maxAllowedFrame, Math.round(k.frame))) }))
    .sort((a, b) => a.frame - b.frame);
  const result: { frame: number; value: number; easing?: any }[] = [];
  for (const k of bounded) {
    if (result.length > 0 && result[result.length - 1].frame === k.frame) {
      result[result.length - 1] = k;
    } else {
      result.push(k);
    }
  }
  return result.length > 0 ? result : [{ frame: 0, value: 0 }];
}

export function listDeviceMockups(): DeviceMockupPreset[] {
  return [...DEVICE_PRESETS];
}

/**
 * Compiles a rich 3D perspective device mockup with multi-layer depth,
 * hardware bezels, glass reflection sheen, and cinematic parallax tilt kinetics.
 */
export function compileDeviceMockupLayers(options: DeviceMockupOptions): MotionLayer[] {
  const {
    device,
    x,
    y,
    width,
    height,
    startFrame,
    endFrame: rawEndFrame,
    title = "Superagent Desktop",
    url = "https://superagent.local",
    accentColor = "#38BDF8",
    screenColor = "#090D16",
    parallaxTilt = true,
  } = options;

  const endFrame = Math.max(startFrame + 8, rawEndFrame);
  const layers: MotionLayer[] = [];

  // Visibility and entrance tracks
  const opacityKeys = cleanKeyframes([
    { frame: 0, value: 0 },
    { frame: startFrame, value: 0 },
    { frame: Math.min(endFrame, startFrame + 6), value: 1, easing: "easeOutExpo" },
    { frame: Math.max(startFrame, endFrame - 6), value: 1 },
    { frame: endFrame, value: 0 },
  ], endFrame);

  const scaleKeys = parallaxTilt
    ? cleanKeyframes([
        { frame: 0, value: 0.9 },
        { frame: startFrame, value: 0.9 },
        { frame: Math.min(endFrame, startFrame + 18), value: 1.0, easing: "easeOutExpo" },
        { frame: endFrame, value: 1.02 },
      ], endFrame)
    : cleanKeyframes([
        { frame: 0, value: 0.96 },
        { frame: startFrame, value: 0.96 },
        { frame: Math.min(endFrame, startFrame + 10), value: 1.0, easing: "easeOutExpo" },
        { frame: endFrame, value: 1.0 },
      ], endFrame);

  const rotationKeys = parallaxTilt
    ? cleanKeyframes([
        { frame: 0, value: -3 },
        { frame: startFrame, value: -3 },
        { frame: Math.min(endFrame, startFrame + 22), value: 0, easing: "easeOutBack" },
        { frame: Math.min(endFrame, startFrame + 50), value: 0.6, easing: "easeInOut" },
        { frame: endFrame, value: 0 },
      ], endFrame)
    : cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: endFrame, value: 0 },
      ], endFrame);

  // 1. Ambient Diffuse Shadow (Backdrop depth)
  layers.push({
    id: `mockup-${device}-shadow-diffuse`,
    kind: "rect",
    x: x - 12,
    y: y + 24,
    width: width + 24,
    height: height + 16,
    cornerRadius: device === "iphone" ? 48 : 20,
    rotation: 0,
    opacity: 0.45,
    fill: "#000000",
    tracks: [
      { property: "opacity", keyframes: opacityKeys },
      { property: "scale", keyframes: scaleKeys },
      { property: "rotation", keyframes: rotationKeys },
    ],
  });

  // 2. Hardware Chassis Frame
  if (device === "macbook") {
    // MacBook Screen Lid Frame
    const lidHeight = height - 24;
    layers.push({
      id: "mockup-macbook-lid",
      kind: "rect",
      x,
      y,
      width,
      height: lidHeight,
      cornerRadius: 16,
      rotation: 0,
      opacity: 1,
      fill: "#18181B",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Screen Display Bezel Container
    const bezelInset = 16;
    layers.push({
      id: "mockup-macbook-screen",
      kind: "rect",
      x: x + bezelInset,
      y: y + bezelInset,
      width: width - bezelInset * 2,
      height: lidHeight - bezelInset * 2,
      cornerRadius: 6,
      rotation: 0,
      opacity: 1,
      fill: screenColor,
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Camera Notch Dot
    layers.push({
      id: "mockup-macbook-camera",
      kind: "rect",
      x: x + Math.round(width / 2) - 4,
      y: y + 6,
      width: 8,
      height: 8,
      cornerRadius: 4,
      rotation: 0,
      opacity: 0.8,
      fill: "#27272A",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Bottom Base Keyboard Lip
    layers.push({
      id: "mockup-macbook-base",
      kind: "rect",
      x: x - 18,
      y: y + lidHeight - 2,
      width: width + 36,
      height: 18,
      cornerRadius: 6,
      rotation: 0,
      opacity: 1,
      fill: "#27272A",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Thumb notch on base
    layers.push({
      id: "mockup-macbook-thumb-notch",
      kind: "rect",
      x: x + Math.round(width / 2) - 36,
      y: y + lidHeight + 2,
      width: 72,
      height: 5,
      cornerRadius: 2,
      rotation: 0,
      opacity: 0.8,
      fill: "#09090B",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

  } else if (device === "iphone") {
    // iPhone Outer Chassis
    layers.push({
      id: "mockup-iphone-chassis",
      kind: "rect",
      x,
      y,
      width,
      height,
      cornerRadius: 44,
      rotation: 0,
      opacity: 1,
      fill: "#1E1E24",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // iPhone Inner Screen Viewport
    const bezel = 12;
    layers.push({
      id: "mockup-iphone-screen",
      kind: "rect",
      x: x + bezel,
      y: y + bezel,
      width: width - bezel * 2,
      height: height - bezel * 2,
      cornerRadius: 36,
      rotation: 0,
      opacity: 1,
      fill: screenColor,
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Dynamic Island Pill
    const islandWidth = 104;
    const islandHeight = 28;
    layers.push({
      id: "mockup-iphone-island",
      kind: "rect",
      x: x + Math.round((width - islandWidth) / 2),
      y: y + bezel + 10,
      width: islandWidth,
      height: islandHeight,
      cornerRadius: 14,
      rotation: 0,
      opacity: 1,
      fill: "#000000",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Bottom Home Indicator Bar
    const barWidth = 120;
    layers.push({
      id: "mockup-iphone-home-bar",
      kind: "rect",
      x: x + Math.round((width - barWidth) / 2),
      y: y + height - bezel - 14,
      width: barWidth,
      height: 4,
      cornerRadius: 2,
      rotation: 0,
      opacity: 0.6,
      fill: "#64748B",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

  } else {
    // Browser Window Mockup
    layers.push({
      id: "mockup-browser-window",
      kind: "rect",
      x,
      y,
      width,
      height,
      cornerRadius: 12,
      rotation: 0,
      opacity: 1,
      fill: screenColor,
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Browser Header / Titlebar
    const headerHeight = 44;
    layers.push({
      id: "mockup-browser-header",
      kind: "rect",
      x,
      y,
      width,
      height: headerHeight,
      cornerRadius: 12,
      rotation: 0,
      opacity: 1,
      fill: "#182030",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Traffic light buttons
    const dotColors = ["#EF4444", "#F59E0B", "#10B981"];
    dotColors.forEach((color, i) => {
      layers.push({
        id: `mockup-browser-dot-${i + 1}`,
        kind: "rect",
        x: x + 16 + i * 18,
        y: y + 17,
        width: 10,
        height: 10,
        cornerRadius: 5,
        rotation: 0,
        opacity: 0.9,
        fill: color,
        tracks: [
          { property: "opacity", keyframes: opacityKeys },
          { property: "scale", keyframes: scaleKeys },
          { property: "rotation", keyframes: rotationKeys },
        ],
      });
    });

    // URL Search Pill Bar
    const pillWidth = Math.min(width - 240, 480);
    const pillX = x + Math.round((width - pillWidth) / 2);
    layers.push({
      id: "mockup-browser-url-pill",
      kind: "rect",
      x: pillX,
      y: y + 8,
      width: pillWidth,
      height: 28,
      cornerRadius: 6,
      rotation: 0,
      opacity: 0.95,
      fill: "#0B0F19",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // Lock icon / SSL indicator dot
    layers.push({
      id: "mockup-browser-lock-dot",
      kind: "rect",
      x: pillX + 12,
      y: y + 19,
      width: 6,
      height: 6,
      cornerRadius: 3,
      rotation: 0,
      opacity: 0.8,
      fill: "#10B981",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });

    // URL Text
    layers.push({
      id: "mockup-browser-url-text",
      kind: "text",
      text: url,
      x: pillX + 26,
      y: y + 14,
      width: pillWidth - 40,
      height: 18,
      rotation: 0,
      opacity: 0.85,
      fill: "#94A3B8",
      fontSize: 12,
      fontFamily: "JetBrains Mono",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });
  }

  // 3. Diagonal Specular Glass Reflection Sheen
  const sheenKeys = cleanKeyframes([
    { frame: 0, value: 0 },
    { frame: startFrame + 6, value: 0 },
    { frame: startFrame + 18, value: 0.12, easing: "easeOutExpo" },
    { frame: Math.min(endFrame, startFrame + 36), value: 0 },
    { frame: endFrame, value: 0 },
  ], endFrame);

  layers.push({
    id: `mockup-${device}-glass-sheen`,
    kind: "rect",
    x: x + Math.round(width * 0.15),
    y: y + 12,
    width: Math.round(width * 0.4),
    height: height - 40,
    cornerRadius: 8,
    rotation: 20,
    opacity: 0.08,
    fill: "#FFFFFF",
    tracks: [
      { property: "opacity", keyframes: sheenKeys },
      { property: "scale", keyframes: scaleKeys },
      { property: "rotation", keyframes: rotationKeys },
    ],
  });

  // 4. Hero Title Header Label inside device screen
  if (title) {
    const titleY = device === "browser" ? y + 64 : y + 36;
    layers.push({
      id: `mockup-${device}-title-txt`,
      kind: "text",
      text: title,
      x: x + 36,
      y: titleY,
      width: width - 72,
      height: 32,
      rotation: 0,
      opacity: 1,
      fill: accentColor,
      fontSize: 18,
      fontFamily: "Inter",
      tracks: [
        { property: "opacity", keyframes: opacityKeys },
        { property: "scale", keyframes: scaleKeys },
        { property: "rotation", keyframes: rotationKeys },
      ],
    });
  }

  return layers;
}

/**
 * Attaches a 3D perspective device mockup frame to an existing MotionProject.
 */
export async function attachDeviceMockupToProject(
  workspace: string,
  project: MotionProject,
  options: {
    device?: DeviceType;
    title?: string;
    url?: string;
    accentColor?: string;
    parallaxTilt?: boolean;
  } = {},
): Promise<{ edits: MotionEdit[]; layerCount: number; deviceType: DeviceType }> {
  const comp = project.composition;
  const device = options.device ?? "macbook";
  const startFrame = 0;
  const endFrame = comp.durationFrames - 1;

  let width = Math.min(comp.width - 120, 1080);
  let height = Math.min(comp.height - 120, 680);
  if (device === "iphone") {
    width = Math.min(comp.width - 80, 420);
    height = Math.min(comp.height - 80, 880);
  }

  const x = Math.round((comp.width - width) / 2);
  const y = Math.round((comp.height - height) / 2);

  const mockupLayers = compileDeviceMockupLayers({
    device,
    x,
    y,
    width,
    height,
    startFrame,
    endFrame,
    title: options.title ?? project.name,
    url: options.url,
    accentColor: options.accentColor,
    parallaxTilt: options.parallaxTilt ?? true,
  });

  const edits: MotionEdit[] = mockupLayers.map(layer => ({
    type: "add-layer",
    layer,
  }));

  return { edits, layerCount: mockupLayers.length, deviceType: device };
}
