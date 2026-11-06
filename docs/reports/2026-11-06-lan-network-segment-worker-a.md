# Worker A — LAN network segment discovery v2

Date: 2026-11-06. Repository: registered `superagent` on existing `main` checkout. No branch/worktree, commits, restarts, process kills, or browser lifecycle changes.

## Implemented

- `src/core/lanRemote/networkSegment.ts`: trims and lowercases a mandatory 3–32 character ASCII segment; derives lowercase SHA-256 of `superagent-lan-segment-v1:` + normalized name; builds `SUPERAGENT_LAN_DISCOVER_2:<hex>`; validates discovery request and reply.
- `src/core/lanRemote/transport.ts`: validates `segmentName` before opening listeners, replies only to matching v2 query and includes `segmentTag`; optional segment-tag verification on pairing, while preserving one-time code, TLS 1.3 and owner approval.
- `src/core/lanRemote/controller.ts`: `discoverLanDevices(segmentName, waitMs?)` rejects invalid segment before UDP, emits only v2 queries, verifies version 2, exact reply tag and responding IP. `pairLanDevice({segmentName?})` can verify pairing segment if caller supplies it; manual IP pairing remains possible with pinned certificate, code and physical approval.
- `src/lanClient.ts`: Windows LAN Client prompts for segment or accepts `--segment=NAME`; non-interactive missing segment fails closed.
- Android `LanClientServer.java` and `MainActivity.java`: EditText input required before Start; Java SHA-256 same prefix as TS, v2-only discovery, optional pairing tag check. Existing Android screen actions and file APIs untouched.
- `tests/lanNetworkSegment.test.ts`: normalization, rejection, tagged queries, v1 refusal, spoof/reply validation, client-entrypoint contract and on-link TLS pairing test.

## Verified

- `bunx vitest run tests/lanNetworkSegment.test.ts tests/trayLanBridge.test.ts`: **PASS 11/11 tests** (6 segment, 5 Tray bridge).
- `bun --bun x tsc --noEmit`: **PASS**.
- `cd apps/superagent-lan-android && ./gradlew :app:compileDebugJavaWithJavac --offline --no-daemon`: **BUILD SUCCESSFUL**.
- `git diff --check` for listed existing paths: **PASS** (some target files are currently untracked in the shared checkout).
- No actual Android hardware discovery exercised; Android validation is Java compilation plus contract tests.

## Handover / integration notes

1. **Three stale E2E fixtures fail by design**: `tests/lanRemote.test.ts` line 45 and `tests/lanFileTransferE2E.test.ts` lines 30 and 86 call `startLanServer` without the now-required `segmentName`. Orchestrator/test owner should pass a test-only name (e.g. `segmentName: "test-lan"`) into those fixtures; never add a runtime default or bypass mandatory segment verification. The attempted regression run had 8 pass / 3 fail, and failures were exactly missing segment errors.
2. Existing Tray bridge already sends `discoverLanDevices(args.segment as string)`. Its separate `parseTrayLanAction` validation currently requires segment to be already trimmed and start with alphanumeric; the shared normalizer accepts any 3–32 allowed characters after trimming. Bridge/Tray owner should make its validation consistent with the shared normalizer and allow UI entry to normalize before submitting.
3. The bridge currently pairs by host/code/fingerprint without a segment name; the controller permits this intentionally for manual pairing because segment is a discovery filter, **not authentication**. If pairing originates from a discovered row, bridge owner can optionally send the normalized segment as `segmentName` to enforce extra consistency; do not weaken TLS pin or on-device approval.
4. The segment hash is guessable from a human-chosen name and must never be presented as an access-control credential. Discovery replies are unauthenticated hints; pairing must pin the full device-displayed TLS fingerprint.
5. Folder-transfer modules, Tray UI, bridge code, source control history, runtime processes and running listeners were not modified by this worker.
