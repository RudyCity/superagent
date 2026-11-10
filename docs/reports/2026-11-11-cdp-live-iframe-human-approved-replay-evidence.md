# SuperAgent 1.14.69 — Native CDP Live, Local Human Control, Qualified Frames & Approved Replay

Date: 2026-11-11 · Branch: main · Status: **source implemented and tested; production cutover pending**

## Scope implemented

**1. Live updates.** `src/core/tools/chromeCdpLiveFeed.ts` projects the existing multi-process CDP session coordinator, latest per-actor cursor positions and allowlisted action audit into a digest-based authenticated long-poll feed, max six subscribers, 250ms change checks, 8.5s default heartbeat. `GET /api/desktop/cdp/live` is bearer-authenticated, host/loopback-validated, rejects browser Origins and forwarded headers; cursor is a SHA-256 digest, never a secret or browser URL. The native Rust bridge forwards credentials; Tray JavaScript never receives the Core token. Any disconnect becomes **unknown** rather than success/empty. This is near-real-time *state streaming by long poll*, not video/screen streaming or a WebSocket feed.

**2. Local human takeover.** The read-only Tray managed CDP panel now offers explicitly confirmed **Take over locally / Return control to agent** for a registered target. The native bridge validates only `port`, `targetId`, `mode`, and `expectedRevision`; Core rereads registration (profile, browser fingerprint and generation), revalidates the revision under the existing cross-process per-tab lock, and uses the original durable `managedBrowserControl.ts` human hold. Human hold prevents agent writes while allowing normal observation. Return to agent does not automatically resume owner-paused agents. Existing browserTakeover operator reservations remain authoritative. This feature is local desktop control, **not remote noVNC takeover**.

**3. Qualified iframe support.** `chromeCdpFrames.ts` / `chromeCdpFrameExtras.ts` add explicit `frameId` commands: `inspect_qualified_frames`, `frame_read`, `frame_highlight`, `frame_click`, `frame_snapshot`, `frame_type`, and `frame_scroll`. Same-process frames use isolated execution context, and OOPIF descendants omitted from `Page.getFrameTree` are discovered using browser `Target.getTargets` with `parentId/parentFrameId` relationships. OOPIF actions attach only to the exact child target, confirm its frame identity, use flattened sessionId and detach on completion. No parent-page fallback when a frame is missing or changed. Frame typing returns only length/status, not text. Scroll is frame-local DOM scroll, not CDP wheel input. Open Shadow DOM click/highlighting and explicit frame targets are supported; inaccessible closed Shadow DOM and unsupported browser target structures fail closed.

**4. Two-party approved replay.** The existing in-memory opt-in recorder now retains SHA-256-only `locatorDigest` and `pageDigest` of an original click with an explicit CSS selector. The request `replay_prepare_click` accepts only a stopped recorded click, same actor/generation/revision, and matching original selector and page URL digests. Operator review is via local native Tray `/api/desktop/cdp/approval` after a visible confirmation; consent is bound to the target and expires after 120 seconds. `replay_execute_click` requires both operator approval and explicit caller confirmation, rechecks target geometry, **consumes approval before real CDP input**, and dispatches exactly one native click; ambiguous effects are not retried. Native human-control transitions revoke any pending/approved requests. No automatic replay of typing, navigation, drag, checkout or unapproved side effects.

## Verification evidence

- `bun run build` for **SuperAgent 1.14.69**: PASS; TypeScript compilation, MCP schema sync and Core manifest generation; manifest SHA-256 `0d670e7ceda876782b0c9d676d0b18da05957fe44e26b10a6179e91a921776fe`.
- `cargo check --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --locked --quiet`: PASS.
- **18 focused Vitest suites, 172/172 PASS** across CDP tools, CDP shares, target highlights, live feed, approval, authenticated Core endpoints, original-selector/page digest binding, frame contexts, Delegate routing, and handoff (final run 2026-11-11 local).
- Actual headed Windows Chrome **cross-origin/OOPIF** (top at 127.0.0.1, child at localhost, `--site-per-process`): explicit frame discovery, read, visual highlight, one DOM click to correct iframe, typed input, redacted typing result, snapshot labels, and frame-local scroll: PASS. Temporary Chrome/profile closed and deleted.
- Actual headed Chrome **approved replay**: record original click; prepare/approve; exact one additional click; repeat denied; substituting another selector rejected after original-selector/page digests were added; other button never fired. Isolated CDP lease and Chrome profile cleaned.
- Actual headed Chrome **Tray UI with mock native Core** at 320, 390, 768, 1280: live state, manual takeover, operator approval, local Tauri payloads: PASS. *Fixture test, not installed-runtime proof.*
- Auth-boundary tests: local bearer permitted; browser Origin, invalid bearer, spoofed host, remote IP, forwarded header, query token, unrecognized fields and stale/missing IDs denied.
- Shared dirty tree preserved; unrelated Android/Rust/LAN/skill/archives deliberately excluded from the CDP commit.

## Pending operational gates / limits

- Do not restart or recycle primary Core :7888 until supervisor/process ownership attestation is independently verified. Existing Core was responding but owner verification failed, and a forced restart risks other live users/sessions.
- GPT-5.6 High CDP Delegate forwarding bridge remains `DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED`; Delegate Chrome debugger parity must be validated after it is provisioned.
- Native installed Tray binary activation, cross-platform Chrome and long soak/load tests are separate gates. `cargo check` is not a distributable package build.
- The live feed is change-driven authenticated long-poll; a full video/screenshot stream is deliberately not implemented. Likewise local hold does not automatically open an interactive remote-control viewer.
- Approval UI requires an operator to inspect the matching real browser tab. No one-click auto-approval, secret persistence, or retries after uncertain actions.
