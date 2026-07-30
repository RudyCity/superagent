# SSH Workspace Audit Report

**Date:** 2026-07-30  
**Auditor:** Automated codebase audit  
**Scope:** `src/core/ssh/` module and all SSH integration points across the codebase  

---

## Executive Summary

The SSH workspace module enables Superagent to operate on a remote host via SSH/SFTP, routing all file, shell, git, and search operations through a persistent SSH connection. The module is well-structured with clear separation of concerns and defense-in-depth boundary enforcement. One critical bug was found and fixed during this audit (ESM `require()` incompatibility). Several medium-severity security findings and test coverage gaps are documented below.

### Files Audited

| File | Lines | Role |
|------|-------|------|
| `src/core/ssh/workspaceMode.ts` | 118 | State manager: mode tracking, SSH URL parsing |
| `src/core/ssh/sshProxy.ts` | 507 | Connection management, SFTP operations, exec, path normalization |
| `src/core/ssh/sshCommands.ts` | 242 | Tool-level wrappers: read, write, edit, glob, grep, background processes |
| `src/core/ssh/sshLogger.ts` | 133 | Structured JSON logging with rotation |
| `src/core/tools/pathHelpers.ts` | 99 | Path resolution with SSH boundary enforcement |
| `src/core/permissions.ts` | 750 | Out-of-bounds detection for SSH mode |
| `src/core/tools/shellTools.ts` | 1028 | Shell tool SSH routing |
| `src/core/tools/dynamicHooks.ts` | 429 | Hook execution SSH routing |
| `src/core/tools/otherTools.ts` | 1747 | Git action/worktree SSH routing |
| `src/core/tools/fileEditTools.ts` | — | File edit SSH routing |
| `src/core/tools/fileReadTools.ts` | — | File read SSH routing |
| `src/core/tools/documentReadTools.ts` | — | Document read SSH routing |
| `src/core/tools/officeCliTools.ts` | — | Office CLI SSH routing |

### Test Files

| File | Tests | Status |
|------|-------|--------|
| `tests/sshProxy.test.ts` | 4 | ✅ Pass |
| `tests/sshWorkspaceFix.test.ts` | 19 | ✅ Pass |
| `tests/sshAdvanced.test.ts` | 2 | ✅ Pass |
| `tests/sshBulkOps.test.ts` | 3 | ✅ Pass |
| `tests/sshToolsFull.test.ts` | 37 | ✅ Pass (after fix) |
| `tests/workspaceBoundaryPermission.test.ts` | 17 | ✅ Pass |
| **Total** | **82** | **82/82 pass** |

---

## Critical Finding (Fixed)

### C1: ESM `require()` Incompatibility in `pathHelpers.ts`

**Severity:** Critical  
**Status:** ✅ Fixed  

**Problem:** The `resolveFilePathFromArgs()` function used `require("../ssh/workspaceMode.js")` to synchronously import the workspace mode module. However, the project is configured as `"type": "module"` in `package.json`, making `require()` unavailable in ESM context. This caused the SSH path resolution to silently fail and fall through to local path resolution.

**Impact:**
- SSH boundary enforcement was bypassed for all file tools that use `resolveFilePathFromArgs`
- Relative paths were resolved against local `cwd` instead of `remoteCwd`
- Absolute POSIX paths (e.g., `/mock/remote/src/index.ts`) were rejected as out-of-bounds locally
- 6 tests in `sshToolsFull.test.ts` were failing

