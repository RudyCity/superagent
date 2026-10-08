# OmniParser Service (Vision-based UI Automation)

Local AI service that detects UI elements (buttons, inputs, icons) in screenshots.
Used by superagent's `control_chrome_vision` tool — **started automatically**, no manual action needed.

## How it works

1. Superagent captures a Chrome tab screenshot via CDP
2. Sends it to this service (`POST http://127.0.0.1:9333/parse`)
3. Service runs YOLOv8 (detect elements) + Florence-2 (label elements) locally on GPU
4. Returns JSON: `[{x, y, width, height, label, type}]` in absolute pixels
5. Superagent clicks/types by label via CDP

## First-time setup

```bash
python services/omniparser/setup.py
```

Downloads ~1.1GB (YOLO weights 40MB + Florence-2 ~1GB) and installs Python deps.
Requires: Python 3.10+, internet connection. NVIDIA GPU recommended (works on CPU, slower).

## Manual start (usually not needed — auto-started by the tool)

```bash
python services/omniparser/omniparser_service.py
```

Listens on `127.0.0.1:9333` (localhost only, never exposed to network).

## Files

- `omniparser_service.py` — HTTP service (stdlib only + PIL)
- `setup.py` — one-time setup (deps + model download)
- `util/` — OmniParser inference code (from microsoft/OmniParser)
- `weights/` — YOLO model (downloaded by setup.py, gitignored)
