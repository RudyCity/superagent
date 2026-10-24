import type { MotionLayer, MotionTrack, RectLayer, MotionProject, MotionEdit } from "../schema/types.js";
import { inspectMotionWav, readMotionAudio, motionAudioTracks } from "../assets/motionAudio.js";
import { detectMotionAudioOnsets } from "../motionBeatSync.js";
import { MotionValidationError } from "../schema/validation.js";

export type AudioVisualizerType = "equalizer" | "waveform" | "pulse-ring";

export interface AudioVisualizerOptions {
  type?: AudioVisualizerType;
  audioBytes?: Buffer;
  fps?: number;
  durationFrames: number;
  x: number;
  y: number;
  width: number;
  height: number;
  accentColor: string;
  barCount?: number;
  baseOpacity?: number;
  startFrame?: number;
  endFrame?: number;
}

/**
 * Deterministically computes normalized audio energy per frame from raw PCM16 WAV bytes.
 * If no audio bytes are provided, produces a synthetic rhythmic energy curve.
 */
export function extractAudioEnergyProfile(
  bytes: Buffer | undefined,
  fps: number,
  durationFrames: number,
  bands = 12,
): number[][] {
  const profile: number[][] = [];
  if (!bytes || bytes.length < 44) {
    // Deterministic synthetic ambient audio energy profile
    for (let f = 0; f < durationFrames; f++) {
      const frameBands: number[] = [];
      const t = f / (fps || 30);
      const beat = (f % 15) === 0 ? 0.9 : 0.3;
      for (let b = 0; b < bands; b++) {
        const freqWave = Math.sin(t * 3.5 + b * 0.45) * 0.35 + 0.45;
        const sub = Math.cos(t * 1.8 + b * 0.2) * 0.2;
        const val = Math.max(0.08, Math.min(1.0, freqWave + sub + (b === 0 ? beat * 0.4 : 0)));
        frameBands.push(Number(val.toFixed(3)));
      }
      profile.push(frameBands);
    }
    return profile;
  }

  const { sampleRate, channels } = inspectMotionWav(bytes);
  const totalSamples = (bytes.length - 44) / (channels * 2);
  const samplesPerFrame = Math.max(1, Math.floor(sampleRate / fps));

  for (let f = 0; f < durationFrames; f++) {
    const frameBands: number[] = [];
    const frameSampleStart = Math.min(totalSamples - 1, f * samplesPerFrame);
    const frameSampleEnd = Math.min(totalSamples, (f + 1) * samplesPerFrame);
    const count = frameSampleEnd - frameSampleStart;

    if (count <= 0) {
      profile.push(new Array(bands).fill(0.05));
      continue;
    }

    const bandSize = Math.max(1, Math.floor(count / bands));
    for (let b = 0; b < bands; b++) {
      let power = 0;
      let bandCount = 0;
      const bStart = frameSampleStart + b * bandSize;
      const bEnd = Math.min(frameSampleEnd, bStart + bandSize);

      for (let i = bStart; i < bEnd; i++) {
        const offset = 44 + i * channels * 2;
        if (offset + 1 < bytes.length) {
          const s = bytes.readInt16LE(offset) / 32768;
          power += s * s;
          bandCount++;
        }
      }
      const rms = bandCount > 0 ? Math.sqrt(power / bandCount) : 0;
      // Boost low bands (bass) slightly, normalize between 0.05 and 1.0
      const weight = 1 + (bands - b) * 0.06;
      const energy = Math.max(0.05, Math.min(1.0, rms * 4.2 * weight));
      frameBands.push(Number(energy.toFixed(3)));
    }
    profile.push(frameBands);
  }

  return profile;
}

/**
 * Compiles audio-reactive visualizer layers (equalizer bars, smooth waveform pips, or pulse rings)
 * adhering strictly to the declarative Superagent Motion schema.
 */
export function compileAudioVisualizerLayers(options: AudioVisualizerOptions): MotionLayer[] {
  const type = options.type ?? "equalizer";
  const fps = options.fps ?? 30;
  const durationFrames = options.durationFrames;
  const startFrame = options.startFrame ?? 0;
  const endFrame = options.endFrame ?? durationFrames - 1;
  const barCount = Math.max(4, Math.min(32, options.barCount ?? (type === "equalizer" ? 14 : 20)));
  const baseOpacity = options.baseOpacity ?? 0.85;

  const energyProfile = extractAudioEnergyProfile(options.audioBytes, fps, durationFrames, barCount);
  const layers: MotionLayer[] = [];

  if (type === "equalizer") {
    const totalGap = 4 * (barCount - 1);
    const barWidth = Math.max(3, Math.floor((options.width - totalGap) / barCount));
    const maxHeight = options.height;

    for (let i = 0; i < barCount; i++) {
      const barX = Math.round(options.x + i * (barWidth + 4));
      const keyframes: { frame: number; value: number; easing?: "easeInOut" | "easeOutExpo" }[] = [];

      for (let f = 0; f < durationFrames; f++) {
        if (f < startFrame || f > endFrame) {
          keyframes.push({ frame: f, value: 0.05 });
          continue;
        }
        const energy = energyProfile[f]?.[i] ?? 0.1;
        const scaleVal = Math.max(0.08, Math.min(1.0, Number(energy.toFixed(3))));
        keyframes.push({
          frame: f,
          value: scaleVal,
          easing: "easeOutExpo",
        });
      }

      // Compact keyframe track by omitting identical adjacent frames
      const compacted: { frame: number; value: number }[] = [];
      for (let k = 0; k < keyframes.length; k++) {
        const cur = keyframes[k];
        const prev = compacted[compacted.length - 1];
        const next = keyframes[k + 1];
        if (!prev || !next || prev.value !== cur.value || next.value !== cur.value) {
          compacted.push(cur);
        }
      }

      const barLayer: RectLayer = {
        id: `audio-eq-bar-${i}`,
        kind: "rect",
        x: barX,
        y: options.y,
        width: barWidth,
        height: maxHeight,
        cornerRadius: Math.min(3, Math.floor(barWidth / 2)),
        rotation: 0,
        opacity: baseOpacity,
        fill: options.accentColor,
        tracks: [
          {
            property: "scaleY",
            keyframes: compacted.length > 0 ? compacted : [{ frame: 0, value: 0.1 }],
          },
          {
            property: "y",
            keyframes: compacted.map(k => ({
              frame: k.frame,
              value: Math.round(options.y + (1 - k.value) * maxHeight * 0.5),
            })),
          },
        ],
      };
      layers.push(barLayer);
    }
  } else if (type === "waveform") {
    // Waveform line composed of mirrored pill segments
    const segmentWidth = Math.max(3, Math.floor(options.width / barCount));
    const centerY = options.y + options.height / 2;

    for (let i = 0; i < barCount; i++) {
      const segX = options.x + i * segmentWidth;
      const keyframes: { frame: number; value: number }[] = [];

      for (let f = 0; f < durationFrames; f++) {
        if (f < startFrame || f > endFrame) {
          keyframes.push({ frame: f, value: 0.05 });
          continue;
        }
        const energy = energyProfile[f]?.[i] ?? 0.1;
        keyframes.push({ frame: f, value: Math.max(0.06, Math.min(1.0, Number(energy.toFixed(3)))) });
      }

      const barLayer: RectLayer = {
        id: `audio-wave-seg-${i}`,
        kind: "rect",
        x: segX,
        y: Math.round(centerY - options.height / 2),
        width: Math.max(2, segmentWidth - 2),
        height: options.height,
        cornerRadius: 2,
        rotation: 0,
        opacity: baseOpacity,
        fill: options.accentColor,
        tracks: [
          {
            property: "scaleY",
            keyframes,
          },
        ],
      };
      layers.push(barLayer);
    }
  } else {
    // Pulse-ring type: concentric expanding rounded rect/pills that pulse on onsets
    const rings = 3;
    for (let r = 0; r < rings; r++) {
      const ringScaleKeys: { frame: number; value: number }[] = [];
      const ringOpacityKeys: { frame: number; value: number }[] = [];

      for (let f = 0; f < durationFrames; f++) {
        if (f < startFrame || f > endFrame) {
          ringScaleKeys.push({ frame: f, value: 0.8 });
          ringOpacityKeys.push({ frame: f, value: 0 });
          continue;
        }
        const avgEnergy = (energyProfile[f]?.reduce((a, b) => a + b, 0) ?? 0) / barCount;
        const scaleVal = 1.0 + avgEnergy * (0.15 + r * 0.12);
        const opacityVal = Math.max(0.04, Math.min(0.65, avgEnergy * 0.85 - r * 0.1));
        ringScaleKeys.push({ frame: f, value: Number(scaleVal.toFixed(3)) });
        ringOpacityKeys.push({ frame: f, value: Number(opacityVal.toFixed(3)) });
      }

      const ringLayer: RectLayer = {
        id: `audio-pulse-ring-${r}`,
        kind: "rect",
        x: options.x - r * 8,
        y: options.y - r * 8,
        width: options.width + r * 16,
        height: options.height + r * 16,
        cornerRadius: Math.min(options.width, options.height) / 2,
        rotation: 0,
        opacity: 0.2,
        fill: options.accentColor,
        tracks: [
          { property: "scale", keyframes: ringScaleKeys },
          { property: "opacity", keyframes: ringOpacityKeys },
        ],
      };
      layers.push(ringLayer);
    }
  }

  return layers;
}

/**
 * Attaches audio-reactive visualizer layers directly to an existing MotionProject.
 */
export async function attachAudioVisualizerToProject(
  workspace: string,
  project: MotionProject,
  options: {
    type?: AudioVisualizerType;
    barCount?: number;
    accentColor?: string;
    position?: "card-bottom" | "hud-bottom" | "custom";
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } = {},
): Promise<{ edits: MotionEdit[]; layerCount: number }> {
  const clips = motionAudioTracks(project);
  let audioBytes: Buffer | undefined;

  if (clips.length > 0) {
    try {
      audioBytes = await readMotionAudio(workspace, clips[0].assetId);
    } catch {
      // Fallback to synthetic if unreadable
    }
  }

  const comp = project.composition;
  const fps = comp.fps.numerator / comp.fps.denominator;
  const accent = options.accentColor ?? "#38BDF8";

  let x = options.x ?? Math.round(comp.width * 0.25);
  let y = options.y ?? Math.round(comp.height * 0.86);
  let width = options.width ?? Math.round(comp.width * 0.5);
  let height = options.height ?? 48;

  if (options.position === "hud-bottom") {
    x = Math.round(comp.width * 0.1);
    y = Math.round(comp.height * 0.9);
    width = Math.round(comp.width * 0.8);
    height = 36;
  }

  const layers = compileAudioVisualizerLayers({
    type: options.type ?? "equalizer",
    audioBytes,
    fps,
    durationFrames: comp.durationFrames,
    x,
    y,
    width,
    height,
    accentColor: accent,
    barCount: options.barCount,
  });

  const edits: MotionEdit[] = [
    {
      type: "replace-composition",
      composition: {
        ...comp,
        layers: [...comp.layers, ...layers],
      },
    },
  ];

  return { edits, layerCount: layers.length };
}