**Fix:** Replaced the `require()` call with a top-level static `import { workspaceMode } from "../ssh/workspaceMode.js"` and extracted the SSH path resolution logic into a synchronous helper function `tryResolveSshPath()`. This is safe because `pathHelpers.ts` is not one of the circular-dependency-prone files (it doesn't import `toolsets.ts` or `prompts.ts`).

---

## Security Findings

### S1: No Host Key Verification (Medium)

**File:** `src/core/ssh/sshProxy.ts`, lines 99-106  
**Severity:** Medium  

The `connectConfig` object does not set `hostVerifier`, `hostHash`, or any host key fingerprint validation. The ssh2 library defaults to accepting any host key (TOFU without verification). The log message on line 127 says `"connected (host key verified)"` but no verification actually occurs.

**Risk:** Man-in-the-middle attacks. An attacker who can intercept the SSH connection can present their own host key and relay traffic.

**Recommendation:** Implement host key verification by storing known host keys in `~/.superagent-r/known_hosts` and setting `hostVerifier` in the connect config. At minimum, correct the misleading log message.

### S2: Password Persisted in Memory (Low)

**File:** `src/core/ssh/sshProxy.ts`, line 136  

After interactive password prompt, the password is stored in `config.password` (the `SshWorkspaceConfig` object) for the connection lifetime. This is accessible via `workspaceMode.getConfig()`.

**Risk:** Low — password is not written to disk and is only in memory. However, any code with access to the `workspaceMode` singleton can read it.

**Recommendation:** Clear the password from config after authentication succeeds, or store it in a separate private field that's not exposed via `getConfig()`.

### S3: Private Key Path in URL Query String (Low)

**File:** `src/core/ssh/workspaceMode.ts`, lines 88-94  

The `parseSshTarget()` function extracts `?key=path` from the SSH URL to specify a private key path. This path could appear in shell history, process argument lists, or logs.

**Risk:** Low — exposes the file path of a private key (not the key contents), but could help an attacker locate key files.

**Recommendation:** Document this as expected behavior. Consider supporting key path via interactive prompt or config file instead of URL parameter.

### S4: Remote Process Kill Without Validation (Low)

**File:** `src/core/ssh/sshCommands.ts`, line 156  

`sshKillBackgroundProcessExecute` runs `kill -9 ${sshProxy.escapeShellArg(processId)}` with a user-supplied PID. While the PID is shell-escaped, `kill -9` is sent to whatever PID the user specifies, which could target arbitrary processes on the remote host.

**Risk:** Low — the PID comes from the AI agent which obtained it from `execBackground()`, but a compromised prompt could specify any PID.

**Recommendation:** Track background PIDs started by Superagent and validate that the requested PID is in the tracked set before killing.

### S5: Exec Timeout Doesn't Kill Remote Process (Medium)

**File:** `src/core/ssh/sshProxy.ts`, lines 332-341  

The `exec()` method uses `Promise.race()` with a timeout promise, but when the timeout fires, the remote process continues running. The SSH stream is not closed on timeout.

**Risk:** Resource leak on the remote host — orphaned processes continue consuming CPU/memory after the timeout.

**Recommendation:** In the timeout handler, close the SSH stream to terminate the remote process:
```typescript
const timeoutPromise = new Promise<never>((_, reject) => {
  timer = setTimeout(() => {
    try { stream.close(); } catch {}
    reject(new Error(`SSH execution timed out after ${timeoutMs}ms`));
  }, timeoutMs);
});
```

---

## Code Quality Findings

### Q1: `parseSshTarget` Missing Host/Port Validation (Low)

**File:** `src/core/ssh/workspaceMode.ts`, lines 45-115  

The parser validates the remote path (non-empty, starts with `/`, no null bytes, no double slashes) but does not validate:
- Host format (could contain spaces, special characters)
- Port range (could be 0, negative, or > 65535)

**Recommendation:** Add host format validation (hostname or IP regex) and port range check (`1 <= port <= 65535`).

### Q2: `sshGlobToolExecute` Find Command Structure (Low)

**File:** `src/core/ssh/sshCommands.ts`, line 207  

The command `find . -path ${escapedPattern} -o -name ${escapedPattern}` uses the same escaped pattern for both `-path` and `-name`. This is functionally redundant — `-path` matches the full path while `-name` matches the basename. Using both with the same pattern could produce unexpected results.

**Recommendation:** Use `-name` for simple filename patterns and `-path` for path patterns, or let the caller specify which mode to use.

### Q3: Cache Mtime Check Requires Extra SFTP Call (Info)

**File:** `src/core/ssh/sshProxy.ts`, lines 371-385  

The smart cache performs an SFTP `stat()` call on every cache hit to validate the file hasn't changed. This adds network latency to every cached read, potentially negating the caching benefit for frequently-read files.

**Recommendation:** This is a correctness-vs-performance trade-off. Consider adding a configurable mode: "strict" (current behavior) vs "fast" (trust cache within TTL without mtime check).

### Q4: `ensureConnected()` Socket Check (Low)

**File:** `src/core/ssh/sshProxy.ts`, lines 174-184  

The reconnection logic checks `this.sshClient._sock?.destroyed || this.sshClient._sock?.closed` but doesn't handle half-open connections where the socket appears alive but the SSH session is dead (e.g., remote host rebooted without closing the connection).

**Recommendation:** Add a lightweight keepalive check (e.g., `exec("true", ".", 5000)`) before proceeding if the connection has been idle for a configurable period.

### Q5: Log Rotation Race Condition (Info)

**File:** `src/core/ssh/sshLogger.ts`, lines 85-95  

The log rotation logic checks `byteCount + bytes > MAX_BYTES` and then truncates. While Node.js is single-threaded, the `WriteStream.write()` is async, so the `byteCount` tracking could drift if multiple writes are queued.

**Recommendation:** This is unlikely to cause issues in practice due to Node.js's single-threaded event loop. No action needed unless log integrity is critical.

---

## Test Coverage Gaps

The following areas have no test coverage:

| Area | File | Risk |
|------|------|------|
| `sshLogger.ts` — rotation, write failures | `sshLogger.ts` | Low |
| `connect()` — auth flows, retry, error handling | `sshProxy.ts` | Medium |
| `disconnect()` — cleanup, listener removal | `sshProxy.ts` | Low |
| `writeFile()` — SFTP put, cache update | `sshProxy.ts` | Medium |
| `listFiles()` — SFTP list, type mapping | `sshProxy.ts` | Low |
| `getSystemMetrics()` — command parsing | `sshProxy.ts` | Low |
| `resolvePassword()` — prompt flow, handler fallback | `sshProxy.ts` | Medium |
| `execBackground()` — nohup, PID extraction | `sshProxy.ts` | Medium |
| `sshEditToolExecute` — content matching, replacement | `sshCommands.ts` | Medium |
| `sshMultiEditToolExecute` — chunk ordering, partial failure | `sshCommands.ts` | Medium |
| Concurrent `connect()` — promise deduplication | `sshProxy.ts` | Low |
| `parseSshTarget` — IPv6 hosts, edge cases | `workspaceMode.ts` | Low |

---

## Architecture Assessment

### Strengths

1. **Clear separation of concerns** — `workspaceMode` (state), `sshProxy` (connection/operations), `sshCommands` (tool wrappers), `sshLogger` (logging) are well-isolated.

2. **Defense-in-depth boundary enforcement** — Path boundary is enforced at two levels: `normalizePosixPath()` in `sshProxy` and `tryResolveSshPath()` in `pathHelpers`, plus `isToolCallOutOfBounds()` in `permissions.ts`.

3. **Correct dynamic import pattern** — Tool files that need SSH modules use dynamic `import()` inside `execute()` to avoid circular dependencies, following the project's AGENTS.md guidelines.

4. **Robust error handling in `exec()`** — The `settled` flag prevents double-resolution, `streamError` tracking ensures stream errors aren't silently swallowed, and the `error` event is wired before `close` to prevent silent failures.

5. **Smart cache with mtime validation** — The file cache checks modification time before returning cached content, preventing stale reads.

6. **Comprehensive SSH routing** — All major tool categories (file read/write/edit, shell, git, search, hooks, document reading, office CLI) have SSH routing.

7. **Shell escaping** — `escapeShellArg()` uses the standard POSIX single-quote wrapping technique, which is correct and secure.

### Areas for Improvement

1. **Host key verification** — Currently absent; should be implemented for production use.
2. **Connection health monitoring** — Only checks socket state, not session liveness.
3. **Background process tracking** — No PID validation before kill operations.
4. **Test coverage** — Connection lifecycle and SFTP operations are untested.

---

## Changes Made

### `src/core/tools/pathHelpers.ts`
- **Fixed:** Replaced `require("../ssh/workspaceMode.js")` (incompatible with ESM) with a top-level static `import { workspaceMode } from "../ssh/workspaceMode.js"`.
- **Added:** `tryResolveSshPath()` helper function that performs synchronous SSH path resolution with boundary enforcement.
- **Result:** 6 previously-failing tests now pass; SSH boundary enforcement works correctly for all file tools.

---

## Verification

```
SSH Test Suite: 82/82 passed
TypeScript Build: No errors