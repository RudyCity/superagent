# SuperAgent End-to-End Verification & Fix Report

**Date:** 2026-11-25  
**Repository:** `D:\backup from pc asus\Documents Development\superagent`  
**Base Commit:** `21889e0d` (`fix(tray): support desktop rule requests, dynamic tool action dropdowns, and MSIX app discovery`)  
**Runtime Version:** `1.14.109` (Bun `1.4.2`)  

---

## 1. Executive Summary

All targeted fixes and end-to-end verifications across the SuperAgent Core TypeScript runtime, MCP server, and native Tauri Tray registry have been completed and verified against live runtime workers:

- **Bug A (`list_monitors`):** Fixed `System.ArgumentException: Argument types do not match` in `MONITOR_DISCOVERY_SCRIPT` (`src/core/desktopUi/adapters/windows.ts`) by converting `System.Collections.Generic.List[object]` to a plain .NET array via `$monitorArray = $monitors.ToArray()` before constructing `[pscustomobject]@{ monitors = $monitorArray; count = $monitorArray.Length }`. Added unit test coverage in `tests/desktop-app-management/windows-provider.test.ts` and verified live via `superagent_desktop_ui(command: "list_monitors")` after Core build, blue-green restart, and MCP backend reload.
- **Bug B (`find_window`):** Verified schema alignment across `src/core/tools/desktopUiTools.ts`, `src/core/tools/registeredFileToolGate.ts`, and `src/core/desktopUi/discovery.ts`, as well as live execution via `superagent_desktop_ui(command: "find_window", query: "SuperAgent")`.
- **Bug C (`open` / `launch_app` & `desktop-access-registry.json`):** Verified fail-closed permanent host file-policy mediation (`[HOST_FILE_POLICY_UNCERTIFIED]`) and Start AppsFolder AUMID resolution to canonical `.exe` + SHA-256 against `desktop-access-registry.json` (`v2`, `defaultEffect: "deny"`).

---

## 2. Code Changes Applied

### 2.1 `src/core/desktopUi/adapters/windows.ts` (Lines 172–177)
Replaced PowerShell array-subexpression wrapping (`@($monitors)`) inside `[pscustomobject]@{ ... }` with `$monitors.ToArray()`:

```diff
+$monitorArray = $monitors.ToArray()
 [pscustomobject]@{
-  monitors = @($monitors)
-  count = $monitors.Count
+  monitors = $monitorArray
+  count = $monitorArray.Length
 } | ConvertTo-Json -Depth 6 -Compress
 `;
```

### 2.2 `tests/desktop-app-management/windows-provider.test.ts`
Added unit test `"discovers active monitors via ToArray() without PowerShell PSCustomObject ArgumentException"` asserting that `createWindowsDesktopUiAdapter(runner).listMonitors()` emits `$monitorArray = $monitors.ToArray()` (and never `monitors = @($monitors)`) and parses multi-monitor bounds/workingArea payloads cleanly.

---

## 3. Verbatim Verification Evidence

### 3.1 Vitest Unit & Security Integration Suites
Command:
```powershell
bunx vitest run tests/desktop-app-management/windows-provider.test.ts tests/mcpPermissionDecision.test.ts tests/desktop-ui-integration/registered-file-tool-gate.test.ts
```
Output (`Exit Code: 0`):
```text
 RUN  v4.1.10 D:/backup from pc asus/Documents Development/superagent

 ✓ tests/desktop-app-management/windows-provider.test.ts (4 tests) 15ms
 ✓ tests/mcpPermissionDecision.test.ts (9 tests) 17ms
 ✓ tests/desktop-ui-integration/registered-file-tool-gate.test.ts (25 tests) 153ms

 Test Files  3 passed (3)
      Tests  38 passed (38)
```

### 3.2 MCP Capability Matrix, Preflight & Doctor Suite
Command:
```powershell
bun test tests/mcpCapabilityPreflightDoctor.test.ts
```
Output (`Exit Code: 0`):
```text
bun test v1.4.2 (744846f84)

