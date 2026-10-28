# SuperAgent Linux CDP Headless + Human Takeover: Milestones M1–M3 Remediation & Follow-Up Plan

**Date:** 2026-10-28  
**Scope:** Actionable unclosed gaps identified during the M1–M3 Deep Audit  
**Target:** Linux Headless CDP, Virtual Display Worker, and Secure Human Takeover Subsystems  
**Status:** ACTIONABLE REMEDIATION PLAN (Fail-Closed Gates Enforced)

---

## 1. Overview & Remediation Objectives

The Milestone M1–M3 Deep Audit (`docs/audits/2026-10-28-superagent-linux-cdp-m1-m3-deep-audit.md`) certified that all source code implementations for headless CDP, virtual display worker supervision, process ownership identity tracking, and the secure human takeover state machine are complete and pass automated unit, integration, and security negative suites (157 passed tests, 498 assertions).

However, in accordance with SuperAgent's strict release gate policy (R0–R7 fail-closed), **production cutover is blocked** until real-world Linux kernel execution and infrastructure hardening gates are fulfilled. This document details the exact, actionable steps required to resolve each remaining gap.

---

## 2. Actionable Remediation Roadmap

### GAP-01 (P0): Live Linux Kernel End-to-End Verification (Ubuntu / Debian)

- **Issue**: Current development and testing occurred on Windows 11 (`win32`). While argument generation, display lock collision avoidance, package discovery, and process start identity matching are tested with mock environments, spawning real `Xvfb`, `openbox`, and `google-chrome-stable` on a real Linux kernel has not been executed on this machine.
- **Required Host Environment**: Clean Ubuntu 22.04 LTS or 24.04 LTS server (or Debian 12) without physical monitor or existing X11/Wayland display.
- **Actionable Execution Plan**:
  1. Provision an Ubuntu VM or dedicated staging container:
     ```bash
     sudo apt-get update
     sudo apt-get install -y wget curl xvfb openbox x11vnc websockify novnc
     wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
     sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
     ```
  2. Verify non-root user execution:
     ```bash
     useradd -m -s /bin/bash superagent-worker
     su - superagent-worker
     ```
  3. Clone worktree branch and install Bun:
     ```bash
     curl -fsSL https://bun.sh/install | bash
     source ~/.bashrc
     bun install
     bun run build
     ```
  4. Execute the live Linux virtual display E2E test:
     ```bash
     bun test tests/browserRuntimeVirtualDisplay.test.ts
     bun test tests/browserTakeoverProtocol.test.ts
     bun test tests/browserTakeoverSecurity.test.ts
     ```
  5. Run an interactive end-to-end takeover verification:
     - Launch headed Chrome in virtual display `:101`;
     - Verify X11 domain socket `/tmp/.X11-unix/X101`;
     - Request takeover on a synthetic OTP challenge page;
     - Connect via mobile/laptop browser through the authenticated takeover UI;
     - Enter OTP manually in the virtual desktop;
     - Trigger "Return to Agent" and confirm that input is revoked, fingerprint is revalidated, and agent resumes;
     - Record process birth identities (`/proc/${pid}/stat`) and capture exit codes.
  6. **Gate Criteria for Certification**: Exit code 0 on all suites; verified display allocation; zero orphaned Xvfb/Chrome processes upon shutdown.

---

### GAP-02 (P1): Containerized Deployment & Non-Root Namespace Isolation

