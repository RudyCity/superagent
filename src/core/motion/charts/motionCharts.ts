import type { MotionLayer, MotionTrack, RectLayer, TextLayer, PathLayer, MotionProject, MotionEdit } from "../schema/types.js";

export type MotionChartType = "benchmark" | "kpi" | "radial" | "sparkline";

export interface BenchmarkItem {
  label: string;
  value: number;
  displayValue?: string;
  accent?: string;
  isHero?: boolean;
}

export interface MotionChartOptions {
  type: MotionChartType;
  x: number;
  y: number;
  width: number;
  height: number;
  startFrame: number;
  endFrame: number;
  title?: string;
  subtitle?: string;
  items?: BenchmarkItem[];
  kpiValue?: string;
  kpiLabel?: string;
  kpiBadge?: string;
  progressPercent?: number;
  sparklineData?: number[];
  accentColor?: string;
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

/**
 * Compiles animated data visualization layers (benchmark comparison bars,
 * KPI counter cards, radial progress rings, or sparkline graphs).
 */
export function compileMotionChartLayers(options: MotionChartOptions): MotionLayer[] {
  const {
    type,
    x,
    y,
    width,
    height,
    startFrame,
    endFrame: rawEndFrame,
    title = "Performance Telemetry",
    subtitle = "Autonomous Execution Benchmarks",
    accentColor = "#38BDF8",
  } = options;

  const endFrame = Math.max(startFrame + 10, rawEndFrame);
  const layers: MotionLayer[] = [];

  // Card entrance tracks
  const cardOpacity = cleanKeyframes([
    { frame: 0, value: 0 },
    { frame: startFrame, value: 0 },
    { frame: Math.min(endFrame, startFrame + 6), value: 1, easing: "easeOutExpo" },
    { frame: Math.max(startFrame, endFrame - 6), value: 1 },
    { frame: endFrame, value: 0 },
  ], endFrame);

  const cardScale = cleanKeyframes([
    { frame: 0, value: 0.94 },
    { frame: startFrame, value: 0.94 },
    { frame: Math.min(endFrame, startFrame + 12), value: 1.0, easing: "easeOutBack" },
    { frame: endFrame, value: 1.0 },
  ], endFrame);

  // 1. Chart Container Card (Glassmorphism dark container)
  layers.push({
    id: `chart-${type}-card-bg`,
    kind: "rect",
    x,
    y,
    width,
    height,
    cornerRadius: 16,
    rotation: 0,
    opacity: 1,
    fill: "#0B101D",
    tracks: [
      { property: "opacity", keyframes: cardOpacity },
      { property: "scale", keyframes: cardScale },
    ],
  });

  // Card Header: Title
  layers.push({
    id: `chart-${type}-title-txt`,
    kind: "text",
    text: title,
    x: x + 28,
    y: y + 24,
    width: width - 56,
    height: 28,
    rotation: 0,
    opacity: 1,
    fill: "#F8FAFC",
    fontSize: 20,
    fontFamily: "Inter",
    tracks: [
      { property: "opacity", keyframes: cardOpacity },
      { property: "scale", keyframes: cardScale },
    ],
  });

  // Card Header: Subtitle
  if (subtitle) {
    layers.push({
      id: `chart-${type}-sub-txt`,
      kind: "text",
      text: subtitle,
      x: x + 28,
      y: y + 54,
      width: width - 56,
      height: 20,
      rotation: 0,
      opacity: 0.7,
      fill: "#94A3B8",
      fontSize: 13,
      fontFamily: "JetBrains Mono",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
        { property: "scale", keyframes: cardScale },
      ],
    });
  }

