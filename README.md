# Superagent 🚀

Superagent adalah asisten pemrograman berbasis terminal interaktif yang dirancang khusus untuk memfasilitasi siklus pengembangan, pengujian, debugging, serta optimalisasi aplikasi secara langsung dari dalam lingkungan kerja Anda. 

Asisten ini menggabungkan antarmuka visual cyberpunk berbasis komponen terminal, pelacakan otomatis batas token konteks model, mekanisme keamanan akses ketat, koordinasi agen paralel (*subagent*), serta integrasi eksekusi terminal lokal yang persisten.

---

## 📖 Latar Belakang

Dalam pengembangan perangkat lunak modern, developer sering kali harus berpindah fokus (*context switching*) antara menulis kode, menjalankan perintah terminal, memantau *log* sistem, melakukan pencarian dokumentasi, dan memanggil API model bahasa besar (LLM). 

Superagent dirancang untuk menjembatani celah tersebut langsung dari terminal dengan menyediakan lingkungan kerja terpadu yang dapat memahami konteks proyek secara mandiri melalui berkas spesifikasi proyek (`agents.md`), mengotomatiskan eksekusi tugas-tugas paralel menggunakan agen sekunder (*subagents*), dan memantau pemakaian batas memori konteks LLM secara real-time. Keamanan merupakan prioritas utama, di mana setiap eksekusi berkas, modifikasi kode, dan eksekusi perintah terminal memerlukan persetujuan eksplisit dari pengguna.

---

## 🛠️ Tech Stack & Arsitektur Proyek

Pengembangan Superagent didukung oleh teknologi modern berbasis Node.js untuk efisiensi tinggi dan modularitas komponen:

