import type { MotionLayer, MotionProject, MotionProperty, MotionTrack } from "../schema/types.js";
import { validateMotionProject, MotionValidationError } from "../schema/validation.js";
import { evaluateTrack } from "../timeline/evaluateFrame.js";
import { effectRegistry } from "./index.js";

/** Curated, fully declarative recipes. IDs are catalog-validated at startup. */
export interface CompoundPreset {
  id: string;
  name: string;
  description: string;
  tags: string[];
  entrance: string;
  emphasis: string;
  exit: string;
  accent?: string;
}
const recipes: CompoundPreset[] = [
  { id: "cinematic-rise", name: "Cinematic Rise", description: "Floating reveal, breathing motion, soft fade", tags: ["cinematic","elegant"], entrance: "entrance-drift-rise", emphasis: "kinetic-breathing", exit: "exit-fade-out", accent: "accent-kinetic-underline" },
  { id: "neon-impact", name: "Neon Impact", description: "Electric whip entrance, glitch and fast exit", tags: ["neon","fast"], entrance: "entrance-whip-left", emphasis: "kinetic-glitch-drift", exit: "exit-whip-right", accent: "accent-tech-callout" },
  { id: "editorial-reveal", name: "Editorial Reveal", description: "Precision vertical reveal with measured sway", tags: ["editorial","clean"], entrance: "entrance-slide-up", emphasis: "kinetic-sway-subtle", exit: "exit-fade-out", accent: "accent-kicker-tag" },
  { id: "bold-hero", name: "Bold Hero", description: "Elastic title impact, percussive hold and fly-out", tags: ["bold","social"], entrance: "entrance-elastic-pop", emphasis: "kinetic-drum-kick", exit: "exit-slide-up", accent: "accent-bottom-rule-thick" },
  { id: "retro-signal", name: "Retro Signal", description: "Stepped reveal, analogue shudder and retreat", tags: ["retro","technology"], entrance: "entrance-step-reveal", emphasis: "kinetic-shudder", exit: "exit-glissando-right", accent: "accent-double-underline" },
  { id: "quiet-story", name: "Quiet Story", description: "Subtle fade, light float and gentle exit", tags: ["minimal","calm"], entrance: "entrance-fade-in", emphasis: "kinetic-hover-sine", exit: "exit-drift-slow", accent: "accent-marker-scribble" },
  { id: "futurist-card", name: "Futurist Card", description: "Spring-pop technology-card animation", tags: ["futurist","card"], entrance: "entrance-pop-up", emphasis: "kinetic-pulse-impact", exit: "exit-tilt-fall", accent: "accent-bracket-focus" },
  { id: "social-burst", name: "Social Burst", description: "Dynamic diagonal movement and rhythmic bounce", tags: ["social","energetic"], entrance: "entrance-diagonal-tl", emphasis: "kinetic-rhythm-hop", exit: "exit-diagonal-br", accent: "accent-arrow-indicator" },
  { id: "announcement", name: "Announcement", description: "Drop-in headline with strong double heartbeat", tags: ["announcement","promo"], entrance: "entrance-drop-in", emphasis: "kinetic-heartbeat", exit: "exit-sink-away", accent: "accent-status-capsule" },
  { id: "soft-breeze", name: "Soft Breeze", description: "Atmospheric horizontal drift and delicate floating", tags: ["soft","lifestyle"], entrance: "entrance-drift-slow", emphasis: "kinetic-wave-float", exit: "exit-float-away", accent: "accent-pulse-dot" },
  { id: "tech-launch", name: "Tech Launch", description: "Vortex entrance, fine tremor and rotational exit", tags: ["technology","launch"], entrance: "entrance-vortex-in", emphasis: "kinetic-tremor", exit: "exit-vortex-out", accent: "accent-focus-crosshair" },
  { id: "magazine-flip", name: "Magazine Flip", description: "Spinning editorial treatment and type movement", tags: ["magazine","editorial"], entrance: "entrance-spin-in", emphasis: "kinetic-seesaw", exit: "exit-spin-out-cw", accent: "accent-quote-notch" },
  { id: "bright-alert", name: "Bright Alert", description: "Fast vertical motion with alert rhythm", tags: ["alert","fast"], entrance: "entrance-whip-up", emphasis: "kinetic-shake-horizontal", exit: "exit-whip-down", accent: "accent-warning-stripe" },
  { id: "gentle-lift", name: "Gentle Lift", description: "Elegant uplift with pendulum easing", tags: ["elegant","gentle"], entrance: "entrance-rebound-up", emphasis: "kinetic-pendulum-decay", exit: "exit-fade-out", accent: "accent-overbar" },
  { id: "live-stream", name: "Live Stream", description: "Crisp live-broadcast text entrance and motion", tags: ["broadcast","tech"], entrance: "entrance-slide-right", emphasis: "kinetic-meter-pulse", exit: "exit-slide-left", accent: "accent-level-meter" },
  { id: "festival-pop", name: "Festival Pop", description: "Celebratory spring, bounce, and colorful exit", tags: ["festival","playful"], entrance: "entrance-pop-left", emphasis: "kinetic-bounce-settle", exit: "exit-pop-right", accent: "accent-spark-cross" },
];

