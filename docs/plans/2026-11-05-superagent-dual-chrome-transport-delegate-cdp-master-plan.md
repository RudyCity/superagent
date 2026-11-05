# SuperAgent Dual Chrome Transport — Managed CDP + Delegate-CDP Master Plan

**Date:** 2026-11-05
**Status:** Design / implementation plan — not yet implemented
**Repository:** `D:\backup from pc asus\Documents Development\superagent`
**Target release:** Delegate `1.8.x` + backward-compatible SuperAgent Chrome transport layer
**Baseline:** Delegate `1.7.0`, commit `7e61f7ae`; existing managed CDP/session gateway remains production baseline
**Hard constraint:** Do not create a new worktree. Preserve unrelated Tray/PDF/Muse/lifecycle work in the current working tree.

---

## 1. Executive summary

SuperAgent currently has two separate browser-control families:

1. **Managed/local CDP**
   - SuperAgent connects to a loopback Chrome DevTools endpoint, normally port `9222`.
   - If needed, SuperAgent can launch an isolated Chrome debug profile.
   - Existing `control_chrome_cdp` provides a large high-level command surface.
   - Existing CDP session manager provides claim/release, capability token, sharing, queueing, revision checks, and audit metadata.

2. **Delegate**
   - A Chrome extension connects to the local Delegate bridge on `ws://127.0.0.1:17341`.
   - It operates on the user's already-open Chrome profile.
   - As of v1.7.0 it provides semantic ChatGPT operations, history indexing, diagnostics, and bounded `run_until_done`.
   - It deliberately does **not** expose arbitrary JavaScript/CDP or non-ChatGPT page control.

The target architecture is to retain both strengths and add a **second CDP transport** backed by the Delegate extension:

```
                        control_chrome_cdp
                               |
                      BrowserTransportRouter
                         /             \
                        /               \
             ManagedCdpTransport   DelegateCdpTransport
             127.0.0.1:9222       Delegate WS 17341
                    |                    |
            DevTools websocket     extension background
                    |                    |
             managed Chrome        chrome.debugger API
                                         |
                                existing user Chrome tab
```

The result is one logical Chrome automation surface with two execution paths:

- `transport: "managed"` — current CDP behavior.
- `transport: "delegate"` — attach to an already-open tab in a connected Delegate Chrome profile.
- `transport: "auto"` — conservative deterministic selection, never silently crossing profiles or choosing among ambiguous tabs.

The existing semantic ChatGPT Delegate tools remain intact. Delegate-CDP is an additional generic transport, not a replacement.

---

## 2. Product goals

### 2.1 Primary goals

1. Allow `control_chrome_cdp` to control either:
   - a SuperAgent-managed CDP browser, or
   - a user's existing Chrome profile connected through Delegate.

2. Reuse the existing high-level CDP command vocabulary wherever technically compatible:
   - target discovery,
   - navigation,
   - evaluation,
   - snapshots/page reads,
   - click/type/wait,
   - screenshots,
   - dialog handling,
   - input events,
   - selected network/console/diagnostic operations,
   - vision integration where possible.

3. Preserve logged-in sessions without requiring a second Chrome profile.

4. Preserve existing managed CDP behavior and existing Delegate semantic ChatGPT behavior with no breaking default migration.

5. Provide explicit ownership/claim semantics for Delegate tabs so multiple agents cannot mutate the same user tab concurrently.

6. Keep credentials, cookies, raw page HTML, screenshots, and user text out of persistent audit journals by default.

### 2.2 Secondary goals

- Make browser routing visible in diagnostics and execution history.
- Permit future use by WordPress, Facebook, Google Drive, Meta Business Suite, and other already-authenticated user sessions.
- Permit future `control_chrome_vision` routing through the same target abstraction.
- Permit future shared-tab orchestration without depending on a remote-debugging port.

### 2.3 Non-goals for v1.8

- Do not remove or deprecate managed CDP.
- Do not bind the Delegate bridge to a public network interface.
- Do not expose unrestricted arbitrary raw CDP to ordinary read-only MCP callers.
- Do not grant browser-wide cookie/database access merely because a tab is attached.
- Do not silently install/reload the Delegate extension.
- Do not use Delegate-CDP to bypass Chrome permission prompts or DevTools conflicts.
- Do not automatically kill Chrome, DevTools, or other debugger owners.
- Do not move the semantic ChatGPT content script to all websites.

---

## 3. Current-state constraints discovered from source

### 3.1 Managed CDP

Current `src/core/tools/chromeCdpTools.ts` is port-centric:

- default loopback host `127.0.0.1`,
- default port `9222`,
- target discovery via `/json/list`,
- WebSocket DevTools connection,
- optional managed browser launch via `ensureCdpRunning()`,
- large command surface already consumed by MCP,
- session keys currently incorporate CDP port + target ID + agent context.

This implementation must remain usable unchanged while the transport abstraction is introduced.

### 3.2 Existing concurrency/security layer

Current managed CDP already supports:

- explicit target selection,
- `claim_target`,
- secret `sessionToken`,
- lease expiry,
- recovery,
- queueing,
- optimistic revision checks,
- metadata-only audit.

Delegate-CDP must not regress these guarantees.

### 3.3 Delegate v1.7

Current extension manifest permissions:

```json
"permissions": [
  "tabs",
  "alarms",
  "storage",
  "scripting"
]
```

It does not yet have `"debugger"`.

Current content script is scoped only to:

```
https://chatgpt.com/*
```

That is desirable and should remain unchanged for semantic ChatGPT features.

Current bridge:

- loopback-only `127.0.0.1:17341`,
- authenticated pairing/token model,
- explicit method allowlist,
- multiple connected Chrome profiles via `clientId`,
- bounded frame size,
- metadata audit.

The new CDP channel should reuse this authenticated bridge rather than create another public listener.

---

## 4. Target architecture

### 4.1 Core abstraction

Introduce a browser transport contract independent of the underlying DevTools connection mechanism.

Suggested files:

```
src/core/browserTransport/types.ts
src/core/browserTransport/router.ts
src/core/browserTransport/managedCdpTransport.ts
src/core/browserTransport/delegateCdpTransport.ts
src/core/browserTransport/targetIdentity.ts
src/core/browserTransport/commandCapabilities.ts
src/core/browserTransport/sessionCoordinator.ts
```

Canonical model:

```ts
type BrowserTransportKind = "managed" | "delegate";

interface BrowserConnectionRef {
  kind: BrowserTransportKind;
  connectionId: string;
}

interface BrowserTargetRef {
  kind: BrowserTransportKind;
  connectionId: string;
  targetId: string;
  tabId?: number;
  title?: string;
  url?: string;
}

interface BrowserTransport {
  listTargets(...): Promise<BrowserTargetRef[]>;
  attach(...): Promise<BrowserAttachment>;
  detach(...): Promise<void>;
  command(...): Promise<unknown>;
  capabilities(...): Promise<BrowserTransportCapabilities>;
  health(...): Promise<BrowserTransportHealth>;
}
```

### 4.2 Canonical opaque target IDs

Do not assume a Chrome `tabId`, raw CDP target ID, and existing managed-CDP target ID are interchangeable.

Use backend-qualified target references.

Recommended external opaque forms:

```
managed:<port>:<cdpTargetId>
delegate:<clientId>:<tabId>
```

Internally preserve fields separately instead of repeatedly parsing strings.

For Delegate targets, `chrome.debugger.getTargets()` can provide target metadata. A raw CDP target identifier may be included as diagnostic metadata if available, but the stable SuperAgent identity remains `clientId + tabId`.

### 4.3 Transport routing

Add transport arguments to `control_chrome_cdp`:

```ts
transport?: "managed" | "delegate" | "auto";
delegateClientId?: string;
delegateTabId?: number;
connectionId?: string;
```

Routing rules:

#### Explicit managed

```
transport=managed
  -> use current port-based CDP only
  -> existing debug_port behavior remains valid
```

#### Explicit Delegate

```
transport=delegate
  -> require a connected Delegate profile
  -> if >1 profiles and no delegateClientId: fail closed
  -> if >1 candidate tabs and no explicit target/tab: fail closed for mutations
```

#### Auto

Conservative selection order:

1. If a qualified target explicitly names a transport, use it.
2. If `delegateClientId` or `delegateTabId` is supplied, use Delegate.
3. If an active managed claim/session exists for the caller, use managed.
4. If a Delegate claim/session exists for the caller, use Delegate.
5. For discovery-only commands, return targets from both backends.
6. For mutations with ambiguous backends/targets, return a structured selection error.
7. Never silently launch a managed Chrome merely because a connected Delegate tab was ambiguous.
8. Never silently choose one of several Delegate profiles.

Default compatibility policy for v1.8:

```
transport omitted -> managed
```

Only change the default to `auto` after a later compatibility release and telemetry/test evidence.

---

## 5. Delegate extension CDP bridge

### 5.1 Manifest permission

Add:

```json
"debugger"
```

to `chrome-extension-delegate/manifest.json`.

Do not broaden content-script matches.

The extension service worker, not a page content script, owns generic CDP dispatch.

### 5.2 New internal Delegate methods

Recommended bridge RPC methods:

```
delegate.cdp.list_targets
delegate.cdp.attach
delegate.cdp.detach
delegate.cdp.command
delegate.cdp.health
delegate.cdp.attachments
```

These are transport-internal methods. They do not need to become general agent-facing tools.

The high-level user-facing API should remain `control_chrome_cdp` / MCP Chrome tools.

### 5.3 Service-worker implementation

Suggested new extension file:

```
chrome-extension-delegate/cdpBridge.js
```

Responsibilities:

- enumerate targets through `chrome.debugger.getTargets()` and `chrome.tabs`,
- map tab IDs to target metadata,
- attach with `chrome.debugger.attach(debuggee, protocolVersion)`,
- dispatch with `chrome.debugger.sendCommand(debuggee, method, params)`,
- receive `chrome.debugger.onEvent`,
- receive `chrome.debugger.onDetach`,
- release attachments in `finally`/lease cleanup,
- expose only allowlisted CDP methods,
- never retry a mutating command after an unknown transport outcome.

