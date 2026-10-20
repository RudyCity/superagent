# SuperAgent Chrome CDP & Web Terminal Engine — Optimization & Hardening Plan

**Date:** 2026-10-21  
**Status:** Implemented in code; live InstaBox verification pending MCP client/server restart  
**Repository:** `D:/backup from pc asus/Documents Development/superagent`  
**Baseline:** SuperAgent `1.14.8` (git main)  
**Target Subsystems:** `src/core/tools/chromeCdp*.ts`, `src/core/mcp/tools/chromeMcpTools.ts`, `scripts/syncMcpSchemas.ts`  
**Canonical Plan:** `docs/plans/2026-10-21-superagent-chrome-cdp-terminal-optimization-plan.md`  

---

## 1. Executive Summary & Objectives

SuperAgent 1.14.8 introduced foundational Chrome DevTools Protocol (CDP) terminal automation (`read_terminal`, `read_terminal_delta`, `write_terminal`, `send_terminal_key`, `execute_terminal`, `watch_terminal`). 

During real-world empirical stress testing on cloud sandbox environments (InstaBox Linux microVMs with modern canvas-rendered xterm.js terminals), several architectural limitations and friction points were surfaced:
1. **Renderer Blind Spots**: Web terminals rendering via Canvas/WebGL (without DOM rows or globals) report `source: "unavailable"`, immediately failing `execute_terminal` and `watch_terminal`.
2. **Multi-line Input Blockade**: `write_terminal` explicitly rejects multi-line input (`/[\r\n]/`), breaking real-world deployment scripts, heredocs (`cat << 'EOF'`), and configuration injections.
3. **Control Key Limitations**: `send_terminal_key` is limited to basic keys, missing vital shell control sequences (`Ctrl+Z`, `Ctrl+A/E`, `Ctrl+U/K/W`, `Ctrl+R`, `PageUp/PageDown`).
4. **MCP Schema Drift**: When new TypeScript tools/enums are added, external MCP clients (such as Google Antigravity) use stale JSON schemas until manually updated.
5. **Windows Pathing & Process Lifecycle**: Unquoted Windows paths with spaces (`D:/backup from pc asus/...`) and abrupt process terminations cause `exit status 0xffffffff` client crashes.

This plan details the design, implementation, and verification steps to transform SuperAgent's CDP terminal engine into an enterprise-grade, resilient browser automation subsystem.

---

## 2. Empirical Audit Evidence (InstaBox Benchmark — 2026-10-20)

Testing against `https://dashboard.instabox.sh/dashboard/machines` (machine: `agent-terbaik-122`) revealed the following runtime facts:

| Component | Verified Behavior | Failure Mode / Limitation |
| :--- | :--- | :--- |
| **Terminal DOM** | Rendered via 3 HTML5 `<canvas>` layers (`.terminal.xterm`). | `domRowsCount: 0`. No `.xterm-rows` in DOM. `browserReadTerminal` returned `unavailable`. |
| **Terminal Input** | Hidden `<textarea class="xterm-helper-textarea" aria-label="Terminal input">` accepts CDP focus & keystrokes. | Working, but plain `Input.insertText` flattened newlines without triggering Enter execution. |
| **Multi-line Execution** | `write_terminal` threw `multiline terminal input is rejected.` | Forced workarounds via Base64 pipelines (`echo <b64> \| base64 -d \| bash`). |
| **MCP Client Sync** | `superagent_chrome_cdp.json` in Antigravity lacked new terminal command enums. | MCP calls failed with `unknown command 'read_terminal'`. |
| **Process Handling** | Background MCP process locked files in `node_modules` during rebuilds; killing produced `-1` exit codes. | No graceful stdio shutdown; space in path `D:/backup from pc asus` required backslash normalization. |

---

## 3. Architecture & Target State

