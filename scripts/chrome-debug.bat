@echo off
REM ============================================
REM  Chrome Debug Launcher - untuk Superagent
REM  Membuka Chrome dengan --remote-debugging-port=9222
REM  (otomatisasi CDP tanpa extension)
REM ============================================

tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL | find /I "chrome.exe" >NUL
if %errorlevel%==0 (
    echo.
    echo  [Chrome masih berjalan]
    echo  Flag debug TIDAK akan aktif kalau Chrome sudah kebuka duluan.
    echo.
    echo  Tutup SEMUA window Chrome dulu, lalu
    echo  double-click file ini lagi.
    echo.
    pause
    exit /b 1
)

echo Membuka Chrome mode debug di port 9222...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
