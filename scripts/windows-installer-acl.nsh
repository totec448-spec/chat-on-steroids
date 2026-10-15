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

# 2.1.38: an update the person asked for ("Restart and install") runs visibly, so they can see
# its progress instead of an app that vanished for a minute or two. Such an update already knows
# whom it installs for and where; it never asks again.
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

# A fresh install keeps its "Run Chat On Steroids" box on the finish page. An update does not wait
# for Finish: it starts the app again when the app asked for that (--force-run), then ends here.
!macro customFinishPage
  Function cosStartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function cosFinishPre
    ${if} ${isUpdated}
      ${if} ${isForceRun}
        HideWindow
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      ${endif}
      Abort
    ${endif}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "cosStartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE cosFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend
