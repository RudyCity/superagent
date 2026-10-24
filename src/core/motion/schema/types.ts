/**
 * Declarative SuperAgent Studio schema v1. Browser-safe: no filesystem or process dependencies.
 * No arbitrary JavaScript, external URLs, fonts or plugins are permitted in a scene.
 */
export const MOTION_SCHEMA_VERSION = 1 as const;

export type MotionProperty = "x" | "y" | "opacity" | "rotation" | "scale" | "scaleX" | "scaleY";
export type MotionEasing = "linear" | "step" | "easeInOut" | "easeOutBack" | "easeIn" | "easeOut" | "bounce";

export interface MotionKeyframe {
  frame: number;
  value: number;
  easing?: MotionEasing;
}
export interface MotionTrack {
  property: MotionProperty;
  keyframes: MotionKeyframe[];
}
interface BaseLayer {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  scale?: number;
  scaleX?: number;
  scaleY?: number;
  fill: string;
  tracks: MotionTrack[];
}
export interface TextLayer extends BaseLayer {
  kind: "text";
  text: string;
  fontSize: number;
  fontFamily: string;
}
export interface RectLayer extends BaseLayer {
  kind: "rect";
  cornerRadius?: number;
}
export interface ImageLayer extends BaseLayer {
  kind: "image";
  assetId: string;
}
export interface VideoLayer extends BaseLayer {
  kind: "video";
  assetId: string;
  startFrame?: number;
  trimInSeconds?: number;
  trimOutSeconds?: number;
  speedMultiplier?: number;
  loop?: boolean;
}
export interface PathLayer extends BaseLayer {
  kind: "path";
  d: string;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: number[];
  strokeDashoffset?: number;
  fillRule?: "nonzero" | "evenodd";
}
export type MotionLayer = TextLayer | RectLayer | ImageLayer | VideoLayer | PathLayer;

export interface MotionAudioTrack {
  assetId: string;
  startFrame: number;
  volume: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  loop?: boolean;
  role?: "music" | "voiceover";
}

export interface MotionStackEntry {
  id: string;
  effectId: string;
  enabled: boolean;
  targetLayerId?: string;
  params?: Record<string, string | number | boolean>;
  startFrame?: number;
  durationFrames?: number;
}
export interface MotionComposition {
  width: number;
  height: number;
  fps: { numerator: number; denominator: number };
  durationFrames: number;
  background: string;
  audio?: MotionAudioTrack;
  audioTracks?: MotionAudioTrack[];
  layers: MotionLayer[];
  /** Declarative stack; rendered layers are the compiled result. */
  effectStack?: MotionStackEntry[];
  /** Original composition before applying the stack, used to rebuild safely. */
  stackBase?: Omit<MotionComposition, "effectStack" | "stackBase">;
}
export interface MotionProject {
  schemaVersion: typeof MOTION_SCHEMA_VERSION;
  id: string;
  workspaceRoot: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  composition: MotionComposition;
}
export type MotionEdit =
  | { type: "set-text"; layerId: string; text: string }
  | { type: "set-property"; layerId: string; property: MotionProperty; value: number }
  | { type: "set-track"; layerId: string; track: MotionTrack }
  | { type: "add-layer"; layer: MotionLayer; index?: number }
  | { type: "remove-layer"; layerId: string }
  | { type: "move-layer"; layerId: string; toIndex: number }
  | { type: "replace-composition"; composition: MotionProject["composition"] }
  | { type: "set-audio"; audio: MotionAudioTrack | null }
  | { type: "set-audio-tracks"; audioTracks: MotionAudioTrack[] };

export interface EvaluatedLayer {
  layer: MotionLayer;
  values: Record<MotionProperty, number>;
}
export interface EvaluatedFrame {
  frame: number;
  width: number;
  height: number;
  background: string;
  layers: EvaluatedLayer[];
}
