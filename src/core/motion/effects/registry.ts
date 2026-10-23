import type { MotionEasing, MotionLayer, MotionProject, MotionProperty, MotionTrack } from "../schema/types.js";
import { validateMotionProject, MotionValidationError } from "../schema/validation.js";
import type {
  EffectApplication,
  EffectApplyContext,
  EffectApplyResult,
  EffectCatalogItem,
  EffectCategory,
  EffectDefinition,
  EffectFilter,
  EffectParamDefinition,
} from "./types.js";
import { EFFECT_CATEGORIES } from "./types.js";

const hexColorRegex = /^#[0-9a-fA-F]{6}$/;
const idRegex = /^[a-z][a-z0-9-]{1,63}$/;

class EffectRegistry {
  private effects = new Map<string, EffectDefinition>();

  public register(effect: EffectDefinition): void {
    if (!idRegex.test(effect.id)) {
      throw new Error(`Invalid effect ID '${effect.id}': must be 2-64 kebab-case alphanumeric characters.`);
    }
    if (this.effects.has(effect.id)) {
      throw new Error(`Duplicate effect ID '${effect.id}' already registered.`);
    }
    if (!EFFECT_CATEGORIES.includes(effect.category)) {
      throw new Error(`Invalid category '${effect.category}' for effect '${effect.id}'.`);
    }
    this.effects.set(effect.id, effect);
  }

  public get(id: string): EffectDefinition | undefined {
    return this.effects.get(id);
  }

  public has(id: string): boolean {
    return this.effects.has(id);
  }

  public count(): number {
    return this.effects.size;
  }

  public list(filter?: EffectFilter): EffectDefinition[] {
    let list = Array.from(this.effects.values());
    if (!filter) return list;

    if (filter.category) {
      list = list.filter(e => e.category === filter.category);
    }
    if (filter.targetKind) {
      list = list.filter(e => e.targetKinds.includes(filter.targetKind!));
    }
    if (filter.tag) {
      const tagLower = filter.tag.toLowerCase();
      list = list.filter(e => e.tags.some(t => t.toLowerCase() === tagLower));
    }
    if (filter.query) {
      const q = filter.query.toLowerCase().trim();
      list = list.filter(e =>
        e.id.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some(t => t.toLowerCase().includes(q)),
      );
    }
    return list;
  }

  public getCatalog(filter?: EffectFilter): EffectCatalogItem[] {
    return this.list(filter).map(e => ({
      id: e.id,
      name: e.name,
      category: e.category,
      description: e.description,
      tags: e.tags,
      targetKinds: e.targetKinds,
      parameters: Object.fromEntries(
        Object.entries(e.parameters).map(([key, p]) => [
          key,
          {
            name: p.name,
            type: p.type,
            description: p.description,
            default: p.default,
            min: p.min,
            max: p.max,
            step: p.step,
            choices: p.choices,
          },
        ]),
      ),
    }));
  }

  public validateParams(
    effectId: string,
    rawParams: Record<string, unknown> = {},
  ): { valid: boolean; errors: string[]; sanitized: Record<string, any> } {
    const effect = this.get(effectId);
    if (!effect) {
      return { valid: false, errors: [`Unknown effect '${effectId}'`], sanitized: {} };
    }

    const errors: string[] = [];
    const sanitized: Record<string, any> = {};
    if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
      return { valid: false, errors: ["Effect parameters must be an object."], sanitized };
    }
    for (const key of Object.keys(rawParams)) {
      if (!Object.prototype.hasOwnProperty.call(effect.parameters, key)) {
        errors.push(`Unsupported parameter '${key}' for effect '${effectId}'.`);
      }
    }