  // 2. Chart Specific Content
  if (type === "benchmark") {
    const rawItems = options.items && options.items.length > 0 ? options.items : [
      { label: "Superagent 3-Tier Multi-Agent", value: 0.42, displayValue: "0.42s (7x Faster)", accent: accentColor, isHero: true },
      { label: "Traditional Monolithic Assistant", value: 2.85, displayValue: "2.85s", accent: "#64748B" },
      { label: "Sequential Single-Thread Agent", value: 4.10, displayValue: "4.10s", accent: "#475569" },
    ];

    const maxValue = Math.max(...rawItems.map(i => i.value), 1);
    const contentStartY = y + 96;
    const barHeight = 24;
    const rowSpacing = Math.min(68, Math.floor((height - 120) / rawItems.length));
    const maxBarWidth = width - 260;

    rawItems.forEach((item, index) => {
      const rowY = contentStartY + index * rowSpacing;
      const targetWidth = Math.max(36, Math.round((item.value / maxValue) * maxBarWidth));
      const barX = x + 28;
      const barAccent = item.accent ?? (item.isHero ? accentColor : "#64748B");

      // Row Label
      layers.push({
        id: `chart-bench-lbl-${index + 1}`,
        kind: "text",
        text: item.label,
        x: barX,
        y: rowY,
        width: width - 56,
        height: 20,
        rotation: 0,
        opacity: item.isHero ? 1 : 0.85,
        fill: item.isHero ? "#FFFFFF" : "#CBD5E1",
        fontSize: 14,
        fontFamily: "Inter",
        tracks: [
          { property: "opacity", keyframes: cardOpacity },
        ],
      });

      // Background Track Groove
      layers.push({
        id: `chart-bench-groove-${index + 1}`,
        kind: "rect",
        x: barX,
        y: rowY + 24,
        width: maxBarWidth,
        height: barHeight,
        cornerRadius: 6,
        rotation: 0,
        opacity: 0.4,
        fill: "#1E293B",
        tracks: [
          { property: "opacity", keyframes: cardOpacity },
        ],
      });

      // Animated Growing Value Bar (Anchored left with compensated X)
      const barStart = startFrame + 8 + index * 6;
      const barEnd = Math.min(endFrame, barStart + 24);

      const barScaleXKeys = cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: barStart, value: 0 },
        { frame: barEnd, value: 1.0, easing: "easeOutExpo" },
        { frame: endFrame, value: 1.0 },
      ], endFrame);

      const barXKeys = cleanKeyframes([
        { frame: 0, value: barX - targetWidth * 0.5 },
        { frame: barStart, value: barX - targetWidth * 0.5 },
        { frame: barEnd, value: barX, easing: "easeOutExpo" },
        { frame: endFrame, value: barX },
      ], endFrame);

      layers.push({
        id: `chart-bench-bar-${index + 1}`,
        kind: "rect",
        x: barX,
        y: rowY + 24,
        width: targetWidth,
        height: barHeight,
        cornerRadius: 6,
        rotation: 0,
        opacity: 1,
        fill: barAccent,
        tracks: [
          { property: "opacity", keyframes: cardOpacity },
          { property: "scaleX", keyframes: barScaleXKeys },
          { property: "x", keyframes: barXKeys },
        ],
      });

      // Metric Value Readout
      const valFadeKeys = cleanKeyframes([
        { frame: 0, value: 0 },
        { frame: barEnd - 6, value: 0 },
        { frame: barEnd + 6, value: 1, easing: "easeOutExpo" },
        { frame: endFrame, value: 1 },
      ], endFrame);

