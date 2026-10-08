@echo off
REM ============================================
REM  Chrome Debug Launcher - untuk Superagent
REM  Tutup paksa Chrome, lalu buka mode debug
REM  (--remote-debugging-port=9222)
REM ============================================

echo Menutup semua proses Chrome...
taskkill /F /IM chrome.exe 2>NUL
echo Menunggu 3 detik...
timeout /t 3 /nobreak >NUL

echo Membuka Chrome mode debug di port 9222...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
echo Selesai.
