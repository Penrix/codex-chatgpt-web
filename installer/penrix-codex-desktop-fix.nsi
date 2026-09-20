Unicode true
Name "Penrix Codex Desktop Fix"
OutFile "Penrix-Codex-Desktop-Fix.exe"
InstallDir "$LOCALAPPDATA\Penrix\CodexDesktopProviderFix"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

!include "LogicLib.nsh"

Section "Install"
  SetOutPath "$INSTDIR"
  File "install-penrix-windows-desktop-provider.ps1"

  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-penrix-windows-desktop-provider.ps1" -SetHighDefault' $0
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Codex Desktop fix failed. Open Codex Web GPT first and run Install into Codex, then try this EXE again."
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix" "DisplayName" "Penrix Codex Desktop Fix"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix" "DisplayVersion" "1.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix" "Publisher" "Penrix"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix" "NoRepair" 1

  IfSilent +2
  MessageBox MB_ICONINFORMATION|MB_OK "Installed. Keep Codex Web GPT open, fully quit Codex Desktop including background codex.exe, then reopen Codex Desktop and test chatgpt-web/high."
SectionEnd

Section "Uninstall"
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install-penrix-windows-desktop-provider.ps1" -Restore' $0
  ${If} $0 != 0
    IfSilent +2
    MessageBox MB_ICONSTOP|MB_OK "Could not restore the original Codex config. The backup was left untouched."
    Abort
  ${EndIf}

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PenrixCodexDesktopFix"
  Delete "$INSTDIR\install-penrix-windows-desktop-provider.ps1"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  IfSilent +2
  MessageBox MB_ICONINFORMATION|MB_OK "Original Codex config restored. Fully restart Codex Desktop."
SectionEnd