```
┌────────────────────────────────────────────────────────────────────────┐
│                   SuperAgent CDP Terminal Engine v2                    │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Multi-Tier Terminal Reader (DOM -> Node Properties -> Fiber -> Crop)│
│    ├── Tier A: Exposed Globals (window.term, window.xterm)             │
│    ├── Tier B: DOM Node Properties (el._xterm, el.terminal)            │
│    ├── Tier C: React Fiber Hook Walk (__reactFiber$.memoizedState)     │
│    ├── Tier D: Accessible DOM Rows (.xterm-rows, [role="log"])         │
│    └── Tier E: Visual Bounding-Box Auto-Crop (Page.captureScreenshot)  │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Smart Input Dispatcher (Single-line, Bracketed Paste, Base64 Pipe) │
│    ├── Mode 'single': Direct Input.insertText + Enter                  │
│    ├── Mode 'bracketed': ANSI \x1b[200~ + text + \x1b[201~             │
│    └── Mode 'base64': Safe echo "<b64>" | base64 -d | <shell> pipeline │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Extended POSIX / Windows Virtual Keystroke Engine                   │
│    └── Ctrl+Z, Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+K, Ctrl+W, Ctrl+R, F1-F12  │
├────────────────────────────────────────────────────────────────────────┤
│ 4. Automated Build & MCP Schema Synchronizer                           │
│    └── npm run sync-mcp (TypeScript AST -> Antigravity / Claude JSON)  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Work Breakdown & Implementation Phases

### Phase 1: Multi-Tier Terminal Discovery & Visual Fallback
**Files:** `src/core/tools/chromeCdpTerminal.ts`, `src/core/tools/chromeCdpTerminalCommands.ts`

1. **DOM Instance Inspection**:
   In `browserReadTerminal`, inspect candidates attached directly to the DOM root:
   ```ts
   for (const key of ["_xterm", "terminal", "__xterm", "__terminal", "_terminalInstance"]) {
     try {
       const inst = (root as any)[key];
       if (isTerm(inst) && !instances.includes(inst)) instances.push(inst);
     } catch {}
   }
   ```
2. **React Fiber Traversal**:
   Walk `root.__reactFiber$...` to locate `ref.current` or hook memoized states with an active xterm buffer.
3. **Visual Fallback (Auto-Crop Bounding Box)**:
   When `source === "unavailable"`, do **not** hard-block `execute_terminal` or `watch_terminal` if `allow_visual_fallback: true` or `auto_crop_screenshot: true` is passed.
   - Use CDP `DOM.getBoxModel` or `element.getBoundingClientRect()` on `.xterm`.
   - Dispatch `Page.captureScreenshot` with `clip: { x, y, width, height, scale: 1 }`.
   - Return `{ source: "canvas-visual", screenshot: "<base64_or_path>", status: "running" }`.

### Phase 2: Multi-Line Scripting & Bracketed Paste Mode
**Files:** `src/core/tools/chromeCdpTerminalCommands.ts`, `src/core/tools/chromeCdpTerminalInput.ts`

1. **Option `multiline_mode`**:
   Accept `multiline_mode?: "reject" | "bracketed" | "base64" | "raw"` (default `"bracketed"` for POSIX shells, or `"base64"` when multi-line is detected with heredocs).
2. **Bracketed Paste Implementation**:
   For shells supporting bracketed paste, wrap multi-line text with `\x1b[200~` and `\x1b[201~`.
3. **Base64 Packaging Fallback**:
   If multi-line text contains complex formatting/heredocs and target is POSIX:
   ```bash
   echo "<base64_encoded_script>" | base64 -d | bash
   ```
4. **Atomic Enter Execution**:
   Ensure `Input.insertText` is followed by explicit `dispatchKeyEvent` (`rawKeyDown` + `char` + `keyUp` for KeyCode 13 / `\r`).

### Phase 3: Extended Terminal Keystroke Map
**Files:** `src/core/tools/chromeCdpTerminalInput.ts`

Add complete terminal shortcut mappings:
```ts
const NATIVE_TERMINAL_KEYS: Record<string, NativeKey> = {
  // Existing: enter, tab, escape, backspace, delete, arrows, home, end, ctrl+c, ctrl+d, ctrl+l
  // New shortcuts:
  "ctrl+z": { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 2 },
  "ctrl+a": { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 },
  "ctrl+e": { key: "e", code: "KeyE", windowsVirtualKeyCode: 69, modifiers: 2 },
  "ctrl+u": { key: "u", code: "KeyU", windowsVirtualKeyCode: 85, modifiers: 2 },
  "ctrl+k": { key: "k", code: "KeyK", windowsVirtualKeyCode: 75, modifiers: 2 },
  "ctrl+w": { key: "w", code: "KeyW", windowsVirtualKeyCode: 87, modifiers: 2 },
  "ctrl+r": { key: "r", code: "KeyR", windowsVirtualKeyCode: 82, modifiers: 2 },
  "pageup": { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  "pagedown": { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  "insert": { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  // Function keys F1-F12
  ...Array.from({ length: 12 }, (_, i) => ({
    [`f${i + 1}`]: { key: `F${i + 1}`, code: `F${i + 1}`, windowsVirtualKeyCode: 112 + i }
  })).reduce((acc, curr) => ({ ...acc, ...curr }), {})
};
```

### Phase 4: Automated MCP Tool Schema Synchronization
**Files:** `scripts/syncMcpSchemas.ts`, `package.json`

1. Create a build utility `scripts/syncMcpSchemas.ts`:
   - Reads `chromeMcpTools.ts` and tool definitions.
   - Outputs synced JSON schema files to both:
     - `D:/backup from pc asus/Documents Development/superagent/dist/mcp/`
     - `%USERPROFILE%/.gemini/antigravity/mcp/superagent/` (if folder exists).
2. Update `package.json`:
   ```json
   "scripts": {
     "sync-mcp": "tsx scripts/syncMcpSchemas.ts",
     "postbuild": "npm run sync-mcp"
   }
   ```

### Phase 5: Windows Path Normalization & Graceful MCP Shutdown
**Files:** `src/cli.ts`, `src/server.ts`, `src/core/mcp/mcpServer.ts`

1. Ensure all path strings passed to Node `child_process` and MCP spawn routines use normalized forward slashes or properly escaped Windows backslashes (`path.normalize`).
2. Implement clean SIGINT/SIGTERM listeners on MCP stdio transports so that client terminations flush streams and cleanly exit with code `0` rather than crashing with `0xffffffff`.

---

## 5. Verification & Acceptance Criteria

1. **Unit Tests (Vitest)**:
   - `tests/chromeCdpTerminalInput.test.ts`: Test all new keys (`ctrl+z`, `ctrl+a/e`, `f1-f12`) and multi-line bracketed paste encoding.
   - `tests/chromeCdpTerminal.test.ts`: Test DOM property discovery (`el._xterm`) and fallback visual crop behavior.
2. **Schema Verification**:
   - Run `npm run sync-mcp` and verify that `superagent_chrome_cdp.json` contains all new enum commands and parameters (`multiline_mode`, `allow_visual_fallback`).
3. **End-to-End Live Benchmark**:
   - Re-test against the active InstaBox machine (`agent-terbaik-122`).
   - Execute multi-line bash heredoc via `write_terminal` with `multiline_mode: "bracketed"` / `"base64"`.
   - Confirm verified exit code is observed and terminal output is captured.

---

## 6. Risk Mitigation

* **Risk**: Modifying `write_terminal` might execute commands prematurely if newlines aren't protected.
  * *Mitigation*: Default `multiline_mode` to `"bracketed"` paste mode, and fallback to Base64 wrapper if shell does not support bracketed paste.
* **Risk**: Deep React Fiber traversal might hit circular references or vary across React versions.
  * *Mitigation*: Use shallow, safe depth bounds (max depth 15, max hook scan 10) with try/catch guards.

---

## 7. Execution Record (2026-10-21)

- **Phase 1 implemented:** Known DOM instance properties and bounded React Fiber refs are inspected before accessibility/DOM fallbacks. An explicitly requested canvas-only fallback returns a cropped screenshot with status visual_only_unverified, completionVerified false, and no fabricated transcript or exit code. Read, watch and execute workflows support the opt-in.
- **Phase 2 implemented:** multiline_mode supports reject, bracketed, base64 and raw. Heredocs default to Base64 packaging only when the caller identifies a POSIX shell through verify_shell: posix; otherwise fail closed. Hazard detection examines the original multiline command before encoding. Bracketed-paste is best-effort and must not be treated as verified shell execution; raw multiline requires allow_dangerous: true. Enter uses rawKeyDown, char and keyUp.
- **Phase 3 implemented:** Ctrl+A/C/D/E/K/L/R/U/W/Z, PageUp/Down, Insert and F1-F12.
- **Phase 4 implemented:** scripts/syncMcpSchemas.ts, sync-mcp, postbuild. Definitions are generated from the real MCP registry into dist/mcp and copied to the existing Antigravity MCP schema folder without creating unrelated user directories. Build verified: 7 schemas written on first run; idempotent on subsequent runs.
- **Phase 5 implemented/verified:** STDIO MCP server installs idempotent SIGINT/SIGTERM and stdin end/close shutdown handling; existing Antigravity registration already passes the normalized CLI path as a separate args element (not a shell-interpolated command). The actual source files are src/cli.tsx and src/core/mcp/superagentMcpServer.ts rather than the placeholder paths stated in the proposal.
- **Tests:** bun run build passed; git diff --check clean aside from Git newline normalization notices; targeted Vitest run passed 117/117 tests across Chrome CDP terminal, Chrome CDP transport, and MCP server suites. New coverage includes Fiber/DOM discovery, native keys, Base64 heredoc packaging, visual-only status and schema parameter parity.
- **Live E2E:** The existing Chrome CDP connection located InstaBox agent-terbaik-122 (dashboard tab), where the currently running MCP still reports source unavailable because it predates the changes. Direct one-off invocation of the new build timed out; only its own test processes were stopped. Thus a real remote heredoc dispatch and verified remote exit code were not demonstrated. Reconnect/restart the MCP client/server using the new build, then re-run a harmless shell test before marking the benchmark complete. Never infer success from a canvas-only screenshot.
