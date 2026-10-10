import { describe, test, expect, beforeEach } from "vitest";
import {
  Point,
  generateBezierTrajectory,
  getCursorPosition,
  setCursorPosition,
  resetCursorPositions,
  dispatchHumanMouseMove,
  dispatchHumanMouseClick,
  executeCursorCommand,
  INJECT_CURSOR_OVERLAY_JS,
  UPDATE_CURSOR_OVERLAY_JS,
  REMOVE_CURSOR_OVERLAY_JS,
} from "../src/core/tools/chromeCdpCursor.js";

describe("chromeCdpCursor - Human-Like Cursor Movement", () => {
  beforeEach(() => {
    resetCursorPositions();
  });

  describe("generateBezierTrajectory", () => {
    test("generates smooth curved trajectory from start to target", () => {
      const start: Point = { x: 100, y: 100 };
      const target: Point = { x: 500, y: 400 };

      const points = generateBezierTrajectory(start, target, {
        steps: 20,
        jitter: false,
      });

      expect(points.length).toBeGreaterThanOrEqual(15);
      expect(points[0].x).toBeCloseTo(100, 1);
      expect(points[0].y).toBeCloseTo(100, 1);

      const last = points[points.length - 1];
      expect(last.x).toBeCloseTo(500, 1);
      expect(last.y).toBeCloseTo(400, 1);

      // Verify trajectory is curved (not purely collinear with start & target)
      // Check middle point distance to straight line
      const mid = points[Math.floor(points.length / 2)];
      const lineYatMidX = start.y + ((target.y - start.y) / (target.x - start.x)) * (mid.x - start.x);
      const deviation = Math.abs(mid.y - lineYatMidX);
      expect(deviation).toBeGreaterThan(0.1);
    });

    test("applies realistic micro-jitters along trajectory", () => {
      const start: Point = { x: 50, y: 50 };
      const target: Point = { x: 300, y: 300 };

      const pointsWithJitter = generateBezierTrajectory(start, target, {
        steps: 25,
        jitter: true,
      });

      expect(pointsWithJitter.length).toBeGreaterThanOrEqual(20);
      expect(pointsWithJitter[0].x).toBe(50);
      expect(pointsWithJitter[0].y).toBe(50);
      expect(pointsWithJitter[pointsWithJitter.length - 1].x).toBe(300);
      expect(pointsWithJitter[pointsWithJitter.length - 1].y).toBe(300);
    });

    test("handles zero-distance moves gracefully", () => {
      const p: Point = { x: 250, y: 250 };
      const points = generateBezierTrajectory(p, p);
      expect(points.length).toBeGreaterThanOrEqual(1);
      expect(points[0].x).toBe(250);
      expect(points[0].y).toBe(250);
    });
  });

  describe("cursorPositionStore", () => {
    test("defaults to viewport center when no prior position exists", () => {
      const pos = getCursorPosition("tab-1");
      expect(pos).toEqual({ x: 400, y: 300 });
    });

    test("stores and retrieves updated position per target", () => {
      setCursorPosition("tab-1", { x: 720, y: 540 });
      expect(getCursorPosition("tab-1")).toEqual({ x: 720, y: 540 });
      expect(getCursorPosition("tab-2")).toEqual({ x: 400, y: 300 });
    });
  });

  describe("visual cursor scripts", () => {
    test("provides non-interfering visual DOM overlay scripts", () => {
      expect(INJECT_CURSOR_OVERLAY_JS).toContain("data-superagent-cursor");
      expect(INJECT_CURSOR_OVERLAY_JS).toContain("pointer-events: none");
      expect(INJECT_CURSOR_OVERLAY_JS).toContain("2147483647");
      expect(UPDATE_CURSOR_OVERLAY_JS(120, 240)).toContain("120px");
      expect(UPDATE_CURSOR_OVERLAY_JS(120, 240)).toContain("240px");
      expect(REMOVE_CURSOR_OVERLAY_JS).toContain("data-superagent-cursor");
    });
  });

  describe("dispatchHumanMouseMove & dispatchHumanMouseClick", () => {
    test("dispatchHumanMouseMove dispatches sequence of mouseMoved events to CDP", async () => {
      const sentEvents: Array<{ method: string; params: any }> = [];
      const mockCdpSend = async (_target: any, method: string, params: any) => {
        sentEvents.push({ method, params });
        return {};
      };

      const target = {
        id: "T1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/T1",
      };

      setCursorPosition("T1", { x: 50, y: 50 });
      const res = await dispatchHumanMouseMove(mockCdpSend, target, { x: 350, y: 250 }, {
        steps: 10,
        stepDelayMs: 1,
        visualCursor: false,
      });

      expect(res.ok).toBe(true);
      expect(res.stepsDispatched).toBeGreaterThanOrEqual(10);
      expect(getCursorPosition("T1").x).toBe(350);
      expect(getCursorPosition("T1").y).toBe(250);

      const moveEvents = sentEvents.filter(
        (e) => e.method === "Input.dispatchMouseEvent" && e.params.type === "mouseMoved"
      );
      expect(moveEvents.length).toBeGreaterThanOrEqual(10);
      expect(moveEvents[moveEvents.length - 1].params.x).toBe(350);
      expect(moveEvents[moveEvents.length - 1].params.y).toBe(250);
    });

    test("dispatchHumanMouseClick glides cursor then dispatches human-timed click events", async () => {
      const sentEvents: Array<{ method: string; params: any }> = [];
      const mockCdpSend = async (_target: any, method: string, params: any) => {
        sentEvents.push({ method, params });
        return {};
      };

      const target = {
        id: "T1",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/T1",
      };

      setCursorPosition("T1", { x: 200, y: 200 });
      const clickRes = await dispatchHumanMouseClick(mockCdpSend, target, { x: 450, y: 300 }, {
        steps: 8,
        stepDelayMs: 1,
        dwellMs: 2,
        pressDurationMs: 2,
        visualCursor: false,
      });

      expect(clickRes.ok).toBe(true);
      expect(clickRes.x).toBe(450);
      expect(clickRes.y).toBe(300);

      const types = sentEvents
        .filter((e) => e.method === "Input.dispatchMouseEvent")
        .map((e) => e.params.type);

      expect(types).toContain("mouseMoved");
      expect(types).toContain("mousePressed");
      expect(types).toContain("mouseReleased");

      const pressedIdx = types.lastIndexOf("mousePressed");
      const releasedIdx = types.lastIndexOf("mouseReleased");
      expect(pressedIdx).toBeGreaterThan(0);
      expect(releasedIdx).toBeGreaterThan(pressedIdx);
    });
  });

  describe("executeCursorCommand", () => {
    test("handles move_cursor command with target coordinates", async () => {
      const mockCdpSend = async () => ({});
      const target = { id: "T1" };

      const out = await executeCursorCommand(mockCdpSend, target, "move_cursor", {
        x: 480,
        y: 320,
        steps: 5,
        step_delay_ms: 1,
      });

      expect(out).toContain("control_chrome_cdp: cursor moved naturally to (480, 320)");
      expect(getCursorPosition("T1")).toEqual({ x: 480, y: 320 });
    });

    test("handles get_cursor command reporting current tab coordinates", async () => {
      const mockCdpSend = async () => ({});
      const target = { id: "T1" };
      setCursorPosition("T1", { x: 640, y: 480 });

      const out = await executeCursorCommand(mockCdpSend, target, "get_cursor", {});
      expect(out).toContain("Current cursor position: (640, 480)");
    });

    test("handles show_cursor and hide_cursor commands", async () => {
      const evals: string[] = [];
      const mockCdpSend = async (_target: any, method: string, params: any) => {
        if (method === "Runtime.evaluate") evals.push(params.expression);
        return {};
      };
      const target = { id: "T1" };

      const showOut = await executeCursorCommand(mockCdpSend, target, "show_cursor", {});
      expect(showOut).toContain("visual cursor overlay enabled");
      expect(evals.some((e) => e.includes("data-superagent-cursor"))).toBe(true);

      const hideOut = await executeCursorCommand(mockCdpSend, target, "hide_cursor", {});
      expect(hideOut).toContain("visual cursor overlay removed");
    });
  });
});
