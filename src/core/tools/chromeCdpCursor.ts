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

import { snapshotStore } from "./chromeCdpHelpers.js";

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
  smooth?: boolean;
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

export interface DragAndDropOptions extends CursorMoveOptions {
  startDwellMs?: number;
  holdDurationMs?: number;
  dropDwellMs?: number;
  mode?: "mouse" | "html5" | "both";
  button?: "left" | "middle" | "right";
  sourceSelector?: string;
  targetSelector?: string;
  useThreshold?: boolean;
}

/** DOM JavaScript to trigger synthetic HTML5 drag-and-drop events via DataTransfer. */
export function buildHtml5DragDropJs(sourceSelector: string, targetSelector: string): string {
  return `(() => {
    function findEl(sel) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (e) {}
      function walk(root) {
        const all = root.querySelectorAll('*');
        for (let i = 0; i < all.length; i++) {
          if (all[i].shadowRoot) {
            try {
              const found = all[i].shadowRoot.querySelector(sel) || walk(all[i].shadowRoot);
              if (found) return found;
            } catch (e) {}
          }
        }
        return null;
      }
      return walk(document);
    }
    const src = findEl(${JSON.stringify(sourceSelector)});
    const dst = findEl(${JSON.stringify(targetSelector)});
    if (!src) return { ok: false, error: "source element not found: " + ${JSON.stringify(sourceSelector)} };
    if (!dst) return { ok: false, error: "target element not found: " + ${JSON.stringify(targetSelector)} };
    try { src.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    try { dst.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    let dt;
    try {
      dt = new DataTransfer();
    } catch (e) {
      dt = { data: {}, setData: function(k, v) { this.data[k] = v; }, getData: function(k) { return this.data[k]; } };
    }
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dst.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { ok: true, sourceTag: src.tagName.toLowerCase(), targetTag: dst.tagName.toLowerCase() };
  })()`;
}

/**
 * Executes a realistic human-like drag and drop sequence using CDP mouse events
 * (with buttons: 1 bitmask maintained across trajectory), and optionally HTML5 drag events.
 */
export async function dispatchHumanDragAndDrop(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  startPoint: Point,
  targetPoint: Point,
  options?: DragAndDropOptions
): Promise<{
  ok: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  steps: number;
  mode: string;
}> {
  const mode = options?.mode || "mouse";
  const button = options?.button || "left";
  const visual = Boolean(options?.visualCursor);
  let totalSteps = 0;

  if (mode === "mouse" || mode === "both") {
    // 1. Move smoothly to source start point
    const preMove = await dispatchHumanMouseMove(cdpSend, target, startPoint, {
      steps: 8,
      visualCursor: visual,
    });
    totalSteps += preMove.stepsDispatched;

    // 2. Pause naturally over source element
    const startDwell = options?.startDwellMs ?? 50;
    if (startDwell > 0) {
      await new Promise((r) => setTimeout(r, startDwell));
    }

    // 3. Mouse Pressed (mousedown with buttons: 1)
    await cdpSend(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: startPoint.x,
      y: startPoint.y,
      button,
      buttons: 1,
      clickCount: 1,
    });

    if (visual) {
      try {
        await cdpSend(target, "Runtime.evaluate", {
          expression: UPDATE_CURSOR_OVERLAY_JS(startPoint.x, startPoint.y, true),
        });
      } catch {}
    }

    // 4. Hold duration before movement to allow drag listeners to register
    const holdDuration = options?.holdDurationMs ?? 60;
    if (holdDuration > 0) {
      await new Promise((r) => setTimeout(r, holdDuration));
    }

    // 5. Initial drag threshold nudge (triggers drag threshold in React DnD, SortableJS, etc.)
    const dx = targetPoint.x - startPoint.x;
    const dy = targetPoint.y - startPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (options?.useThreshold !== false && dist > 8) {
      const thresholdX = Math.round((startPoint.x + (dx / dist) * 5) * 10) / 10;
      const thresholdY = Math.round((startPoint.y + (dy / dist) * 5) * 10) / 10;
      await cdpSend(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: thresholdX,
        y: thresholdY,
        button,
        buttons: 1,
      });
    }

    // 6. Multi-step trajectory interpolation to target
    const trajectory = generateBezierTrajectory(startPoint, targetPoint, options);
    const stepDelay = options?.stepDelayMs ?? 8;
    for (let i = 0; i < trajectory.length; i++) {
      const pt = trajectory[i];
      await cdpSend(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: pt.x,
        y: pt.y,
        button,
        buttons: 1,
      });

      if (visual) {
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
    totalSteps += trajectory.length;

    // 7. Drop Dwell over target before releasing
    const dropDwell = options?.dropDwellMs ?? 60;
    if (dropDwell > 0) {
      await new Promise((r) => setTimeout(r, dropDwell));
    }

    // 8. Mouse Released (mouseup with buttons: 0)
    await cdpSend(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: targetPoint.x,
      y: targetPoint.y,
      button,
      buttons: 0,
      clickCount: 1,
    });

    setCursorPosition(target.id, targetPoint);
  }

  if (mode === "html5" || mode === "both") {
    if (options?.sourceSelector && options?.targetSelector) {
      try {
        await cdpSend(target, "Runtime.evaluate", {
          expression: buildHtml5DragDropJs(options.sourceSelector, options.targetSelector),
          returnByValue: true,
        });
      } catch {}
    }

    // Native CDP Drag events
    try {
      await cdpSend(target, "Input.dispatchDragEvent", {
        type: "dragEnter",
        x: targetPoint.x,
        y: targetPoint.y,
        data: { dragOperationsMask: 1, items: [] },
      });
      await cdpSend(target, "Input.dispatchDragEvent", {
        type: "dragOver",
        x: targetPoint.x,
        y: targetPoint.y,
        data: { dragOperationsMask: 1, items: [] },
      });
      await cdpSend(target, "Input.dispatchDragEvent", {
        type: "drop",
        x: targetPoint.x,
        y: targetPoint.y,
        data: { dragOperationsMask: 1, items: [] },
      });
    } catch {}
  }

  return {
    ok: true,
    startX: startPoint.x,
    startY: startPoint.y,
    endX: targetPoint.x,
    endY: targetPoint.y,
    steps: totalSteps,
    mode,
  };
}

