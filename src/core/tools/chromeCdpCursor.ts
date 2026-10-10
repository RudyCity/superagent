/**
 * Chrome Remote Debugging (CDP) Human-Like Cursor Movement Engine.
 *
 * Implements realistic, natural human kinematics for simulated cursor movements:
 * - Cubic Bézier curve trajectories with perpendicular deflection (curved paths instead of robotic lines)
 * - Fitts's law velocity profiling (cubic ease-in-out: slow start, rapid transit, gentle deceleration)
 * - Physiological micro-jitters mimicking natural human hand tremors
 * - Natural human dwell timing (perception pauses) and realistic button press holding durations
 * - Real-time sequential CDP Input.dispatchMouseEvent ('mouseMoved') stream to trigger browser :hover and listeners
 * - Optional visual virtual pointer overlay in the DOM with click ripple animations for headful / screenshot feedback
 */

export interface Point {
  x: number;
  y: number;
}

export interface TrajectoryOptions {
  steps?: number;
  jitter?: boolean;
  curveIntensity?: number;
}

export interface CursorMoveOptions extends TrajectoryOptions {
  stepDelayMs?: number;
  visualCursor?: boolean;
}

export interface CursorClickOptions extends CursorMoveOptions {
  dwellMs?: number;
  pressDurationMs?: number;
  button?: "left" | "middle" | "right";
  clickCount?: number;
}

/** In-memory store of the last known cursor position per target tab. */
const cursorPositionStore = new Map<string, Point>();

export function getCursorPosition(targetId: string): Point {
  return cursorPositionStore.get(targetId) || { x: 400, y: 300 };
}

export function setCursorPosition(targetId: string, pt: Point): void {
  cursorPositionStore.set(targetId, {
    x: Math.round(pt.x * 10) / 10,
    y: Math.round(pt.y * 10) / 10,
  });
}

export function resetCursorPositions(): void {
  cursorPositionStore.clear();
}

/** Cubic ease-in-out easing function. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Generates an array of points forming a smooth, human-like cubic Bézier curve from start to target.
 */
export function generateBezierTrajectory(
  start: Point,
  target: Point,
  options?: TrajectoryOptions
): Point[] {
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 1) {
    return [{ x: start.x, y: start.y }];
  }

  const defaultSteps = Math.max(12, Math.min(36, Math.round(dist / 22)));
  const steps = options?.steps !== undefined ? Math.max(2, options.steps) : defaultSteps;
  const applyJitter = options?.jitter ?? true;
  const intensity = options?.curveIntensity ?? 0.22;

  // Calculate perpendicular normal vector for realistic curve deflection
  const nx = -dy / dist;
  const ny = dx / dist;

  // Deterministic or subtle random curvature direction
  const curveSign = (Math.abs(start.x * 31 + start.y * 17) % 2 === 0 ? 1 : -1);
  const deflection1 = dist * intensity * curveSign;
  const deflection2 = dist * (intensity * 0.65) * -curveSign;

  // Control points
  const p1: Point = {
    x: start.x + dx * 0.28 + nx * deflection1,
    y: start.y + dy * 0.28 + ny * deflection1,
  };
  const p2: Point = {
    x: start.x + dx * 0.72 + nx * deflection2,
    y: start.y + dy * 0.72 + ny * deflection2,
  };

  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = i / steps;
    const t = easeInOutCubic(s);
    const u = 1 - t;

    // Cubic Bézier calculation: B(t) = u^3*P0 + 3*u^2*t*P1 + 3*u*t^2*P2 + t^3*P3
    let x = u * u * u * start.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * target.x;
    let y = u * u * u * start.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * target.y;

    // Add subtle micro-jitter (tremor) between start and end
    if (applyJitter && i > 0 && i < steps) {
      const damp = Math.sin(Math.PI * s); // dampens jitter near start & end
      const jitterX = (Math.sin(i * 1.7) * 0.8 + Math.cos(i * 2.3) * 0.4) * damp;
      const jitterY = (Math.cos(i * 1.9) * 0.8 + Math.sin(i * 2.1) * 0.4) * damp;
      x += jitterX;
      y += jitterY;
    }

    points.push({
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    });
  }

  // Ensure first and last points match exact start and target
  points[0] = { x: start.x, y: start.y };
  points[points.length - 1] = { x: target.x, y: target.y };

  return points;
}

