# MCP Permission & Tool Governance Audit — 2026-11-18

## Executive finding

SuperAgent already checks multiple independent authorization layers, but discovery represented a tool as *catalog-visible* without showing whether a particular command is certifiable or whether the current principal has the required MCP Connection Controls grant. This contributed to repeated attempts against `superagent_desktop_ui` even after an operator approved Execute. The host file-policy denial was **correct**: `inspect_window` opens a session and reads semantic window contents even with `includeScreenshotImage:false`.

**This change does not widen host privileges, automatically approve requests, restart a service, or certify window content/control.** Source-only implementation and targeted regression cases are distinct from installed runtime proof.

## Security layers and ownership

| Layer | Source of authority | Check / findings | State |
| --- | --- | --- | --- |
| OAuth scopes | MCP authenticated principal | Read catalog visibility does not grant write/admin, write tools require `mcp:tools:write`, administrative project tools require admin in addition | Existing enforcement unchanged; admin metadata clarified |
| MCP Connection Controls | Principal-bound `mcp-connection:execute` grant by human in Tray | Dangerous non-project tools use independent human grant, revoked grants must be effective immediately | Existing enforcement unchanged; optional read-only preflight now reports current grant |
| Project RBAC / capability | Registered, enabled project and authenticated identity | Read/write/execute/git/planning capability + exact project scope; no generic YOLO escalation | Existing enforcement unchanged; action-dependent Git metadata corrected |
| Permanent file-policy v2 | Native Tray registry, Core-side gate | Command- and argument-sensitive certification, explicit file paths checked against host executable identity, no blanket bypass | Remains fail-closed, now emits redacted path denial |
| Desktop native authority | Exact PID/HWND, registered desktop view/input rules, per-session human consent, session token/revision | Native input may require approval but does not overrule file-policy v2. `inspect_window` is content-reading | P0: protected content mediation not implemented |
| Gateway / tool catalog | `superagent_tool_search/describe/execute/status` | Search and listing are not grants; execute target is reauthorized with the original handler | Non-executing command preflight added to describe |

## Source fixes

1. **Exact Desktop UI preflight:** `superagent_tool_describe({name:"superagent_desktop_ui",checkArguments:{command:"..."}})` now returns `permissionPreflight`: requested known command, host file-policy `eligible/blocked/inactive`, structured denial reason code, MCP Connection Execute `granted/approval_required`, OAuth catalog visibility, and `nativeHostApproval:not_checked`.
   - Calls the **same existing registered file gate**, with no parallel allowlist that bypasses it.
   - Only available if the principal can already discover the dangerous Desktop UI tool using its existing OAuth scopes. An unrelated tool or invalid `checkArguments` fails closed.
   - Does **not** perform Desktop UI actions, request MCP approval, read a screenshot, open a session, or guarantee a later invocation will work.
   - No arbitrary file-tool preflight because an unrestricted path permission oracle could reveal protected filesystem details.
2. **Log and audit privacy:** Permission-check input fields are replaced by a fixed metadata marker in MCP audit and activity success/failure paths. The preflight result is redacted from the event stream, and the response never echoes caller-supplied window titles, file paths, session tokens or text.
3. **Host path denial privacy:** Permanent file-policy error now says `for the selected target` instead of returning the canonical local absolute path.
4. **Grant metadata fidelity:** `superagent_git_action` reports `capabilityMode:action_dependent` (without injecting a non-enum `capability` value) and `capabilitiesByAction`: read for status/diff/log; git for add/commit/restore/clean. Admin tools advertise that **both** OAuth write and admin scopes are required.
5. **Guardrail preservation:** OAuth checks, project grants, MCP Connection Controls approval, native Desktop UI consent, file-policy decisions, disabled tool restrictions, and original gateway dispatch were not relaxed.

## Example inspection workflow (after the new MCP backend is built and activated)

```json
{"name":"superagent_desktop_ui","checkArguments":{"command":"inspect_window","pid":1234,"nativeId":"5678"}}
```

Call the above through `superagent_tool_describe` on a principal authorized to discover `superagent_desktop_ui`. Expected while permanent file-policy v2 is active: `permissionPreflight.hostFilePolicy.decision="blocked"`, `permissionPreflight.mcpConnectionExecute.decision` reflecting the *current* identity's own grant, `nativeHostApproval.decision="not_checked"`. This is deliberately **not** a tool execution.

For supported metadata-only calls, use `{"command":"probe"}` or `{"command":"inspect_security_prompts"}` without unsupported extra arguments. Do not interpret `eligible` as authorization to read window contents.

## Tests and unverified acceptance

New/updated test coverage in:
- `tests/mcpApprovalAndFilePolicy.test.ts`: no request creation; command-specific file-policy; grant present, revoked, and absent; OAuth read-only cannot inspect dangerous tool grant; audit/activity redaction.
- `tests/desktop-ui-integration/registered-file-tool-gate.test.ts`: malformed metadata shape vs uncertified command, nested gateway denial, no canonical path disclosure.
- `tests/mcpFilePolicyMatrix.test.ts`: action-dependent Git grant metadata and dual-scope administrator metadata.

**Suggested official gates:** `bun --bun x vitest run tests/mcpApprovalAndFilePolicy.test.ts tests/mcpFilePolicyMatrix.test.ts tests/desktop-ui-integration/registered-file-tool-gate.test.ts`, `bun --bun x tsc --noEmit`, full project tests, GitHub CI, then attended Windows Desktop UI acceptance through the installed build.

**Evidence scope:** Source changes and test code are committed to GitHub. Static invariants were inspected through GitHub APIs. No verified local tests, complete CI, restart, active backend deployment, release, or native click-through are claimed. The currently running Core/Tray must not be assumed to have loaded this code.

## Remaining gaps / next implementation stages

- **P0:** Native, host-attested Desktop UI view/input mediator to enforce host file-content policy per exact target; merely allowing a command in `registeredFileToolGate` would break protection. Do not make arbitrary screenshots or UIA text eligible under generic metadata rules.
- **P1:** Self-owned Tray notification navigation receipt test API with allowlisted routes and no arbitrary screenshot/input, to verify click routing independently from general desktop privileges.
- **P1:** Extend command-specific preflight to other actions only after demonstrating a side-effect-free, non-sensitive query model. Generic file path probing without a narrowly authorized scope is prohibited.
- **P2:** Present these distinct permission layers in Tray Access Manager and machine-readable provider diagnostics; do not collapse `tool visible`, `scope granted`, `host certified`, `consented`, `tested` and `released` into a single “available” status.
- **P2:** Reconcile OAuth scheme metadata with legacy accepted read aliases (`mcp:tools:read` / write-compatible reads) in a versioned client compatibility plan, not a silent scope relaxation.