    for (const [key, def] of Object.entries(effect.parameters)) {
      const val = rawParams[key] !== undefined ? rawParams[key] : def.default;

      if (def.type === "number") {
        if (typeof val !== "number" || !Number.isFinite(val)) {
          errors.push(`Param '${key}' must be a finite number.`);
        } else {
          if (def.min !== undefined && val < def.min) {
            errors.push(`Param '${key}' value ${val} is below minimum ${def.min}.`);
          }
          if (def.max !== undefined && val > def.max) {
            errors.push(`Param '${key}' value ${val} is above maximum ${def.max}.`);
          }
          sanitized[key] = val;
        }
      } else if (def.type === "color") {
        if (typeof val !== "string" || !hexColorRegex.test(val)) {
          errors.push(`Param '${key}' must be a hex color (#RRGGBB).`);
        } else {
          sanitized[key] = val;
        }
      } else if (def.type === "enum") {
        if (!def.choices || !def.choices.includes(val as any)) {
          errors.push(`Param '${key}' value '${val}' is not in allowed choices: ${def.choices?.join(", ")}.`);
        } else {
          sanitized[key] = val;
        }
      } else if (def.type === "boolean") {
        if (typeof val !== "boolean") {
          errors.push(`Param '${key}' must be a boolean.`);
        } else {
          sanitized[key] = val;
        }
      } else if (def.type === "string") {
        if (typeof val !== "string" || val.includes("<") || val.includes(">") || val.length > 256) {
          errors.push(`Param '${key}' must be a safe string under 256 characters.`);
        } else {
          sanitized[key] = val;
        }
      }
    }

