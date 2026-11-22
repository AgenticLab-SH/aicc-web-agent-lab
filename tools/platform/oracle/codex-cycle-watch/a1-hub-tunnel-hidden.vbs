Option Explicit
Dim shell, root, ps, scriptPath, cmd, rc
Set shell = CreateObject("WScript.Shell")
root = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.ai-control-center\oracle-a1-access"
ps = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
scriptPath = root & "\keep-a1-hub-tunnel.ps1"
cmd = Chr(34) & ps & Chr(34) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34) & " -Root " & Chr(34) & root & Chr(34)
rc = shell.Run(cmd, 0, True)
WScript.Quit rc
