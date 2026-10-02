# Panduan: Menghubungkan Superagent dengan Asisten Remote (Muse) via Telegram

Panduan publik untuk menghubungkan **superagent** (AI coding assistant yang berjalan di laptop) dengan **asisten remote "Muse"** (AI assistant yang berperan sebagai otak/perencana) melalui grup Telegram privat. Cocok untuk setup di mesin mana pun, dari nol.

> **Legenda placeholder** — ganti dengan nilai Anda sendiri:
> | Placeholder | Arti |
> |---|---|
> | `<BOT_A_USERNAME>` / `<BOT_A_ID>` | Bot Telegram milik sisi Muse (diberikan oleh penyedia asisten remote Anda) |
> | `<BOT_B_USERNAME>` | Bot Telegram milik Anda (dibuat via @BotFather) |
> | `<TOKEN_BOT_B>` | Token Bot B dari @BotFather |
> | `<GROUP_ID>` | ID numerik grup privat Anda (selalu negatif, mis. `-1234567890`) |

---

## 1. Gambaran Arsitektur

```
┌─────────────────────┐         ┌─────────────────────────┐         ┌─────────────────────┐
│     SUPERAGENT      │         │   GRUP TELEGRAM PRIVAT  │         │        MUSE         │
│   (laptop/pc Anda)  │         │                         │         │  (server assistant) │
│                     │         │  ┌───────────────────┐  │         │                     │
│  /muse <task>       │         │  │ Bot B (milik Anda)│  │         │  Penalaran,         │
│  mengeksekusi tool  │◄───────►│  │ Bot A (milik Muse)│  │◄───────►│  perencanaan,       │
│  lokal: read, glob, │         │  └───────────────────┘  │         │  menulis task_batch │
│  grep, write, edit  │         │                         │         │                     │
└─────────────────────┘         └─────────────────────────┘         └─────────────────────┘
```

**Prinsip desain:** integrasi dilakukan pada **tingkat tugas** (agen-ke-agen), bukan sebagai model provider. Muse berpikir dalam batch besar; superagent mengeksekusi tool-nya secara lokal di mesin Anda.

**Alur satu tugas:**

1. `/muse <tugas>` → superagent (via Bot B) mengirim **`task_request`** ke grup.
2. Muse membaca, bernalar, mengirim **`task_batch`** berisi tool call.
3. Superagent mengeksekusi tool secara lokal (dengan permission prompt untuk operasi destruktif), mengirim **`task_result`**.
4. Ulangi 2–3 sampai selesai → Muse mengirim **`task_done`**.

**Transport:** murni Telegram Bot API long polling (`getUpdates`). Tanpa webhook, tanpa port publik. Mesin Anda hanya melakukan koneksi *keluar* ke `api.telegram.org`.

---

## 2. Prasyarat

- Akun Telegram.
- superagent terinstal dengan modul `remoteAgent` (`src/core/remoteAgent/`) dan perintah `/muse`.
- Informasi Bot A dari penyedia asisten remote Anda: `<BOT_A_USERNAME>` dan `<BOT_A_ID>`.

---

## 3. Setup Telegram (di HP)

### 3.1 Buat Bot B (milik Anda)

1. Buka **@BotFather** → `/newbot` → ikuti langkahnya.
2. **Simpan token** di tempat aman. Jangan pernah kirim token lewat chat mana pun.

### 3.2 Aktifkan Bot-to-Bot Communication Mode

Mode ini memungkinkan dua bot saling melihat pesan satu sama lain (Telegram Bot API 10.0+). **Hanya bisa diaktifkan manual**, tidak via API:

1. Buka **@BotFather** → tap **Open App** (Mini App). Pakai aplikasi Telegram HP versi terbaru — setting ini kadang tidak muncul di client desktop lawas.
2. Pilih **Bot B** → **Settings / Bot Settings** → aktifkan **Bot-to-Bot Communication Mode**.
3. Pastikan mode yang sama aktif di **Bot A** (tanyakan/konfirmasi ke penyedia asisten remote Anda).

### 3.3 Buat grup privat

