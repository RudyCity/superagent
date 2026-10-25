import type { MotionProject } from "../schema/types.js";
import { renderStudioNativeHtml } from "./studioNativeCodeExporter.js";
import type { StudioCodeTrigger } from "./studioCodeExporter.js";

/**
 * Portable React 18+ / Next.js client component.
 * A sandboxed, same-size srcDoc iframe keeps generated animations isolated
 * from the host React tree (no HTML injection, global timers or styles).
 * This adapter is intentionally NOT a conversion into editable JSX layers.
 */
export function renderStudioReactComponent(project: MotionProject, trigger: StudioCodeTrigger = "autoplay"): string {
  const doc = renderStudioNativeHtml(project, trigger);
  if (Buffer.byteLength(doc) > 1024 * 1024) throw new Error("Studio React source exceeds 1MB");
  const source = JSON.stringify(doc).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const ratio = project.composition.width + " / " + project.composition.height;
  return `"use client";
import type { CSSProperties } from "react";

export interface StudioAnimationProps {
  className?: string;
  title?: string;
  style?: CSSProperties;
}

const STUDIO_OFFLINE_HTML = ${source};

/**
 * SuperAgent Studio project ${project.id}, revision ${project.revision}.
 * Fully offline, sandboxed SVG animation. No CDN dependencies.
 * This is an isolated React/Next.js wrapper, not direct editable JSX layers.
 */
export default function StudioAnimation({
  className,
  title = ${JSON.stringify(project.name)},
  style,
}: StudioAnimationProps) {
  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      loading="lazy"
      className={className}
      srcDoc={STUDIO_OFFLINE_HTML}
      style={{
        display: "block",
        width: "100%",
        aspectRatio: "${ratio}",
        border: 0,
        ...style,
      }}
    />
  );
}
`;
}
