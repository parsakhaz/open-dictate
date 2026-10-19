; Uninstalling asks whether to also delete settings, history, recordings and downloaded models.
; Updates also run the old uninstaller; ${isUpdated} keeps everything then, and silent uninstalls keep it too.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent dictate_keep_data
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your dictate settings, history and downloaded models?$\r$\n$\r$\nChoose No to keep them for a later install." /SD IDNO IDNO dictate_keep_data
    RMDir /r "$APPDATA\dictate"
    RMDir /r "$LOCALAPPDATA\dictate"
    dictate_keep_data:
  ${endIf}
!macroend
