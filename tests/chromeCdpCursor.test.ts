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
  dispatchHumanDragAndDrop,
  executeDragAndDropCommand,
  buildHtml5DragDropJs,
} from "../src/core/tools/chromeCdpCursor.js";
import { snapshotStore } from "../src/core/tools/chromeCdpHelpers.js";

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

  describe("dispatchHumanDragAndDrop & executeDragAndDropCommand", () => {
    test("dispatchHumanDragAndDrop dispatches realistic mousePressed, dragging trajectory with buttons:1, and mouseReleased", async () => {
      const sentEvents: Array<{ method: string; params: any }> = [];
      const mockCdpSend = async (_target: any, method: string, params: any) => {
        sentEvents.push({ method, params });
        return {};
      };
      const target = { id: "tab-drag-1" };
      setCursorPosition("tab-drag-1", { x: 50, y: 50 });

      const res = await dispatchHumanDragAndDrop(
        mockCdpSend,
        target,
        { x: 100, y: 100 },
        { x: 300, y: 250 },
        { steps: 10, stepDelayMs: 0, holdDurationMs: 0, dropDwellMs: 0 }
      );

      expect(res.ok).toBe(true);
      expect(res.startX).toBe(100);
      expect(res.startY).toBe(100);
      expect(res.endX).toBe(300);
      expect(res.endY).toBe(250);

      const pressEvent = sentEvents.find((e) => e.method === "Input.dispatchMouseEvent" && e.params?.type === "mousePressed");
      expect(pressEvent).toBeDefined();
      expect(pressEvent?.params?.x).toBe(100);
      expect(pressEvent?.params?.y).toBe(100);
      expect(pressEvent?.params?.buttons).toBe(1);

      const dragMoves = sentEvents.filter((e) => e.method === "Input.dispatchMouseEvent" && e.params?.type === "mouseMoved" && e.params?.buttons === 1);
      expect(dragMoves.length).toBeGreaterThanOrEqual(10);

      const releaseEvent = sentEvents.find((e) => e.method === "Input.dispatchMouseEvent" && e.params?.type === "mouseReleased");
      expect(releaseEvent).toBeDefined();
      expect(releaseEvent?.params?.x).toBe(300);
      expect(releaseEvent?.params?.y).toBe(250);
      expect(releaseEvent?.params?.buttons).toBe(0);

      expect(getCursorPosition("tab-drag-1")).toEqual({ x: 300, y: 250 });
    });

    test("executeDragAndDropCommand handles coordinate-based drag", async () => {
      const mockCdpSend = async () => ({});
      const target = { id: "tab-coords" };

      const out = await executeDragAndDropCommand(mockCdpSend, target, {
        sourceX: 120,
        sourceY: 150,
        targetX: 450,
        targetY: 300,
        step_delay_ms: 0,
        hold_duration_ms: 0,
        drop_dwell_ms: 0,
      });

      expect(out).toContain("control_chrome_cdp: dragged successfully");
      expect(out).toContain("coordinates (120, 150)");
      expect(out).toContain("coordinates (450, 300)");
      expect(getCursorPosition("tab-coords")).toEqual({ x: 450, y: 300 });
    });

    test("executeDragAndDropCommand handles relative delta dx and dy", async () => {
      const mockCdpSend = async () => ({});
      const target = { id: "tab-delta" };
      setCursorPosition("tab-delta", { x: 200, y: 200 });

      const out = await executeDragAndDropCommand(mockCdpSend, target, {
        sourceX: 200,
        sourceY: 200,
        dx: 150,
        dy: -50,
        step_delay_ms: 0,
        hold_duration_ms: 0,
        drop_dwell_ms: 0,
      });

      expect(out).toContain("dragged successfully");
      expect(out).toContain("offset (+150, -50)");
      expect(getCursorPosition("tab-delta")).toEqual({ x: 350, y: 150 });
    });

    test("executeDragAndDropCommand resolves CSS selectors to center points", async () => {
      const mockCdpSend = async (_target: any, method: string, params: any) => {
        if (method === "Runtime.evaluate" && params?.expression?.includes("querySelector")) {
          if (params.expression.includes("#source-card")) return { result: { value: { x: 150, y: 220 } } };
          if (params.expression.includes("#target-col")) return { result: { value: { x: 600, y: 400 } } };
        }
        return {};
      };
      const target = { id: "tab-sel" };

      const out = await executeDragAndDropCommand(mockCdpSend, target, {
        sourceSelector: "#source-card",
        targetSelector: "#target-col",
        step_delay_ms: 0,
        hold_duration_ms: 0,
        drop_dwell_ms: 0,
      });

      expect(out).toContain("dragged successfully");
      expect(out).toContain("selector '#source-card'");
      expect(out).toContain("selector '#target-col'");
      expect(getCursorPosition("tab-sel")).toEqual({ x: 600, y: 400 });
    });

    test("executeDragAndDropCommand resolves snapshot indices", async () => {
      const targetId = "tab-snap";
      snapshotStore.set(targetId, [
        { index: 0, tag: "div", text: "Root", selector: "#app" },
        { index: 1, tag: "div", text: "Draggable Card", selector: "#item-1" },
        { index: 2, tag: "div", text: "Drop Column", selector: "#col-2" },
      ]);

      const mockCdpSend = async (_target: any, method: string, params: any) => {
        if (method === "Runtime.evaluate" && params?.expression?.includes("querySelector")) {
          if (params.expression.includes("#item-1")) return { result: { value: { x: 180, y: 120 } } };
          if (params.expression.includes("#col-2")) return { result: { value: { x: 520, y: 380 } } };
        }
        return {};
      };

      const out = await executeDragAndDropCommand(mockCdpSend, { id: targetId }, {
        sourceIndex: 1,
        targetIndex: 2,
        step_delay_ms: 0,
        hold_duration_ms: 0,
        drop_dwell_ms: 0,
      });

      expect(out).toContain("dragged successfully");
      expect(out).toContain("index 1");
      expect(out).toContain("index 2");
      expect(getCursorPosition(targetId)).toEqual({ x: 520, y: 380 });
    });

    test("executeDragAndDropCommand supports html5 mode with synthetic DataTransfer and CDP drag events", async () => {
      const sentEvents: Array<{ method: string; params: any }> = [];
      const mockCdpSend = async (_target: any, method: string, params: any) => {
        sentEvents.push({ method, params });
        if (method === "Runtime.evaluate" && params?.expression?.includes("querySelector")) {
          if (params.expression.includes("#drag-src")) return { result: { value: { x: 100, y: 100 } } };
          if (params.expression.includes("#drag-dst")) return { result: { value: { x: 300, y: 300 } } };
        }
        return {};
      };
      const target = { id: "tab-html5" };

      const out = await executeDragAndDropCommand(mockCdpSend, target, {
        sourceSelector: "#drag-src",
        targetSelector: "#drag-dst",
        mode: "html5",
      });

      expect(out).toContain("dragged successfully");
      expect(out).toContain("[mode: html5]");

      const dragEnter = sentEvents.find((e) => e.method === "Input.dispatchDragEvent" && e.params?.type === "dragEnter");
      const dragOver = sentEvents.find((e) => e.method === "Input.dispatchDragEvent" && e.params?.type === "dragOver");
      const drop = sentEvents.find((e) => e.method === "Input.dispatchDragEvent" && e.params?.type === "drop");
      expect(dragEnter).toBeDefined();
      expect(dragOver).toBeDefined();
      expect(drop).toBeDefined();
    });

    test("executeDragAndDropCommand reports clear error when target is missing", async () => {
      const mockCdpSend = async () => ({});
      const target = { id: "tab-err" };

      const out = await executeDragAndDropCommand(mockCdpSend, target, {
        sourceX: 100,
        sourceY: 100,
      });

      expect(out).toContain("control_chrome_cdp failed: drag_and_drop requires a target");
    });
  });
});
