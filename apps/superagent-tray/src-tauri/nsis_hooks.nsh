; Windows NSIS hooks (Tauri v2 hook names).
; Add only the CLI folder we own to the current user's PATH, never another user's path.
!include "LogicLib.nsh"
!include "StrFunc.nsh"
${StrStr}
${UnStrRep}

!macro NSIS_HOOK_PREINSTALL
  ; Gracefully stop running SuperAgent processes and background Core services before updating files
  DetailPrint "Stopping existing SuperAgent processes..."
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM superagent-tray.exe /T'
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM superagent.exe /T'
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM bun.exe /T'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name superagent-tray, superagent, bun -ErrorAction SilentlyContinue | Stop-Process -Force"'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { try { $$_.Path -like ''*$INSTDIR*'' } catch { $$false } } | Stop-Process -Force -ErrorAction SilentlyContinue"'

  ; Verify that superagent-tray.exe has released file locks before proceeding
  ${If} ${FileExists} "$INSTDIR\superagent-tray.exe"
    StrCpy $R9 0
    loop_wait_tray:
      ClearErrors
      FileOpen $R8 "$INSTDIR\superagent-tray.exe" a
      ${IfNot} ${Errors}
        FileClose $R8
        Goto tray_unlocked
      ${EndIf}
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM superagent-tray.exe /T'
      Sleep 500
      IntOp $R9 $R9 + 1
      ${If} $R9 < 10
        Goto loop_wait_tray
      ${EndIf}
    tray_unlocked:
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\bun.exe"
    StrCpy $R9 0
    loop_wait_bun:
      ClearErrors
      FileOpen $R8 "$INSTDIR\bun.exe" a
      ${IfNot} ${Errors}
        FileClose $R8
        Goto bun_unlocked
      ${EndIf}
      nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM bun.exe /T'
      Sleep 500
      IntOp $R9 $R9 + 1
      ${If} $R9 < 6
        Goto loop_wait_bun
      ${EndIf}
    bun_unlocked:
  ${EndIf}

  Sleep 500
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
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM superagent-tray.exe /T'
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM superagent.exe /T'
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM bun.exe /T'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process -Name superagent-tray, superagent, bun -ErrorAction SilentlyContinue | Stop-Process -Force"'
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { try { $$_.Path -like ''*$INSTDIR*'' } catch { $$false } } | Stop-Process -Force -ErrorAction SilentlyContinue"'
  Sleep 1000
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