1. Buat grup Telegram baru (privat).
2. Tambahkan **Bot B** dan **`<BOT_A_USERNAME>`** sebagai anggota.
3. Jadikan **keduanya admin** (keduanya perlu "has access to messages").
4. Kirim satu pesan di grup, mis. `tes`.

---

## 4. Setup Superagent (di Mesin Anda)

### 4.1 Konfigurasi

Di terminal superagent (token diketik lokal — tidak lewat chat, tidak masuk repo):

```
/muse config botToken <TOKEN_BOT_B>
/muse config groupId <GROUP_ID>
/muse config museBotId <BOT_A_ID>
```

**Mendapatkan `<GROUP_ID>`:** setelah mengirim `tes` di grup, tanyakan ke asisten remote Anda, atau tambahkan @getmyid_bot sementara ke grup untuk melihat ID-nya (lalu keluarkan lagi). **ID grup selalu negatif.**

Cek: `/muse status` (token tampil tersamar, tidak pernah full).

### 4.2 Tes koneksi

```
/muse hai
```

Seharusnya: "Sending task request…" → Muse membalas satu batch tool → superagent mengeksekusi → hasil kembali → `task_done`. Jika ini jalan, seluruh bus hidup.

---

## 5. Sisi Asisten Remote (Muse) — Berupa Prompt Saja

Sisi asisten remote tidak butuh instalasi khusus. Cukup berikan prompt berikut ke AI assistant mana pun yang memiliki akses ke Bot API Telegram (dengan token Bot A). Ganti semua placeholder `<...>` dengan nilai Anda.

---

**Prompt:**

> You are **Muse**, the remote brain in an agent-to-agent coding setup. A local runner ("superagent") on the user's machine executes tools for you; you do the reasoning. You communicate **only** through a private Telegram group via Bot API long polling.
>
> **Identities**
> - Bot A (you): `<BOT_A_USERNAME>`, id `<BOT_A_ID>` — poll its `getUpdates` exclusively (call `deleteWebhook` first; one token, one poller).
> - Bot B (superagent): `<BOT_B_USERNAME>`, id `<BOT_B_ID>` — you never have its token.
> - Group: chat id `<GROUP_ID>` (both bots are admins, Bot-to-Bot Communication Mode enabled).
>
> **Protocol** — JSON envelopes, `v: 1`:
> - `task_request` (in): `{v, kind, id, session, task, workspace, tools[]}` — a new task from superagent.
> - `task_batch` (out): `{v, kind, id, task_id, calls[{id, tool, args}]}` — your tool calls. Tools: `read`, `glob`, `grep`, `ripgrep_search` (safe); `write`, `edit`, `write_to_file`, `replace_file_content`, `apply_patch` (destructive — the runner prompts its user first).
> - `task_result` (in): `{v, kind, id, task_id, results[{id, ok, output?, error?}]}` — execution results.
> - `task_done` (out): `{v, kind, id?, task_id, summary}` — send when the task is complete or blocked.
> - `chat` (either): `{v, kind, id?, task_id?, text}` — non-tool notes.
>
> **Rules**
> 1. Process only messages where `chat.id == <GROUP_ID>` AND `from.id == <BOT_B_ID>`; ignore everything else.
> 2. Dedupe by envelope `id` and Telegram `update_id` — never answer the same batch twice.
> 3. Loop: `task_request` → reason → `task_batch` → wait `task_result` → repeat → `task_done`. Max 50 batches / 30 min per task.
> 4. One Telegram message caps at 4096 chars — split larger envelopes as `MUSEBUS <envelope_id> <n>/<N>\n<chunk>`.
> 5. Prefer read-only batches first (explore before modifying). Keep `summary` concise.

---

Dengan prompt ini, asisten remote mana pun bisa langsung berperan sebagai Muse tanpa setup tambahan.

## 6. Referensi Protokol (Ringkas)