/** Resolves source or target position from coordinates, index, selector, or relative delta. */
async function resolveDragLocation(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  role: "source" | "target",
  payload: Record<string, unknown>,
  referencePoint?: Point
): Promise<{ point: Point | null; desc: string; selector?: string; error?: string }> {
  // 1. Direct coordinates
  let x: unknown = role === "source"
    ? (payload.sourceX ?? payload.fromX ?? payload.startX)
    : (payload.targetX ?? payload.toX ?? payload.endX);
  let y: unknown = role === "source"
    ? (payload.sourceY ?? payload.fromY ?? payload.startY)
    : (payload.targetY ?? payload.toY ?? payload.endY);

  const obj = role === "source" ? payload.source : payload.target;
  if (typeof obj === "object" && obj !== null) {
    if ("x" in obj) x = (obj as any).x;
    if ("y" in obj) y = (obj as any).y;
  }

  if (typeof x === "number" && typeof y === "number") {
    return { point: { x, y }, desc: `coordinates (${x}, ${y})` };
  }

  // 2. Relative offset (target only)
  if (role === "target") {
    const dx = payload.dx ?? payload.deltaX ?? payload.delta_x;
    const dy = payload.dy ?? payload.deltaY ?? payload.delta_y;
    if (typeof dx === "number" || typeof dy === "number") {
      const base = referencePoint || getCursorPosition(target.id);
      const targetPt = {
        x: base.x + Number(dx || 0),
        y: base.y + Number(dy || 0),
      };
      const signX = Number(dx || 0) >= 0 ? "+" : "";
      const signY = Number(dy || 0) >= 0 ? "+" : "";
      return {
        point: targetPt,
        desc: `offset (${signX}${dx || 0}, ${signY}${dy || 0}) to (${targetPt.x}, ${targetPt.y})`,
      };
    }
  }

  // 3. Index lookup
  let rawIdx: unknown = role === "source"
    ? (payload.sourceIndex ?? payload.source_index ?? payload.fromIndex)
    : (payload.targetIndex ?? payload.target_index ?? payload.toIndex);
  if (rawIdx === undefined && typeof obj === "number") {
    rawIdx = obj;
  }

  if (typeof rawIdx === "number" && Number.isInteger(rawIdx)) {
    const entries = snapshotStore.get(target.id);
    if (!entries) {
      return {
        point: null,
        desc: `index ${rawIdx}`,
        error: `control_chrome_cdp failed: no snapshot for tab '${target.id}'. Run 'snapshot' first before referencing index ${rawIdx}.`,
      };
    }
    const entry = entries[rawIdx];
    if (!entry) {
      return {
        point: null,
        desc: `index ${rawIdx}`,
        error: `control_chrome_cdp failed: index ${rawIdx} out of range — snapshot has ${entries.length} elements (0..${entries.length - 1}).`,
      };
    }
    const center = await resolveElementCenterPoint(cdpSend, target, entry.selector);
    if (!center) {
      return {
        point: null,
        desc: `index ${rawIdx} (${entry.selector})`,
        error: `control_chrome_cdp failed: element at index ${rawIdx} (${entry.selector}) could not be resolved in the DOM.`,
      };
    }
    const tag = entry.tag || "element";
    const label = (entry.text || entry.ariaLabel || entry.name || entry.selector || "").replace(/\s+/g, " ").trim();
    return {
      point: center,
      desc: `index ${rawIdx} (<${tag}> "${label.slice(0, 40)}")`,
      selector: entry.selector,
    };
  }

  // 4. Selector lookup
  let rawSel: unknown = role === "source"
    ? (payload.sourceSelector ?? payload.source_selector ?? payload.fromSelector)
    : (payload.targetSelector ?? payload.target_selector ?? payload.toSelector);
  if (rawSel === undefined && typeof obj === "string") {
    rawSel = obj;
  }

  if (typeof rawSel === "string" && rawSel.trim()) {
    const sel = rawSel.trim();
    const center = await resolveElementCenterPoint(cdpSend, target, sel);
    if (!center) {
      return {
        point: null,
        desc: `selector '${sel}'`,
        error: `control_chrome_cdp failed: could not locate element with selector '${sel}'.`,
      };
    }
    return { point: center, desc: `selector '${sel}'`, selector: sel };
  }

  // 5. Default fallback for source only: current cursor position
  if (role === "source") {
    const current = getCursorPosition(target.id);
    return { point: current, desc: `current cursor position (${current.x}, ${current.y})` };
  }

  return {
    point: null,
    desc: "unknown target",
    error: "control_chrome_cdp failed: drag_and_drop requires a target (targetSelector, targetIndex, target {x,y}, or dx/dy offsets).",
  };
}

