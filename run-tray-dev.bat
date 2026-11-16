@echo off
title SuperAgent Tray Dev Watcher
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0apps\superagent-tray"
echo ========================================================
echo Starting SuperAgent Tray in Dev Mode (Hot-Reload Watcher)...
echo ========================================================
cargo tauri dev
pause