    return { valid: errors.length === 0, errors, sanitized };
  }

  public apply(
    effectId: string,
    ctx: EffectApplyContext,
    rawParams: Record<string, unknown> = {},
  ): EffectApplyResult {
    const effect = this.get(effectId);
    if (!effect) {
      throw new Error(`Effect '${effectId}' not found.`);
    }

    const validation = this.validateParams(effectId, rawParams);
    if (!validation.valid) {
      throw new MotionValidationError(validation.errors);
    }

    const result = effect.apply(ctx, validation.sanitized);
    // Catalog presets may request longer timing than the available scene
    // window. Normalize every generated track to the requested frame range
    // before it reaches the shared renderer/schema, without executing code.
    const normalize = (track: MotionTrack): MotionTrack => createTrack(track.property,
      track.keyframes.map(keyframe => ({
        ...keyframe,
        frame: Math.max(ctx.startFrame, Math.min(ctx.endFrame, keyframe.frame)),
      })));
    return {
      ...result,
      ...(result.tracks ? { tracks: result.tracks.map(normalize) } : {}),
      ...(result.newLayers ? { newLayers: result.newLayers.map(layer => ({
        ...layer, tracks: layer.tracks.map(normalize),
      })) } : {}),
    };
  }

  public applyToProject(project: MotionProject, application: EffectApplication): MotionProject {
    const effect = this.get(application.effectId);
    if (!effect) {
      throw new Error(`Effect '${application.effectId}' not found in registry.`);
    }

    validateMotionProject(project);
    const cloned: MotionProject = JSON.parse(JSON.stringify(project));
    const comp = cloned.composition;

    let targetLayer: MotionLayer | undefined;
    if (application.targetLayerId) {
      targetLayer = comp.layers.find(l => l.id === application.targetLayerId);
      if (!targetLayer) {
        throw new Error(`Target layer '${application.targetLayerId}' not found in project.`);
      }
    }

    if (targetLayer && !effect.targetKinds.includes(targetLayer.kind)) {
      throw new MotionValidationError([`Effect '${effect.id}' does not support layer kind '${targetLayer.kind}'.`]);
    }
    if (!targetLayer && !effect.targetKinds.includes("scene")) {
      throw new MotionValidationError([`Effect '${effect.id}' requires a targetLayerId.`]);
    }
    const startFrame = application.startFrame ?? 0;
    if (!Number.isSafeInteger(startFrame) || startFrame < 0 || startFrame >= comp.durationFrames) {
      throw new MotionValidationError(["Effect startFrame must be an integer inside the composition."]);
    }
    const durationFrames = application.durationFrames ?? (comp.durationFrames - startFrame);
    if (!Number.isSafeInteger(durationFrames) || durationFrames < 1) {
      throw new MotionValidationError(["Effect durationFrames must be a positive integer."]);
    }
    const endFrame = Math.min(comp.durationFrames - 1, startFrame + durationFrames - 1);

    const aspect: "16:9" | "1:1" | "9:16" =
      comp.height > comp.width ? "9:16" : comp.height === comp.width ? "1:1" : "16:9";

    const ctx: EffectApplyContext = {
      project: cloned,
      targetLayerId: application.targetLayerId,
      targetLayer,
      startFrame,
      endFrame,
      durationFrames: endFrame - startFrame + 1,
      compositionWidth: comp.width,
      compositionHeight: comp.height,
      fps: comp.fps.numerator / comp.fps.denominator,
      backgroundColor: comp.background,
      aspectRatio: aspect,
    };

    const result = this.apply(application.effectId, ctx, application.params);

    if (result.tracks) {
      if (targetLayer) {
        // Merge tracks into target layer. Maximum 4 tracks, unique property names.
        for (const newTrack of result.tracks) {
          const existingIdx = targetLayer.tracks.findIndex(t => t.property === newTrack.property);
          if (existingIdx >= 0) {
            targetLayer.tracks[existingIdx] = newTrack;
          } else if (targetLayer.tracks.length < 4) {
            targetLayer.tracks.push(newTrack);
          } else {
            throw new MotionValidationError([`Effect '${effect.id}' exceeds the 4-track limit on '${targetLayer.id}'.`]);
          }
        }
      } else if (effect.category === "camera" || effect.category === "transition") {
        // Scene-level camera and transition tracks affect all composition layers.
        for (const layer of comp.layers) {
          for (const newTrack of result.tracks) {
            const baseVal = (layer as any)[newTrack.property] ?? 0;
            const diff = baseVal - (newTrack.keyframes[0]?.value ?? 0);
            const layerTrack: MotionTrack = {
              property: newTrack.property,
              keyframes: newTrack.keyframes.map(kf => ({
                ...kf,
                // Opacity is a multiplier, unlike positional translations.
                value: newTrack.property === "opacity" ? kf.value * layer.opacity : kf.value + diff,
              })),
            };
            const existingIdx = layer.tracks.findIndex(t => t.property === layerTrack.property);
            if (existingIdx >= 0) {
              layer.tracks[existingIdx] = layerTrack;
            } else if (layer.tracks.length < 4) {
              layer.tracks.push(layerTrack);
            } else {
              throw new MotionValidationError([`Effect '${effect.id}' exceeds the 4-track limit on '${layer.id}'.`]);
            }
          }
        }
      }
    }

    if (result.newLayers && result.newLayers.length > 0) {
      const existingIds = new Set(comp.layers.map(l => l.id));
      for (const nl of result.newLayers) {
        let uniqueId = nl.id;
        let counter = 1;
        while (existingIds.has(uniqueId)) {
          uniqueId = `${nl.id}-${counter++}`;
        }
        existingIds.add(uniqueId);
        nl.id = uniqueId;

        if (effect.category === "background") {
          // Prepend background layers behind other scene layers
          comp.layers.unshift(nl);
        } else {
          comp.layers.push(nl);
        }
      }
    }

    if (result.updatedLayers) {
      for (const update of result.updatedLayers) {
        if (!update.id) continue;
        const target = comp.layers.find(l => l.id === update.id);
        if (target) {
          Object.assign(target, update);
        }
      }
    }

    cloned.updatedAt = new Date().toISOString();
    validateMotionProject(cloned);
    return cloned;
  }
}

export const effectRegistry = new EffectRegistry();

/** Helper to construct a MotionTrack with valid ascending keyframes */
export function createTrack(
  property: MotionProperty,
  keyframes: { frame: number; value: number; easing?: MotionEasing }[],
): MotionTrack {
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  const deduped: typeof keyframes = [];
  for (const kf of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].frame === kf.frame) {
      deduped[deduped.length - 1] = kf;
    } else {
      deduped.push(kf);
    }
  }
  return { property, keyframes: deduped };
}
