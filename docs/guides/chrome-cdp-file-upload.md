# SuperAgent Chrome CDP: File Upload dan Windows Open Dialog

Fitur ini tersedia melalui `superagent_chrome_cdp` (MCP) atau `control_chrome_cdp` (agent), mendukung **Managed CDP** dan **Delegate-CDP**. Pilih `targetId`/profil Chrome secara eksplisit bila ada beberapa tab/profil.

## 1. Lihat input file pada halaman

```json
{"command":"list_file_inputs","transport":"delegate","delegateTabId":23}
```

Mengembalikan selector/index, disabled, multiple, accept, hidden, dan nama file yang sudah dipilih. `inputIndex` menggunakan indeks nol dalam hasil pencarian selector file input, **bukan** indeks snapshot umum.

## 2. Upload PDF langsung lewat CDP (disarankan)

```json
{
  "command": "upload_file",
  "transport": "delegate",
  "delegateTabId": 23,
  "selector": "input[type=file]",
  "files": ["C:\\Users\\USER\\Downloads\\POS Peminjaman Ruang Sidang Lt.6 - FTAB.pdf"],
  "allowOutsideWorkspace": true,
  "confirmExternalFile": true
}
```

`files` juga bisa disimpan di dalam string JSON `payload`. File di dalam workspace tidak memerlukan kedua flag persetujuan eksternal. Hidden file input didukung. Maksimal 10 file, 100 MiB per file, total 200 MiB. Pada beberapa input gunakan `inputIndex` atau selector spesifik. Input yang tidak mengizinkan `multiple` ditolak untuk beberapa file. Saat ini pemilihan input berada di DOM utama (iframe lintas asal belum didukung).

Jalur ini memanggil `DOM.setFileInputFiles` secara langsung sehingga **tidak membuka Windows Open File dialog**. Browser dapat otomatis memulai unggahan ketika event input berubah. Perintah ini tidak menekan tombol Submit formulir secara eksplisit.

## 3. File chooser Chrome yang belum terbuka

Untuk Managed CDP:

1. `{"command":"handle_file_chooser","payload":"{\"arm\":true}"}` untuk mengaktifkan interception.
2. Trigger tombol Choose File di halaman, misalnya melalui `click`.
3. `{"command":"handle_file_chooser","payload":"{\"files\":[\"C:\\\\folder\\\\file.pdf\"]}"}` untuk mengisi input berdasarkan peristiwa `Page.fileChooserOpened`.

Untuk Delegate-CDP (attachment debugger sementara), langkah trigger harus digabung dalam **satu panggilan**:

```json
{
  "command": "handle_file_chooser",
  "transport": "delegate",
  "delegateTabId": 23,
  "payload": "{\"files\":[\"C:\\\\folder\\\\file.pdf\"],\"triggerSelector\":\"button.choose-file\",\"allowOutsideWorkspace\":true,\"confirmExternalFile\":true}"
}
```

`triggerSelector` dijalankan hanya pada input pilihan yang dimaksud di tab aktif. Jika tidak ada event chooser yang valid, tidak ada upaya menebak jendela lain.

## 4. Windows Open File dialog yang *sudah* terbuka

Ini **bukan** dialog JavaScript browser. Gunakan fallback UI Automation hanya bila dialog memang ada:

```json
{
  "command": "handle_file_chooser",
  "transport": "delegate",
  "delegateTabId": 23,
  "payload": "{\"filePath\":\"C:\\\\Users\\\\USER\\\\Downloads\\\\document.pdf\",\"nativeDialog\":true,\"confirmNativeDialog\":true,\"allowOutsideWorkspace\":true,\"confirmExternalFile\":true}"
}
```

Fallback hanya Windows, mencari **tepat satu** dialog Open milik proses Chrome/Edge (kelas `#32770`), kemudian menargetkan kontrol `File name` dan tombol `Open` via UI Automation. `windowTitle` dapat diisi untuk pencocokan judul dialog secara persis. Ia gagal dengan aman jika tidak ada dialog cocok, ada lebih dari satu, elemen UI ambigu, atau sesi desktop tidak interaktif. Multi-file native dibatasi pada file satu folder. Jangan beri `triggerSelector` pada mode native.

## 5. Verifikasi

```json
{"command":"verify_upload","transport":"delegate","delegateTabId":23,"expectedNames":["document.pdf"],"successSelector":".upload-success"}
```

Status `selected_in_browser` berarti browser menerima pilihan file; `page_evidence_observed` berarti elemen penanda ditemukan pada halaman. **Keduanya bukan bukti server telah menerima dan menyimpan file**. Periksa respons jaringan, data situs, atau item hasil upload sebelum mengklaim unggahan selesai.

## Batasan

- File terletak pada **mesin yang menjalankan SuperAgent/Core dan browser Chrome**; Delegate-CDP pada mesin berbeda tidak dapat membaca path tersebut.
- Dialog Open yang sudah terbuka memerlukan UI Automation Windows dan opsi opt-in eksplisit.
- UIA fallback bisa gagal pada dialog custom aplikasi, sesi noninteraktif, izin desktop terbatas, atau struktur dialog nonstandar.
- Tidak ada form submission paksa, file byte/content tidak dimasukkan ke output MCP.
- Extension Delegate harus dimuat ulang setelah perubahan `cdpPolicy.js`/`cdpBridge.js`, dan Core/MCP perlu restart setelah build agar perintah baru terlihat live.