| `kind` | Arah | Isi |
|---|---|---|
| `task_request` | superagent → Muse | `{v, kind, id, session, task, workspace, tools[], system_prompt_hash, system_prompt?}` — `system_prompt` hanya dikirim saat berubah (hash SHA-256 16 char selalu dikirim) |
| `task_batch` | Muse → superagent | `{v, kind, id, task_id, calls[{id, tool, args, depends_on?, timeout_ms?}]}` — `depends_on`: call IDs yang harus selesai dulu; `timeout_ms`: deadline per-call |
| `task_result` | superagent → Muse | `{v, kind, id, task_id, results[{id, ok, output?, error?}]}` |
| `task_done` | Muse → superagent | `{v, kind, id?, task_id, summary}` |
| `chat` | dua arah | `{v, kind, id?, task_id?, text}` |
| `prompt_cache_miss` | Muse → superagent | `{v, kind, task_id}` — Muse tidak punya prompt untuk hash ini; superagent kirim ulang full prompt |

**Format chunk** (pesan >3800 char): `MUSEBUS <envelope_id> <n>/<N>\n<chunk>`.
Juga diterima: `MUSEBUS <n>/<N> <chunk>` (tanpa ID) dan plain JSON tanpa prefix
(untuk envelope kecil). Output tool dipotong agar muat di batas Telegram.

**Eksekusi batch**: read-only calls dalam satu wave jalan paralel; modifying calls
dan semua `run_command`/`bash` selalu sekuensial (cegah race condition tulis file).

**Loop guard** (progress-based): task ditutup hanya jika >60 menit elapsed DAN
>60 menit tanpa progres. Safety net: 1000 batch / 24 jam.

---

## 7. Troubleshooting

| Gejala | Kemungkinan penyebab | Solusi |
|---|---|---|
| `Remote agent (Muse) is not configured` | Salah satu dari `botToken` / `groupId` / `museBotId` belum di-set | Lengkapi ketiganya |
| `Failed to send task request` | Bot B belum menjadi anggota grup, atau token salah | Cek daftar Members di HP; validasi token |
| `task_request` terkirim tapi tak ada respons | **Bot-to-Bot Communication Mode** belum aktif di salah satu bot | Ulangi langkah 3.2 |
| Batch dari Muse tidak diproses (log: "did not yield complete envelope") | Format envelope salah | Gunakan plain JSON untuk envelope kecil, atau `MUSEBUS <id> <n>/<N>\n<chunk>` untuk chunk |
| Kode baru tidak aktif setelah edit | Watcher masih pakai modul lama | Restart `/muse watch` setiap habis ubah kode remoteAgent |
| Hasil batch tidak kembali | Offset maju sebelum diproses + crash | Sudah di-fix: offset maju setelah proses (update ke versi terbaru) |
| ID grup ditolak / pesan tak sampai | Kurang tanda minus (ID grup selalu negatif) | Tambahkan `-` di depan |
| `groupId` tertukar dengan ID bot | `groupId` harus negatif; ID bot positif | Perbaiki nilainya |
| Daftar admin (via API) belum menampilkan bot yang baru ditambahkan | Cache Bot API bisa basi beberapa menit | Uji kirim pesan yang menentukan, bukan daftar admin |
| Dua poller berebut satu token | `getUpdates` vs webhook / dua proses polling bersamaan | Satu token satu poller; `deleteWebhook` sebelum polling |

---

## 8. Keamanan

1. **Token tidak lewat chat.** Hanya di terminal lokal + file config yang di-`.gitignore`. Jika bocor: revoke via @BotFather (`/revoke`).
2. **Permission prompt tetap aktif.** Tool destruktif selalu minta persetujuan user — tidak di-auto-approve.
3. **Pesan bot Telegram tidak end-to-end encrypted.** Jangan kirim secret/`.env`/API key lewat grup.
4. **Satu token, satu poller.** Bot A dipoll eksklusif sisi Muse; Bot B eksklusif superagent.
5. **Validasi pengirim.** Hanya proses envelope dari `from.id` yang dikenal; abaikan sisanya.
6. **Batas pengaman.** Progress-based stall detection (60 menit); safety net 1000 batch / 24 jam; dedupe batch ID agar tool tak dieksekusi dobel.