### 5.4 Attach lifecycle

State per Delegate client:

```
DETACHED
  |
  | explicit attach / command lease
  v
ATTACHING
  |
  v
ATTACHED
  |
  +--> command(s)
  |
  +--> heartbeat / lease renewal
  |
  v
DETACHING
  |
  v
DETACHED
```

Detach conditions:

- explicit release,
- session lease expiry,
- agent cancellation where safe,
- browser tab closed,
- `chrome.debugger.onDetach`,
- extension disabled,
- Delegate socket disconnect after bounded grace period,
- service-worker recovery reconciliation.

Do not detach another DevTools/debugger owner.

If attach returns an error equivalent to "another debugger is already attached", return a typed conflict:

```
DELEGATE_CDP_DEBUGGER_CONFLICT
```

with no kill/retry workaround.

### 5.5 Protocol version

Start with a supported stable version accepted by `chrome.debugger.attach`; isolate it in one constant and test fallback behavior.

Do not hardcode protocol-domain assumptions into the generic bridge.

---

## 6. CDP method policy

### 6.1 Why an allowlist is required

A raw unrestricted `chrome.debugger.sendCommand` would create a much larger security surface than current Delegate.

Define policy by CDP method, not merely by high-level tool name.

Suggested file:

```
src/core/browserTransport/delegateCdpPolicy.ts
```

### 6.2 Initial classes

#### Read-safe at transport level

Examples:

```
Runtime.evaluate              only when expression is generated by trusted high-level readers
DOM.getDocument
DOM.querySelector
DOM.querySelectorAll
DOM.getBoxModel
Page.getFrameTree
Page.getLayoutMetrics
Accessibility.getFullAXTree
Network.getResponseBody       only for observed request IDs in the same attachment
Log.enable
Runtime.enable
Page.enable
Network.enable
```

Note: `Runtime.evaluate` is not intrinsically read-only. Arbitrary caller expressions remain dangerous. Only framework-generated read expressions may qualify as read-safe.

#### Write / page mutation

```
Page.navigate
Runtime.evaluate              arbitrary/mutating expression
Input.dispatchMouseEvent
Input.dispatchKeyEvent
Input.insertText
DOM.focus
Emulation.*
Page.handleJavaScriptDialog
```

#### Restricted/high-risk

Default deny for v1.8 unless a high-level audited operation explicitly requires it:

```
Browser.*
Target.closeTarget            use chrome.tabs.remove via dedicated command instead
Storage.clearDataForOrigin
Storage.setCookies
Network.setCookie
Network.deleteCookies
Security.*
SystemInfo.*
Target.setAutoAttach
Browser.setDownloadBehavior
```

### 6.3 Cookie policy

Existing managed CDP has special cookie restrictions because browser-wide cookies can escape a tab boundary.

For Delegate-CDP v1.8:

- do not support `get_cookies` initially,
- return `DELEGATE_CDP_CAPABILITY_UNSUPPORTED`,
- later add origin-scoped cookie handling only after a dedicated privacy review.

---

## 7. High-level command compatibility matrix

Create a machine-readable capability table so routing does not depend on scattered conditionals.

Suggested file:

```
src/core/browserTransport/commandCapabilities.ts
```

Initial matrix:

| High-level command | Managed CDP | Delegate-CDP v1.8 | Notes |
|---|---:|---:|---|
| list_targets | Yes | Yes | Combined in auto discovery |
| claim_target | Yes | Yes | Unified target lease |
| release_target | Yes | Yes | Must detach Delegate debugger if last lease |
| recover_session | Yes | Yes | Backend-aware |
| list_sessions | Yes | Yes | Qualified target IDs |
| activate | Yes | Yes | Delegate uses `chrome.tabs.update({active:true})` |
| new_tab | Yes | Yes | Delegate uses `chrome.tabs.create` |
| close_tab | Yes | Yes | Dangerous, explicit |
| navigate | Yes | Yes | Prefer `Page.navigate`; tabs.update fallback only by policy |
| evaluate | Yes | Yes | Dangerous for arbitrary expression |
| snapshot | Yes | Yes | Reuse high-level scripts over `Runtime.evaluate` |
| read_page | Yes | Yes | Generated read expression |
| extract_links | Yes | Yes | Generated read expression |
| click | Yes | Yes | Input/DOM path |
| type | Yes | Yes | Input/DOM path |
| wait_for | Yes | Yes | Poll generated expression |
| verify_action | Yes | Yes | Reuse transition snapshots |
| screenshot | Yes | Yes | `Page.captureScreenshot` |
| pdf | Yes | Later/conditional | `Page.printToPDF` support must be verified per Chrome/debugger API |
| dialogs | Yes | Yes | Page domain |
| emulate_device | Yes | Yes/verify | Capability probe |
| get_cookies | Yes/restricted | No initially | Privacy boundary |
| terminal commands | Yes | Phase 2 | Requires parity testing on Delegate debugger |
| desktop target discovery | Yes | No | Port/Electron-specific |
| media-device special flows | Yes | Phase 2 | Browser/profile behavior differs |