- **Bahasa**: TypeScript (ES Modules)
- **Runtime**: Node.js (v18+)
- **Antarmuka Pengguna**: [Ink](https://github.com/vadimdemedes/ink) (React di dalam terminal) untuk render antarmuka grafis terminal yang interaktif dan responsif.
- **Integrasi LLM**: [Vercel AI SDK](https://sdk.vercel.ai/) (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) untuk interaksi terstruktur dengan model bahasa.
- **Eksekusi Perintah**: [Execa](https://github.com/sindresorhus/execa) untuk kontrol proses latar belakang yang tangguh.
- **Uji Coba & Testing**: [Vitest](https://vitest.dev/) untuk pengujian unit secara cepat dan andal.

### Struktur Direktori Utama

```
superagent/
├── src/
│   ├── cli.tsx                 # Titik masuk utama aplikasi (Entrypoint)
│   ├── app.tsx                 # Logika antarmuka React (Ink) dan penanganan input
│   ├── core/
│   │   ├── agent.ts            # Inti dari siklus interaksi agen dan eksekusi instruksi
│   │   ├── config.ts           # Manajemen konfigurasi environment dan file global .env
│   │   ├── checkpoints.ts      # Logika penyimpanan/pemuatan status sesi obrolan
│   │   ├── slash-commands.ts   # Registrasi perintah interaktif terminal (e.g., /terminal, /checkpoint)
│   │   └── tools/              # Kumpulan fungsi perkakas (tools) yang dapat dijalankan agen
│   │       ├── shellTools.ts   # Eksekusi command dan manajemen proses latar belakang
│   │       ├── systemTools.ts  # Manipulasi file, pembuatan direktori, dan deteksi port
│   │       ├── subagentTools.ts# Pembuatan dan orkestrasi agen sekunder paralel
│   │       └── networkTools.ts # Fetch web content, browser automation, dll.
│   └── components/             # Komponen antarmuka terminal (Visual indicators, Wizards, Logs)
├── tests/                      # Kumpulan tes unit menggunakan Vitest
└── package.json                # Manifes proyek dan skrip build/run
```

---

## 🌟 Fitur Utama Pengembang

### 1. Antarmuka Visual & Pelacakan Konteks Real-Time
Menampilkan statistik real-time mengenai ukuran prompt saat ini, jumlah token komplesi, histori memori, model aktif yang digunakan, serta batas sisa jendela konteks model untuk membantu menghemat konsumsi token API Anda.

### 2. Manajemen Sesi & Checkpoint Persisten
Memungkinkan developer menyimpan status sesi pengkodean saat ini dan memulihkannya kembali kapan saja (melalui `/checkpoint save <name>` dan `/checkpoint restore <id>`). Sangat membantu untuk bereksperimen dengan pendekatan implementasi yang berbeda tanpa takut kehilangan histori percakapan sebelumnya. Anda juga dapat melanjutkan sesi terakhir secara otomatis dengan argumen `--resume` atau `-r`.

### 3. Orkestrasi Multi-Agen (*Subagents*)
Mendukung pembuatan agen sekunder secara paralel untuk mempercepat proses pencarian informasi atau pembagian tugas yang independen:
- **Researcher**: Berfokus mencari informasi dalam repositori dan referensi luar secara read-only.
- **Coder**: Menangani penulisan kode dan perbaikan logika program.
- **Reviewer**: Menjalankan pengujian fungsional dan melakukan audit terhadap perubahan kode.

### 4. Eksekusi Terminal Popped-Up (`/terminal`)
Menjalankan tugas pengembangan, server lokal, atau alur kerja khusus pengujian di luar proses headless tradisional. Perintah `/terminal <cmd>` akan memunculkan jendela emulator terminal asli yang baru pada sistem operasi host (Windows cmd, macOS Terminal, Linux x-terminal-emulator), lengkap dengan konfigurasi preset berbasis file konfigurasi lokal `terminal-presets.json`.

### 5. Mode Perencanaan Terstruktur (`implementation_plan.md`)
Sebelum melakukan perubahan kode yang kompleks, sistem akan menyusun rencana implementasi secara terperinci di root repositori dan meminta persetujuan pengguna. Proses ini meminimalisir kesalahan perombakan kode berskala besar yang tidak terencana.

---

## 🚀 Panduan Memulai & Pengembangan

### Persyaratan Awal
- **Node.js** v18+
- **npm** atau package manager lainnya

### Langkah Penginstalan

1. Unduh dan masuk ke direktori repositori:
   ```bash
   git clone <repository-url>
   cd superagent
   ```

2. Pasang semua dependensi pengembangan:
   ```bash
   npm install
   ```

3. Konfigurasi Kunci API Global:
   Secara default, Superagent menyimpan konfigurasi global di direktori beranda pengguna untuk menjaga kebersihan repositori proyek Anda. Buat berkas `.env` di dalam folder `~/.superagent-r/` (misalnya, `C:\Users\<Username>\.superagent-r\.env` di Windows atau `/home/<username>/.superagent-r/.env` di macOS/Linux) dengan format berikut:
   ```env
   # API Keys (Sediakan minimal salah satu)
   ANTHROPIC_API_KEY=your_anthropic_api_key
   OPENAI_API_KEY=your_openai_api_key

   # Provider Terpilih (openai atau anthropic)
   PROVIDER=openai

   # Model yang Digunakan
   MODEL=gpt-4o
   ```

---

## ⚙️ Skrip Pengembangan (Scripts)

Di dalam repositori, Anda dapat menggunakan perintah NPM berikut untuk kebutuhan pengembangan:

- **Menjalankan Mode Pengembangan**:
  ```bash
  npm run dev
  ```
- **Melanjutkan Sesi Sebelumnya**:
  ```bash
  npm run dev -- --resume
  # atau
  npm run dev -- -r
  ```
- **Melakukan Build TypeScript ke JavaScript (Dist)**:
  ```bash
  npm run build
  ```
- **Menjalankan Hasil Build Produksi**:
  ```bash
  npm start
  ```
- **Menjalankan Pengujian Unit (Unit Testing)**:
  ```bash
  npm test
  ```

---

## 💬 Perintah Pendukung (/ Commands)

Selama sesi interaksi terminal aktif, Anda dapat memasukkan perintah berikut untuk memanipulasi alur kerja:

| Perintah | Deskripsi Fungsi |
| :--- | :--- |
| `/new` | Memulai sesi percakapan baru, membersihkan histori, serta log tampilan. |
| `/resume` | Memulihkan sesi sebelumnya dari riwayat global melalui antarmuka dialog interaktif. |
| `/search-history <query>` | Mencari string pencarian pada seluruh berkas histori sesi kerja lokal secara cepat. |
| `/checkpoint` | Mengelola pencadangan status percakapan (`list`, `save <nama>`, `restore <id>`). |
| `/goal <deskripsi>` | Mengaktifkan mode pencapaian target tugas terotomatisasi jangka panjang. |
| `/init` | Melakukan audit sistem, inisialisasi git repository, dan membuat cetak biru `agents.md`. |
| `/agents` | Memeriksa daftar tipe subagent terdaftar beserta instans subagent yang aktif saat ini. |
| `/processes` | Menampilkan proses latar belakang aktif beserta daftar checklist `task.md` (alias: `/procs`). |
| `/terminal <cmd>` | Menjalankan perintah atau memicu preset terkonfigurasi pada terminal pop-up baru. |
| `/skills` | Membuka repositori templat/panduan otomatisasi alur kerja (*skills*) yang terpasang. |
| `/install <owner/repo>` | Memasang modul otomatisasi/panduan alur kerja baru dari repositori. |
| `/login` | Mengatur provider aktif dan menyimpan otentikasi kunci API secara aman. |
| `/model <nama>` | Mengganti atau menampilkan model bahasa besar aktif yang sedang dikoneksikan. |
| `/help` | Menampilkan pesan panduan instruksi bantuan ini. |
| `/quit` | Keluar dari aplikasi. |

---

## ✍️ Kontributor & Penulis (Author)

Proyek ini dirancang, dikembangkan, dan dipelihara oleh:
- **Rudy H.** ([GitHub Profile](https://github.com/RudyCity)) - *Creator & Lead Developer*

Terima kasih kepada seluruh kontributor yang telah membantu dalam perbaikan bug, penyempurnaan fitur, dan penulisan dokumentasi. Jika Anda ingin berkontribusi, silakan pelajari berkas [CONTRIBUTING.md](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/CONTRIBUTING.md).

---

## 📄 Lisensi

Proyek ini dilisensikan di bawah **MIT License** - lihat berkas [LICENSE](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/LICENSE) untuk detail lebih lanjut.

