!macro grantSandboxReadAccess
  ClearErrors
  ExecWait '"$SYSDIR\icacls.exe" "$INSTDIR" /grant "*S-1-15-2-2:(OI)(CI)(RX)" /Q' $0
  ${If} ${Errors}
    StrCpy $0 2
  ${EndIf}
  ${If} $0 != 0
    # During an update this runs before any page exists, where Abort ends the installer
    # silently (#1258). Say why, and what usually helps, unless the install is silent.
    ${IfNot} ${Silent}
      MessageBox MB_ICONSTOP|MB_OK "Windows could not set the folder access needed to start Chat On Steroids safely (icacls exit code $0) for:$\r$\n$INSTDIR$\r$\n$\r$\nIf Chat On Steroids is installed in a protected folder such as Program Files, run this installer as administrator."
    ${EndIf}
    SetErrorLevel 2
    Abort "Windows could not set the folder access needed to start Chat On Steroids safely."
  ${EndIf}
!macroend

!macro customInit
  # initMultiUser has resolved a previous custom install path by this point.
  # Repair an existing install before an update removes its runnable version.
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    !insertmacro grantSandboxReadAccess
  ${EndIf}
!macroend

!macro customInstall
  # Chromium's sandbox needs read and execute access through the app tree.
  # Add one inheritable grant to the final directory without resetting other ACLs.
  !insertmacro grantSandboxReadAccess
!macroend