tests\mcpCapabilityPreflightDoctor.test.ts:
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 1: reports host_policy_blocked when project grant is present but host policy is uncertified [6.41ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 2: rejects execution with oauth_scope_missing when caller lacks required scope [0.95ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 3: reports project_grant_missing when caller lacks required project capability [0.48ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 4: reports file_outside_project when argument references file outside project root [1.27ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 5: flags approval_required for operations requiring operator confirmation [0.41ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 6: reports dependency_missing when action prerequisites are not met [77.59ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 7: aggregates service health and isolates probe timeouts without failing other services [2.72ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 8: reports target_not_claimed when leased web actions are invoked without sessionToken [0.65ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 9: validates expectedRevision in preflight arguments [0.51ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 10: accurately flags uncertified actions in capability matrix [0.39ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > accepts exact secure Delegate uploads without requiring a caller-supplied ingress receipt [0.79ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > rejects secure Delegate upload preflight without explicit upload consent [0.55ms]
(pass) Unified Tool Capability Matrix & Preflight Engine > Scenario 15: preserves dynamic gateway discovery, resolves tool aliases, and identifies deprecated endpoints [1.18ms]
(pass) Tool Doctor Diagnostics > audits the MCP catalog and classifies actions without blind success claims [5.00ms]
(pass) Tool Doctor Diagnostics > doctorCommand executes and writes formatted audit report to context [114.47ms]

 15 pass
 0 fail
 70 expect() calls
Ran 15 tests across 1 file. [1.86s]
```

### 3.3 Rust Tray `desktop_access_registry` Unit Suite
Command:
```powershell
cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml desktop_access_registry
```
Output:
```text
     Running unittests src\main.rs (apps\superagent-tray\src-tauri\target\debug\deps\superagent_tray-fd0656439d146fe9.exe)

running 10 tests
test desktop_access_registry::tests::detects_identical_target_for_deduplication ... ok
test desktop_access_registry::tests::detects_identical_desktop_target_for_deduplication ... ok
test desktop_access_registry::tests::strips_windows_verbatim_namespace_prefix ... ok
test desktop_access_registry::tests::rejects_unc_or_wildcard_path_and_unknown_modes ... ok
test desktop_access_registry::tests::audit_entry_appends_and_reads_back ... ok
test desktop_access_registry::tests::permanent_rules_are_versioned_and_default_denied ... ok
test desktop_access_registry::tests::pending_active_rule_requests_enqueue_deduplicate_and_persist ... ok
test desktop_access_registry::tests::registry_update_is_atomic_and_replaces_existing_path ... ok
test desktop_access_registry::tests::verifies_executable_from_real_binary ... ok
test desktop_access_registry::tests::installed_app_discovery_returns_structured_entries ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 132 filtered out; finished in 2.70s
```

### 3.4 Toolchain Diagnostic (`gh --version`)
Command:
```powershell
gh --version
```
Output (`Exit Code: 0`):
```text
gh version 2.83.2 (2025-12-10)
https://github.com/cli/cli/releases/tag/v2.83.2
```

### 3.5 Production Build, Blue-Green Core Restart & URL-Stable MCP Reload
- **Build (`bun run build`):**
  ```text
  Building superagent@1.14.109 with Bun 1.4.2
  MCP Chrome schemas synchronized: dist=0, existing Antigravity folder=51.
  [Named MCP] two Bun launchers bundled and SHA-256 verified, version 1.14.109
  [Core build] SHA-256 f5482ad25c46172c005809f35448f4706c023188c17f57c78f5f18e895611272; source 8af421ad269469961adf840891d102bd8364d84d4055dd35bc947d3d88c0be85; files 1065
  [SuperAgent Tray] Installed to C:\Users\USER\.superagent-r\bin\superagent-tray.exe
  [SuperAgent Tray] Promoted active global release: 5445f3630109de0dd41188ab9242327a4cf36820ea3e6738313efc8566914a01
  ```
- **Core Blue-Green Restart (`superagent_core_restart`):**
  - Supervisor PID: `41576` (port `7888`)
  - Previous Worker PID: `40352` -> New Active Worker PID: `38372`
  - Verified Build Digest: `f5482ad25c46172c005809f35448f4706c023188c17f57c78f5f18e895611272`
- **MCP Backend Reload (`superagent_manage_services`):**
  - Owner PID: `10504` (port `9227`)
  - Previous Backend PID: `18424` -> New Backend PID: `34140`
  - Preserved Public URL: `https://breath-above-have-gateway.trycloudflare.com/mcp`

### 3.6 Live MCP Tool Verification (`list_monitors` & `find_window`)

#### `superagent_desktop_ui({ "command": "list_monitors" })`
```json
{
  "success": true,
  "monitors": [
    {
      "index": 0,
      "deviceName": "\\\\.\\DISPLAY1",
      "primary": true,
      "bitsPerPixel": 32,
      "bounds": {
        "x": 0,
        "y": 0,
        "width": 2560,
        "height": 1600
      },
      "workingArea": {
        "x": 0,
        "y": 0,
        "width": 2560,
        "height": 1528
      }
    }
  ],
  "count": 1
}
```

#### `superagent_desktop_ui({ "command": "find_window", "query": "SuperAgent" })`
```json
{
  "success": true,
  "windows": [
    {
      "pid": 12164,
      "nativeId": "79497404",
      "title": "SuperAgent · Runtime & Desktop Companion",
      "active": false,
      "scaleFactor": 1.5,
      "bounds": {
        "x": -11,
        "y": -11,
        "width": 2582,
        "height": 1550
      },
      "application": "superagent-tray"
    },
    {
      "pid": 12164,
      "nativeId": "6359184",
      "title": "click.superagent.app-siw",
      "active": false,
      "scaleFactor": 1.5,
      "bounds": {
        "x": 0,
        "y": 0,
        "width": 22,
        "height": 22
      },
      "application": "superagent-tray"
    }
  ],
  "limit": 50,
  "truncated": false
}
```