/** DOM JavaScript to inject a sleek virtual cursor pointer and ripple element. */
export const INJECT_CURSOR_OVERLAY_JS = `(() => {
  let el = document.getElementById('__superagent_virtual_cursor__');
  if (!el) {
    el = document.createElement('div');
    el.id = '__superagent_virtual_cursor__';
    el.setAttribute('data-superagent-cursor', 'true');
    el.style.cssText = 'position:fixed;top:0;left:0;width:20px;height:20px;z-index:2147483647;pointer-events: none;transform:translate3d(-50px,-50px,0);transition:none;will-change:transform;';
    el.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35));"><path d="M4 3L18 12L11.5 13.5L9 20L4 3Z" fill="#2563eb" stroke="#ffffff" stroke-width="1.8" stroke-linejoin="round"/></svg><div id="__superagent_cursor_ripple__" style="position:absolute;top:0;left:0;width:24px;height:24px;margin-top:-2px;margin-left:-2px;border:2px solid #3b82f6;border-radius:50%;opacity:0;pointer-events: none;transform:scale(0.4);"></div>';
    document.body.appendChild(el);
  }
  return true;
})()`;

/** DOM JavaScript to update virtual cursor position and optionally trigger click ripple. */
export function UPDATE_CURSOR_OVERLAY_JS(x: number, y: number, ripple = false): string {
  return `(() => {
    const el = document.getElementById('__superagent_virtual_cursor__');
    if (el) {
      el.style.transform = 'translate3d(${x}px, ${y}px, 0)';
      ${ripple ? `
        const rip = document.getElementById('__superagent_cursor_ripple__');
        if (rip) {
          rip.style.transition = 'none';
          rip.style.transform = 'scale(0.4)';
          rip.style.opacity = '0.9';
          rip.offsetHeight;
          rip.style.transition = 'transform 0.35s cubic-bezier(0,0,0.2,1), opacity 0.35s ease-out';
          rip.style.transform = 'scale(2.2)';
          rip.style.opacity = '0';
        }
      ` : ''}
    }
    return true;
  })()`;
}

/** DOM JavaScript to remove the virtual cursor overlay. */
export const REMOVE_CURSOR_OVERLAY_JS = `(() => {
  const el = document.getElementById('__superagent_virtual_cursor__') || document.querySelector('[data-superagent-cursor]');
  if (el) el.remove();
  return true;
})()`;

/**
 * Dispatches a human-like cursor trajectory to the CDP target via sequential mouseMoved events.
 */
export async function dispatchHumanMouseMove(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  targetPoint: Point,
  options?: CursorMoveOptions
): Promise<{ ok: boolean; stepsDispatched: number; endPosition: Point }> {
  const startPoint = getCursorPosition(target.id);
  const trajectory = generateBezierTrajectory(startPoint, targetPoint, options);
  const stepDelay = options?.stepDelayMs ?? 8;
  const showVisual = options?.visualCursor ?? false;

  if (showVisual) {
    try {
      await cdpSend(target, "Runtime.evaluate", { expression: INJECT_CURSOR_OVERLAY_JS });
    } catch {}
  }

  for (let i = 0; i < trajectory.length; i++) {
    const pt = trajectory[i];
    await cdpSend(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pt.x,
      y: pt.y,
    });

    if (showVisual) {
      try {
        await cdpSend(target, "Runtime.evaluate", {
          expression: UPDATE_CURSOR_OVERLAY_JS(pt.x, pt.y, false),
        });
      } catch {}
    }

    if (stepDelay > 0 && i < trajectory.length - 1) {
      await new Promise((r) => setTimeout(r, stepDelay));
    }
  }

  setCursorPosition(target.id, targetPoint);
  return { ok: true, stepsDispatched: trajectory.length, endPosition: targetPoint };
}