- **Issue**: On Linux, all processes running under the *same OS user account* can connect directly to loopback `127.0.0.1:9222` without passing through SuperAgent's in-process coordinator locks. For multi-tenant or shared-server environments, OS-user or container network namespace isolation is mandatory.
- **Actionable Execution Plan**:
  1. Create a production-hardened `Dockerfile.headless-browser`:
     ```dockerfile
     FROM ubuntu:24.04

     ENV DEBIAN_FRONTEND=noninteractive
     RUN apt-get update && apt-get install -y \
         wget curl ca-certificates xvfb openbox x11vnc websockify novnc \
         libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
         libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
         libgbm1 libasound2t64 \
         && wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
         && apt-get install -y ./google-chrome-stable_current_amd64.deb \
         && rm google-chrome-stable_current_amd64.deb \
         && rm -rf /var/lib/apt/lists/*

     # Dedicated non-root user
     RUN useradd -m -u 1001 -s /bin/bash browseragent \
         && mkdir -p /home/browseragent/.superagent-r \
         && chown -R browseragent:browseragent /home/browseragent

     USER browseragent
     WORKDIR /home/browseragent
     ```
  2. Implement `docker-compose.takeover.yml` with separate network namespace and resource limits (caps on RAM: 2GB, CPU: 2 cores).
  3. Ensure user namespaces are enabled so Chromium sandbox functions without `--no-sandbox`.

---

### GAP-03 (P1): Production External HTTPS / OIDC Reverse Proxy Hardening

- **Issue**: Local transports bind strictly to `127.0.0.1`. Remote human takeover from a mobile phone or laptop requires an external HTTPS reverse proxy with real TLS and user authentication (OIDC/SSO).
- **Actionable Execution Plan**:
  1. Maintain `humanTakeover.remoteAccessEnabled: false` as the default in production configuration.
  2. Provide canonical Caddy and Nginx reverse proxy configuration templates in `docs/guides/linux-headless-takeover-deployment.md`:
     - TLS termination with valid Let's Encrypt / enterprise certificates;
     - OIDC / OAuth2 proxy authentication layer enforcing user identity before reaching SuperAgent Core;
     - WebSocket upgrade proxying for `/api/browser/takeover/ws`;
     - Strict Origin header verification.
  3. Add a startup configuration validator: If `humanTakeover.remoteAccessEnabled` is set to `true`, verify that an external reverse proxy authorization header or TLS environment is present; if not, fail closed with an error.

---

### GAP-04 (P2): Automated Heuristic Challenge Detection

- **Issue**: Currently, takeover must be initiated explicitly by the agent calling `request_human_takeover`. Detecting CAPTCHAs, OTPs, or auth walls automatically reduces task latency.
- **Actionable Execution Plan**:
  1. Implement `src/core/browserTakeover/challengeDetector.ts`:
     - Inspect DOM node signatures for common verification widgets (e.g. `iframe[src*="recaptcha"]`, `iframe[src*="turnstile"]`, `iframe[src*="hcaptcha"]`, `input[autocomplete="one-time-code"]`);
     - Detect navigation to standard authentication endpoints (`accounts.google.com`, `login.microsoftonline.com`, `auth0.com`);
     - Rate-limit detections and report uncertainty as `CHALLENGE_SUSPECTED`.
  2. Emit an advisory event to the agent rather than auto-locking the browser, allowing the agent to confirm before pausing.
  3. Strict privacy rule: Do not extract or log form input field values or password attributes.

---

## 3. Milestone Completion Tracking

| Gap Item | Severity | Owner | Target Milestone | Blocked Release Gate |
| :--- | :--- | :--- | :--- | :--- |
| GAP-01: Real Linux Kernel E2E on Ubuntu | P0 | Browser Gateway | Staging Linux Run | Gate R4 / Desktop E2E |
| GAP-02: Container & Non-Root Namespace | P1 | DevOps / Core | Milestone M5 | Gate R2 / OS Keystore & ACL |
| GAP-03: HTTPS / OIDC Reverse Proxy Guide | P1 | Security Team | Milestone M5 | Gate R1 / TLS Enforcement |
| GAP-04: Heuristic Challenge Detector | P2 | Agent Automation | Milestone M4 | Feature Polish |

**Conclusion**: All code modifications in Milestones M1–M3 are verified, stable, and regression-free. Milestone M4 (Pause/Detect/Resume Orchestration) and Milestone M5 (Hardening & Deployment) can proceed in staging while GAP-01 is scheduled on an Ubuntu host.
