# Senopati V6.9 — Lifecycle, single-instance and recovery audit

Date: 25 October 2026
Workspace: SuperAgent on Windows/Bun
Scope: guarded INT8 semantic intent inference only; original ONNX destructive guard and backend authorization unchanged.

## Automatic lifecycle

- A local lifecycle bridge starts the Senopati watchdog whenever a new SuperAgent CLI or SuperAgent REST core is launched, if the selected policy has enabled=true and inferenceMode=shared_only.
- T-Line's separate backend spawns or connects to the SuperAgent REST core; the same successful REST bind startup hook covers freshly launched T-Line sessions. No second model is loaded in the T-Line backend.
- Tests, private Core workers and an explicit SUPERAGENT_SENOPATI_AUTOSTART=0 opt-out do not launch the model.
- Per-user JSON config in ~/.superagent-r/senopati-lifecycle.json permits app-launch autostart on/off and always retains the shared service when an unrelated CLI/T-Line session exits.
- A current-user Windows Startup item named SuperAgent Senopati Shared.cmd was installed, with an exact-content ownership check. It calls the idempotent Bun watchdog launcher at user logon. It does not add Windows services, scheduled tasks, admin privileges or registry modifications. A real Windows reboot/login has not been performed.

## Exclusive model startup and shutdown

- src/core/senopatiStartLease.ts obtains an atomic file lease BEFORE loading the 500+ MiB model. Another owner cannot load concurrently; only a validated, expired lease owned by a provably dead PID can be reclaimed. The named pipe remains authoritative for the live service.
- A negative direct-serve test against an online owner refused the duplicate without disrupting the existing model.
- The shared inference server rejects new work during shutdown, closes queued requests, and drains active model-only sockets with a 15-second maximum. No other process, session, tunnel, MCP, or desktop backend is stopped.
- src/core/senopatiWatchdogStatus.ts validates heartbeat and process state without exposing watchdog ownership nonce.

## Honest crash recovery evidence

1. The first REAL force-kill drill FAILED because a newly introduced model-startup scope bug referenced a policy variable outside its lexical scope after releasing the startup lease. The watchdog attempted bounded recovery, then exhausted retries. This was a genuine finding, not a pass.
2. Fixed the scope bug, restored the isolated model manually, and restarted its watchdog.
3. A second controlled FORCE-KILL targeted only the OS-verified model command line and PID 54864. The watchdog remained PID 22080 and automatically restored a new model at PID 30224 within 4.85 seconds. Tokenizer Rust, INT8 precision and a synthetic retrieve inference all passed after recovery.
4. A separate graceful control command restarted only the model PID 30224 -> PID 9152. The watchdog continued running, health settled to healthy, and the synthetic load test succeeded 48/48 at concurrency 16.
5. The model RAM resident set in final checks was around 571-575 MiB. Historical PIDs can change; use the status command for the current owner.

The successful crash record is in the Git-ignored local model directory as v69_abrupt_crash_recovery_drill_v1.json. No external notifications were issued.

## Controls

Terminal CLI:
    superagent senopati status
    superagent senopati doctor
    superagent senopati start
    superagent senopati restart
    superagent senopati stop
    superagent senopati autostart on
    superagent senopati autostart off
    superagent senopati login status
    superagent senopati login install
    superagent senopati login remove

When running the SuperAgent source directly, substitute bun src/cli.tsx senopati.
Interactive commands:
    /senopati status
    /senopati autostart on
    /senopati autostart off
    /senopati help

/status all now includes read-only local Senopati model/watchdog status. Startup entries may be removed only when their contents match this installation's managed script.

## Release boundaries and unverified items

- A model intent/risk prediction is never a permission grant. Backend MCP/project/tenant checks and the older destructive-shell guard remain independent.
- INT8 model safety is NOT approved for full replacement; there is still zero independently human-adjudicated natural gold.
- Full OS reboot/login, live packaged T-Line UI testing, long-run memory leak observation and T-Line instance upgrades were NOT carried out. The current local Bun source was tested.
- Binary weights remain pinned locally, excluded from Git. No unrelated workspace changes were committed.
- Verification includes V6.9 lifecycle/lease tests, existing V6.8 watchdog and queue tests, older MCP security tests, TypeScript compilation, forced and graceful model-only restart, and synthetic CPU inference load.


## Follow-up: 26 October 2026 — drain safety and profile namespace

A second round of V6.9 hardening closed two subtle race/isolation gaps:

- **Graceful shutdown replacement fence:** the model keeps the exclusive
  startup lease for the whole drain period, not just while loading ONNX.
  The watchdog checks the lease before allocating a successor and does
  not count lease waiting against its restart budget. Unknown/corrupt
  lease ownership fails closed rather than spawning a second large model.
- **Installation + profile-scoped IPC:** local Windows named pipes now use
  a SHA-256 namespace derived from both installation and selected config
  directory. Multiple projects sharing one profile reuse one ONNX session,
  while isolated profiles do not collide. The prior server was verified
  exited before its IPC namespace changed. Historical successor model PID
  24232 and watchdog PID 22204 were healthy at that handover.
- **Safe staging default:** if no lifecycle config exists, only the
  canonical user profile auto-starts the shared model by default.
  Custom, CI, staging and isolated test profiles default to off unless
  explicitly enabled; tests cannot leave a 500+ MiB background process.

**Real graceful drain test**, recorded in ignored local model evidence
(v69_bounded_drain_drill_v1.json): 48 synthetic requests were running
when the server received a model-only graceful stop. Twelve completed
and 36 returned no new mmBERT prediction, allowing the original
lightweight fallback. The shutdown lease was observed, the same
watchdog survived and a successor model started within about **4.1 s**.

**Fresh post-migration performance:** T-Line's authenticated Bun REST
bridge passed in an isolated profile without spawning another ONNX
daemon. Four independent Bun clients submitted 192 unique synthetic
prompts: **192/192 succeeded, zero failures, one shared model PID and
approximately 582 MiB resident memory**. The evidence file is
multiprocess_load_report_v4_profile_isolated.json, excluded from Git.
Whole-project TypeScript compilation passed.

Limitations: a real Windows reboot/login and packaged T-Line GUI launch
are not tested; independent natural human-gold safety evaluation has
not approved the INT8 Noul head. Model output never grants tools,
tenant access or shell execution. Synthetic performance is not an SLO.


**Final post-namespace abrupt-crash regression (26 October 2026):**
An OS force-kill targeted only the positively identified, live Senopati
model PID 24232. Watchdog PID 22204 stayed alive and restored the new
model as PID 10988 in **5.396 seconds**. The Rust tokenizer, INT8
precision, and synthetic retrieve inference succeeded again. The model
was healthy at the following doctor check, with approximately 582 MiB
resident memory. The exact local evidence is saved in the Git-ignored
model directory as v69_abrupt_crash_recovery_drill_v2_profile_namespace.json.
This is a local forced-crash recovery drill, not a full reboot test.
