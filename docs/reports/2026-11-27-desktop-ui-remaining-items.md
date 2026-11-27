# Desktop UI: remaining items, evidence and plans

**Date:** 2026-11-27
**Status:** items 1-4, 7, 8, 11, 12 implemented; items 5, 6, 9, 10 require native builds,
cross-platform hosts or CI desktop sessions and are tracked here with acceptance criteria.
**Related:** [Desktop UI live-window input](../guides/desktop-ui-live-window-input.md)

## 13. Workspace permission (ACL) escalation — evidence

The one-shot DSH ACL diagnosis/repair was run unconfined (not elevated) against the
workspace root and its ancestors. Verdict: **NOT_THIS_CLASS**, zero changes.

| Object | Owner | Effective rights |
|---|---|---|
| `…\superagent` | signed-in user | FullControl, WRITE_DAC, WRITE_OWNER |
| `…\Documents Development` | signed-in user | WRITE_DAC, no WRITE_OWNER |
| `D:\backup from pc asus` | signed-in user | WRITE_DAC, no WRITE_OWNER |
| `D:\` | Administrators | none for this user |

No AppContainer package SIDs (`S-1-15-2-*`) and no missing workspace right were found;
the folder does carry a **low mandatory label**. Report:
`C:\Users\USER\.superagent-r\acl-recovery\acl-report-233f4960eb7b48b088da87a90b82a083.jsonl`

### Escalation text (send with the report)

> DSH fails to provision its workspace grant with `SetNamedSecurityInfoW` / Win32 5 on
> `D:\backup from pc asus\Documents Development\superagent`. The authorised ACL repair
> reports `NOT_THIS_CLASS`: the workspace root already grants this user FullControl plus
> WRITE_DAC and WRITE_OWNER, no package ACL entries exist, and the only anomaly is a low
> mandatory label on the folder. Please check DSH's own ACL provisioning path (and its
> interaction with the low integrity label) rather than the folder ACL.
> Report: `<path above>`.

Until then, the session can run with **full access** to avoid per-command escalation.

## 5. Single native Desktop UI host (capture + UIA in one binary)

Current state: two carriers per Core — a verified capture worker (WGC or persistent
PowerShell) and a persistent UIAutomation carrier. Cold start is ~1.5 s and two script
surfaces exist.

Plan:

1. Extract the existing C# P/Invoke + UIA logic into one `superagent-desktop-host.exe`
   (WinRT Graphics Capture for frames, UIAutomation for the tree, one JSON-lines protocol).
2. Keep the current process contracts (`ready`, `capture`, `inspect`, `close`) and the
   per-request HWND/PID/title/bounds/cloak/affinity verification verbatim.
3. Ship it as a checksum-pinned build artifact (same verification shape as the existing
   WGC helper); Core only reads the fixed artifact, never a caller-provided path.
4. Acceptance: cold snapshot < 400 ms, warm < 200 ms, identical security tests, no
   PowerShell dependency on the hot path, artifact verified in the release contract.

## 6. Sandboxing the carrier

The carrier is the most privileged helper on the host. Plan:

- Launch inside a Job Object with a restricted token and a low integrity level.
- Bind each request to a per-connection nonce and reject replayed frames.
- Cap stdout framing (already bounded) and add a watchdog that kills the carrier after
  N consecutive protocol violations.
- Acceptance: a carrier that is fed a forged request cannot capture or inspect a window
  it was not started for; kernel-level containment verified with Process Explorer.

## 9. Persistent carriers for macOS and Linux

`macos.ts` and `linux.ts` still spawn a helper per snapshot (~1 s). The Windows carrier
protocol is already platform neutral. Plan:

1. Port the JSON-lines carrier loop to a small Swift (AX) and Python (AT-SPI) helper.
2. Reuse `windowsAccessibilityHost`'s framing, timeouts, idle close and fail-open-to-
   one-shot behaviour as the shared client contract.
3. Acceptance: warm snapshot < 600 ms on macOS and Linux, parity tests in CI where
   runners have a graphical session.

## 10. CI-safe native E2E

`windows-winforms.e2e` requires exclusive desktop focus and fails whenever another window
is foreground. Options, in order of cost:

1. Dedicated window station/desktop for the fixture (`CreateDesktop`) so focus is isolated.
2. Deterministic animated fixture app plus a focus guard that fails with a clear skip
   reason instead of a spurious assertion.
3. Keep adapter-level animation fixtures (already in `tests/desktop-ui/session-live-frames.test.ts`)
   as the CI default and treat native E2E as an attended certification step.

Acceptance: `bun run test:e2e` is green on a clean Windows runner without a human at the
machine, and the attended run is separately labelled as certification.
