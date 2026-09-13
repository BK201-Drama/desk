; desk: never leave a desktop shortcut — the app IS the desktop board.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$DESKTOP\desk.lnk"
!macroend

; desk 会把 HideIcons 置 1（见 src-tauri/src/fence/hide.rs）。退出钩子只能覆盖
; 「desk 跑过再退出」，覆盖不到「装完从没运行过就卸载」。所以卸载必须在这里再兜一次底。
;
; 用 DeleteRegValue 而不是写 0：卸载后系统要回到「这个值从未被设置过」的出厂状态，
; 而不是留下一个 desk 写过的 0（那会让 Explorer 认为用户显式设置过）。
; 值本来就不存在时 DeleteRegValue 会置错误标志，清掉它，别影响卸载器后续步骤。
!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" "HideIcons"
  ClearErrors
!macroend