      layers.push({
        id: `chart-bench-val-${index + 1}`,
        kind: "text",
        text: item.displayValue ?? `${item.value}`,
        x: barX + maxBarWidth + 16,
        y: rowY + 26,
        width: 180,
        height: 20,
        rotation: 0,
        opacity: 1,
        fill: item.isHero ? accentColor : "#94A3B8",
        fontSize: 13,
        fontFamily: "JetBrains Mono",
        tracks: [
          { property: "opacity", keyframes: valFadeKeys },
        ],
      });
    });

  } else if (type === "kpi") {
    // KPI Hero Stat Card
    const val = options.kpiValue ?? "99.8%";
    const label = options.kpiLabel ?? "Autonomous Completion Rate";
    const badge = options.kpiBadge ?? "⚡ Zero Human Intervention";

    const kpiSpringScale = cleanKeyframes([
      { frame: 0, value: 0.8 },
      { frame: startFrame + 6, value: 0.8 },
      { frame: Math.min(endFrame, startFrame + 22), value: 1.0, easing: "easeOutBack" },
      { frame: endFrame, value: 1.0 },
    ], endFrame);

    // Glowing Ambient Orb behind KPI
    layers.push({
      id: "chart-kpi-glow-orb",
      kind: "rect",
      x: x + Math.round(width / 2) - 100,
      y: y + Math.round(height / 2) - 50,
      width: 200,
      height: 100,
      cornerRadius: 50,
      rotation: 0,
      opacity: 0.18,
      fill: accentColor,
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
        { property: "scale", keyframes: kpiSpringScale },
      ],
    });

    // Hero Metric Number Display
    layers.push({
      id: "chart-kpi-value-txt",
      kind: "text",
      text: val,
      x: x + 28,
      y: y + 95,
      width: width - 56,
      height: 72,
      rotation: 0,
      opacity: 1,
      fill: "#FFFFFF",
      fontSize: 56,
      fontFamily: "Inter",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
        { property: "scale", keyframes: kpiSpringScale },
      ],
    });

    // KPI Sub-label
    layers.push({
      id: "chart-kpi-label-txt",
      kind: "text",
      text: label,
      x: x + 28,
      y: y + 172,
      width: width - 56,
      height: 24,
      rotation: 0,
      opacity: 0.8,
      fill: "#94A3B8",
      fontSize: 16,
      fontFamily: "Inter",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
      ],
    });

    // Trending Badge Pill
    const badgeWidth = Math.min(width - 56, badge.length * 9 + 28);
    layers.push({
      id: "chart-kpi-badge-bg",
      kind: "rect",
      x: x + 28,
      y: y + 210,
      width: badgeWidth,
      height: 32,
      cornerRadius: 16,
      rotation: 0,
      opacity: 0.9,
      fill: "#102336",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
        { property: "scale", keyframes: kpiSpringScale },
      ],
    });

    layers.push({
      id: "chart-kpi-badge-txt",
      kind: "text",
      text: badge,
      x: x + 40,
      y: y + 217,
      width: badgeWidth - 24,
      height: 18,
      rotation: 0,
      opacity: 1,
      fill: accentColor,
      fontSize: 12,
      fontFamily: "JetBrains Mono",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
      ],
    });

  } else if (type === "radial") {
    // Radial Progress Ring
    const percent = Math.min(100, Math.max(0, options.progressPercent ?? 88));
    const radius = Math.min(Math.floor((width - 60) / 4), Math.floor((height - 110) / 2));
    const centerX = x + Math.round(width / 2);
    const centerY = y + 120 + Math.round((height - 150) / 2);
    const perimeter = Math.round(2 * Math.PI * radius);
    const targetOffset = Math.round(perimeter * (1 - percent / 100));

    // SVG Circular Path description (center cx, cy with radius r)
    const circlePath = `M ${centerX} ${centerY - radius} A ${radius} ${radius} 0 1 1 ${centerX} ${centerY + radius} A ${radius} ${radius} 0 1 1 ${centerX} ${centerY - radius}`;

    // Background track ring
    layers.push({
      id: "chart-radial-track",
      kind: "path",
      d: circlePath,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      opacity: 0.25,
      fill: "transparent",
      stroke: "#334155",
      strokeWidth: 14,
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
      ],
    });

    // Animated Active Arc
    const ringDrawKeys = cleanKeyframes([
      { frame: 0, value: perimeter },
      { frame: startFrame + 6, value: perimeter },
      { frame: Math.min(endFrame, startFrame + 34), value: targetOffset, easing: "easeOutExpo" },
      { frame: endFrame, value: targetOffset },
    ], endFrame);

    layers.push({
      id: "chart-radial-active",
      kind: "path",
      d: circlePath,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      opacity: 1,
      fill: "transparent",
      stroke: accentColor,
      strokeWidth: 14,
      strokeDasharray: [perimeter, perimeter],
      strokeDashoffset: perimeter,
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
        { property: "strokeDashoffset", keyframes: ringDrawKeys },
      ],
    });

    // Center Percentage Text
    layers.push({
      id: "chart-radial-val-txt",
      kind: "text",
      text: `${percent}%`,
      x: centerX - 60,
      y: centerY - 18,
      width: 120,
      height: 36,
      rotation: 0,
      opacity: 1,
      fill: "#FFFFFF",
      fontSize: 32,
      fontFamily: "Inter",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
      ],
    });

  } else if (type === "sparkline") {
    // Sparkline Trend Polyline
    const data = options.sparklineData && options.sparklineData.length > 1
      ? options.sparklineData
      : [12, 18, 15, 26, 32, 28, 45, 54, 72];

    const plotX = x + 36;
    const plotY = y + 100;
    const plotW = width - 72;
    const plotH = height - 130;

    const minVal = Math.min(...data);
    const maxVal = Math.max(...data, minVal + 1);
    const stepX = plotW / (data.length - 1);

    const points = data.map((v, i) => {
      const px = Math.round(plotX + i * stepX);
      const py = Math.round(plotY + plotH - ((v - minVal) / (maxVal - minVal)) * plotH);
      return { x: px, y: py };
    });

    const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

    // Approximate total length for strokeDashoffset animation
    let totalLen = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      totalLen += Math.sqrt(dx * dx + dy * dy);
    }
    const safeLen = Math.round(totalLen) || 400;

    const sparkDrawKeys = cleanKeyframes([
      { frame: 0, value: safeLen },
      { frame: startFrame + 6, value: safeLen },
      { frame: Math.min(endFrame, startFrame + 28), value: 0, easing: "easeOutExpo" },
      { frame: endFrame, value: 0 },
    ], endFrame);

    layers.push({
      id: "chart-sparkline-line",
      kind: "path",
      d: pathD,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      rotation: 0,
      opacity: 1,
      fill: "transparent",
      stroke: accentColor,
      strokeWidth: 4,
      strokeDasharray: [safeLen, safeLen],
      strokeDashoffset: safeLen,
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
        { property: "strokeDashoffset", keyframes: sparkDrawKeys },
      ],
    });

    // Terminal Glowing Dot at End of Line
    const lastPoint = points[points.length - 1];
    layers.push({
      id: "chart-sparkline-head-dot",
      kind: "rect",
      x: lastPoint.x - 5,
      y: lastPoint.y - 5,
      width: 10,
      height: 10,
      cornerRadius: 5,
      rotation: 0,
      opacity: 1,
      fill: "#FFFFFF",
      tracks: [
        { property: "opacity", keyframes: cardOpacity },
      ],
    });
  }

  return layers;
}

