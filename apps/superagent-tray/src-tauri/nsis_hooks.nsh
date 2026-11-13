; Windows NSIS hooks (Tauri v2 hook names).
; Add only the CLI folder we own to the current user's PATH, never another user's path.
!include "LogicLib.nsh"
!include "StrFunc.nsh"
${StrStr}
${UnStrRep}

!macro NSIS_HOOK_PREINSTALL
  ; Gracefully stop running SuperAgent processes and background Core services before updating files
  DetailPrint "Stopping existing SuperAgent processes..."
  nsExec::Exec 'taskkill.exe /F /IM superagent-tray.exe /T'
  nsExec::Exec 'taskkill.exe /F /IM superagent.exe /T'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($$_.Name -like ''*bun*'' -or $$_.Name -like ''*superagent*'' -or $$_.Name -like ''*node*'') -and ($$_.CommandLine -like ''*$INSTDIR*'' -or $$_.ExecutablePath -like ''*$INSTDIR*'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 1200
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Do not append duplicates, including when repairing/reinstalling.
  ReadRegStr $0 HKCU "Environment" "Path"
  ${StrStr} $1 ";$0;" ";$INSTDIR;"
  ${If} $1 == ""
    ${If} $0 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
    ${EndIf}
    WriteRegStr HKCU "Software\RudyCity\SuperAgent" "AddedPath" "$INSTDIR"
  ${EndIf}
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Stopping active SuperAgent processes before uninstall..."
  nsExec::Exec 'taskkill.exe /F /IM superagent-tray.exe /T'
  nsExec::Exec 'taskkill.exe /F /IM superagent.exe /T'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($$_.Name -like ''*bun*'' -or $$_.Name -like ''*superagent*'' -or $$_.Name -like ''*node*'') -and ($$_.CommandLine -like ''*$INSTDIR*'' -or $$_.ExecutablePath -like ''*$INSTDIR*'') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Sleep 1200
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $2 HKCU "Software\RudyCity\SuperAgent" "AddedPath"
  ; Never remove a pre-existing user PATH entry or another installation's entry.
  ${If} $2 == "$INSTDIR"
    ReadRegStr $0 HKCU "Environment" "Path"
    ${UnStrRep} $1 ";$0;" ";$INSTDIR;" ";"
    ; Remove the two synthetic boundary delimiters.
    StrLen $3 $1
    ${If} $3 > 1
      StrCpy $1 $1 -1 1
      WriteRegExpandStr HKCU "Environment" "Path" "$1"
    ${Else}
      DeleteRegValue HKCU "Environment" "Path"
    ${EndIf}
    DeleteRegValue HKCU "Software\RudyCity\SuperAgent" "AddedPath"
    DeleteRegKey /ifempty HKCU "Software\RudyCity\SuperAgent"
  ${EndIf}
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend
