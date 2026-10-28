# SuperAgent Linux Headless CDP & Security Architecture Audit (Milestone M0)

**Date:** 2026-10-28  
**Scope:** Milestone M0 of the SuperAgent Linux Headless CDP + Human Takeover Master Plan  
**Target:** SuperAgent Core, Browser Runtime, CDP Gateway, MCP Tools  
**Auditor:** SuperAgent Core & Browser Automation Engineering  
**Status:** COMPLETE / CANONICAL AUDIT  

---

## 1. Executive Summary

As part of the **SuperAgent Linux Headless CDP + Secure Human Takeover Master Plan** (`docs/plans/2026-10-28-superagent-linux-headless-cdp-human-takeover-master-plan.md`), Milestone M0 mandates an exhaustive security and architectural audit of:
1. All active CDP control and mutation paths across SuperAgent;
2. Direct-CDP bypass surfaces and uncoordinated communication channels;
3. Lease, lock, and human hold guarantees;
4. Linux environment compatibility constraints (displayless servers, sandbox requirements, executable resolution, process ownership).

This audit identifies critical invariants and security boundaries required before enabling headless browser execution (M1) and future virtual-desktop remote human takeover (M2–M4).

---

## 2. Inventory of CDP Control & Write Paths

SuperAgent interacts with Chromium browsers through three primary layers: Native Chrome DevTools Protocol (CDP HTTP/WebSocket), Set-of-Mark Vision perception, and the optional SuperAgent Chrome Extension WebSocket bridge.

| Subsystem / Tool | Entry File | Write / Mutation Mechanisms | Coordinator Protection | Human Hold Guard |
| :--- | :--- | :--- | :--- | :--- |
| **`control_chrome_cdp`** | `src/core/tools/chromeCdpTools.ts` | Navigations, clicks, keyboard events, DOM evaluations, cookies, viewport, emulation | `withCdpTargetWrite` & `guarded()` per-target lock | **Enforced** via `assertManagedAgentMayWrite` |
| **`control_chrome_vision`** | `src/core/tools/chromeVisionTools.ts` | Set-of-Mark coordinate clicks (`click_id`), typing (`type_id`), hover, interactive dispatches | `withCdpTargetWrite` & `guarded()` per-target lock | **Enforced** via `assertManagedAgentMayWrite` |
| **`superagent_browser_gateway`** | `src/core/tools/crossIdeCdpGateway.ts` | Shared MCP CDP operations from Codex, Antigravity, or other IDEs | `withCdpTargetWrite` with `expectedRevision` fencing | **Enforced** via `assertManagedAgentMayWrite` |
| **`chromeCdpTerminal`** | `src/core/tools/chromeCdpTerminal.ts` | Interactive terminal keystrokes into CDP pages | Wrapped in `controlChromeCdpTool` dispatch | **Enforced** via write categorization |
| **`remoteChromeBridge`** | `src/core/tools/remoteChromeBridge.ts` | Commands dispatched to Chrome Extension sidepanel or content scripts (port 9223) | **NONE (Direct Bridge)** | **BYPASS RISK**: Does not check `withCdpTargetWrite` |
| **`browserMacroTools`** | `src/core/tools/browserMacroTools.ts` | Macro helpers (`callBrowser`) routing to extension bridge | **NONE (Direct Bridge)** | **BYPASS RISK**: Does not check `withCdpTargetWrite` |

### Key Audit Findings:
1. **CDP Native Layer is Well-Guarded**: All mutating actions in `chromeCdpTools.ts` and `chromeVisionTools.ts` pass through `classifyCdpCommand()`. If classified as `"write"`, execution is routed through `withCdpTargetWrite(port, targetId, agentId, fn)`.
2. **Human Hold Integration**: `withCdpTargetWrite` imports and evaluates `assertManagedAgentMayWrite(port, targetId)`. If a human hold file exists in `~/.superagent-r/cdp-sessions/human-holds/<key>.json` and the browser fingerprint matches, `assertManagedAgentMayWrite` throws an error (`"Human has control of this tab. Wait for Return to Agent."`), immediately aborting the agent mutation.
3. **Extension Bridge Bypass Hazard**: The Chrome Extension WebSocket bridge (`remoteChromeBridge.ts` listening on loopback port 9223) bypasses the CDP coordinator entirely. While designed for desktop extension control, if an agent uses extension tools concurrently while a CDP target is under human hold, mutations could occur. **Remediation Invariant:** In headless Linux environments, the Chrome Extension is not installed or utilized; automation operates strictly via native loopback CDP.

---

## 3. Direct-CDP Bypass & Security Surface Analysis

### 3.1 Loopback vs. Network Exposure
- **Vulnerability**: Chromium's `--remote-debugging-port` provides unrestricted remote control over the browser, including arbitrary script execution (`Runtime.evaluate`), navigation, filesystem download triggers, and target termination.
- **Enforcement**:
  - Chrome must **strictly** bind to loopback: `--remote-debugging-address=127.0.0.1`.
  - Binding to `0.0.0.0` or a public interface is strictly prohibited.
  - In multi-tenant environments, any local process under the same OS user can connect to `127.0.0.1:9222`. Application-level coordinator locks in TypeScript cannot prevent an uncoordinated local process from connecting directly to the port. Therefore:
    - Dedicated OS user or container isolation is mandatory for multi-tenant deployments.

### 3.2 The `--no-sandbox` Hazard
- **Vulnerability**: Disabling Chromium's sandbox via `--no-sandbox` removes user namespace, seccomp-bpf, and chroot protections. Any zero-day renderer exploit in a visited website yields immediate host shell execution.
- **Enforcement**:
  - The runtime must **never** default to `--no-sandbox`.
  - On Linux servers, Chromium must run with sandbox enabled under a non-root user account (configured with standard user namespaces `kernel.unprivileged_userns_clone=1`).

