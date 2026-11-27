/**
 * Live smoke measurement for the persistent Windows UIAutomation carrier.
 *
 * Manual, operator-run only: this script is NOT executed by CI or vitest. It
 * opens no input path and performs read-only discovery, capture and
 * accessibility inspection of already-visible top-level windows.
 *
 * Usage:
 *   bun scripts/desktop-ui-accessibility-live-smoke.ts --label before
 *   bun scripts/desktop-ui-accessibility-live-smoke.ts --label after
 *
 * Prints one JSON block per matching Chromium/Electron/terminal window with the
 * element count, actionable/value/nativeRef/focused totals, dominant roles and
 * the inspection latency.
 */
import { createNativeDesktopUiAdapter } from "../src/core/desktopUi/nativeAdapter.js";
import type {
  DesktopDiscoveredWindow,
  NativeCapture,
} from "../src/core/desktopUi/types.js";

/**
 * Windows that exercise the two UIA families this carrier must cover:
 * Chromium/Electron web content (huge dynamic tree) and a native XAML terminal
 * (small tree where RawView is richer than ControlView).
 */
const TARGET_PATTERN =
  /deepseek|antigravity|windowsterminal|windows terminal|google chrome|microsoft edge|electron/i;

const DISCOVERY_LIMIT = 50;

function labelFromArgv(): string {
  const index = process.argv.indexOf("--label");
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return "current";
}

function syntheticCapture(window: DesktopDiscoveredWindow): NativeCapture {
  return {
    image: new Uint8Array(0),
    capturedAt: new Date().toISOString(),
    targetWindow: {
      pid: window.pid,
      nativeId: window.nativeId,
      title: window.title,
      active: window.active,
      bounds: window.bounds,
      ...(window.scaleFactor === undefined ? {} : { scaleFactor: window.scaleFactor }),
    },
  };
}

function countRoles(elements: { role: string }[]): string {
  const counts = new Map<string, number>();
  for (const element of elements) counts.set(element.role, (counts.get(element.role) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([role, count]) => `${role}=${count}`)
    .join(",");
}

async function main(): Promise<void> {
  const label = labelFromArgv();
  const adapter = createNativeDesktopUiAdapter();
  const discovery = await adapter.listWindows?.(DISCOVERY_LIMIT);
  if (!discovery) {
    console.error(`[${label}] window discovery is unavailable on this platform`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[${label}] discovered ${discovery.windows.length} windows (truncated=${discovery.truncated})`,
  );
  const targets = discovery.windows.filter(
    (window) => TARGET_PATTERN.test(window.application) || TARGET_PATTERN.test(window.title),
  );
  if (targets.length === 0) {
    console.error(`[${label}] no Chromium/Electron/terminal window matched`);
    process.exitCode = 1;
    return;
  }
  for (const window of targets) {
    let capture: NativeCapture;
    let captureSource: "printwindow" | "synthetic";
    try {
      capture = await adapter.capture({
        pid: window.pid,
        nativeId: window.nativeId,
        title: window.title,
      });
      captureSource = "printwindow";
    } catch {
      // The accessibility tree does not depend on the screenshot; keep measuring
      // element quality when PrintWindow refuses a GPU-composited surface.
      capture = syntheticCapture(window);
      captureSource = "synthetic";
    }
    const started = performance.now();
    try {
      const snapshot = await adapter.inspectAccessibility(
        { pid: window.pid, nativeId: window.nativeId, title: window.title },
        capture,
      );
      const elapsedMs = Math.round(performance.now() - started);
      const elements = snapshot.elements;
      console.log(
        JSON.stringify(
          {
            label,
            application: window.application,
            pid: window.pid,
            title: window.title,
            capture: captureSource,
            elapsedMs,
            elements: elements.length,
            actionable: elements.filter((element) => element.actionable).length,
            withValue: elements.filter((element) => element.value !== null).length,
            withLabel: elements.filter((element) => element.label !== null).length,
            withNativeRef: elements.filter((element) => element.nativeRef !== undefined).length,
            focused: elements.filter((element) => element.focused === true).length,
            roles: countRoles(elements),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          label,
          application: window.application,
          pid: window.pid,
          capture: captureSource,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
      process.exitCode = 1;
    }
  }
}

await main();
