# SuperAgent Permanent Access Manager — Implementation and verification

## Requested behavior

The host configures app and file permissions once at startup. Registered rules
have **no expiry date** and persist until the host revokes them. Runtime
desktop sessions remain short-lived, bound to a verified native window, and
cannot bypass UAC/OS security.

## Implemented

- **Host-owned native v2 registry**: `desktop-access-registry.json` in the native
  Tray config directory; initializes empty with default deny; only native
  focused Tray with attended host dialog can enroll; native revoke is immediate
  at next Core action. Old v1 time-limited trust is not silently promoted.
- **App policies**: view/input allow or deny, exact OS executable path and
  SHA-256 identity, optional exact window title, optional accessibility role
  and label for individual actionable controls. Explicit deny overrides allow.
  Native authorization checks fresh target, PID/window, OS process, executable
  hash and the approval race before persisting any rule.
- **OS identity adapters**: Windows process path/birth verification+SHA256 via
  PowerShell; Linux /proc executable+process-starttime checks, canonical path
  and SHA256; macOS canonical executable via /bin/ps comm/lstart plus SHA256.
  Missing/unverifiable identity fails closed. Linux WSL smoke succeeded.
- **Core session integration**: new registrations are checked at input
  admission and on every input action. Element role and label checks are at
  actual semantic dispatch. Registered viewing is checked before opening,
  and again at every screenshot. Revoked or changed process denies actions.
  Legacy/global session consent cannot override installed v2 policy.
- **Core-managed file policies**: native file/folder picker binds exact
  canonical path, recursive folder flag, read/write/delete allow/deny, to the
  authenticated **running Core worker executable** (not third-party apps).
  Native authenticated loopback read-only PID endpoint lets Tray attest the
  real worker, which can differ from supervisor PID. The executable SHA256
  is independently rechecked by Core during file tool operations.
  Agent ToolExecutor, direct tool call, MCP and nested MCP gateway, and direct
  MCP read/write endpoints enforce policy before file IO, including blocked
  children such as .env. Unmediated shell/search/unknown tools are denied
  when v2 policy is active, rather than claiming they can filter hidden files.
  v2 empty registry defaults to deny access to Core file tools. Missing v2
  preserves legacy behavior only until host initializes v2.
- **Native Tray UI**: Access Manager replaces legacy Trust panel when the new
  native commands are actually installed. Shows active windows, scopes,
  allow/deny, role/label, native file/folder picker, registered rules, revoke,
  and first-run enrollment reminder. Older Tray installations fall back to
  legacy UI, rather than pretending v2 is available.
- **Defensive validation**: reject symlinked/corrupt/oversize policy files,
  ambiguous input, invalid paths, wildcard executable identities, duplicate
  rules, concurrent native enrollment changes and changed executable hashes.

## Important scope boundary

A Core-managed file rule controls file access through SuperAgent tools,
**not** files opened directly by an independently running Antigravity, Chrome,
terminal, editor or other third-party process. True per-app filesystem
sandboxing/ACL needs an OS-owned capability broker, sandbox or native
filesystem policy per supported platform, with independent host permissions
and E2E tests. No claimed OS sandbox or arbitrary-process I/O interception
exists. The Tray UI states this boundary explicitly.

Canonical path validation is done before tool execution and in the verified
native picker, but unrestricted OS-level file writes from arbitrary processes
are not intercepted. Native UAC/permissions never bypassed.

## Verification commands

```sh
bun vitest run tests/desktopAccessManagerTrayUi.test.ts tests/desktopTrustedInputTrayUi.test.ts tests/desktop-ui-integration/permanent-registry-core.test.ts tests/desktop-ui-integration/permanent-registry-store.test.ts tests/desktop-ui-integration/persistent-access-policy.test.ts tests/desktop-ui-integration/registered-file-tool-gate.test.ts tests/desktop-ui-integration/permanent-file-mcp-io.test.ts tests/desktop-ui-integration/trusted-desktop-input.test.ts tests/desktop-ui-discovery/discovery.test.ts
bun run build
cargo check --manifest-path apps/superagent-tray/src-tauri/Cargo.toml
cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml desktop_access_registry
```

Actual Windows installer and real first-run attended native-dialog acceptance,
installed runtime E2E, and macOS/Linux desktop host E2E require platform-specific
verification. A successful source build does not prove those.