const byId = new Map(recipes.map(recipe => [recipe.id, recipe]));
if (byId.size !== recipes.length) throw new Error("Duplicate compound preset ID");
for (const preset of recipes) {
  for (const [phase, effectId] of Object.entries({
    entrance: preset.entrance, emphasis: preset.emphasis, exit: preset.exit, accent: preset.accent,
  })) {
    if (!effectId) continue;
    const effect = effectRegistry.get(effectId);
    if (!effect || !effect.targetKinds.includes("text")) {
      throw new Error("Invalid compound effect " + preset.id + ": " + effectId);
    }
    if (phase !== "accent" && (effect.targetKinds.includes("scene") && !effect.targetKinds.includes("text"))) {
      throw new Error("Compound animation phase must support text");
    }
  }
}

export function listCompoundPresets(query?: string): CompoundPreset[] {
  const q = query?.trim().toLowerCase();
  return recipes.filter(recipe => !q || [recipe.id, recipe.name, recipe.description, ...recipe.tags]
    .some(field => field.toLowerCase().includes(q))).map(recipe => ({
      ...recipe, tags: [...recipe.tags],
  }));
}
export function getCompoundPreset(id: string): CompoundPreset | undefined {
  const item = byId.get(id);
  return item ? { ...item, tags: [...item.tags] } : undefined;
}
export interface CompoundPresetApplication {
  presetId: string;
  targetLayerId: string;
  startFrame?: number;
  durationFrames?: number;
  intensity?: number;
}

/**
 * Evaluate phases into one composite property track: never overwrite a
 * preceding phase with the following one. Edits are transactional and typed;
 * execution is pure, with no scripts, shaders or user-supplied expressions.
 */
