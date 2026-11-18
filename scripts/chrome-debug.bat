@echo off
setlocal EnableExtensions
REM Legacy attended Windows launcher (port 9222 only).
REM Prefer the supervised launch_chrome_profile tool for PID/ownership tracking.
REM Never close, adopt or alter a user's existing Chrome processes.
set "CDP_PORT=9222"
set "DEBUG_DIR=%USERPROFILE%\.superagent-r\chrome-debug-profile"
set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" (
  echo ERROR: Chrome not found. Install Google Chrome or use supervised browser executable discovery.
  exit /b 1
)
REM A foreign process on 9222 must never be mistaken for this launch.
powershell.exe -NoProfile -NonInteractive -Command "$c=Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue; if($c){exit 1}else{exit 0}" >nul 2>&1
if errorlevel 1 (
  echo ERROR: Port 9222 is already in use. No Chrome process was modified.
  exit /b 2
)
if not exist "%DEBUG_DIR%" mkdir "%DEBUG_DIR%"
if not exist "%DEBUG_DIR%" (
  echo ERROR: Cannot create the isolated debug profile.
  exit /b 3
)
echo Launching an isolated Chrome CDP profile on 127.0.0.1:9222...
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="%DEBUG_DIR%" --no-first-run --no-default-browser-check about:blank
if errorlevel 1 (
  echo ERROR: Chrome start command failed.
  exit /b 4
)
echo Launch requested. Verify readiness using the SuperAgent managed CDP transport_status command.
echo This legacy launcher is not supervised by BrowserProcessManager.
exit /b 0