/**
 * Attaches an animated data visualization chart to an existing MotionProject.
 */
export async function attachChartToProject(
  workspace: string,
  project: MotionProject,
  options: {
    type?: MotionChartType;
    title?: string;
    subtitle?: string;
    items?: BenchmarkItem[];
    kpiValue?: string;
    kpiLabel?: string;
    kpiBadge?: string;
    progressPercent?: number;
    sparklineData?: number[];
    accentColor?: string;
  } = {},
): Promise<{ edits: MotionEdit[]; layerCount: number; chartType: MotionChartType }> {
  const comp = project.composition;
  const chartType = options.type ?? "benchmark";
  const startFrame = 0;
  const endFrame = comp.durationFrames - 1;

  const width = Math.min(comp.width - 120, 840);
  const height = Math.min(comp.height - 120, 480);
  const x = Math.round((comp.width - width) / 2);
  const y = Math.round((comp.height - height) / 2);

  const chartLayers = compileMotionChartLayers({
    type: chartType,
    x,
    y,
    width,
    height,
    startFrame,
    endFrame,
    title: options.title,
    subtitle: options.subtitle,
    items: options.items,
    kpiValue: options.kpiValue,
    kpiLabel: options.kpiLabel,
    kpiBadge: options.kpiBadge,
    progressPercent: options.progressPercent,
    sparklineData: options.sparklineData,
    accentColor: options.accentColor,
  });

  const edits: MotionEdit[] = chartLayers.map(layer => ({
    type: "add-layer",
    layer,
  }));

  return { edits, layerCount: chartLayers.length, chartType };
}