Every unsupported command must fail with a structured capability response, not silently fall back to another transport.

---

## 8. Session ownership and concurrency

### 8.1 Generalize the target key

Current coordination is port-centric. Introduce a transport-neutral key:

```ts
interface BrowserTargetKey {
  transport: "managed" | "delegate";
  connectionId: string; // managed port identity or Delegate clientId
  targetId: string;     // managed CDP targetId or Delegate tab identity
}
```

Canonical serialized key examples:

```
managed|9222|ABC123
delegate|9a700a1a-c9b1-421d-a321-997c929ac80c|tab:481
```

### 8.2 Migration strategy

Do not rewrite all session semantics in one step.

#### Stage A

- preserve existing `chromeCdpSessionManager.ts` for managed backend,
- introduce `delegateCdpSessionManager.ts` with equivalent token/lease semantics,
- expose a common coordinator facade.

#### Stage B

After parity tests:

- migrate shared coordination primitives into a transport-neutral browser target session coordinator,
- keep compatibility adapters for existing managed APIs.

This reduces regression risk to mature managed CDP.

### 8.3 Claims

For mutations on Delegate tabs:

- require explicit claim for multi-agent mode,
- issue secret capability token,
- hash tokens at rest,
- enforce TTL,
- queue conflicting mutations,
- allow read observer semantics according to policy,
- fail closed if the target identity changes.

### 8.4 Revision

Track per-target revision from:

- top-level navigation,
- tab replacement,
- debugger detach/re-attach,
- page lifecycle changes,
- explicit mutation completion.

Vision/snapshot actions must reject stale revision IDs.

---

## 9. Delegate profile and tab discovery

### 9.1 Connection discovery

Reuse `delegateBridge.listConnections()`.

Return:

```json
{
  "transport": "delegate",
  "clientId": "...",
  "profileLabel": "Chrome Delegate 1",
  "connectedAt": 0,
  "capabilities": {
    "semanticChatGPT": true,
    "cdp": true
  }
}
```

The extension hello message should advertise feature capabilities/version so an old v1.7 extension is distinguishable from v1.8.

Example:

```json
{
  "extensionVersion": "1.8.0",
  "capabilities": [
    "chatgpt-semantic-v1",
    "delegate-cdp-v1"
  ]
}
```

### 9.2 Target discovery

`delegate.cdp.list_targets` must return bounded metadata only:

- opaque target ref,
- tabId,
- title truncated,
- URL truncated,
- active/window metadata,
- attachable boolean,
- debugger attachment state if available,
- incognito indicator only if extension has access and policy permits.

Never return cookies, page text, storage, or auth tokens in discovery.

### 9.3 Special URLs

Default deny attachment/control for:

- `chrome://*`,
- `chrome-extension://*`,
- Chrome Web Store,
- DevTools pages,
- browser settings,
- extension manager,
- other privileged schemes.

Allow:

- `http://*`,
- `https://*`,
- explicitly reviewed local app schemes if supported.

---

## 10. BrowserTransportRouter implementation

### 10.1 New router

Suggested API:

```ts
resolveBrowserTransport(args, context): Promise<ResolvedBrowserTransport>
```

Output:

```ts
{
  kind: "managed" | "delegate",
  connectionId: string,
  target?: BrowserTargetRef,
  capabilities: ...
}
```

### 10.2 Integration with `control_chrome_cdp`

Refactor command execution into transport-independent high-level operations where possible.

Do not rewrite all 1,600+ lines immediately.

Recommended incremental extraction:

1. discovery,
2. connection/attach,
3. raw high-level CDP command sender,
4. common evaluate/screenshot/input helpers,
5. command-specific special cases.

Managed implementation continues to use its current HTTP/WebSocket functions behind an adapter.

Delegate implementation uses bridge RPC.

### 10.3 No cross-transport silent fallback

If an operation begins on Delegate and returns an unknown outcome, do not retry it on managed CDP.

Likewise never migrate a target from managed to Delegate during the same mutation.

Transport choice is immutable for a command execution.

---

## 11. MCP/API schema

### 11.1 Existing tool extension

Extend `superagent_chrome_cdp` / `control_chrome_cdp` schema with:

```
transport: managed | delegate | auto
connection_id
delegate_client_id
delegate_tab_id
```

Prefer snake/camel naming consistent with the existing tool layer; normalize once internally.

### 11.2 Discovery response

For `list_targets` with `transport:auto`:

```json
{
  "targets": [
    {
      "transport": "managed",
      "connectionId": "9222",
      "targetId": "managed:9222:..."
    },
    {
      "transport": "delegate",
      "connectionId": "<clientId>",
      "targetId": "delegate:<clientId>:<tabId>"
    }
  ]
}
```

### 11.3 New optional diagnostic tool

