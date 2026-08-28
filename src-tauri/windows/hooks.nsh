; desk: never leave a desktop shortcut — the app IS the desktop board.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$DESKTOP\desk.lnk"
!macroend
