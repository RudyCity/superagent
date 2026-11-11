# Delegate-CDP v1.8 — Dual Chrome Transport

## Overview

SuperAgent supports two Chrome automation transports behind the existing `control_chrome_cdp` surface:

- `transport: "managed"` — the existing local/managed Chrome DevTools endpoint. This remains the default when `transport` is omitted.
- `transport: "delegate"` — an already-open user Chrome profile connected through the authenticated Delegate bridge on loopback `127.0.0.1:17341`.
- `transport: "auto"` — discovery/status aggregation only unless the caller supplies a backend-qualified target. Mutating calls never guess between transports.

Qualified targets use:

- `managed:<port>:<cdpTargetId>`
- `delegate:<clientId>:<tabId>`

The semantic ChatGPT Delegate API remains separate and unchanged.

## Chrome permission and opt-in

Delegate 1.8.0 adds the Chrome `debugger` permission. Generic Delegate-CDP runs only in the extension service worker through `chrome.debugger`; the ChatGPT content script remains restricted to `https://chatgpt.com/*`.

Delegate-CDP is OFF by default. Enable it explicitly from the Delegate popup. The popup reports whether CDP is enabled and, while an operation owns `chrome.debugger`, the current attachment count/tab IDs. Turning it off detaches debugger sessions owned by SuperAgent. A bridge disconnect uses a short cleanup grace period and never closes Chrome or unrelated tabs.

After installing/updating from an older Delegate version, Chrome may require the extension to be reloaded and the new `debugger` permission accepted before Delegate-CDP can connect.

## Security boundaries

Delegate-CDP deliberately has a narrower raw-CDP surface than managed CDP.

Both the host and extension enforce an allowlist. Browser-wide cookie/storage APIs, `Browser.*`, `Storage.*`, `Security.*`, `SystemInfo.*`, `Target.setAutoAttach`, and direct `Target.closeTarget` are denied. Privileged browser, extension, DevTools, and file URLs are denied.

Arbitrary `Runtime.evaluate` is treated as a dangerous mutation and is only dispatched through the audited high-level evaluate path. Framework-generated reader expressions are marked as trusted-generated reads.

If Chrome reports that another debugger/DevTools owner is attached, Delegate-CDP returns `DELEGATE_CDP_DEBUGGER_CONFLICT`. It does not kill DevTools, detach another owner, or retry takeover.

Transport/RPC timeouts do not replay commands. A mutation whose outcome is uncertain is not automatically retried.

Audit/connection state stores metadata only. Page text, form values, cookie values, screenshots, and capability tokens are not written to the Delegate connection audit.

## Ownership and ambiguity

Delegate tabs support claim/lease capability tokens. Claimed tabs require matching `agentId` and `sessionToken` for access. Callers may supply `expectedRevision` for optimistic concurrency; stale revisions fail before dispatch, and the revision advances only after a successful write. Claims are logical ownership leases: SuperAgent probes debugger ownership when claiming, then releases the debugger. Normal Delegate-CDP operations attach only for their bounded execution window and detach in `finally`, so an expired logical lease does not leave a stale debugger attachment behind.

Operations targeting the same Delegate tab are serialized by a per-target host lock, including legacy/unclaimed calls. When more than one Delegate profile is online, callers must select `delegateClientId`. When more than one candidate tab exists for a mutation, callers must select `delegateTabId` or a qualified target ID. Ambiguous mutations fail closed.

## Examples

Managed behavior is backward compatible:

```json
{"command":"list_targets"}
```

Explicit Delegate discovery:

```json
{
  "command": "list_targets",
  "transport": "delegate",
  "delegateClientId": "<clientId>"
}
```

Select an existing logged-in tab:

```json
{
  "command": "read_page",
  "transport": "delegate",
  "targetId": "delegate:<clientId>:<tabId>"
}
```

Combined discovery:

```json
{"command":"list_targets","transport":"auto"}
```

This returns one structured `targets` array. Every entry is backend-qualified, for example `managed:9222:<targetId>` or `delegate:<clientId>:<tabId>`. If one backend is unavailable, the available targets are still returned together with a bounded `errors` entry for the unavailable backend.

## Delegate-CDP v1.8 command surface

Implemented for Delegate transport:

- target discovery and transport health
- claim/recover/release and session inspection
- activate/new tab/close tab
- navigate
- read page / snapshot / extract links
- audited evaluate
- click / type / wait
- screenshot
- dialog event inspection and dialog handling
- native cursor movement, `hover_cursor` (trusted browser hover, optional dwell), `click_cursor` (one native press/release), `show_cursor`/`hide_cursor` (non-interactive visual overlay), wheel scroll, coordinate drag-and-drop, and device/viewport emulation. These run only within the authenticated exact-tab Delegate debugger lease; managed CDP still has broader tooling. The Delegate overlay is transient and is not registered across document navigations. **MP4 session recording currently requires managed CDP**, with explicit owner video consent and output in the current project; see [CDP session recording](cdp-session-recording.md).
- Vision/Set-of-Mark routing through the same qualified target identity; Vision caches include the transport identity to prevent cross-backend snapshot reuse

Unsupported commands return an explicit `DELEGATE_CDP_CAPABILITY_UNSUPPORTED` response and never silently fall back to managed Chrome.

Managed-only or later-parity areas include browser-wide cookies, desktop/Electron discovery, terminal automation, specialized media flows, and other advanced CDP domains.
