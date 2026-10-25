import type { MotionLayer, MotionProject, MotionTrack } from "../schema/types.js";
import type { StudioCodeTrigger } from "./studioCodeExporter.js";
import { validateMotionProject } from "../schema/validation.js";

/**
 * P4 experimental direct JSX source, not an iframe adapter. Every vector/text
 * layer is emitted as an individual SVG JSX node which can be edited in code.
 * Does not inline untrusted HTML, eval, network resources, or npm packages.
 */
function literal(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function elementOf(layer: MotionLayer, index: number): string {
  const state = "layer" + index;
  const props = [
    "key={" + literal(layer.id) + "}",
    "data-studio-id={" + literal(layer.id) + "}",
    "data-studio-index={" + index + "}",
    "transform={transform(" + state + ", SCENE_LAYERS[" + index + "].width, SCENE_LAYERS[" + index + "].height)}",
    "opacity={" + state + ".opacity}",
  ].join(" ");
  let inner: string;
  if (layer.kind === "rect") {
    inner = "<rect width={" + layer.width + "} height={" + layer.height +
      "} rx={" + (layer.cornerRadius ?? 0) + "} fill={" + literal(layer.fill) + "} />";
  } else if (layer.kind === "text") {
    inner = "<text x={0} y={" + layer.fontSize + "} fontSize={" + layer.fontSize +
      "} fontFamily={" + literal(layer.fontFamily) + "} fill={" + literal(layer.fill) +
      "}>{" + literal(layer.text) + "}</text>";
  } else if (layer.kind === "path") {
    inner = "<path d={" + literal(layer.d) + "} fill={" + literal(layer.fill) +
      "} fillRule={" + literal(layer.fillRule ?? "nonzero") + "}" +
      (layer.stroke ? " stroke={" + literal(layer.stroke) + "}" : "") +
      (layer.strokeWidth !== undefined ? " strokeWidth={" + layer.strokeWidth + "}" : "") +
      (layer.strokeDasharray?.length
        ? " strokeDasharray={" + literal(layer.strokeDasharray.join(" ")) + "}" : "") +
      " strokeDashoffset={" + state + ".strokeDashoffset} />";
  } else {
    throw new Error("Editable React JSX supports only rect, path and text Studio layers");
  }
  return "        <g " + props + ">\n          " + inner + "\n        </g>";
}

export function renderStudioEditableReactComponent(
  project: MotionProject, trigger: StudioCodeTrigger = "autoplay",
): string {
  validateMotionProject(project);
  if (!["autoplay", "click", "hover", "scroll"].includes(trigger))
    throw new Error("Unsupported Studio JSX trigger");
  const c = project.composition;
  if (c.layers.some(layer => layer.kind === "image" || layer.kind === "video"))
    throw new Error("Editable React JSX requires vector/text-only layers; import image/video as vectors first");
  if (c.audio || c.audioTracks?.length)
    throw new Error("Editable React JSX does not embed audio; export audio separately");
  if (c.interactionGraph?.bindings.length)
    throw new Error("Editable React JSX does not yet translate Interaction Graph bindings; use HTML or sandboxed React");
  if (c.layers.length > 96) throw new Error("Editable React JSX supports up to 96 vector layers");
  const data = c.layers.map(layer => ({
    id: layer.id, width: layer.width, height: layer.height,
    x: layer.x, y: layer.y, opacity: layer.opacity,
    rotation: layer.rotation, scaleX: layer.scaleX ?? layer.scale ?? 1,
    scaleY: layer.scaleY ?? layer.scale ?? 1,
    strokeDashoffset: layer.kind === "path" ? layer.strokeDashoffset ?? 0 : 0,
    tracks: layer.tracks satisfies MotionTrack[],
  }));
  const nodes = c.layers.map((layer, index) => elementOf(layer, index)).join("\n");
  const stateNames = c.layers.map((_, index) =>
    "  const layer" + index + " = evaluateLayer(SCENE_LAYERS[" + index + "], frame);").join("\n");
  const fps = c.fps.numerator / c.fps.denominator;
  const duration = c.durationFrames / fps;
  const output = `"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Editable first-party Studio React / Next.js SVG export.
 * Project ${project.id}, revision ${project.revision}.
 * Vector/text layer nodes below can be edited as ordinary JSX.
 * No embedded sandbox document, CDN, or network dependencies.
 * Raster/video/audio/Interaction Graph effects are intentionally unsupported.
 */
export interface StudioAnimationProps {
  className?: string;
  title?: string;
  style?: CSSProperties;
}

type StudioKey = { frame: number; value: number; easing?: string };
type StudioTrack = { property: string; keyframes: StudioKey[] };
type StudioState = {
  x: number; y: number; opacity: number; rotation: number;
  scaleX: number; scaleY: number; strokeDashoffset: number;
};
type StudioLayer = StudioState & { id: string; width: number; height: number; tracks: StudioTrack[] };

const FPS = ${fps};
const DURATION_FRAMES = ${c.durationFrames};
const DURATION = ${duration};
const TRIGGER = String(${literal(trigger)});
const SCENE_LAYERS: StudioLayer[] = ${literal(data)};

function easing(fraction: number, name = "linear"): number {
  const t = fraction;
  if (name === "step") return 0;
  if (name === "easeIn") return t * t;
  if (name === "easeOut") return t * (2 - t);
  if (name === "easeInOut") return t * t * (3 - 2 * t);
  if (name === "easeOutCubic") return 1 - Math.pow(1 - t, 3);
  if (name === "easeOutQuart") return 1 - Math.pow(1 - t, 4);
  if (name === "easeOutExpo") return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  if (name === "apple") return 1 - Math.pow(1 - t, 3.8);
  if (name === "spring") return 1 - Math.exp(-4.5 * t) * Math.cos(4.2 * t * Math.PI);
  if (name === "easeOutBack") {
    const u = t - 1; return 1 + 2.70158 * u * u * u + 1.70158 * u * u;
  }
  if (name === "bounce") {
    const n = 7.5625, d = 2.75;
    let v = t;
    if (v < 1 / d) return n * v * v;
    if (v < 2 / d) { v -= 1.5 / d; return n * v * v + .75; }
    if (v < 2.5 / d) { v -= 2.25 / d; return n * v * v + .9375; }
    v -= 2.625 / d; return n * v * v + .984375;
  }
  return t;
}
function trackValue(track: StudioTrack, frame: number): number {
  const keys = track.keyframes;
  if (frame <= keys[0].frame) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (frame <= b.frame) {
      const t = (frame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * easing(t, a.easing);
    }
  }
  return keys[keys.length - 1].value;
}
function evaluateLayer(layer: StudioLayer, frame: number): StudioState {
  const state: StudioState = {
    x: layer.x, y: layer.y, opacity: layer.opacity, rotation: layer.rotation,
    scaleX: layer.scaleX, scaleY: layer.scaleY, strokeDashoffset: layer.strokeDashoffset,
  };
  for (const track of layer.tracks) {
    const value = trackValue(track, frame);
    if (track.property === "scale") {
      state.scaleX = value; state.scaleY = value;
    } else if (track.property in state) {
      (state as unknown as Record<string, number>)[track.property] = value;
    }
  }
  return state;
}
function transform(values: StudioState, width: number, height: number): string {
  // Match Studio native SVG: translation then rotation and scale around the
  // visual layer center. Rotate/scale at the origin would visibly drift.
  const cx = width / 2, cy = height / 2;
  return "translate(" + values.x + " " + values.y + ") translate(" +
    cx + " " + cy + ") rotate(" + values.rotation + ") scale(" +
    values.scaleX + " " + values.scaleY + ") translate(" + (-cx) + " " + (-cy) + ")";
}

/** Deterministic direct JSX scene. Position and text nodes are editable below. */
export default function StudioAnimation({
  className, title = ${literal(project.name)}, style,
}: StudioAnimationProps) {
  const [seconds, setSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const startScroll = useRef<number | null>(null);
  useEffect(() => {
    if (TRIGGER !== "autoplay") return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) setSeconds(DURATION);
    else setPlaying(true);
  }, []);
  useEffect(() => {
    if (!playing) return;
    let raf = 0, last = 0;
    function tick(now: number) {
      const delta = last ? Math.min((now - last) / 1000, .25) : 0;
      last = now;
      setSeconds(current => {
        const next = Math.min(DURATION, current + delta);
        return next;
      });
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  useEffect(() => {
    if (playing && seconds >= DURATION) setPlaying(false);
  }, [playing, seconds]);
  useEffect(() => {
    if (TRIGGER !== "scroll") return;
    const handle = () => {
      if (startScroll.current === null) startScroll.current = window.scrollY;
      const progress = Math.max(0, Math.min(1, (window.scrollY - startScroll.current) /
        Math.max(window.innerHeight, 1)));
      setPlaying(false);
      setSeconds(progress * DURATION);
    };
    window.addEventListener("scroll", handle, { passive: true });
    return () => window.removeEventListener("scroll", handle);
  }, []);
  const seek = (value: number) => {
    setPlaying(false);
    setSeconds(Math.max(0, Math.min(DURATION, value)));
  };
  const replay = () => { setSeconds(0); setPlaying(true); };
  const frame = Math.min(DURATION_FRAMES - 1, seconds * FPS);
${stateNames}
  return (
    <section className={className} style={{ width: "100%", ...style }}>
      <svg
        id="studio-stage" role="img" aria-label={title}
        viewBox="0 0 ${c.width} ${c.height}"
        width="100%" xmlns="http://www.w3.org/2000/svg"
        tabIndex={0}
        onClick={TRIGGER === "click" ? replay : undefined}
        onKeyDown={TRIGGER === "click" ? event => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); replay(); }
        } : undefined}
        onMouseEnter={TRIGGER === "hover" ? replay : undefined}
        onMouseLeave={TRIGGER === "hover" ? () => setPlaying(false) : undefined}
        onFocus={TRIGGER === "hover" ? replay : undefined}
      >
        <rect width={${c.width}} height={${c.height}} fill={${literal(c.background)}} />
${nodes}
      </svg>
      <div className="studio-animation-controls" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="button" onClick={() => setPlaying(current => !current)}>Play / Pause</button>
        <button type="button" onClick={replay}>Replay</button>
        <input type="range" aria-label="Animation timeline" min={0} max={1000}
          value={Math.round(seconds / DURATION * 1000)}
          onChange={event => seek(Number(event.currentTarget.value) / 1000 * DURATION)}
          style={{ flex: 1 }} />
        <output>{seconds.toFixed(1) + "s / " + DURATION.toFixed(1) + "s"}</output>
      </div>
    </section>
  );
}
`;
  if (Buffer.byteLength(output, "utf8") > 2 * 1024 * 1024)
    throw new Error("Editable React JSX source exceeds 2MiB");
  return output;
}
