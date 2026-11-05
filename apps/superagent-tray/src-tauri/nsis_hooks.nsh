; Custom NSIS hooks for SuperAgent Windows Installer
; Automatically registers the installation directory into the User's PATH

!macro customInstall
  DetailPrint "Registering SuperAgent in User PATH..."
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
  ${Else}
    WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
  ${EndIf}
  ; Broadcast WM_SETTINGCHANGE (0x001A) so open shells and desktop refresh environment
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  ; Broadcast environment change on uninstall
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend
