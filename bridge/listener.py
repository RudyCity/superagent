#!/usr/bin/env python3
"""Muse-side WebSocket bridge client for superagent.
Persistent WebSocket bridge client to the laptop superagent workstation.
- Single Muse session per bridge (server allows only one; close code 4009 otherwise).
- Connects to WS_URL with Bearer auth (env BEARER).
- Goes through the VM egress proxy (env https_proxy).
- Multi-bridge: set BRIDGE=<name> to isolate outbox/spool/log under bridges/<name>/.
  Without BRIDGE, uses the legacy top-level dirs (backward compat).
- Incoming messages -> stdout + log; task envelopes spooled.
- Outgoing: drop a JSON file into the bridge's outbox/; it is sent and moved to sent/.
- Reconnects with backoff. Token is NEVER written to disk or logs.
"""
import asyncio, json, os, sys, time, shutil
from datetime import datetime, timezone

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

# WAJIB: isi URL tunnel via env WS_URL. Jangan hardcode URL asli di sini.
URL = os.environ.get("WS_URL") or "wss://<tunnel-kamu>.trycloudflare.com/muse"
BASE = os.path.expanduser("~/workspace/ws-bridge")
_BRIDGE = os.environ.get("BRIDGE", "").strip()
if _BRIDGE:
    _safe = "".join(ch for ch in _BRIDGE if ch.isalnum() or ch in "-_")[:40]
    BASE = os.path.join(BASE, "bridges", _safe)
SPOOL_DIR = os.path.join(BASE, "spool")
OUTBOX = os.path.join(BASE, "outbox")
SENT_DIR = os.path.join(BASE, "sent")
CHAT_DIR = os.path.join(BASE, "chat_inbox")
LOG_FILE = os.path.join(BASE, "listener.log")


def log(*parts):
    line = f"{datetime.now(timezone.utc).isoformat()} {' '.join(str(p) for p in parts)}"
    print(line, flush=True)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception:
        pass


async def handle_message(raw):
    log("IN:", raw[:3000])
    try:
        env = json.loads(raw)
    except Exception:
        return
    if not isinstance(env, dict):
        return
    kind = env.get("kind")
    if kind == "chat":
        # User chat message from the laptop via tunnel -> dedicated inbox
        # (watched by the ws-chat-inbox hook which wakes an agent).
        try:
            os.makedirs(CHAT_DIR, exist_ok=True)
            ts = int(time.time() * 1000)
            eid = str(env.get("id", f"no-id-{ts}"))
            safe = "".join(ch for ch in eid if ch.isalnum() or ch in "-_")[:40]
            cpath = os.path.join(CHAT_DIR, f"{ts}_{safe}.json")
            with open(cpath, "w") as f:
                json.dump(env, f)
            log(f"chat inbox -> {cpath}: {(env.get('text') or '')[:120]}")
        except Exception as e:
            log(f"chat inbox write failed: {e}")
    if kind in ("task_request", "task_batch", "task_result", "task_done", "chat",
                "hello", "ready", "welcome", "tasks", "result", "error"):
        os.makedirs(SPOOL_DIR, exist_ok=True)
        eid = str(env.get("id", f"no-id-{int(time.time())}"))
        safe = "".join(ch for ch in eid if ch.isalnum() or ch in "-_")[:60]
        path = os.path.join(SPOOL_DIR, f"{kind}_{safe}.json")
        with open(path, "w") as f:
            json.dump(env, f)
        log(f"spooled {kind} -> {path}")


async def outbox_pump(ws):
    os.makedirs(OUTBOX, exist_ok=True)
    os.makedirs(SENT_DIR, exist_ok=True)
    while True:
        try:
            files = sorted(f for f in os.listdir(OUTBOX) if f.endswith(".json"))
        except Exception:
            files = []
        for fn in files:
            src = os.path.join(OUTBOX, fn)
            try:
                with open(src) as f:
                    payload = f.read()
                json.loads(payload)  # validate
                await ws.send(payload)
                log(f"OUT: {fn} ({len(payload)} chars)")
                shutil.move(src, os.path.join(SENT_DIR, fn))
            except Exception as e:
                log(f"outbox send failed for {fn}: {e}")
                try:
                    os.remove(src)
                except Exception:
                    pass
        await asyncio.sleep(1)


async def main():
    token = os.environ.get("BEARER", "")
    if not token:
        log("FATAL: no BEARER env")
        sys.exit(2)
    proxy = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY")
    backoff = 5
    while True:
        try:
            async with connect(
                URL,
                additional_headers={"Authorization": f"Bearer {token}"},
                open_timeout=25,
                max_size=16 * 1024 * 1024,
                ping_interval=20,
                ping_timeout=20,
                proxy=proxy,
            ) as ws:
                log("CONNECTED, listening for tasks")
                backoff = 5
                pump = asyncio.create_task(outbox_pump(ws))
                try:
                    async for raw in ws:
                        await handle_message(raw)
                finally:
                    pump.cancel()
        except ConnectionClosed as e:
            log(f"DISCONNECTED: {e}, reconnect in {backoff}s")
        except Exception as e:
            log(f"ERROR: {type(e).__name__}: {e}, reconnect in {backoff}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 120)


if __name__ == "__main__":
    asyncio.run(main())