/** Unified executor for drag-and-drop command in control_chrome_cdp. */
export async function executeDragAndDropCommand(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  payload: Record<string, unknown>
): Promise<string> {
  const sourceRes = await resolveDragLocation(cdpSend, target, "source", payload);
  if (sourceRes.error) return sourceRes.error;
  if (!sourceRes.point) return "control_chrome_cdp failed: could not determine source position for drag_and_drop.";

  const targetRes = await resolveDragLocation(cdpSend, target, "target", payload, sourceRes.point);
  if (targetRes.error) return targetRes.error;
  if (!targetRes.point) return "control_chrome_cdp failed: could not determine target position for drag_and_drop.";

  const mode = payload.mode === "html5" || payload.mode === "both" ? payload.mode : "mouse";
  const smooth = payload.smooth !== false;
  const steps = typeof payload.steps === "number" ? payload.steps : undefined;
  const stepDelayMs = typeof payload.step_delay_ms === "number"
    ? payload.step_delay_ms
    : (typeof payload.stepDelayMs === "number" ? payload.stepDelayMs : undefined);
  const holdDurationMs = typeof payload.hold_duration_ms === "number"
    ? payload.hold_duration_ms
    : (typeof payload.holdDurationMs === "number" ? payload.holdDurationMs : undefined);
  const dropDwellMs = typeof payload.drop_dwell_ms === "number"
    ? payload.drop_dwell_ms
    : (typeof payload.dropDwellMs === "number" ? payload.dropDwellMs : undefined);
  const visualCursor = Boolean(payload.visualCursor ?? payload.visual);

  const res = await dispatchHumanDragAndDrop(cdpSend, target, sourceRes.point, targetRes.point, {
    mode,
    smooth,
    steps,
    stepDelayMs,
    holdDurationMs,
    dropDwellMs,
    visualCursor,
    sourceSelector: sourceRes.selector,
    targetSelector: targetRes.selector,
  });

  return `control_chrome_cdp: dragged successfully from ${sourceRes.desc} to ${targetRes.desc} in ${res.steps} trajectory steps [mode: ${res.mode}].`;
}

