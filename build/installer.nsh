; build/installer.nsh
; Optional custom NSIS hooks — runs during Windows installer creation.
; Keeps it minimal: just ensures a clean uninstall before reinstall.

!macro customInstall
  ; Nothing custom needed — electron-builder handles the heavy lifting
!macroend

!macro customUnInstall
  ; Clean up any leftover server processes on uninstall
  nsExec::Exec 'taskkill /f /im "Talkity.exe" /t'
!macroend
