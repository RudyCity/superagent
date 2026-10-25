/**
 * Windows local E2E: real installed Chrome under a temporary profile.
 * Creates no personal-profile connections; cleans only its own spawned PID tree.
 * Run: bun scripts/smoke-managed-chrome.ts
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossIdeCdpGateway } from "../src/core/tools/crossIdeCdpGateway.js";
import { registerManagedBrowser, listManagedBrowserRegistrations, browserFingerprintForPort } from "../src/core/tools/managedBrowserRegistry.js";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function findChrome(): string {
  for (const envName of ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]) {
    const root = process.env[envName];
    if (!root) continue;
    const file = join(root, "Google", "Chrome", "Application", "chrome.exe");
    if (existsSync(file)) return file;
  }
  throw new Error("Installed Chrome not found; personal browser remains untouched.");
}
async function main() {
  if (process.platform !== "win32") throw new Error("Smoke requires Windows.");
  const profile = mkdtempSync(join(tmpdir(), "tline-browser-smoke-profile-"));
  const state = mkdtempSync(join(tmpdir(), "tline-browser-smoke-coordinator-"));
  const oldDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
  const oldHost = process.env.SUPERAGENT_CDP_HOST;
  process.env.SUPERAGENT_CDP_SESSION_DIR = state;
  process.env.SUPERAGENT_CDP_HOST = "127.0.0.1";
  let child: ChildProcess | undefined;
  try {
    child = spawn(findChrome(), [
      "--headless=new", "--no-first-run", "--no-default-browser-check",
      "--disable-default-apps", "--disable-extensions",
      "--user-data-dir=" + profile, "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1", "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    if (!child.pid) throw new Error("Smoke Chrome process not created.");

    let port = 0, connected = false;
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error("Chrome exited before local CDP was ready.");
      try {
        const file = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
        port = Number(file.split(/\r?\n/)[0]);
        if (port >= 1024 && port <= 65535) {
          const reply = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(1500) });
          if (reply.ok) { connected = true; break; }
        }
      } catch { /* Chrome boot is in progress */ }
      await pause(180);
    }
    if (!connected) throw new Error("Isolated Chrome CDP did not become reachable.");

    const owner = new CrossIdeCdpGateway({ sessionId: "smoke-owner-" + profile, clientLabel: "owner" });
    const reader = new CrossIdeCdpGateway({ sessionId: "smoke-observer-" + profile, clientLabel: "observer" });
    const discovery = await owner.invoke({ action: "discover", port }) as any;
    if (discovery.browserError || !discovery.pages?.length) throw new Error("Gateway discovery failed.");
    const tab = discovery.pages.find((p: any) => p.url === "about:blank") || discovery.pages[0];
    const fingerprint = await browserFingerprintForPort(port);
    const registration = await registerManagedBrowser({
      profileId: "local-smoke", generation: String(child.pid) + "-" + String(Date.now()) + "00000000",
      port, targetId: tab.targetId, browserFingerprint: fingerprint,
    });
    const seen = await reader.invoke({ action: "managed" }) as any;
    if (!seen.registrations.some((r: any) => r.port === port && r.targetId === tab.targetId))
      throw new Error("Registry not visible via gateway.");
    const claim = await owner.invoke({ action: "claim", port, targetId: tab.targetId }) as any;
    if (claim.status !== "owner") throw new Error("Owner claim did not succeed.");
    let rejected = false;
    try { await reader.invoke({ action: "execute", port, targetId: tab.targetId, command: "read_page" }); }
    catch { rejected = true; }
    if (!rejected) throw new Error("An unclaimed agent was able to read.");
    await owner.invoke({ action: "share", port, targetId: tab.targetId, enabled: true });
    const req = await reader.invoke({ action: "request_attach", port, targetId: tab.targetId, role: "observer" }) as any;
    await owner.invoke({ action: "approve_attach", port, targetId: tab.targetId, requestId: req.requestId });
    const joined = await reader.invoke({ action: "poll_attach", port, targetId: tab.targetId, requestId: req.requestId }) as any;
    if (joined.role !== "observer") throw new Error("Observer attach did not succeed.");
    const result = await reader.invoke({ action: "execute", port, targetId: tab.targetId, command: "read_page" }) as any;
    if (!result.ok) throw new Error("Approved observer did not read page successfully.");
    if (registration.expiresAt <= Date.now() || listManagedBrowserRegistrations().length !== 1)
      throw new Error("Registration expired prematurely.");
    // Closing the exact test PID tree must immediately hide the live managed
    // registration, even though its cached TTL has not yet elapsed.
    const spawnedPid = child.pid!;
    execFileSync("taskkill", ["/PID", String(spawnedPid), "/T", "/F"], { timeout: 8000, stdio: "ignore" });
    child = undefined;
    let hiddenAfterExit = false;
    for (let retry = 0; retry < 25; retry++) {
      const after = await reader.invoke({ action: "managed" }) as any;
      if (!after.registrations.some((r: any) => r.port === port && r.targetId === tab.targetId)) {
        hiddenAfterExit = true;
        break;
      }
      await pause(150);
    }
    if (!hiddenAfterExit) throw new Error("Stopped browser remained available through managed discovery.");
    let staleAgentBlocked = false;
    try { await reader.invoke({ action: "execute", port, targetId: tab.targetId, command: "read_page" }); }
    catch { staleAgentBlocked = true; }
    if (!staleAgentBlocked) throw new Error("Stale agent remained able to access stopped browser.");
    await owner.invoke({ action: "release", port, targetId: tab.targetId });
    console.log(JSON.stringify({
      status: "pass", browser: "installed Chrome (headless)", tempProfile: true,
      isolatedCoordinator: true, registration: true, browserFingerprintChecked: true, gatewayDiscover: true,
      ownerClaim: true, deniedWithoutClaim: true, approvedObserverAttach: true,
      observerRead: true, ownerRelease: true, stoppedBrowserHiddenBeforeTtl: true,
      staleAgentDeniedAfterBrowserExit: true,
    }, null, 2));
  } finally {
    if (child?.pid) {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { timeout: 8000, stdio: "ignore" }); }
      catch { try { child.kill(); } catch {} }
    }
    await pause(500);
    try { rmSync(profile, { recursive: true, force: true }); }
    catch { console.error("Warning: temporary Chrome profile could not be deleted."); }
    rmSync(state, { recursive: true, force: true });
    if (oldDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = oldDir;
    if (oldHost === undefined) delete process.env.SUPERAGENT_CDP_HOST;
    else process.env.SUPERAGENT_CDP_HOST = oldHost;
  }
}
main().catch(e => { console.error("Managed Chrome smoke failed:", e.message); process.exitCode = 1; });
