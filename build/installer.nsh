; Silent in-app update passes /S --force-run. The assisted installer then
; starts the new exe once from installSection. Do not start it from here or
; a second copy would open.
;
; The Grok Bot shim is a second Go7 Workhorse.exe holding app.asar. Mac
; already stops it before replace; Windows uninstall then failed with
; "Failed to uninstall old application files: 2". Kill the image before
; the old uninstaller runs. Do not launch the new app from this file.

!macro customInit
  !ifndef nsProcess::KillProcess
    !include "nsProcess.nsh"
  !endif
  ${nsProcess::KillProcess} "Go7 Workhorse.exe" $R0
  Sleep 800
!macroend