Prefer extending existing diagnostics rather than exposing raw Delegate-CDP controls.

Possible user-facing read-only command:

```
control_chrome_cdp({command:"transport_status"})
```

Response:

- managed endpoint reachable,
- Delegate profiles connected,
- Delegate-CDP capability advertised,
- active attachments,
- conflicts,
- supported command sets.

---

## 12. Permission model

### 12.1 MCP classification

Keep `superagent_chrome_cdp` dangerous as it is today because the surface includes mutations.

For finer future policy, classify subcommands internally.

### 12.2 Delegate bridge authorization

Only paired/authenticated Delegate clients may receive CDP RPC.

Add method-level policy to the host:

- discovery/health,
- attach/detach,
- command.

Do not accept caller-supplied arbitrary extension IDs or socket endpoints.

### 12.3 Extension permission UX

Adding Chrome's `debugger` permission is security-sensitive and may show stronger browser warnings.

Update README/popup with a precise explanation:

- used only when SuperAgent explicitly selects Delegate-CDP,
- attaches only to selected normal web tabs,
- visible DevTools/debugging warning behavior may occur,
- semantic ChatGPT Delegate can remain enabled independently if CDP feature is disabled.

Add extension setting:

```
Enable Delegate-CDP: OFF by default for first upgrade
```

Recommended first-run behavior:

- existing v1.7 users upgrade,
- semantic Delegate remains enabled,
- Delegate-CDP requires explicit toggle,
- popup explains debugger permission/state.

Once proven stable, default may be reconsidered.

### 12.4 Local policy switch

Add:

```
SUPERAGENT_DELEGATE_CDP=0|1
```

Default during development: `1` when extension explicitly enables it.
Production release may require both host and extension enablement.

---

## 13. Attachment registry and recovery

### 13.1 Host registry

Suggested file:

```
src/core/delegate/cdpAttachmentRegistry.ts
```

Track:

- clientId,
- tabId,
- qualified target ID,
- owner/session,
- attachedAt,
- lastCommandAt,
- leaseExpiresAt,
- lastDetachReason,
- capability set.

No page contents.

### 13.2 Extension registry

Service worker keeps in-memory attachment state and reconciles after wake:

- call `chrome.debugger.getTargets()`,
- discover whether SuperAgent-owned target still has debugger attached when possible,
- mark unknown state conservatively,
- require re-claim/re-attach if ownership cannot be proven.

### 13.3 Bridge disconnect

On Delegate WebSocket loss:

- do not instantly detach if service worker is only reconnecting,
- start a short bounded grace interval,
- if host ownership does not return, detach SuperAgent-owned debugger sessions,
- never detach sessions not proven to be owned by SuperAgent.

---

## 14. Event transport

Some existing CDP behavior depends on events.

Add Delegate event frames:

```json
{
  "type": "delegate_cdp_event",
  "clientId": "...",
  "tabId": 123,
  "method": "Page.lifecycleEvent",
  "params": {}
}
```

Host must:

- validate frame size,
- map to active attachment,
- drop events from unknown/unowned targets,
- bound event queue memory,
- redact sensitive event fields in logs,
- publish only events requested/enabled by the high-level command.

Do not forward all Network events indefinitely by default.

---

## 15. High-level operation migration

### Phase 1 operations

Implement first because they cover most real-world browser control:

- list targets,
- activate,
- navigate,
- evaluate,
- snapshot,
- read page,
- extract links,
- click,
- type,
- wait for,
- screenshot,
- dialog read/handle.

### Phase 2 operations

- terminal helpers,
- transition verification,
- cursor/drag,
- emulation,
- network diagnostics,
- console logs,
- media-device flows,
- vision target routing.

### Deferred/review required

- cookies,
- browser-wide storage,
- downloads,
- PDF if debugger parity is inconsistent,
- privileged Target/Browser domains.

---

## 16. Vision integration

Current `control_chrome_vision` assumes CDP target identity.

Introduce `BrowserTargetRef` into vision state keys.

Vision workflow:

```
perceive_page
  -> route target
  -> capture screenshot via selected transport
  -> store snapshot under qualified target key + revision
  -> click_id/type_id
  -> verify same transport + same revision
```

Never use a managed screenshot followed by a Delegate click against a superficially matching URL.

---

## 17. Audit and observability

### 17.1 Metadata-only audit

Record:

- timestamp,
- transport,
- connection ID hash or bounded opaque ID,
- target ID hash,
- command class,
- read/write,
- duration,
- result code,
- attach/detach reason,
- queue wait,
- revision.

Do not persist:

- cookies,
- auth headers,
- page text,
- arbitrary evaluate expression text,
- screenshots,
- form values,
- user drafts,
- Delegate auth token/session token.

### 17.2 Doctor

Extend `delegate.doctor` or add browser transport diagnostics to show:

- extension version,
- `delegate-cdp-v1` capability,
- debugger permission enabled,
- number of attachable tabs,
- current SuperAgent-owned debugger attachments,
- conflict count,
- host policy switch,
- bridge state.

### 17.3 Tray