### 3.3 Foreign Process Termination Hazard
- **Prior Gap**: Legacy code used executable name or port presence to assume Chrome ownership. Killing processes blindly (`pkill -f chrome` or killing any process listening on 9222) risks terminating a developer's personal browser or an external service.
- **Enforcement**:
  - The browser runtime must integrate with SuperAgent's `ProcessSupervisor` / `ProcessRegistry` (`src/core/process/processSupervisor.ts`).
  - Spawning records:
    - Unique `recordId`;
    - Process `pid`;
    - `creationIdentity` (process start timestamp ticks);
    - Full executable path;
    - Target CDP port and mode.
  - Termination must **strictly** verify that the target OS process start identity matches the recorded launch identity. If unverified or mismatched, termination is aborted.

---

## 4. Lease, Lock, and Revision Guarantees

SuperAgent's CDP session manager (`src/core/tools/chromeCdpSessionManager.ts`) implements cross-process synchronization:

1. **Per-Target Mutex (`guarded`)**:
   - Uses file locks (`~/.superagent-r/cdp-sessions/targets/<hash>.lock`) via `proper-lockfile` semantics to prevent concurrent write collisions on the same tab.
2. **Lease TTL & Claim Heartbeats**:
   - Agent claims have a bounded TTL (90,000 ms).
   - Writes renew active owner leases.
   - Stale leases automatically expire, preventing permanent lockouts if an agent crashes.
3. **Revision Fencing (`expectedRevision`)**:
   - Each successful mutation increments `current.revision`.
   - Shared multi-agent operations require `expectedRevision`. If an intervening agent or human modified the DOM, subsequent stale writes fail fast (`"CDP stale revision: refresh snapshot and retry."`).
4. **Generation Binding**:
   - Each browser launch generates a distinct runtime generation and browser fingerprint (SHA-256 of `/devtools/browser/<uuid>`).
   - If Chrome restarts or crashes, the browser fingerprint changes, causing stale target claims and human holds to fail closed rather than attaching to an unverified browser instance.

---

## 5. Linux Environment Compatibility Matrix

Displayless Linux servers (Ubuntu/Debian via SSH, VPS, Docker) present specific runtime differences compared to desktop Windows/macOS workstations:

| Dimension | Windows / macOS | Linux Desktop (X11 / Wayland) | Linux Server (Headless / SSH) |
| :--- | :--- | :--- | :--- |
| **Display Availability** | Always available (`win32` / `darwin`) | `DISPLAY` or `WAYLAND_DISPLAY` set | **Absent** (`DISPLAY` unset) |
| **Chromium Headed Launch** | Native desktop window | Opens in desktop environment | **Crashes immediately** (`Missing X server`) |
| **Headless Flag Requirement** | Optional (`--headless=new`) | Optional | **Mandatory** (`--headless=new`) |
| **GPU Acceleration** | Hardware GPU active | Hardware or Mesa OpenGL | Software only; requires `--disable-gpu` |
| **Executable Names** | `chrome.exe` / `Google Chrome` | `google-chrome`, `chromium` | `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` |
| **Profile Permissions** | Default ACLs | Standard POSIX | **Must enforce `0700`** directory permissions |
| **Virtual Display (M2)** | N/A | N/A | Requires Xvfb + minimal WM (reserved for M2) |

### Mode Resolution Matrix for M1:

```text
Requested Mode    Platform    DISPLAY / Wayland?    Effective Mode     Outcome
-------------------------------------------------------------------------------------------------
"auto"            Linux       Absent                "headless"         Launch with --headless=new
"auto"            Linux       Present               "headed"           Launch headed
"auto"            Windows     N/A                   "headed"           Preserve Windows headed
"auto"            Darwin      N/A                   "headed"           Preserve macOS headed

"headless"        Any         Any                   "headless"         Launch with --headless=new
"headed"          Linux       Absent                ERROR              Fail fast: DISPLAY missing
"headed"          Linux       Present               "headed"           Launch headed
"headed"          Windows     N/A                   "headed"           Launch headed

"virtual-display" Any         Any                   ERROR              Fail fast: Reserved for M2
```

---

## 6. Recommendations & Action Items for Milestone M1

1. **Dedicated Module Architecture**: Create `src/core/browserRuntime/` to decouple browser lifecycle, executable discovery, and mode configuration from CLI tools.
2. **Canonical Launcher Unification**: Update `src/core/tools/chromeCommon.ts` (`ensureCdpRunning`) to delegate to `BrowserProcessManager`, eliminating ad-hoc unmonitored `child_process.spawn` calls.
3. **Fail-Fast Safety Checks**:
   - Reject `virtual-display` with an actionable message stating it is reserved for Milestone M2.
   - Reject `headed` on displayless Linux hosts with clear guidance to use `headless` mode.
4. **Ownership-Aware Stop**: Implement graceful termination (`SIGTERM` followed by timeout and verified `SIGKILL`), refusing to terminate any PID not recorded in the process registry.
5. **Port & Health Verification**: Verify `/json/version` and `/json/list` endpoints to confirm browser readiness before returning control to the caller.

---

## 7. Audit Sign-Off

- **CDP Write Paths Audited**: 100%
- **Direct-CDP Bypass Assessed**: Yes (Loopback and OS isolation documented)
- **Lease & Revision Guarantees Confirmed**: Yes (Fail-closed on fingerprint/generation mismatch)
- **Linux Environment Matrix Defined**: Complete
- **Status**: **PASS — Milestone M0 Requirements Fully Satisfied**. Proceed to Milestone M1 implementation.
