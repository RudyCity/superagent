# r-ui MCP Workflow: Live Jiro Bento & Mobbin App Flows

Panduan operasional pemanfaatan **Model Context Protocol (MCP)** untuk menarik blok bento dan alur interaksi nyata secara live saat merancang atau memperbarui antarmuka dalam arsitektur `r-ui`.

---

## 1. Arsitektur Integrasi Live MCP

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       r-ui LIVE MCP DESIGN PIPELINE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. JIRO MCP (https://mcp.jiro.build)                                       │
│     └── Tarik: 1,400+ Bento blocks, modular sections, asymmetric grids      │
│  2. MOBBIN MCP (https://api.mobbin.com/mcp / plugin: mobbin)                │
│     └── Tarik: Real app screens, multi-step flows, state transitions        │
│  3. r-ui FILTER & SYNTHESIS ENGINE                                          │
│     ├── Terapkan 8 Anti-Slop Visual Laws (No purple haze, no neon glow)     │
│     ├── Petakan ke CSS Tokens orisinal (--r-ui-*)                           │
│     └── Terapkan Dual-Layer Theming (5 Canvas + 8 Color Accents)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Jiro MCP Workflow (`jiro.build`)

### A. Peran & Domain
Gunakan MCP `jiro` saat merancang:
- **Blok Bento Asimetris** (rasio 2:1, bento cards interaktif, highlight stats).
- **Struktur Hero Section & Split View** (headline + preview live mockup).
- **Komponen Modular**: Pricing matrices, feature highlights, tabs navigation, dan timeline cards.

### B. Pola Pemanggilan & Query
Saat membutuhkan blok bento baru, rumuskan query dengan tipe spesifik:
- `bento grid with primary interactive card and secondary stat counters`
- `media editor inspector panel with segmented controls`
- `pricing table with annual discount pill toggle`

### C. Aturan Konversi ke `r-ui`
1. **Asymmetric Bento Enforcement**: Hindari grid simetris monoton (3 kolom ukuran sama). Wajib berikan card utama bobot `col-span-2` atau `row-span-2`.
2. **Sanitasi Warna & Border**: Hapus semua warna hardcoded atau gradien ungu generik. Ganti dengan token `--r-ui-border-subtle` dan `--r-ui-surface-card`.
3. **Elevasi Mikro**: Ganti drop shadow tebal dengan border 1px presisi dan shadow mikro (`--r-ui-shadow-sm`).

---

## 3. Mobbin MCP Workflow (`mobbin.com`)

### A. Peran & Domain
Gunakan MCP `mobbin` saat merancang:
- **Alur Antarmuka Kompleks (UX Flows)**: Modal dialogs, settings drawers, timeline controls, multi-track audio/video editor layout, context menus.
- **State Handling Riil**: Loading skeletons, empty states dengan actionable CTA, konfirmasi permission, dan error banners.

### B. Tooling MCP Mobbin
Gunakan tool MCP Mobbin yang relevan:
- `search_screens(platform: "web" | "ios", query: "...", limit: 5, output_destination: "code")`: Mencari layar nyata produk kelas dunia untuk topik tertentu.
- `search_flows(platform: "web" | "ios", query: "...", limit: 3)`: Menelusuri seluruh urutan interaksi multi-step.
- `get_collection_contents(collection_id: "...")`: Mengambil kumpulan screen referensi yang telah dikurasi.

### C. Contoh Implementasi Query:
```json
{
  "platform": "web",
  "query": "desktop video editor multitrack timeline and inspector panel",
  "limit": 5,
  "output_destination": "code"
}
```

---

## 4. Sintesis ke Doktrin Estetika `r-ui`

Setelah data struktur ditarik dari MCP `jiro` atau `mobbin`:

1. **Anti-Slop Filter Checklist**:
   - [ ] Tidak ada gradien ungu/pink AI generik (*No purple haze*).
   - [ ] Tidak ada shadow hitam tebal yang keruh (*No muddy shadows*).
   - [ ] Tidak ada efek neon/cyberpunk glow ring yang menyilaukan (*No glow rings*).
   - [ ] Blur backdrop maksimal 6–8px dengan border 1px kontras tinggi (*Crisp glassmorphism*).
2. **Dual-Layer Theming Binding**:
   - Terapkan Canvas Theme yang sesuai: `light`, `dark`, `dim`, `paper`, atau `midnight`.
   - Sematkan Color Accent yang selaras: `cyan`, `emerald`, `amber`, `rose`, `violet`, `cobalt`, `crimson`, atau `graphite`.
3. **Interaktivitas Taktil**:
   - Terapkan micro-interactions pegas (*spring physics* `scale: 0.98` saat klik) dan visual feedback instan.
