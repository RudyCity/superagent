# SuperAgent 1.14.70 — CDP Private Live Preview and Ordered Workflow Replay

Date: 2026-11-11 · Branch: `main` · Release gate: **source and Windows debug binary verified; installed runtime NOT activated**

## Actual code changes

1. **Private, on-demand native Chrome visual preview.** New `src/core/tools/chromeCdpVisualPreview.ts` and exact-tab CDP JPEG helpers in `chromeCdpTools.ts`. The existing authenticated loopback-only Core route now supports `POST /api/desktop/cdp/preview`; Rust native Tray forwards it without exposing the Core bearer to the WebView. The user explicitly chooses **Watch private preview** for a verified registered tab and confirms the sensitive content. It is throttled to one compressed frame per second, 640k-character bounded base64, no disk writes or screenshot cache. The image source is cleared on Stop, lost Core connection or hidden Tray.

2. **Navigation-bound consent.** Every explicit preview begins with a cryptographically random, canonical UUID `previewId`. The Core rejects preview requests without consent, an active exact CDP lease/revision, the current browser fingerprint and the same consent ID bound to the first captured tab URL digest/generation. It checks document URL both before and after capture, so a cross-document navigation cannot silently show a newly loaded private page under old approval. New user consent is required. An invalid JPEG or fingerprint fails closed.

3. **Strict stepwise replay workflow.** New `src/core/tools/chromeCdpWorkflowReplay.ts`, command surface `workflow_start`, `workflow_status`, `workflow_skip`, plus `workflowId` enforcement in the existing `replay_cursor` and one-time operator-authorized `replay_prepare_click`/`replay_execute_click`. The workflow is opt-in, short-lived, actor/target/generation scoped, max 128 monotonic steps, and never runs in the background. Replayed cursor motion and a one-time approved original-selector/original-URL-bound click consume their steps **before** physical side effects. Typed values, navigation, drag and scroll remain manual-only: they cannot safely be auto-replayed because their sensitive payloads were deliberately not retained. Manual skips require explicit caller confirmation.

4. **Tray UI and Rust Tauri.** Added a private screenshot panel with explicit start/stop and fail-closed disconnect state, no public endpoint. Added allowlisted native `cdp-preview` action that validates all fields including the consent UUID. No changes to the existing single-authority managed human-control/noVNC reservations; remote viewer remains disabled without verified operator token, TLS and explicit session handoff.

5. **Version and release docs.** `1.14.69 → 1.14.70` in package.json, Cargo.toml, Cargo.lock (the SuperAgent package), tauri.conf.json, CHANGELOG.md. No package dependency changes or new migrations.

## Verified evidence

- **20 focused test suites, 180/180 PASS** (CDP tool, concurrent/shared target, live feed, manual control, iframe/OOPIF, replay, local operator auth, private preview and workflow).
- **16 Delegate test suites, 154/154 PASS** with `bun run verify:delegate`; 22 Chrome extension JS files syntax checked, Delegate discovery certification PASS. This is source-level, NOT a live GPT-5.6 High Delegate session.
- `bun run build`: PASS for SuperAgent **1.14.70**, TypeScript + MCP schema sync + Core manifest generation.
- Native Tray Rust `cargo check --locked --quiet`: PASS. Native executable `CARGO_NET_OFFLINE=true cargo tauri build --no-bundle --debug --ci`: PASS; debug PE built at `apps/superagent-tray/src-tauri/target/debug/superagent-tray.exe`. This was NOT installed/activated as the running Tray binary.
- **Real headed Chrome managed-CDP private preview**: verified registered browser fingerprint and claimed session, JPEG `ffd8ff` signature, bounded bytes, no disk writes by preview; isolated browser closed and temporary profile/lease directories removed.
- **Real headed Chrome navigation consent test:** initial JPEG valid; navigating to a different document with the same previewId was denied; a fresh previewId after respecting the one-frame/sec throttle succeeded; browser/profile/lease cleaned.
- **Real headed Chrome stepwise workflow:** recorded cursor move + a click; started workflow; cursor replay consumed step 1; exact recorded-selector click required native operator approval and consumed step 2; final click count 2 = original 1 + replay 1; no duplicate or auto-advance, isolated Chrome/profile cleaned.
- **Headed Tray UI fixture smoke** at widths 390,768,1280: live screenshot displayed from mock native Core, then Stop removed the in-memory image and concealed the panel. Fixture-backed UI only, not installed Tray proof.
- Native auth-route tests reject remote/unverified headers, browser Origins, bad bearer, query tokens and non-POST image methods.
- `superagent_desktop_ui list_windows`: real user Tray visible, but read-only accessibility snapshot failed with `Windows accessibility inspection returned invalid JSON`; no attempt to click controls blindly.

## Outstanding authorization and release gates

- Runtime manager says Core :7888 **inactive, no authenticated supervisor**, and explicitly refuses start/restart. This response did **not** spawn an unsupervised Core, kill a live PID or take over the installed Tray.
- The live CDP Delegate forwarding route still returns `DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED`. Cryptographic principal verification cannot be bypassed; test suite passes do not provision the signer or prove real GPT-5.6 High delegation.
- Installed Tray binary upgrade/restart must occur through a verified owner. The produced debug executable is not a signed NSIS production installer or a user-approved installation.
- Native streaming is authenticated **state change long-poll** and explicitly requested local JPEG preview (max 1 fps), not unrestricted remote WebSocket video streaming. This avoids implicit collection/sharing of private browser pages.
- Cross-device interactive noVNC remains constrained to the existing token-authorized virtual-display takeover and secure TLS/OIDC route. No public unauthenticated remote control was added.
- Linux/macOS installed GUI and real Delegate transport acceptance were not available on this Windows host. Full global test suite and long-soak/performance acceptance remain separate release gates.
- Manual-sensitive replay steps do not automatically re-execute type/navigation/drag/payment actions; those operations require explicit action-specific user consent and safe current-target verification, rather than replaying missing plaintext.

## Clean shared checkout boundaries

Only the intended CDP/Tray source, tests, version metadata and this report are eligible for the commit. Pre-existing modified skill guidance, untracked nested Cargo folder and previous Delegate package receipts/ZIPs are not part of this work. No new branch/worktree, no install/restart of primary runtime, no forced lifecycle mutation.
