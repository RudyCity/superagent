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

## 2026-11-17 follow-up — four-stage implementation and evidence

### Stage 1 — effect certification and usable restricted search

- `superagent_manage_services` read-only actions now reject mutation-only/path
  parameters, even under a valid MCP Connection Controls grant.
- `superagent_media_plan` enforces a read grant against **every** explicit
  input file, the destination existence lookup and optional watermark file.
  Its tool schema includes `watermarkPath`. This still creates no artifacts.
- `superagent_grep_search` has an **explicit `filePaths` mode** that scans
  bounded regular files using a literal query only; recursive grep, regex,
  arbitrary `path`/glob/include/exclude and unapproved inputs remain denied.
  Exact-file mode limits 50 paths, 1 MiB per file, 8 MiB total, 200 returned
  matches, supports offset/limit, rejects traversal, symlinks and unapproved
  native host read paths, and does not launch a shell.
- General CLI/shell, recursive inventory, remote Android shell, browser
  `evaluate`, Desktop Input/screenshots, and PDF/media output-producing
  tools remain fail-closed until their real effects are mediated per action.
  A broad name-based exemption is **not** security approval.

### Stage 2 — independent operator authorization

- MCP `tools/list`, `superagent_tool_search` and `tool_describe` now expose
  **separate** file-policy readiness and MCP authorization requirements.
  Project grant, MCP Connection Controls `execute`, OAuth scope, and
  gateway nested-target requirements are distinguished.
- `tests/mcpApprovalAndFilePolicy.test.ts` proves that a certified Desktop
  metadata action still requires a human-issued MCP Connection Controls grant
  and `mcp:tools:write`; a revoked grant takes effect on the next call.
  Chat-agent YOLO is not used to grant MCP permissions.

### Stage 3 — test evidence and open acceptance

- Focused Linux CI at
  [run 44042532389](https://github.com/RudyCity/superagent/actions/runs/44042532389)
  passed **167/167 tests (19 files)** and TypeScript typecheck.
- The independent host-policy matrix passed **24/24 tests on each** of
  Ubuntu 24.04, Windows-latest and macOS 15 at the same run.
- Exact-file grep has additional tests and an added CI gate; its final result
  must be checked on the latest commit before marking the new search certified.
- GitHub Actions unit/CI success does **not** establish installed desktop,
  Android physical device, authenticated live MCP over tunnel, native input,
  24–72h soak, or a production R0–R7 certificate.

### Stage 4 — activation and release gate: BLOCKED

- Read-only `superagent_core_status`, `superagent_services_status` and
  `superagent_tool_status` calls through the connected fast1 MCP route
  returned an internal connection failure. The agent **did not** restart,
  kill, adopt, rewire, or silently replace an independently owned process.
- The current published prerelease inspected was
  [v1.14.104-rc.3](https://github.com/RudyCity/superagent/releases/tag/v1.14.104-rc.3)
  (15 assets, published 2026-11-17 02:13:20 UTC), **predating these changes**.
- A new release must meet the release-incident playbook's native package,
  checksum, immutable tag/SHA and per-client requirements. Production cutover
  is blocked by the outstanding R0–R7 host/identity/soak/operator evidence.
  Never equate a GitHub commit or CI build with code installed on the live
  Windows Core/MCP/Tray or public tunnel.

### 2026-11-17 08:17 UTC — latest isolated transport and authorization evidence

- [Run 44044400904](https://github.com/RudyCity/superagent/actions/runs/44044400904):
  project-registered direct and nested MCP grep end-to-end acceptance passed,
  with **171/171 focused tests** and TypeScript PASS. Test fixture was fixed
  to grant the authenticated reader the explicit project `read` capability,
  rather than misattributing project-grant denial to file policy.
- [Run 44044533780](https://github.com/RudyCity/superagent/actions/runs/44044533780):
  byte-bounded exact-file reader changes passed the same security matrix on
  Windows, Linux and macOS and the focused MCP suite.
- [Run 44045228520](https://github.com/RudyCity/superagent/actions/runs/44045228520):
  isolated authenticated Streamable HTTP policy smoke passed, with
  **172/172 focused tests** and **29/29 host-policy tests on EACH of Windows,
  Ubuntu and macOS**. Typecheck in that snapshot FAILED in
  `src/core/tools/chromeCdpRecordingLibrary.ts` because the archive status
  lacked typed `source` metadata. A later surgical fix added the same
  managed/delegate source classification already written in recording
  manifests; the fix's separate CI must pass before declaring typecheck green.
- Read-only **operator/owner-verified** runtime acceptance verifier:
  `scripts/mcp-tool-policy-live-verify.ts`. It requires
  `SUPERAGENT_MCP_POLICY_LIVE_ACCEPTANCE=1`, reviewed
  `SUPERAGENT_MCP_POLICY_URL`, a bearer token **from host environment**
  `SUPERAGENT_MCP_POLICY_BEARER_TOKEN`, and
  `SUPERAGENT_MCP_POLICY_PORT`. It checks stable owner/Backend PIDs and
  public URL against the authenticated local service inventory, then makes
  only `tools/list` and `superagent_tool_status` MCP requests. Output contains
  no URL or token, and no process/file/browser/Android mutation is performed.
  This script was **NOT run on the user's host** because the live MCP connector
  still returns an internal connection failure.

**End state:** code implemented, automated security regression evidenced,
runtime and new public release remain blocked by real host owner proof,
external connection recovery and R0–R7 production approval. Do not use
the passing staging tests to justify an unattended release or restart.

### 2026-11-17 08:35 UTC — digest-pinned live acceptance (stage 3 verified; stage 4 unverified)

[GitHub Actions run 44047846830](https://github.com/RudyCity/superagent/actions/runs/44047846830)
at source commit `295adf5acf3a649d52f5b79765ba9ad3aa4feca0`:

- TypeScript check and focused MCP regression: **23 files, 178/178 tests PASS**.
- Native matrix: **35/35 policy tests on each** Windows-latest, Ubuntu 24.04 and macOS 15.
- The read-only MCP owner now reports `backendReleaseDigest` as validated
  SHA-256 metadata from the **authenticated private owner**. This does not
  authorize any restart or publish operation.
- `assessDesktopMcpOwnerEvidence` has a backward-compatible optional
  `expectedReleaseDigest` parameter; when provided, both owner snapshots
  must match that exact 64-character digest. Missing, malformed, stale, or
  mismatched release digests are blocking failures, even with healthy owner
  and backend PIDs.
- `scripts/mcp-tool-policy-live-verify.ts` requires
  `SUPERAGENT_MCP_POLICY_EXPECTED_RELEASE_DIGEST` in addition to the
  attended host opt-in, URL, token, and port. Its PASS receipt includes only
  a digest prefix; never prints credentials or full owner URL.
- **Not installed or executed on the user's laptop:** calls to the connected
  `fast1` read-only Core/MCP/tool-status tools still failed internally.
  There is no attested live owner, no verified installed release digest,
  no new native packaging/asset integrity evidence, and no R0–R7 approval.

To progress stage 4, use the **published, SHA-256-verified tagged backend**
on a separately reviewed release window; obtain its exact activated backend
digest, verify real independent owner PID/birth and same public URL, run the
read-only verifier locally with host-supplied credentials, check historical
sessions and rollback before any activation decision. Do not use a source
commit SHA as the expected backend build digest, or treat successful CI as
authorization for a production reload.

**Four-stage status:** Implemented PASS for these code changes; Tested PASS
at the commit above; Runtime Verified BLOCKED; Released BLOCKED.
