; electron-updater passes --updated so NSIS skips runAfterFinish.
; This desk is not electron-updater — reopen after a silent update.
!macro customInstall
  Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
!macroend
