import type { MotionEdit, MotionLayer, MotionProject, MotionProperty, MotionTrack } from "../schema/types.js";

export const EFFECT_CATEGORIES = [
  "entrance",
  "exit",
  "kinetic-typography",
  "camera",
  "transition",
  "background",
  "graphic-accent",
] as const;

export type EffectCategory = typeof EFFECT_CATEGORIES[number];

export type EffectParamType = "number" | "color" | "string" | "boolean" | "enum";

export interface EffectParamDefinition<T = unknown> {
  name: string;
  type: EffectParamType;
  description: string;
  default: T;
  min?: number;
  max?: number;
  step?: number;
  choices?: (string | number)[];
}

export interface EffectApplyContext {
  project: MotionProject;
  targetLayerId?: string;
  targetLayer?: MotionLayer;
  sceneIndex?: number;
  startFrame: number;
  endFrame: number;
  durationFrames: number;
  compositionWidth: number;
  compositionHeight: number;
  fps: number;
  accentColor?: string;
  backgroundColor?: string;
  aspectRatio?: "16:9" | "1:1" | "9:16";
}

export interface EffectApplyResult {
  tracks?: MotionTrack[];
  newLayers?: MotionLayer[];
  updatedLayers?: Partial<MotionLayer>[];
  compositionEdits?: MotionEdit[];
}

export interface EffectDefinition {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  tags: string[];
  targetKinds: ("text" | "rect" | "image" | "scene")[];
  parameters: Record<string, EffectParamDefinition>;
  apply: (ctx: EffectApplyContext, params: Record<string, any>) => EffectApplyResult;
}

export interface EffectCatalogItem {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  tags: string[];
  targetKinds: ("text" | "rect" | "image" | "scene")[];
  parameters: Record<string, {
    name: string;
    type: EffectParamType;
    description: string;
    default: unknown;
    min?: number;
    max?: number;
    step?: number;
    choices?: (string | number)[];
  }>;
}

export interface EffectFilter {
  category?: EffectCategory;
  query?: string;
  targetKind?: "text" | "rect" | "image" | "scene";
  tag?: string;
}

export interface EffectApplication {
  effectId: string;
  targetLayerId?: string;
  params?: Record<string, unknown>;
  startFrame?: number;
  durationFrames?: number;
}
