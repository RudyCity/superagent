#!/usr/bin/env python3
"""One watch segment for the Muse<->superagent Telegram bridge.

Loops getUpdates long-polls until --deadline (epoch). On finding complete
matching envelopes it appends them to pending_matches.jsonl and exits with
code 10 (lock left held) so the parent can reason and reply. On no matches it
advances the offset file each iteration. Exit 0 when the deadline passes.
MUSEBUS chunks are reassembled in chunks/<envelope_id>/ with dedupe key
"<envelope_id> <n>/<N>".
"""
import sys, os, json, time, argparse, re

HOME = os.environ["HOME"]
RELAY = os.path.join(HOME, "workspace", "tg-relay")
LOCK = os.path.join(RELAY, "bridge.lock")
OFFSET_FILE = os.path.join(RELAY, "bridge_offset.txt")
STATE_FILE = os.path.join(RELAY, "bridge_state.json")
PENDING = os.path.join(RELAY, "pending_matches.jsonl")
CHUNKS = os.path.join(RELAY, "chunks")
MALFORMED = os.path.join(RELAY, "malformed.log")

# Load identities from bridge-config.json (kit) or fall back to tg-relay copy.
def load_config():
    for p in (os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "..", "bridge-config.json"),
              os.path.join(RELAY, "bridge-config.json")):
        p = os.path.normpath(p)
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)
    raise SystemExit("bridge-config.json not found; run setup.py first")

CFG = load_config()
GROUP_ID = CFG["group"]["id"]
BOT_B_ID = CFG["bot_b"]["id"]
KEYWORDS = ("task_request", "task_result", "MUSEBUS")
CHUNK_RE = re.compile(r'^MUSEBUS (\S+) (\d+)/(\d+)\n', re.S)

sys.path.insert(0, os.path.join(HOME, "workspace", "skills", "telegram-bot", "bin"))
import tg

ap = argparse.ArgumentParser()
ap.add_argument("--deadline", type=int, required=True)
args = ap.parse_args()

os.makedirs(CHUNKS, exist_ok=True)


def read_offset():
    try:
        with open(OFFSET_FILE) as f:
            return int(f.read().strip())
    except Exception:
        return 0


def write_offset(n):
    with open(OFFSET_FILE, "w") as f:
        f.write(str(n))


def open_task_exists():
    try:
        with open(STATE_FILE) as f:
            st = json.load(f)
        tasks = st.get("tasks", st) if isinstance(st, dict) else []
        if isinstance(tasks, dict):
            tasks = tasks.values()
        for t in tasks:
            if isinstance(t, dict) and t.get("started_at") and not t.get("closed_at"):
                return True
        return False
    except Exception:
        return False


def log_malformed(kind, text):
    with open(MALFORMED, "a") as f:
        f.write(json.dumps({"ts": time.time(), "kind": kind,
                            "preview": text[:200]}) + "\n")


def handle_chunk(text, update_id):
    """Store a MUSEBUS chunk; return reassembled envelope or None."""
    m = CHUNK_RE.match(text)
    if not m:
        log_malformed("chunk_no_header", text)
        return None
    env_id, n_s, N_s = m.group(1), m.group(2), m.group(3)
    n, N = int(n_s), int(N_s)
    if n < 1 or n > N or N > 200:
        log_malformed("chunk_bad_index", text)
        return None
    d = os.path.join(CHUNKS, env_id)
    os.makedirs(d, exist_ok=True)
    key_file = os.path.join(d, "chunk_%d.txt" % n)
    if os.path.exists(key_file):
        return None  # duplicate chunk
    with open(key_file, "w") as f:
        f.write(text[m.end():])
    meta_p = os.path.join(d, "meta.json")
    try:
        with open(meta_p) as f:
            meta = json.load(f)
    except Exception:
        meta = {}
    meta["total"] = N
    meta.setdefault("update_ids", {})[str(n)] = update_id
    with open(meta_p, "w") as f:
        json.dump(meta, f)
    have = [f for f in os.listdir(d) if f.startswith("chunk_")]
    if len(have) == N:
        body = "".join(
            open(os.path.join(d, "chunk_%d.txt" % i)).read()
            for i in range(1, N + 1))
        for f in os.listdir(d):
            os.unlink(os.path.join(d, f))
        os.rmdir(d)
        try:
            return json.loads(body)
        except Exception:
            log_malformed("chunk_reassembly_not_json", body)
            return None
    return None


n = read_offset()
print(f"segment start offset={n} deadline={args.deadline}", flush=True)
pending = []

while time.time() < args.deadline:
    timeout = 30
    if open_task_exists():
        timeout = 10
        try:
            tg.call("sendChatAction", {"chat_id": GROUP_ID, "action": "typing"})
        except Exception:
            pass
    try:
        os.utime(LOCK, None)
    except Exception:
        pass
    try:
        resp = tg.call("getUpdates", {"offset": n + 1, "timeout": timeout})
    except Exception as e:
        print(f"poll error: {e}", flush=True)
        time.sleep(5)
        continue
    if not isinstance(resp, dict) or not resp.get("ok"):
        print("telegram ok=false, sleeping 5", flush=True)
        time.sleep(5)
        continue
    updates = resp.get("result", []) or []
    max_id = n
    for u in updates:
        uid = u.get("update_id", n)
        if uid > max_id:
            max_id = uid
        msg = u.get("message") or u.get("edited_message") or {}
        chat = msg.get("chat") or {}
        frm = msg.get("from") or {}
        text = msg.get("text") or ""
        if (chat.get("id") != GROUP_ID or frm.get("id") != BOT_B_ID
                or not any(k in text for k in KEYWORDS)):
            continue
        if text.startswith("MUSEBUS"):
            env = handle_chunk(text, uid)
            if env is not None:
                env["_reassembled_from"] = "MUSEBUS"
                pending.append((uid, env))
        else:
            try:
                pending.append((uid, json.loads(text)))
            except Exception:
                log_malformed("plain_not_json", text)
    if pending:
        # Do NOT advance the offset; parent processes first (critical ordering).
        with open(PENDING, "a") as f:
            for uid, env in pending:
                f.write(json.dumps({"update_id": uid, "envelope": env}) + "\n")
        print(f"MATCHES={len(pending)} seen_max_id={max_id} offset_still={n}",
              flush=True)
        sys.exit(10)
    if max_id > n:
        n = max_id
        write_offset(n)

print("deadline reached, exiting", flush=True)
sys.exit(0)
