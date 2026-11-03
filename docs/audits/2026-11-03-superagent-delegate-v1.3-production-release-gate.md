# SuperAgent Delegate v1.3.0 — production release-gate audit

Date: 2026-11-03 (Asia/Jakarta)
Workspace: `D:\backup from pc asus\Documents Development\superagent`
Branch: `main`
Scope: isolated `chrome-extension-delegate/`, its bridge/tools integration, release scripts and associated tests.

## Decision

**Controlled local release candidate: PASS. Unrestricted production: NO-GO pending real-browser acceptance.**

This audit distinguishes code validation from a deployed, authenticated browser
configuration. A live `send_message` attempt through the connector was blocked by
OpenAI safety checks, not accepted as a successful ChatGPT send. We did not use
another tool to circumvent the block. `stop_generation` and a real navigated
existing-chat-to-new-chat transition remain unverified in a fully loaded
conversation; the homepage `already_new_chat` path was verified.

## Verified implementation

- Four delegate tools exposed only to eligible single-agent modes:
  `delegate.create_chat`, `delegate.read_chat`, `delegate.send_message`,
  `delegate.stop_generation`; Master remains excluded.
- Fixed loopback listener at `127.0.0.1:17341`, extension-origin verification,
  optional pinned extension ID, and mandatory pairing for `NODE_ENV=production`.
- Pairing supports a 32–512 character secret via
  `SUPERAGENT_DELEGATE_AUTH_TOKEN` or a private file specified by
  `SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE`; token comparison uses SHA-256
  digest and `timingSafeEqual`. Secret is not exposed in status output.
- `chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})`
  occurs before extension storage is read. Popup saves the secret per profile.
- Eight connected profile limit, 32 open-socket limit, 2 MB incoming frame cap;
  duplicate active client IDs rejected, no socket takeover. Requests cannot
  be fulfilled by a different profile's response.
- Explicit `clientId` whenever multiple profiles are connected, explicit
  `tabId` whenever multiple ChatGPT tabs exist in a profile. No ambiguous
  routing or failover. Profile OFF does not disable another profile.
- Manual tab repair injects **only the packaged `content.js`** on an
  origin-verified ChatGPT tab, in the isolated world, without reload or
  chat mutation; duplicate content listeners are guarded.
- New-chat from homepage reports `already_new_chat` instead of inventing a
  navigation; existing chat waits for a composer and draft/busy checks;
  no automatic replay on timeout, abort or reconnect.
- `read_chat` returns a bounded recent window and explicit truncation
  metadata; a loading/unavailable conversation must not be claimed to be
  a clean ready chat.

## Evidence captured

1. Simulated DOM, WebSocket routing, popup state, origin restrictions,
   spoofing rejection, pairing and tool-discovery regression:
   **56/56 passing** on the full `bun run verify:delegate` gate against
   the hardened v1.3.0 source (2026-11-03, after auth/UI/repair changes).
2. `bun --bun x tsc --noEmit`, `bun run verify:extension-js`,
   `bun run build`, `bun scripts/verify-delegate-discovery.ts`: PASS.
3. Production startup without secret: `DELEGATE_AUTH_REQUIRED` and no
   listener — **PASS**. Production startup using a private secret file,
   then clean shutdown — **PASS**.
4. An existing Chrome tab with `Receiving end does not exist` was
   repaired read-only by `attach_content`; subsequent `probe`
   returned `ready:true` — **PASS**.
5. Multiple real Chrome Delegate connections were visible on localhost
   and in the popup — **PASS** at transport level.
6. Earlier live `delegate.create_chat` on a fresh homepage returned
   `{created:false,already_new_chat:true,ready:true,status:'waiting_for_input'}`;
   subsequent `delegate.read_chat` confirmed an empty chat — **PASS**.
7. A requested live `send_message` attempt was blocked by tool safety
   checks; **not executed**. No alternate transmission attempted.
8. Deterministic allowlisted release archive, extracted-file SHA-256
   verification, receipt — **PASS** with the packaging script.
   Final bundle: `build/releases/superagent-delegate-1.3.0.zip`;
   SHA-256 `dd543e80454457c2c40f466df84c3566a0c70d1fc7a00f8b9d83a4d5fdea0f65` (reverify if runtime source changes).
9. The private per-user production pairing file was created exclusively,
   outside the repository. Its full secret was **not printed**.
10. Production mode with no secret refused to start; production mode with
    the private secret file started and shut down cleanly (two direct smoke
    checks, not just source inspections).

## Security/operational boundaries

- The token lives in a private user configuration file on the host and in
  Chrome extension-local storage per profile, **never in Git**. Windows ACL
  review and local-account hardening remain the operator's responsibility.
- Pairing authenticates a client to the local bridge; it does not turn
  Chrome UI heuristics into a stable public API. ChatGPT UI changes require
  DOM compatibility retesting.
- `NODE_ENV=production` without pairing fails closed. Starting the process
  with the default/development environment still supports compatibility,
  **not** an approved secure production configuration.
- Single-process owner of port 17341 only. If SuperAgent is deployed with
  supervisor-managed multiple worker processes, delegate routing/broker
  ownership remains an integration gap; do not claim multi-worker readiness.
- Chrome Web Store publication, remote hosting, external network access,
  browser store approval and hands-off auto-update were **not** performed.

## Required gates before marking deployment GO

1. Restart the intended single-process production host with
   `NODE_ENV=production` and `SUPERAGENT_DELEGATE_AUTH_TOKEN_FILE`.
2. Pair each approved Chrome profile via the popup, verify at least two
   authenticated clients, ON/OFF, restart and reconnect behavior.
3. Run independent real-browser targeted `create_chat`, `read_chat`,
   exactly-once `send_message` and explicit `stop_generation` in a
   dedicated test conversation; do not act on valuable user chats.
4. Confirm a successful existing-chat-to-new-chat URL/DOM transition with
   preserved drafts, recovery after dropped connections, and no replay.
5. Re-run `bun run verify:delegate`, build and `bun run release:delegate`;
   compare receipt SHA-256 and confirm no secrets were packaged.
6. Confirm operator-approved deployment method (local unpacked/enterprise
   policy or external Chrome Web Store submission). No silent publication.

## Rollback

Keep the previous known-good server binary and unpacked extension folder.
If a rollout fails, stop the agent host cleanly, restore the matching prior
server/extension pair, restart under the same account and confirm status
via a read-only probe before allowing new chat operations. Never rotate
the pairing secret silently or resume ambiguous sends.
