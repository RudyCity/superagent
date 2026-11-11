# Managed Chrome CDP session recording (project-local)

The `control_chrome_cdp` managed transport can save an **opt-in browser session archive** with genuine H.264 MP4 video, redacted action transcript, console/error events and network metadata. This is a browser-tab capture, not a video of the operating-system desktop or an audio recording.

## Storage: the current project, not SuperAgent

The recorder resolves the **active command workspace / project cwd**, not the SuperAgent source tree or `~/.superagent-r` configuration. If no absolute active project directory is available, starting recording **fails closed**; it does not guess a fallback.

```text
<current-project>/
└── .superagent/
    └── recordings/
        ├── .gitignore             # ignores all recordings below this directory
        └── cdp/
            └── <recording-uuid>/
                ├── video.mp4
                ├── actions.json
                ├── transcript.jsonl
                ├── console.jsonl
                ├── errors.jsonl
                ├── network.jsonl
                ├── diagnostics.jsonl
                ├── manifest.json
                └── README.txt
```

Each recording gets a new UUID folder; existing files are not overwritten. The private files remain on the **local project filesystem** until you remove them. The recorder creates a nested Git-ignore rule, but inspect your project’s Git status before any commit or upload. Do not publish these files: **the video can show passwords, messages or other sensitive page contents** even though text logs are redacted.

## Start, inspect and stop

1. On a managed Chrome tab, claim ownership with `claim_target` and retain your `targetId`, `agentId` and secret `sessionToken`. Sharing a tab as an observer or contributor does not grant permission to start a sensitive video recording.
2. Call `control_chrome_cdp` with `command:"record_session_start"`, `transport:"managed"`, the exact target and owner identity, and `confirmSensitiveVideo:true`. **MP4 is enabled by default**; you need not pass `video:true`.
3. Perform the actions to be documented. Native `hover_cursor` and `click_cursor` are logged as action categories and accompanied by video frames; no raw selector, typed value or form content is written to JSON logs.
4. Call `record_session_status` to inspect the frame count, dropped frames, file paths and errors. Finish with `record_session_stop`. The stop command flushes queued text logs, finalizes FFmpeg and returns the output paths and actual status.

Example inputs (substitute real authorized values; do not paste secrets into a public issue):

```json
{"command":"record_session_start","transport":"managed","targetId":"<claimed-target-id>","agentId":"<owner-id>","sessionToken":"<private-session-capability>","confirmSensitiveVideo":true}
{"command":"record_session_status","transport":"managed","targetId":"<claimed-target-id>","agentId":"<owner-id>","sessionToken":"<private-session-capability>"}
{"command":"record_session_stop","transport":"managed","targetId":"<claimed-target-id>","agentId":"<owner-id>","sessionToken":"<private-session-capability>"}
```

The tool's actual working directory must be the intended project. The archive path returned by `record_session_start` is authoritative; verify it before proceeding.

## Contents and limitations

| File | What is saved |
| --- | --- |
| `video.mp4` | Captured exact tab surface, 960×540 pixels, up to **5 FPS**, H.264, **no audio** |
| `actions.json` | Bounded action category, cursor coordinates and cryptographic selector/URL digests where available; no typed text |
| `transcript.jsonl` | Recording start/stop and time-ordered tool-action category, outcome and bounded redacted failure summaries |
| `console.jsonl` | Redacted console/log/exception metadata |
| `errors.jsonl` | Error-level console entries, exceptions, failed requests, HTTP 4xx/5xx and capture/encoder failures |
| `network.jsonl` | Request/response/failure timing and status metadata; no cookies, headers, request or response body |
| `diagnostics.jsonl` | Combined bounded console/error/network metadata |
| `manifest.json` | Recording ID, files, durations, counts, MP4 outcome, problem list and privacy flags |
| `README.txt` | Human-readable summary of the archive |

Requires locally installed `ffmpeg` on PATH. SuperAgent now checks both `ffmpeg` and `ffprobe` during interactive startup and offers an explicitly approved package-manager installation when missing. You can also run `superagent deps check` or `superagent deps install` manually. The recorder itself never downloads or installs FFmpeg. Resource bounds: at most **4 simultaneous session videos**, **10 minutes per recording**, **160 MB of input JPEG data**, and **2500 metadata rows per category**. If a lease becomes invalid, capture fails, or a limit is reached, the recorder stops collecting and attempts to finalize the video and manifest; inspect the returned status and errors before relying on the archive. A successful start is **not** proof that the final MP4 has been finalized: always verify stop status.

This recorder is deliberately **not** a full raw conversation/keystroke recorder. It saves a structured transcript of browser actions and diagnostic events, not private chat message bodies, cookies, unredacted HTTP traffic, typed secrets or OS audio. The video itself can still contain whatever was visibly rendered inside the tab.

**Transport boundary:** these recording commands currently operate only on claimed **managed CDP** targets, not Delegate-CDP or unverified Chrome extensions. The source feature requires a running, correctly authorized Core; its presence in the repository does not prove the installed Tray or Core has been updated.
