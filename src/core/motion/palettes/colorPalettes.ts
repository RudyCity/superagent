import type { MotionLayer, MotionTrack, RectLayer, MotionProject, MotionEdit } from "../schema/types.js";

export interface MotionPalette {
  id: string;
  name: string;
  description: string;
  background: string;
  cardBackground: string;
  accent: string;
  secondary: string;
  text: string;
  mutedText: string;
}

export const MOTION_PALETTES: Record<string, MotionPalette> = {
  cyber: {
    id: "cyber",
    name: "Cyberpunk Neon",
    description: "High-voltage electric cyan, crimson laser, and deep obsidian dark space",
    background: "#070A13",
    cardBackground: "#0F172A",
    accent: "#00F0FF",
    secondary: "#FF0055",
    text: "#F8FAFC",
    mutedText: "#94A3B8",
  },
  nord: {
    id: "nord",
    name: "Nordic Frost",
    description: "Arctic glacier cyan, soft slate gray, and calm polar midnight",
    background: "#242933",
    cardBackground: "#2E3440",
    accent: "#88C0D0",
    secondary: "#81A1C1",
    text: "#ECEFF4",
    mutedText: "#D8DEE9",
  },
  emerald: {
    id: "emerald",
    name: "Mint Emerald Studio",
    description: "Vibrant emerald green, mint highlight, and deep organic pine obsidian",
    background: "#061A14",
    cardBackground: "#0A2E23",
    accent: "#10B981",
    secondary: "#34D399",
    text: "#ECFDF5",
    mutedText: "#6EE7B7",
  },
  dracula: {
    id: "dracula",
    name: "Dracula Midnight",
    description: "Saturated gothic purple, neon pink rose, and soft vampiric slate",
    background: "#1E1F29",
    cardBackground: "#282A36",
    accent: "#BD93F9",
    secondary: "#FF79C6",
    text: "#F8F8F2",
    mutedText: "#6272A4",
  },
  luxury: {
    id: "luxury",
    name: "Bespoke Champagne Gold",
    description: "Warm royal champagne gold, warm amber glow, and deep bronze charcoal",
    background: "#0C0A09",
    cardBackground: "#1C1917",
    accent: "#D4AF37",
    secondary: "#F59E0B",
    text: "#FAFAF9",
    mutedText: "#A8A29E",
  },
  sunset: {
    id: "sunset",
    name: "Solar Dusk",
    description: "Warm radiant sunset orange, hot electric pink, and twilight purple",
    background: "#180D1B",
    cardBackground: "#2D122D",
    accent: "#F97316",
    secondary: "#EC4899",
    text: "#FFF1F2",
    mutedText: "#FDA4AF",
  },
  monochrome: {
    id: "monochrome",
    name: "Pure Swiss Architectural",
    description: "Timeless black and white high-contrast editorial hierarchy",
    background: "#09090B",
    cardBackground: "#18181B",
    accent: "#F4F4F5",
    secondary: "#A1A1AA",
    text: "#FAFAFA",
    mutedText: "#71717A",
  },
};

export function getMotionPalette(id: string): MotionPalette | undefined {
  return MOTION_PALETTES[id.toLowerCase().trim()];
}

export function listMotionPalettes(): MotionPalette[] {
  return Object.values(MOTION_PALETTES);
}

/**
 * Creates an angled specular sheen reflection highlight layer (Apple / Linear card shimmer)
 * that sweeps across the hero card with a smooth velocity curve.
 */
export function compileSpecularSheenLayer(options: {
  id?: string;
  cardX: number;
  cardY: number;
  cardWidth: number;
  cardHeight: number;
  startFrame: number;
  endFrame: number;
  sheenColor?: string;
  sheenWidth?: number;
  angle?: number;
}): RectLayer {
  const {
    id = "card-specular-sheen",
    cardX,
    cardY,
    cardWidth,
    cardHeight,
    startFrame,
    endFrame,
    sheenColor = "#FFFFFF",
    sheenWidth = 48,
    angle = -20,
  } = options;

  const sweepDistance = cardWidth + 240;
  const startX = cardX - 120;
  const endX = startX + sweepDistance;
  const sweepDuration = Math.max(12, Math.min(30, endFrame - startFrame));

  // The sheen sweeps during the active hold phase
  const sweepStart = startFrame + 10;
  const sweepEnd = sweepStart + sweepDuration;

  const xTrack: MotionTrack = {
    property: "x",
    keyframes: [
      { frame: 0, value: startX },
      { frame: sweepStart, value: startX, easing: "easeOutExpo" },
      { frame: sweepEnd, value: endX, easing: "easeInOut" },
      { frame: endFrame, value: endX },
    ],
  };

  const opacityTrack: MotionTrack = {
    property: "opacity",
    keyframes: [
      { frame: 0, value: 0 },
      { frame: sweepStart, value: 0 },
      { frame: sweepStart + 4, value: 0.18, easing: "linear" },
      { frame: sweepEnd - 6, value: 0.18, easing: "linear" },
      { frame: sweepEnd, value: 0 },
      { frame: endFrame, value: 0 },
    ],
  };

  return {
    id,
    kind: "rect",
    x: startX,
    y: cardY - 20,
    width: sheenWidth,
    height: cardHeight + 40,
    cornerRadius: 4,
    rotation: angle,
    opacity: 0,
    fill: sheenColor,
    tracks: [xTrack, opacityTrack],
  };
}

/**
 * Applies a curated design palette across an existing MotionProject composition.
 */
export function applyPaletteToComposition(
  project: MotionProject,
  paletteName: string,
): MotionProject {
  const palette = getMotionPalette(paletteName);
  if (!palette) {
    throw new Error(`Unknown motion palette '${paletteName}'. Available: ${Object.keys(MOTION_PALETTES).join(", ")}`);
  }

  const comp = project.composition;
  const updatedLayers = comp.layers.map(layer => {
    // Background / Canvas
    if (layer.id.includes("ambient-glow") || layer.id.includes("glow")) {
      return { ...layer, fill: palette.accent };
    }
    if (layer.id.includes("hero-card") || layer.id.includes("card-bg")) {
      return { ...layer, fill: palette.cardBackground };
    }
    if (layer.id.includes("timeline-runner") || layer.id.includes("accent-strip") || layer.id.includes("pill-bg")) {
      return { ...layer, fill: palette.accent };
    }
    if (layer.id.includes("kicker") || layer.id.includes("status-pill") || layer.id.includes("chip")) {
      return { ...layer, fill: palette.secondary };
    }
    if (layer.kind === "text") {
      if (layer.id.includes("title")) {
        return { ...layer, fill: palette.text };
      }
      if (layer.id.includes("subtitle")) {
        return { ...layer, fill: palette.mutedText };
      }
    }
    return layer;
  });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    composition: {
      ...comp,
      background: palette.background,
      layers: updatedLayers,
    },
  };
}
