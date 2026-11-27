/**
 * Windows native window discovery E2E: a real disposable WinForms fixture, the
 * real Windows adapter and the real session-manager policy.
 *
 * ## CI (default) vs attended (certification)
 *
 * - **Default run** (`vitest run tests/desktop-ui-discovery/windows-winforms.e2e.test.ts`,
 *   also selected by `bun run test:e2e`): focus-independent. Window discovery,
 *   geometry, capture stability, screenshot schema/image, accessibility,
 *   session-manager and background-window assertions always run. Foreground
 *   authority assertions run only when the fixture can actually own the
 *   foreground; otherwise that single test skips with the concrete capability
 *   reason (`no interactive input desktop`, `another window owns the
 *   foreground`, `session locked`). A machine with the operator's app in front
 *   therefore does not produce a false failure, and the harness NEVER steals
 *   focus in this mode.
 * - **Attended certification** (`SUPERAGENT_E2E_REQUIRE_FOCUS=1`): the fixture
 *   asks Windows to claim the foreground, the pre-flight reports exactly which
 *   window owns it, and every gated assertion becomes strict. If foreground
 *   authority cannot be proven the test FAILS with the concrete blocker (which
 *   window is in front) instead of silently passing.
 *
 * ## Bounded pre-flight
 *
 * Before assertions, each fixture is probed for process liveness, window
 * existence, visibility and non-minimized state (polled up to 15 s). A missing
 * precondition fails with a message naming it, never with an assertion diff.
 *
 * ## Background window scenario
 *
 * Two fixtures are used: a background target and an occluder. Read-only capture,
 * schema, inline screenshot image, accessibility and view-only session work for
 * the background window are focus-independent and always asserted. The
 * foreground-authority assertions (target is not foreground; native input is
 * refused with `TARGET_NOT_ACTIVE`) are gated exactly like the first scenario.
 */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWindowsDesktopUiAdapter } from "../../src/core/desktopUi/adapters/windows.js";
import { resolveNativeDesktopExecutable } from "../../src/core/desktopUi/nativeExecutableIdentity.js";
import { DesktopUiConsentManager, DesktopUiSessionManager } from "../../src/core/tools/desktopUiTools.js";
import {
  assertBackgroundAuthority,
  assertFixturePreconditions,
  assertForegroundAuthority,
  awaitFixturePreflight,
  backgroundUnavailableReason,
  describeForeground,
  focusUnavailableReason,
  isWindows,
  readFocusProbe,
  requireFocus,
  startWindowsWinformsFixture,
  terminateFixture,
  type FixtureHandle,
} from "./windows-winforms-focus.support.js";

type NativeAdapter = ReturnType<typeof createWindowsDesktopUiAdapter>;
type NativeIdentity = NonNullable<Awaited<ReturnType<typeof resolveNativeDesktopExecutable>>>;

const OWNER = "windows-discovery-e2e";
const BG_OWNER = "windows-bg-view-e2e";

function findFixtureWindow(
  windows: Awaited<ReturnType<NonNullable<NativeAdapter["listWindows"]>>>["windows"],
  fixture: FixtureHandle,
) {
  return windows.find((window) =>
    window.pid === fixture.pid
    && window.nativeId === fixture.nativeId
    && window.title === fixture.title);
}

function registeredManager(identity: NativeIdentity, windowTitle: string): DesktopUiSessionManager {
  return new DesktopUiSessionManager(new DesktopUiConsentManager(), {
    permanentRegistry: () => ({
      version: 2,
      defaultEffect: "deny",
      rules: [{
        id: "e2e-bg-view-input",
        kind: "desktop",
        effect: "allow",
        app: identity,
        operations: ["view", "input"],
        scope: { windowTitle },
      }],
    }),
  });
}

