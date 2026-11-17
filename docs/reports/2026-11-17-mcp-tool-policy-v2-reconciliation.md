# MCP tool catalog and host file-policy v2 reconciliation — 2026-11-17

## Scope and evidence

The MCP entrypoint was audited across the complete registered tool definitions and
the gateway, with a focused matrix exercising the v2 default-deny file registry.
This document records **code and CI evidence**, not an installed Windows/Android
runtime acceptance test.

Focused GitHub Actions evidence:
- [MCP Fast Regression: 163 tests, 18 files, typecheck PASS](https://github.com/RudyCity/superagent/actions/runs/44040479511/job/133893782448) — source commit `37f4bfff02f32f1732308ba46356c27fda02455f`.
- Earlier matrix pass: 159 tests before the expanded LAN/Core/Desktop and document readers.

Relevant seams: `src/core/tools/registeredFileToolGate.ts`,
`src/core/mcp/mcpToolGateway.ts`,
`src/core/mcp/superagentMcpServer.ts`.

## File effect classification used for every discovered tool

`tools/list` returns `_meta.filePolicy.active`, `readiness`, and an explicit
note that this is **not authorization**. The same classification is returned by
`superagent_tool_search`, `superagent_tool_describe`, and summarized by
`superagent_tool_status`. Categories are:

| Readiness | Meaning |
|---|---|
| `certified_metadata` | Narrow metadata/control-plane request that does not accept arbitrary file paths |
| `certified_app_storage` | Bounded Delegate history synchronization to its own index, with exact argument allowlist |
| `requires_explicit_files` | Caller must name source/target files; each canonical path is checked by the permanent registry |
| `action_dependent` | Only explicitly certified actions/argument shapes may pass the file-policy gate |
| `uncertified` | Fails closed while a v2 registry is active |

This is **one** layer. MCP OAuth scopes, independent MCP Connection Controls,
per-principal project grants, path/symlink safety, native app/window approval,
hard blocklists, and owner verification remain required.

## Certified operations

- Existing controlled file reads/writes (by canonical file-path permissions) and
  `superagent_read_document`; explicit-source
  `pdf_inspect`, `pdf_extract`, `pdf_ocr`, `pdf_verify`, and `media_inspect`.
- Bounded metadata `superagent_process_pool_status`,
  `superagent_lan_capabilities`, `superagent_media_capabilities`.
- Chrome metadata-only `list_targets` / `transport_status` and restricted
  process inventory via the prior Chrome certification; browser `identity`/`policy`.
- LAN/device inventory, tunnel list and pairing **status**, with no file-path
  arguments, no credentials and request-ID validation.
- Desktop UI `probe`, `list_windows`, `get_active_window`,
  `find_window`, `list_installed_apps`, `live_inventory`,
  `inspect_security_prompts`; these still require MCP write scope/connection
  grant because the enclosing desktop tool is conservatively classified dangerous.
- Supervised Core `restart`, `rollback`, `drain` only for a bounded
  port, explicit `confirm:true`, operation ID and expected SHA-256 build digest.
  The core supervisor must authenticate and attest the operation; this
  classification does not authorize a restart on its own.
- Delegate `sync_history` as an app-owned SQLite index operation, not a
  blanket file access exemption; its argument keys/types are restricted.

The gateway retains seven frequently used Delegate read/inspection tools as
eager entries; all other Delegate operations remain accessible by
`superagent_tool_search`/`superagent_tool_execute` with full checks.

## Intentionally blocked or not yet certifiable

- General CLI/shell execution, recursive grep/discovery, Git diff/log content:
  these can read explicitly denied child files.
- Desktop UI screenshots, window snapshots, UI actions and arbitrary package
  mutation while the file registry is active: native approval alone cannot
  prove arbitrary file-content exclusion.
- Browser evaluate/upload, local `file://` target access, and unverified CDP
  transports.
- LAN/Android remote shell/input/screen and unreviewed device mutations.
- PDF render/split/edit/sign/redact and media transform/convert/batch workflows
  that can produce implicit files or use multiple nested inputs. They require
  an additional output/artifact-effects mediation contract instead of name-based
  blanket certification.
- Any unrecognized tool or malformed gateway wrapper.

## Verification and remaining acceptance

`tests/mcpFilePolicyMatrix.test.ts` asserts complete registered catalog
classification and v2 discovery metadata. The extended
`tests/desktop-ui-integration/registered-file-tool-gate.test.ts` exercises
allowed/denied actions, canonical file permission checks, nested gateway
calls, malformed/unexpected arguments, and cross-domain negative cases.

**Not established:** actual speedup, Windows Tray/runtime/tunnel parity,
installed-desktop/Android E2E, platform soak, or R0–R7 production certification.
GitHub commits are not automatically installed on the active MCP host.
Do not auto-restart or migrate a shared Core/MCP owner based only on CI success.