Later integrate read-only status into SuperAgent Tray:

```
Chrome
  Managed CDP: healthy / port
  Delegate profiles: N
  Delegate-CDP: enabled / disabled
  Active Delegate attachments: N
```

Do not make Tray implementation a release blocker for core v1.8.

---

## 18. Failure model

Define typed errors:

```
DELEGATE_CDP_DISABLED
DELEGATE_CDP_EXTENSION_TOO_OLD
DELEGATE_CDP_PERMISSION_MISSING
DELEGATE_CDP_CLIENT_NOT_FOUND
DELEGATE_CDP_CLIENT_SELECTION_REQUIRED
DELEGATE_CDP_TAB_NOT_FOUND
DELEGATE_CDP_TARGET_AMBIGUOUS
DELEGATE_CDP_TARGET_FORBIDDEN
DELEGATE_CDP_ATTACH_FAILED
DELEGATE_CDP_DEBUGGER_CONFLICT
DELEGATE_CDP_NOT_ATTACHED
DELEGATE_CDP_METHOD_DENIED
DELEGATE_CDP_CAPABILITY_UNSUPPORTED
DELEGATE_CDP_COMMAND_TIMEOUT
DELEGATE_CDP_UNKNOWN_MUTATION_OUTCOME
DELEGATE_CDP_DETACHED
DELEGATE_CDP_SESSION_REQUIRED
DELEGATE_CDP_SESSION_EXPIRED
DELEGATE_CDP_REVISION_CONFLICT
```

Rules:

- Unknown mutation outcome: inspect state before retry.
- Transport timeout never proves command was not executed.
- Debugger conflict never triggers forced detach of another owner.
- Tab close/navigation race returns target/revision error.
- Old extension falls back only if caller selected `transport:auto` for a read/discovery command; never silently reroute a mutation.

---

## 19. Implementation phases

## Phase 0 — Freeze contracts and add tests first

**Objective:** establish compatibility and security expectations.

Tasks:

- Add transport/target types.
- Add capability matrix.
- Add routing unit tests.
- Add tests that current managed behavior remains default when `transport` omitted.
- Add tests that ambiguity fails closed.
- Add tests that semantic Delegate tools remain unchanged.

Gate:

- existing managed CDP targeted suites remain green,
- existing Delegate 107-test suite remains green.

---

## Phase 1 — Extension debugger bridge

**Files:**

```
chrome-extension-delegate/manifest.json
chrome-extension-delegate/background.js
chrome-extension-delegate/cdpBridge.js
chrome-extension-delegate/popup.*
tests/delegateCdpExtension.test.ts
```

Tasks:

- bump Delegate to `1.8.0`,
- add `debugger` permission,
- add explicit Delegate-CDP enable toggle,
- advertise `delegate-cdp-v1`,
- implement list/attach/detach/command/health,
- privileged URL denylist,
- command allowlist,
- event forwarding,
- attach registry,
- conflict handling.

Gate:

- no non-ChatGPT content-script expansion,
- semantic Delegate remains functional with Delegate-CDP toggle OFF.

---

## Phase 2 — Host Delegate-CDP transport

**Files:**

```
src/core/delegate/bridge.ts
src/core/delegate/cdpTransport.ts
src/core/delegate/cdpAttachmentRegistry.ts
src/core/browserTransport/*
tests/delegateCdpTransport.test.ts
```

Tasks:

- extend bridge method allowlist/capability handshake,
- implement typed request wrappers,
- implement target mapping,
- implement health/capability probe,
- implement host attach lease cleanup,
- implement event routing.

Gate:

- reconnect does not replay mutations,
- host never sends unsupported raw methods,
- no audit-content leakage.

---

## Phase 3 — BrowserTransportRouter

**Files:**

```
src/core/browserTransport/router.ts
src/core/browserTransport/managedCdpTransport.ts
src/core/browserTransport/delegateCdpTransport.ts
src/core/tools/chromeCdpTools.ts
```

Tasks:

- wrap existing managed CDP functions,
- add Delegate adapter,
- add explicit `transport`,
- preserve omitted-transport managed default,
- combined discovery in `auto`,
- structured capability errors.

Gate:

- managed regression parity,
- no automatic Chrome launch when caller explicitly selects Delegate.

---

## Phase 4 — Session/claim parity

Tasks:

- introduce Delegate target leases,
- secret capability token,
- queue,
- TTL,
- revision,
- attach/detach ownership,
- coordinator facade,
- list sessions across both transports.

Gate:

- two agents cannot mutate the same Delegate tab without sharing/ownership rules,
- dead lease can recover without stealing a live debugger owner.

---

## Phase 5 — High-level command parity

Implement Phase 1 command set:

- navigate,
- evaluate,
- snapshot/read,
- click/type/wait,
- screenshot,
- dialog,
- links.

Re-use the same action-validation and result formatting code as managed CDP where possible.

Gate:

- same logical command produces equivalent structured result on both backends,
- unsupported operations fail explicitly.

---

## Phase 6 — MCP/schema/discovery integration

**Files:**

