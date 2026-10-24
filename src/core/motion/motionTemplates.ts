import type { MotionLayer, MotionProject, MotionTrack } from "./schema/types.js";
import { validateMotionProject, MotionValidationError } from "./schema/validation.js";
import type { MotionBrandKit } from "./motionBrandKit.js";

interface TemplateDefinition {
  id: string; name: string; category: string; description: string;
  align: "left" | "center" | "right";
  tone: "bold" | "clean" | "calm";
}
const templates: readonly TemplateDefinition[] = [
  { id: "product-launch", name: "Product Launch", category: "Marketing", description: "Bold opening headline, launch badge and animated divider", align: "left", tone: "bold" },
  { id: "saas-feature", name: "SaaS Feature", category: "SaaS", description: "Feature showcase with structured tech callout", align: "left", tone: "clean" },
  { id: "social-announcement", name: "Social Announcement", category: "Social", description: "High-impact centered announcement for short promos", align: "center", tone: "bold" },
  { id: "editorial-story", name: "Editorial Story", category: "Editorial", description: "Spacious magazine-style title and underline", align: "left", tone: "calm" },
  { id: "customer-quote", name: "Customer Quote", category: "Testimonials", description: "Quiet quote reveal with understated accent block", align: "center", tone: "calm" },
  { id: "tech-update", name: "Tech Update", category: "Technology", description: "Right-aligned headline, progress accent and kinetic highlights", align: "right", tone: "clean" },
  { id: "terminal-promo", name: "Terminal Promo", category: "Developer", description: "Cyberpunk terminal console with traffic lights, code prompt, and kinetic telemetry", align: "left", tone: "bold" },
];
export function listMotionTemplates(): Array<TemplateDefinition & { origin: "superagent-original" }> {
  return templates.map(item => ({ ...item, origin: "superagent-original" }));
}
export interface MotionTemplateInput {
  templateId: string;
  headline?: string;
  subtitle?: string;
}
const fit = (size: number, min: number, max: number) => Math.max(min, Math.min(size, max));
export function compileMotionTemplate(
  project: MotionProject, brand: MotionBrandKit, input: MotionTemplateInput,
): MotionProject["composition"] {
  validateMotionProject(project);
  const template = templates.find(item => item.id === input.templateId);
  if (!template) throw new MotionValidationError(["Unknown Motion template"]);
  if ((input.headline !== undefined && (typeof input.headline !== "string" ||
      !input.headline.trim() || input.headline.length > 120)) ||
      (input.subtitle !== undefined && (typeof input.subtitle !== "string" || input.subtitle.length > 160))) {
    throw new MotionValidationError(["Template headline or subtitle is invalid"]);
  }
  const c = project.composition;
  const w = c.width, h = c.height, duration = c.durationFrames;
  const pad = Math.round(w * .075);
  const contentWidth = Math.round(w * .85);
  const baseSize = template.tone === "bold" ? 100 : template.tone === "clean" ? 80 : 84;
  const headline = input.headline?.trim() ?? template.name;
  const subtitle = input.subtitle?.trim() ?? template.description;
  const fontSize = fit(Math.min(h * .115, w * .085,
    contentWidth * 1.9 / Math.max(12, headline.length), baseSize * w / 1280), 20, 150);
  const headlineHeight = Math.max(45, Math.round(fontSize * 1.9));
  const titleY = Math.round(h * (template.align === "center" ? .39 : .30));
  const subtitleSize = fit(Math.min(38, h * .038, w * .025), 12, 50);
  const alignX = (text: string, size: number) => {
    const visualWidth = Math.min(contentWidth, size * .54 * text.length);
    if (template.align === "center") return Math.round((w - visualWidth) / 2);
    if (template.align === "right") return Math.round(w - pad - visualWidth);
    return pad;
  };
  const headlineX = alignX(headline, fontSize);
  const subtitleX = alignX(subtitle, subtitleSize);
  const start = Math.min(duration - 1, 2);
  const finish = Math.max(start, Math.min(duration - 1, Math.round(duration * .16)));
  const reveal = (): MotionTrack[] => [{ property: "opacity", keyframes: finish === start
    ? [{ frame: start, value: 1 }]
    : [{ frame: start, value: 0, easing: "easeInOut" }, { frame: finish, value: 1 }] }];
  const titleTracks = (): MotionTrack[] => {
    const result = reveal();
    if (finish > start) result.push({ property: "y", keyframes: [
      { frame: start, value: titleY + Math.round(h * .07), easing: "easeInOut" },
      { frame: finish, value: titleY },
    ] });
    return result;
  };
  const accentWidth = Math.round(w * .16);
  const accentX = template.align === "center" ? Math.round((w - accentWidth) / 2) :
    template.align === "right" ? w - pad - accentWidth : pad;
  const layers: MotionLayer[] = [
    { id: "brand-panel", kind: "rect", x: Math.round(w * .045), y: Math.round(h * .09),
      width: Math.round(w * .91), height: Math.round(h * .82),
      fill: brand.primary, opacity: template.tone === "calm" ? .085 : .13,
      rotation: 0, cornerRadius: Math.round(Math.min(w, h) * .035), tracks: [] },
    { id: "brand-accent", kind: "rect", x: accentX,
      y: Math.round(h * .72), width: accentWidth, height: fit(Math.round(h * .014), 4, 28),
      fill: brand.accent, opacity: 1, rotation: 0, tracks: reveal() },
    { id: "headline", kind: "text", x: headlineX, y: titleY, width: contentWidth, height: headlineHeight,
      rotation: 0, opacity: 1, fill: brand.textColor, tracks: titleTracks(),
      text: headline, fontSize, fontFamily: brand.fontFamily },
    { id: "subtitle", kind: "text", x: subtitleX, y: Math.max(0, Math.min(h - 70, titleY + headlineHeight + Math.round(h * .035))),
      width: contentWidth, height: Math.max(32, Math.round(h * .11)),
      rotation: 0, opacity: 1, fill: brand.textColor, tracks: reveal(),
      text: subtitle, fontSize: subtitleSize,
      fontFamily: brand.fontFamily },
  ];
  if (brand.logoAssetId) {
    layers.push({ id: "brand-logo", kind: "image", assetId: brand.logoAssetId,
      x: template.align === "right" ? pad : Math.round(w * .72), y: Math.round(h * .12),
      width: Math.round(w * .17), height: Math.round(h * .14),
      fill: "#FFFFFF", opacity: 1, rotation: 0, tracks: reveal() });
  }
  if (template.id === "terminal-promo") {
    const termW = Math.round(w * 0.91);
    const termX = Math.round(w * 0.045);
    const termY = Math.round(h * 0.09);
    layers.unshift(
      { id: "terminal-accent-strip", kind: "rect", x: termX + 24, y: termY, width: Math.min(termW - 48, 240), height: 4,
        cornerRadius: 2, rotation: 0, opacity: 1, fill: brand.accent, tracks: reveal() },
      { id: "terminal-dot-red", kind: "rect", x: termX + 24, y: termY + 20, width: 12, height: 12,
        cornerRadius: 6, rotation: 0, opacity: 1, fill: "#EF4444", tracks: reveal() },
      { id: "terminal-dot-yellow", kind: "rect", x: termX + 44, y: termY + 20, width: 12, height: 12,
        cornerRadius: 6, rotation: 0, opacity: 1, fill: "#F59E0B", tracks: reveal() },
      { id: "terminal-dot-green", kind: "rect", x: termX + 64, y: termY + 20, width: 12, height: 12,
        cornerRadius: 6, rotation: 0, opacity: 1, fill: "#10B981", tracks: reveal() },
      { id: "terminal-divider", kind: "rect", x: termX, y: termY + 44, width: termW, height: 1,
        rotation: 0, opacity: 0.35, fill: "#334155", tracks: reveal() },
    );
  }
  const composition: MotionProject["composition"] = {
    width: w, height: h, fps: structuredClone(c.fps), durationFrames: duration,
    background: brand.background, layers,
    ...(c.audio ? { audio: structuredClone(c.audio) } : {}),
    ...(c.audioTracks ? { audioTracks: structuredClone(c.audioTracks) } : {}),
  };
  validateMotionProject({ ...project, composition });
  return composition;
}