describe.skipIf(!isWindows)("Windows native window discovery E2E", () => {
  describe("discovery and read-only inspection", () => {
    let fixture: FixtureHandle | null = null;
    let adapter: NativeAdapter;

    beforeAll(async () => {
      adapter = createWindowsDesktopUiAdapter();
      fixture = await startWindowsWinformsFixture(
        `SuperAgent Discovery ${randomUUID()}`,
        { attemptFocus: requireFocus },
      );
      await awaitFixturePreflight(fixture, "discovery");
    }, 45000);

    afterAll(async () => {
      if (fixture) await terminateFixture(fixture.child);
    }, 15000);

    it("lists, captures and read-only inspects an exact disposable WinForms top-level window", async () => {
      const target = fixture!;

      const listed = await adapter.listWindows!(100);
      const window = findFixtureWindow(listed.windows, target);
      expect(
        window,
        `Fresh discovery did not list the fixture window (pid ${target.pid}, nativeId ${target.nativeId}, title ${JSON.stringify(target.title)}).`,
      ).toBeDefined();
      expect(window).toMatchObject({
        pid: target.pid,
        nativeId: target.nativeId,
        title: target.title,
        application: expect.stringMatching(/powershell/i),
      });
      expect(window!.bounds.width).toBeGreaterThan(0);
      expect(window!.bounds.height).toBeGreaterThan(0);
      expect(window!.scaleFactor).toBeGreaterThan(0);

      // Discovery's active flag and getActiveWindow() must agree even when a
      // different application owns the foreground. Foreground *authority* (the
      // fixture itself being active) is asserted by the gated test below.
      const activeWindow = await adapter.getActiveWindow!();
      if (window!.active) {
        expect(activeWindow?.nativeId).toBe(target.nativeId);
      } else {
        expect(activeWindow?.nativeId).not.toBe(target.nativeId);
      }

      // Establish that this fixture has painted stable pixels before the real
      // session's independent stale-screenshot and window identity checks.
      await expect.poll(async () => {
        const first = await adapter.capture(target);
        const second = await adapter.capture(target);
        return first.image.byteLength > 0 &&
          second.image.byteLength > 0 &&
          first.targetWindow.nativeId === target.nativeId &&
          second.targetWindow.nativeId === target.nativeId &&
          createHash("sha256").update(first.image).digest("hex") ===
            createHash("sha256").update(second.image).digest("hex");
      }, { timeout: 12000, interval: 100 }).toBe(true);

      const manager = new DesktopUiSessionManager(new DesktopUiConsentManager());
      const inspected = await manager.inspectWindow({
        pid: target.pid,
        nativeId: target.nativeId,
        ownerPrincipal: OWNER,
        adapter,
      });
      expect(inspected.schema.screenshot.targetWindow.nativeId).toBe(target.nativeId);
      expect(inspected.schema.elements.some((element) =>
        element.source === "accessibility" && element.role === "button" && element.label === "Inspect Me",
      )).toBe(true);
      expect(inspected).not.toHaveProperty("screenshotImage");
      expect(manager.getActiveSessionsCount()).toBe(0);
    }, 45000);

    it("proves foreground authority and getActiveWindow identity", async (ctx) => {
      const target = fixture!;
      const probe = await readFocusProbe(target.pid, target.nativeId);
      assertFixturePreconditions(probe, "discovery");

      const reason = focusUnavailableReason(probe);
      if (reason) {
        if (requireFocus) assertForegroundAuthority(probe, `the discovery fixture ${JSON.stringify(target.title)}`);
        ctx.skip(
          `Focus-dependent assertions skipped: ${reason}. `
          + "Unset SUPERAGENT_E2E_REQUIRE_FOCUS for the CI-safe capability-gated mode, "
          + "or keep the fixture window in front for attended foreground certification.",
        );
      }

      const listed = await adapter.listWindows!(100);
      const window = findFixtureWindow(listed.windows, target);
      expect(
        window,
        `Fresh discovery did not list the fixture window (pid ${target.pid}, nativeId ${target.nativeId}, title ${JSON.stringify(target.title)}).`,
      ).toBeDefined();
      expect(
        window!.active,
        `Expected the fixture window to be foreground; the current foreground is ${describeForeground(probe)}.`,
      ).toBe(true);

      const active = await adapter.getActiveWindow!();
      expect(
        active?.nativeId,
        `getActiveWindow() did not return the foreground fixture (pid ${target.pid}, nativeId ${target.nativeId}); `
        + `it returned ${active ? `pid ${active.pid} / nativeId ${active.nativeId}` : "null"}.`,
      ).toBe(target.nativeId);
      expect(active?.pid).toBe(target.pid);
    }, 30000);
  });

  describe("background window access", () => {
    let background: FixtureHandle | null = null;
    let occluder: FixtureHandle | null = null;
    let identity: NativeIdentity | null = null;
    let adapter: NativeAdapter;
    const backgroundTitle = `SuperAgent BgView ${randomUUID()}`;
    const occluderTitle = `SuperAgent Occluder ${randomUUID()}`;

    beforeAll(async () => {
      adapter = createWindowsDesktopUiAdapter();
      background = await startWindowsWinformsFixture(backgroundTitle);
      await awaitFixturePreflight(background, "background");
      occluder = await startWindowsWinformsFixture(occluderTitle, { attemptFocus: requireFocus });
      await awaitFixturePreflight(occluder, "occluder");
      identity = await resolveNativeDesktopExecutable(background.pid);
    }, 60000);

    afterAll(async () => {
      if (occluder) await terminateFixture(occluder.child);
      if (background) await terminateFixture(background.child);
    }, 15000);

    it("captures, screenshots and opens a view-only session on an occluded background window", async () => {
      const target = background!;
      const other = occluder!;
      expect(
        identity,
        `Could not resolve the native executable identity of the background fixture (pid ${target.pid}).`,
      ).not.toBeNull();

      const listed = await adapter.listWindows!(100);
      const backgroundWindow = findFixtureWindow(listed.windows, target);
      const occluderWindow = findFixtureWindow(listed.windows, other);
      expect(
        backgroundWindow,
        `Fresh discovery did not list the background fixture (pid ${target.pid}, nativeId ${target.nativeId}).`,
      ).toBeDefined();
      expect(
        occluderWindow,
        `Fresh discovery did not list the occluder fixture (pid ${other.pid}, nativeId ${other.nativeId}).`,
      ).toBeDefined();
      expect(backgroundWindow).toMatchObject({
        pid: target.pid,
        nativeId: target.nativeId,
        title: backgroundTitle,
        application: expect.stringMatching(/powershell/i),
      });
      expect(backgroundWindow!.bounds.width).toBeGreaterThan(0);
      expect(backgroundWindow!.bounds.height).toBeGreaterThan(0);
      expect(backgroundWindow!.scaleFactor).toBeGreaterThan(0);

      // Background capture stays stable while the occluder is (or may be) in
      // front. Foreground ownership itself is not asserted here.
      await expect.poll(async () => {
        const first = await adapter.capture(target);
        const second = await adapter.capture(target);
        return first.image.byteLength > 0 &&
          second.image.byteLength > 0 &&
          first.targetWindow.nativeId === target.nativeId &&
          second.targetWindow.nativeId === target.nativeId &&
          createHash("sha256").update(first.image).digest("hex") ===
            createHash("sha256").update(second.image).digest("hex");
      }, { timeout: 12000, interval: 100 }).toBe(true);

      const manager = registeredManager(identity!, backgroundTitle);
      const inspected = await manager.inspectWindow({
        pid: target.pid,
        nativeId: target.nativeId,
        ownerPrincipal: BG_OWNER,
        includeScreenshotImage: true,
        adapter,
      });
      expect(inspected.window.pid).toBe(target.pid);
      expect(inspected.window.nativeId).toBe(target.nativeId);
      expect(inspected.schema.screenshot.targetWindow.nativeId).toBe(target.nativeId);
      expect(inspected.screenshotImage, "Registered background inspection must include the bounded inline PNG.").toBeTruthy();
      expect(inspected.schema.elements.some((element) =>
        element.source === "accessibility" && element.role === "button" && element.label === "Inspect Me",
      )).toBe(true);

      const viewSession = await manager.openSession({
        pid: target.pid,
        nativeId: target.nativeId,
        title: backgroundTitle,
        ownerPrincipal: BG_OWNER,
        allowInput: false,
        adapter,
      });
      expect(viewSession.inputAllowed).toBe(false);
      const snap = await manager.snapshot({
        sessionToken: viewSession.sessionToken,
        ownerPrincipal: BG_OWNER,
      });
      expect(snap.schema.screenshot.targetWindow.nativeId).toBe(target.nativeId);
      manager.closeSession(viewSession.sessionToken, BG_OWNER);
      expect(manager.getActiveSessionsCount()).toBe(0);
    }, 60000);

    it("refuses native input on a non-foreground window", async (ctx) => {
      const target = background!;
      const other = occluder!;
      const probe = await readFocusProbe(target.pid, target.nativeId);
      assertFixturePreconditions(probe, "background");
      const occluderProbe = await readFocusProbe(other.pid, other.nativeId);
      assertFixturePreconditions(occluderProbe, "occluder");

      const reason = backgroundUnavailableReason(probe);
      if (reason) {
        if (requireFocus) assertBackgroundAuthority(probe, occluderProbe);
        ctx.skip(
          `Background-input assertions skipped: ${reason}. `
          + "Unset SUPERAGENT_E2E_REQUIRE_FOCUS for the CI-safe capability-gated mode, "
          + "or keep a different window in front for attended certification.",
        );
      }

      const listed = await adapter.listWindows!(100);
      const backgroundWindow = findFixtureWindow(listed.windows, target);
      expect(
        backgroundWindow,
        `Fresh discovery did not list the background fixture (pid ${target.pid}, nativeId ${target.nativeId}).`,
      ).toBeDefined();
      expect(
        backgroundWindow!.active,
        `Expected a background window; the current foreground is ${describeForeground(probe)}.`,
      ).toBe(false);

      const capture = await adapter.capture(target);
      expect(capture.targetWindow.nativeId).toBe(target.nativeId);
      expect(
        capture.targetWindow.active,
        `Expected the capture metadata to report a background window; the current foreground is ${describeForeground(probe)}.`,
      ).toBe(false);

      const manager = registeredManager(identity!, backgroundTitle);
      await expect(manager.openSession({
        pid: target.pid,
        nativeId: target.nativeId,
        title: backgroundTitle,
        ownerPrincipal: BG_OWNER,
        allowInput: true,
        adapter,
      })).rejects.toMatchObject({ code: "TARGET_NOT_ACTIVE" });
      expect(manager.getActiveSessionsCount()).toBe(0);
    }, 45000);
  });
});