```
src/core/mcp/tools/chromeMcpTools.ts
scripts/syncMcpSchemas.ts
tests/chromeMcpTools*.test.ts
```

Tasks:

- extend schemas with transport selector,
- update descriptions,
- sync generated MCP schemas,
- ensure tool discovery mentions both transport modes,
- preserve existing clients that omit new fields.

Gate:

- old MCP calls still validate,
- new Delegate-target arguments are bounded and validated.

---

## Phase 7 — Vision and advanced commands

Tasks:

- qualified target key in vision storage,
- screenshots via transport,
- cursor/drag/emulation parity,
- terminal compatibility assessment,
- network/console diagnostics,
- selected media APIs.

Gate:

- stale snapshot protection works across Delegate tabs,
- no cross-transport target confusion.

---

## Phase 8 — Live E2E and release

Required live scenarios:

1. **Managed baseline**
   - launch isolated managed Chrome,
   - list/navigate/read/click/screenshot,
   - claim/release.

2. **Delegate existing Chrome**
   - connect existing user Chrome,
   - list normal web tabs,
   - select a logged-in harmless test site,
   - attach,
   - read,
   - click/type harmless field,
   - screenshot,
   - release/detach.

3. **Two Delegate profiles**
   - confirm client selection is mandatory.

4. **Two tabs**
   - confirm mutation ambiguity fails closed.

5. **DevTools conflict**
   - manually attach DevTools/debugger,
   - confirm typed conflict and no forced takeover.

6. **Disconnect/reconnect**
   - bridge disconnect while attached,
   - recover or cleanly detach after grace interval,
   - no mutation replay.

7. **Claim contention**
   - two agents request same Delegate tab,
   - verify queue/permission behavior.

8. **Forbidden target**
   - chrome://settings,
   - extension pages,
   - DevTools,
   - confirm denial.

9. **Old Delegate v1.7**
   - semantic tools work,
   - Delegate-CDP reports extension-too-old.

10. **Session privacy**
   - inspect audit files and logs,
   - confirm no cookies/page text/form values/tokens.

---

## 20. Test matrix

### Unit

- target identity parsing/serialization,
- transport routing,
- capability matrix,
- method policy,
- privileged URL filtering,
- MCP schema validation,
- timeout/error translation,
- attach registry,
- lease expiry,
- event queue bounds.

### Extension simulation

Mock:

- `chrome.debugger.getTargets`,
- `attach`,
- `detach`,
- `sendCommand`,
- `onEvent`,
- `onDetach`,
- `chrome.tabs.*`.

Assertions:

- exactly-once mutation dispatch,
- no retry after unknown outcome,
- detach only owned target,
- debugger conflict preserved,
- disabled toggle blocks CDP calls.

### Integration

- fake Delegate WebSocket client with CDP capability,
- fake managed CDP server,
- router against both,
- multi-profile/multi-tab ambiguity,
- claim/session boundaries.

### Regression

At minimum:

```
bun --bun x tsc --noEmit
bun run verify:extension-js
bun --bun x vitest run <delegate suites>
bun --bun x vitest run <chrome CDP suites>
bun --bun x vitest run <MCP suites>
bun scripts/verify-delegate-discovery.ts
bun run build
```

Do not mark release complete from simulated tests alone; live Chrome debugger attach must be demonstrated.

---

## 21. Security review checklist

Before release:

- [ ] Delegate bridge remains bound only to loopback.
- [ ] Pairing/auth remains mandatory in production.
- [ ] `debugger` permission documented and user-controlled.
- [ ] No broad content script matches.
- [ ] Privileged URLs denied.
- [ ] Raw CDP method allowlist enforced in both host and extension.
- [ ] Arbitrary `Runtime.evaluate` classified dangerous.
- [ ] Cookie/storage methods denied initially.
- [ ] Unknown mutation outcome never automatically retried.
- [ ] Another debugger owner is never forcibly detached.
- [ ] Target claims use unlogged secret capabilities.
- [ ] Audit is metadata-only.
- [ ] Multi-profile ambiguity fails closed.
- [ ] Multi-tab mutation ambiguity fails closed.
- [ ] Old Delegate extension cannot accidentally receive CDP commands.
- [ ] Disconnect cleanup does not kill Chrome or close unrelated tabs.

---

## 22. Backward compatibility

### Existing managed callers

No change required:

```json
{"command":"list_targets"}
```

continues to mean managed CDP during v1.8.

Explicit form:

```json
{"command":"list_targets","transport":"managed"}
```

### New Delegate callers

```json
{
  "command":"list_targets",
  "transport":"delegate",
  "delegateClientId":"<clientId>"
}
```

Then:

```json
{
  "command":"navigate",
  "transport":"delegate",
  "targetId":"delegate:<clientId>:<tabId>",
  "url":"https://example.com"
}
```

### Auto discovery

```json
{
  "command":"list_targets",
  "transport":"auto"
}
```

returns both backends with explicit qualified IDs.

---

## 23. User-facing workflow target

### Workflow A — isolated automation

User asks:

> buka browser untuk testing

SuperAgent:

```
managed CDP
 -> launch isolated Chrome if necessary
 -> automate
```

### Workflow B — existing logged-in Chrome

User asks:

> buka Facebook via CDP dari Chrome yang sudah terkoneksi Delegate

SuperAgent:

```
transport=delegate
 -> select connected clientId
 -> list tabs
 -> use existing logged-in tab/session
 -> attach chrome.debugger
 -> automate
 -> detach
```

### Workflow C — unspecified

User asks:

> buka via CDP

For v1.8 compatibility:

```
default -> managed
```

A later preference can support:

```
browser.defaultTransport = auto | managed | delegate
```

but should not be introduced until explicit mode is proven.

---

## 24. Proposed source layout

```
chrome-extension-delegate/
  background.js
  cdpBridge.js                    NEW
  cdpPolicy.js                    NEW or bundled if small
  popup.js
  manifest.json

src/core/browserTransport/
  types.ts                        NEW
  targetIdentity.ts               NEW
  commandCapabilities.ts          NEW
  router.ts                       NEW
  managedCdpTransport.ts          NEW
  delegateCdpTransport.ts         NEW
  sessionCoordinator.ts           NEW / phase 2

src/core/delegate/
  bridge.ts
  cdpTransport.ts                 NEW
  cdpAttachmentRegistry.ts        NEW

src/core/tools/
  chromeCdpTools.ts               REFACTOR incrementally
  chromeCdpCommandPolicy.ts
  chromeCdpSessionManager.ts      KEEP, adapter first

src/core/mcp/tools/
  chromeMcpTools.ts               SCHEMA extension

tests/
  delegateCdpExtension.test.ts    NEW
  delegateCdpTransport.test.ts    NEW
  browserTransportRouter.test.ts  NEW
  browserTransportSession.test.ts NEW
  chromeCdpDualTransport.test.ts  NEW
```

---

## 25. Recommended implementation order

The safest sequence is:

1. Target identity + capability matrix + routing tests.
2. Extension capability handshake and `debugger` toggle.
3. Read-only Delegate target discovery.
4. Attach/detach health path.
5. Read-only CDP commands: page metadata/snapshot/screenshot.
6. Delegate target leases and ownership.
7. Write commands: navigate/click/type.
8. Integrate `control_chrome_cdp`.
9. MCP schema.
10. Vision.
11. Advanced terminal/network/media parity.
12. Live E2E.
13. Release v1.8.

Do not begin with arbitrary `Runtime.evaluate` or cookie APIs.

---

## 26. Acceptance criteria

Delegate-CDP v1.8 is complete only when all of these are true:

1. `control_chrome_cdp` can explicitly select `managed` or `delegate`.
2. Existing calls with no transport field retain current managed behavior.
3. Delegate can enumerate normal user tabs without content-script expansion.
4. Delegate can attach/detach via `chrome.debugger`.
5. At least navigate/read/click/type/screenshot work live through Delegate.
6. Existing logged-in user session is preserved.
7. Multi-profile and multi-tab ambiguity fail closed.
8. Session claim/lease prevents simultaneous uncoordinated mutation.
9. DevTools/debugger conflict is reported without takeover.
10. No unknown mutation is auto-retried.
11. Forbidden browser/extension pages cannot be controlled.
12. Local audit contains metadata only.
13. Existing semantic ChatGPT Delegate tools still pass regression.
14. Existing managed CDP suites still pass regression.
15. Full TypeScript/build passes.
16. Live E2E is demonstrated on both transports.
17. Extension popup clearly indicates Delegate-CDP enabled/attached state.
18. Old Delegate versions fail with a clear upgrade-required error rather than silently degrading.
19. Release documentation describes permission and privacy boundaries.
20. No unrelated Tray/PDF/Muse/lifecycle changes are required to ship the core feature.

---

## 27. Post-v1.8 follow-up

After production evidence:

### v1.9 candidates

- preference `browser.defaultTransport`,
- automatic best-transport selection with explicit policy,
- Delegate-CDP terminal parity,
- Delegate network inspector,
- browser download manager,
- optional origin-scoped cookies after privacy review,
- shared Delegate tab collaboration across agents,
- Tray transport picker/status,
- persistent but non-secret target aliases,
- remote-machine Delegate via an authenticated Muse/tunnel transport only if separately designed; never expose port 17341 directly.

---

## 28. Final architectural decision

The recommended end state is **not** "replace CDP with Delegate".

The end state is:

```
                  SuperAgent Browser API
                          |
                  BrowserTransportRouter
                    /             \
          Managed CDP         Delegate-CDP
             |                    |
       isolated Chrome       user's Chrome
                                  |
                           chrome.debugger
```

and alongside it:

```
Delegate semantic ChatGPT API
  read_chat
  history/index
  send_message
  run_until_done
```

These remain separate capabilities over the same authenticated Delegate connection.

This provides the desired two Chrome paths without sacrificing managed-browser isolation, existing multi-agent CDP safety, or the user's already-authenticated Chrome session.
