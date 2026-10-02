#!/usr/bin/env python3
"""Telegram Bot API CLI. Usage:
  tg.py getMe
  tg.py getUpdates [--offset N] [--timeout 30]
  tg.py sendMessage <chat_id> <text>
  tg.py sendDocument <chat_id> <file_path> [caption]
"""
import json, sys, urllib.request, urllib.parse
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import dynamic_credential_entry, read_json_response

ALLOWED = ["api.telegram.org"]
CRED = "custom.telegram-bot"

def api_url(method):
    # Build URL with RAW surrogate (not URL-encoded): the egress proxy
    # replaces hsurr:* literally, and URL-encoding breaks the match.
    entry = dynamic_credential_entry(CRED, "access_token")
    surr = str(entry["surrogate"]).strip()
    url = f"https://api.telegram.org/bot{surr}/{method}"
    # sanity: host allowlist
    assert urllib.parse.urlparse(url).hostname in ALLOWED
    return url

def call(method, params=None, files=None):
    url = api_url(method)
    if files:
        # multipart for file upload
        import uuid
        boundary = uuid.uuid4().hex
        body = b""
        for k, v in (params or {}).items():
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, (fname, fpath) in files.items():
            with open(fpath, "rb") as f:
                data = f.read()
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + data + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(url, data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        data = urllib.parse.urlencode(params or {}).encode() if params else None
        req = urllib.request.Request(url, data=data)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return read_json_response(resp)

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "getMe"
    if cmd == "getMe":
        print(json.dumps(call("getMe"), indent=1)[:500])
    elif cmd == "getUpdates":
        offset = None; timeout = 30
        args = sys.argv[2:]
        for i, a in enumerate(args):
            if a == "--offset" and i + 1 < len(args):
                offset = int(args[i + 1])
            if a == "--timeout" and i + 1 < len(args):
                timeout = int(args[i + 1])
        params = {"timeout": timeout}
        if offset is not None:
            params["offset"] = offset
        r = call("getUpdates", params)
        updates = r.get("result", [])
        print(json.dumps(updates, indent=1)[:4000])
        if updates:
            print(f"\n# {len(updates)} update(s), last update_id={updates[-1]['update_id']}", file=sys.stderr)
    elif cmd == "sendMessage":
        chat_id, text = sys.argv[2], sys.argv[3]
        r = call("sendMessage", {"chat_id": chat_id, "text": text})
        print("sent ok" if r.get("ok") else json.dumps(r)[:500])
    elif cmd == "sendDocument":
        chat_id, fpath = sys.argv[2], sys.argv[3]
        caption = sys.argv[4] if len(sys.argv)> 4 else ""
        import os
        r = call("sendDocument", {"chat_id": chat_id, "caption": caption},
                 files={"document": (os.path.basename(fpath), fpath)})
        print("sent ok" if r.get("ok") else json.dumps(r)[:500])
    else:
        print(f"unknown command: {cmd}", file=sys.stderr); sys.exit(1)

if __name__ == "__main__":
    main()
