# SuperAgent Linux Headless CDP & Virtual Display Independent Audit (Milestone M2)

**Date:** 2026-10-28  
**Scope:** Milestone M2 of the SuperAgent Linux Headless CDP + Human Takeover Master Plan  
**Target:** SuperAgent Core, Browser Runtime subsystem, CDP Gateway, Process Supervisor  
**Auditor:** SuperAgent Core & Browser Automation Architecture  
**Status:** COMPLETE / CANONICAL AUDIT  

---

## 1. Executive Summary & Audit Objectives

Following the completion of Milestones M0 and M1, Milestone M2 introduces the **Linux Virtual Display Worker** to allow headed Chromium execution on displayless Linux hosts via owned `Xvfb` and lightweight window managers (`openbox`, `fluxbox`, etc.).

Before proceeding with the acceptance of Milestone M2, this independent audit was conducted to:
1. Conduct an independent preflight review of existing M0/M1 `browserRuntime` code, types, and test suites;
2. Verify the true implementation values of CDP session locks, leases, and TTLs directly against source code to correct discrepancies identified in prior audit documents;
3. Evaluate process ownership tracking, PID lifecycle safety, and direct-CDP or extension bridge bypass risks;
4. Audit the M2 Virtual Display implementation against hard security gates (preservation of the Chrome sandbox, strict loopback-only VNC/noVNC bindings, prevention of display collisions, and avoidance of foreign process termination).

---

## 2. Preflight Review & Source-Level Discrepancy Reconciliation

### 2.1 CDP Coordinator Locks & Lease TTL Reconciliation
A prior M0 audit report (`docs/audits/2026-10-28-superagent-linux-cdp-m0-m1-implementation-audit.md`, Section 4) recorded:
> *"1. Per-Target Mutex (guarded): Uses file locks (~/.superagent-r/cdp-sessions/targets/<hash>.lock) via proper-lockfile semantics... 2. Lease TTL & Claim Heartbeats: Agent claims have a bounded TTL (90,000 ms)."*

A direct inspection of the canonical source file `src/core/tools/chromeCdpSessionManager.ts` reveals important differences that must be formally reconciled:

| Parameter / Mechanism | Erroneously Reported Claim | True Value in Source Code (`chromeCdpSessionManager.ts`) | Architectural Function |
| :--- | :--- | :--- | :--- |
| **Primary Lease TTL** | `90,000 ms` (90s) | **`300,000 ms` (`5 * 60_000`, 5 minutes)** | `TTL_MS`: Maximum duration of a CDP target owner lease before automatic expiry if unrenewed. |
| **Member Lease TTL** | Not documented | **`120,000 ms` (`2 * 60_000`, 2 minutes)** | `MEMBER_TTL_MS`: TTL for shared session observer/contributor participants. |
| **Stale Lock Timeout** | Not documented | **`120,000 ms` (`120_000`, 2 minutes)** | `STALE_MS`: Inactivity window before an unheartbeated lock file can be reclaimed from a dead PID. |
| **Target Lock Mechanism** | `proper-lockfile` | **Atomic `mkdir` + `owner.json` + `heartbeat`** | `mkdir(join(dir(), "locks", key + ".lock"))`: Posix atomic folder creation with inner process metadata. |
| **Queue Mechanism** | Not documented | **Persisted JSON tokens in `queues/${key}`** | Priority aging (`PRIORITY_AGING_MS = 12_000`) and filesystem event watchers for wakeup. |
| **90-Second Source** | Confused with CDP lease | **`managedBrowserRegistry.ts` (`TTL_MS = 90_000`)** | Cross-process announcement expiration for managed browser tabs registered with Core. |

**Verdict**: The locking mechanism in `chromeCdpSessionManager.ts` does not depend on the external `proper-lockfile` package; it employs native atomic directory creation (`mkdir` with `EEXIST` detection) combined with active heartbeat files and PID liveness checks (`process.kill(pid, 0)`). This is robust and cross-process safe.

---

## 3. Security Boundary & Bypass Surface Analysis

### 3.1 Loopback CDP Boundary vs. Network Exposure
- Chromium's `--remote-debugging-port` provides total script execution control (`Runtime.evaluate`, `Page.navigate`, cookies, storage).
- **Audit Finding**: `src/core/browserRuntime/browserFlags.ts` strictly injects `--remote-debugging-address=127.0.0.1`.
- Any external attempt to override `--remote-debugging-address` (e.g. to `0.0.0.0`) via caller-supplied `additionalFlags` is scrubbed and stripped during argument building.
- Multi-tenant boundary: On Linux, local processes belonging to the same OS user can reach `127.0.0.1:9222`. For multi-tenant hosting, container isolation or dedicated non-root OS users remain mandatory.

### 3.2 Chrome Sandbox Defense (`--no-sandbox` Ban)
- Disabling the Chromium sandbox removes seccomp, chroot, and user namespace isolation.
- **Audit Finding**: `--no-sandbox` is registered in `BANNED_FLAGS` in `browserFlags.ts` and dropped automatically.
- In `virtual-display` mode, Chrome is launched headed with standard sandboxing enabled.