export function applyCompoundPreset(project: MotionProject, input: CompoundPresetApplication): MotionProject {
  validateMotionProject(project);
  const preset = byId.get(input.presetId);
  if (!preset) throw new MotionValidationError(["Unknown compound preset: " + String(input.presetId)]);
  const target = project.composition.layers.find(layer => layer.id === input.targetLayerId);
  if (!target || target.kind !== "text") {
    throw new MotionValidationError(["Compound presets require an existing text layer."]);
  }
  const start = input.startFrame ?? 0;
  const frames = input.durationFrames ?? Math.min(120, project.composition.durationFrames - start);
  const strength = input.intensity ?? 1;
  if (!Number.isSafeInteger(start) || start < 0 || start >= project.composition.durationFrames ||
      !Number.isSafeInteger(frames) || frames < 12 || frames > 420 ||
      start + frames > project.composition.durationFrames) {
    throw new MotionValidationError(["Compound preset requires 12-420 frames entirely inside the composition."]);
  }
  if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0.25 || strength > 2) {
    throw new MotionValidationError(["Compound preset intensity must be between 0.25 and 2."]);
  }
  const result = structuredClone(project);
  const layer = result.composition.layers.find(item => item.id === input.targetLayerId)!;
  const end = start + frames - 1;
  const phaseFrames: Array<{ phase: string; id: string; first: number; last: number }> = [
    { phase: "entrance", id: preset.entrance, first: start, last: start + Math.max(2, Math.floor(frames * .22)) },
    { phase: "emphasis", id: preset.emphasis, first: start + Math.floor(frames * .27), last: start + Math.floor(frames * .78) },
    { phase: "exit", id: preset.exit, first: start + Math.floor(frames * .82), last: end },
  ];
  const generated = new Map<MotionProperty, Array<{ first: number; last: number; track: MotionTrack }>>();
  const compile = (id: string, first: number, last: number) => {
    const ctx = {
      project: result, targetLayerId: layer.id, targetLayer: layer,
      startFrame: first, endFrame: last, durationFrames: last - first + 1,
      compositionWidth: result.composition.width, compositionHeight: result.composition.height,
      fps: result.composition.fps.numerator / result.composition.fps.denominator,
    };
    return effectRegistry.apply(id, ctx);
  };
  for (const phase of phaseFrames) {
    const compiled = compile(phase.id, phase.first, phase.last);
    if (!compiled.tracks?.length) throw new MotionValidationError(["Compound phase generated no motion: " + phase.id]);
    for (const track of compiled.tracks) {
      const current = generated.get(track.property) ?? [];
      current.push({ first: phase.first, last: phase.last, track });
      generated.set(track.property, current);
    }
  }
  for (const [property, phases] of generated) {
    const old = layer.tracks.find(track => track.property === property);
    const baseline = (frame: number) => old ? evaluateTrack(old, frame) : layer[property];
    const keyframes: MotionTrack["keyframes"] = old
      ? old.keyframes.filter(point => point.frame < start - 1 || point.frame > end + 1)
        .map(point => ({ ...point }))
      : [];
    if (start > 0) keyframes.push({ frame: start - 1, value: baseline(start - 1) });
    for (let frame = start; frame <= end; frame++) {
      let value = baseline(frame);
      for (const phase of phases) {
        if (frame < phase.first || frame > phase.last) continue;
        const effectVal = evaluateTrack(phase.track, frame);
        if (property === "opacity") value *= effectVal;
        else value += (effectVal - layer[property]) * strength;
      }
      if (property === "opacity") value = Math.min(1, Math.max(0, value));
      else value = Math.max(-100000, Math.min(100000, value));
      keyframes.push({ frame, value });
    }
    if (end < project.composition.durationFrames - 1) keyframes.push({ frame: end + 1, value: baseline(end + 1) });
    keyframes.sort((a,b) => a.frame - b.frame);
    if (keyframes.length > 1024) throw new MotionValidationError(["Preset exceeds motion track keyframe capacity."]);
    const replacement: MotionTrack = { property, keyframes };
    const idx = layer.tracks.findIndex(track => track.property === property);
    if (idx >= 0) layer.tracks[idx] = replacement;
    else if (layer.tracks.length < 4) layer.tracks.push(replacement);
    else throw new MotionValidationError(["Preset exceeds the four-track limit."]);
  }

  if (preset.accent) {
    const first = start + Math.floor(frames * .1);
    const last = start + Math.floor(frames * .82);
    const accent = compile(preset.accent, first, last);
    if (accent.newLayers?.length) {
      const ids = new Set(result.composition.layers.map(item => item.id));
      for (const [index, item] of accent.newLayers.entries()) {
        const overlay = structuredClone(item);
        const baseId = ("preset-" + preset.id + "-" + index).slice(0, 58);
        let id = baseId, n = 1;
        while (ids.has(id)) id = baseId + "-" + n++;
        ids.add(id); overlay.id = id;
        const initialOpacity = overlay.opacity;
        const animatedOpacity = overlay.tracks.find(track => track.property === "opacity");
        const opacityFrames: MotionTrack["keyframes"] = [];
        if (first > 0) opacityFrames.push({ frame: first - 1, value: 0 });
        for (let frame = first; frame <= last; frame++) {
          const fadeIn = Math.min(1, (frame - first) / 5);
          const fadeOut = Math.min(1, (last - frame) / 5);
          const value = (animatedOpacity ? evaluateTrack(animatedOpacity, frame) : initialOpacity) *
            Math.max(0, Math.min(fadeIn, fadeOut));
          opacityFrames.push({ frame, value: Math.max(0, Math.min(1, value)) });
        }
        if (last < project.composition.durationFrames - 1) opacityFrames.push({ frame: last + 1, value: 0 });
        overlay.tracks = [...overlay.tracks.filter(track => track.property !== "opacity"), {
          property: "opacity" as const, keyframes: opacityFrames,
        }];
        result.composition.layers.push(overlay);
      }
    }
  }

  result.updatedAt = new Date().toISOString();
  validateMotionProject(result);
  return result;
}