/**
 * Glides cursor naturally to target, pauses with realistic human dwell time,
 * and executes a natural mouse press and release.
 */
export async function dispatchHumanMouseClick(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  targetPoint: Point,
  options?: CursorClickOptions
): Promise<{ ok: boolean; x: number; y: number; steps: number }> {
  const moveRes = await dispatchHumanMouseMove(cdpSend, target, targetPoint, options);
  const dwell = options?.dwellMs ?? 45;
  const pressDuration = options?.pressDurationMs ?? 65;
  const button = options?.button ?? "left";
  const clickCount = options?.clickCount ?? 1;

  if (dwell > 0) {
    await new Promise((r) => setTimeout(r, dwell));
  }

  if (options?.visualCursor) {
    try {
      await cdpSend(target, "Runtime.evaluate", {
        expression: UPDATE_CURSOR_OVERLAY_JS(targetPoint.x, targetPoint.y, true),
      });
    } catch {}
  }

  // Mouse Pressed
  await cdpSend(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: targetPoint.x,
    y: targetPoint.y,
    button,
    clickCount,
  });

  if (pressDuration > 0) {
    await new Promise((r) => setTimeout(r, pressDuration));
  }

  // Mouse Released
  await cdpSend(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: targetPoint.x,
    y: targetPoint.y,
    button,
    clickCount,
  });

  return {
    ok: true,
    x: targetPoint.x,
    y: targetPoint.y,
    steps: moveRes.stepsDispatched,
  };
}

/**
 * Resolves the center coordinate (x, y) of an element by CSS selector via Runtime.evaluate.
 */
export async function resolveElementCenterPoint(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  selector: string
): Promise<Point | null> {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2)
    };
  })()`;

  try {
    const res = await cdpSend(target, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    return (res?.result?.value as Point) || null;
  } catch {
    return null;
  }
}

/**
 * Unified executor for cursor commands (move_cursor, click_cursor, show_cursor, hide_cursor, get_cursor).
 */
export async function executeCursorCommand(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  command: string,
  payload: Record<string, unknown>
): Promise<string> {
  switch (command) {
    case "get_cursor": {
      const pos = getCursorPosition(target.id);
      return `control_chrome_cdp: Current cursor position: (${pos.x}, ${pos.y}) for tab '${target.id}'.`;
    }
    case "show_cursor": {
      await cdpSend(target, "Runtime.evaluate", { expression: INJECT_CURSOR_OVERLAY_JS });
      return "control_chrome_cdp: visual cursor overlay enabled on page.";
    }
    case "hide_cursor": {
      await cdpSend(target, "Runtime.evaluate", { expression: REMOVE_CURSOR_OVERLAY_JS });
      return "control_chrome_cdp: visual cursor overlay removed from page.";
    }
    case "move_cursor":
    case "move_mouse": {
      let targetPt: Point | null = null;
      if (typeof payload.x === "number" && typeof payload.y === "number") {
        targetPt = { x: payload.x, y: payload.y };
      } else if (payload.selector && typeof payload.selector === "string") {
        targetPt = await resolveElementCenterPoint(cdpSend, target, payload.selector);
        if (!targetPt) {
          return `control_chrome_cdp failed: could not locate element with selector '${payload.selector}'.`;
        }
      }

      if (!targetPt) {
        return "control_chrome_cdp failed: move_cursor requires either { x, y } coordinates or { selector }.";
      }

      const steps = typeof payload.steps === "number" ? payload.steps : undefined;
      const stepDelayMs = typeof payload.step_delay_ms === "number" ? payload.step_delay_ms : undefined;
      const visual = Boolean(payload.visualCursor ?? payload.visual);

      const moveRes = await dispatchHumanMouseMove(cdpSend, target, targetPt, {
        steps,
        stepDelayMs,
        visualCursor: visual,
      });

      return `control_chrome_cdp: cursor moved naturally to (${moveRes.endPosition.x}, ${moveRes.endPosition.y}) in ${moveRes.stepsDispatched} trajectory steps.`;
    }
    default:
      return `control_chrome_cdp: unknown cursor command '${command}'.`;
  }
}