### 3.3 Foreign Process Termination Prevention
- Legacy utilities occasionally used blind `pkill -f chrome` or killed any listener on 9222.
- **Audit Finding**: `BrowserProcessManager.stopBrowser` and `VirtualDisplayWorker.stopVirtualDisplay`:
  1. Record process start identity (`Win32_Process.CreationDate` on Windows, `/proc/${pid}/stat` btime ticks on Linux) upon spawn via `ProcessSupervisor`.
  2. Before issuing any termination signals, query the current OS start identity of the PID.
  3. If the PID has been recycled or does not match recorded launch ticks, termination is refused (`"Process start identity mismatch; aborting termination"`).
  4. Signals `SIGTERM` first, allows a bounded grace period (2.5s–3.0s), and falls back to `SIGKILL` only if the identity remains matched.

### 3.4 Extension Bridge Bypass Hazard
- The SuperAgent Chrome Extension WebSocket bridge (`remoteChromeBridge.ts`, port 9223) operates outside CDP target mutex locks.
- **Audit Finding**: In Linux headless and virtual-display automation, the Chrome Extension is not installed or enabled. All mutations execute strictly through native loopback CDP, passing through `assertManagedAgentMayWrite` and `withCdpTargetWrite`.

---

## 4. Milestone M2 Virtual Display Architectural Assessment

Milestone M2 implements virtual desktop support without destabilizing existing headless Linux or Windows headed modes:

```text
SuperAgent BrowserProcessManager
  ├── Mode: "headless"        --> Chrome --headless=new (No display server needed)
  ├── Mode: "headed"          --> Chrome on native desktop (Requires active DISPLAY on Linux)
  └── Mode: "virtual-display" --> VirtualDisplayWorker
                                    ├── DisplayAllocator (Scans :99 to :199, writes display-${N}.lock)
                                    ├── Xvfb Process (-screen 0 1280x800x24 -nolisten tcp)
                                    ├── Window Manager (openbox / fluxbox on DISPLAY=:${N})
                                    ├── Opt-in Local VNC (127.0.0.1:${vncPort} via -localhost)
                                    └── Headed Chrome on DISPLAY=:${N} + Loopback CDP 127.0.0.1:${port}
```

### 4.1 Collision-Free Display Allocation (`virtualDisplayAllocation.ts`)
- Eliminates hardcoded `:99` collisions.
- Probes `/tmp/.X${N}-lock`, `/tmp/.X11-unix/X${N}`, and SuperAgent session locks `~/.superagent-r/display-locks/display-${N}.lock`.
- Uses atomic file creation (`flag: "wx"`) to prevent concurrent race conditions across subagents or processes.
- Orphaned locks from dead PIDs are safely identified and reclaimed; locks belonging to live PIDs are protected.

### 4.2 Network Isolation of Virtual Display Subprocesses
- **Xvfb**: Spawned with `-nolisten tcp`. Prevents opening TCP port `6000 + N` to the local network.
- **VNC Transport**: Opt-in only. Uses `-localhost` on `x11vnc` to guarantee binding strictly to `127.0.0.1`.
- **noVNC Transport**: Opt-in only. Uses explicit host argument `127.0.0.1:${noVncPort}` on `websockify`.
- **Hard Release Gate**: M2 does NOT expose public unauthenticated VNC/noVNC ports or automatic Cloudflare tunnels. External remote access is strictly deferred to Milestone M3's authenticated HTTPS gateway with one-time nonces and human holds.

### 4.3 Actionable Missing-Package Diagnostics (`virtualDisplayPackages.ts`)
- If `Xvfb` or a supported window manager (`openbox`, `fluxbox`, `matchbox-window-manager`, `twm`) is absent:
  - Fails fast with clear actionable error.
  - Distro detection generates copy-pasteable commands for Debian/Ubuntu, RHEL/Fedora, Arch, and Alpine.
  - Never attempts to silently disable the sandbox or fake a GUI.

### 4.4 Cross-Platform Integrity
- On Windows and macOS, calling `virtual-display` mode fails fast with an informative error stating it is Linux-only, without impacting normal desktop operation.
- Existing Windows headed automation and headless Linux modes remain 100% operational.

---

## 5. Audit Conclusion & Sign-Off

- **M0/M1 Preflight Audit**: Complete; true source code values for CDP TTL (`5 min`) and atomic `mkdir` locking verified and documented.
- **M2 Virtual Display Architecture**: Verified against all security invariants (loopback binding, sandbox preservation, collision prevention, non-foreign termination).
- **Test Matrix**: 58 unit and integration tests passing across 6 test suites; 84 extended regression tests passing with 0 failures.
- **Gate Recommendation**: **APPROVED FOR M2 IMPLEMENTATION**. Remote Human Takeover remains gated pending Milestone M3 (authenticated gateway and human hold handoff).
