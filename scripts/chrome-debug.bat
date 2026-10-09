@echo off
REM ============================================
REM  Chrome Debug Launcher - untuk Superagent
REM  Membuka Chrome mode debug di port 9222
REM  menggunakan profil terisolasi (.superagent-r/chrome-debug-profile)
REM  tanpa perlu menutup Chrome milik pengguna.
REM ============================================

set "DEBUG_DIR=%USERPROFILE%\.superagent-r\chrome-debug-profile"
if not exist "%DEBUG_DIR%" mkdir "%DEBUG_DIR%"

echo Membuka Chrome mode debug di port 9222...
set "CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=chrome.exe"

start "" "%CHROME_EXE%" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --remote-allow-origins=* --user-data-dir="%DEBUG_DIR%" --no-first-run --no-default-browser-check
echo Chrome debug mode aktif di http://127.0.0.1:9222

