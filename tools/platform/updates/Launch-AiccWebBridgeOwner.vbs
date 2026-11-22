Option Explicit
Dim fs, sh, source
Set fs = CreateObject("Scripting.FileSystemObject")
source = fs.BuildPath(fs.GetParentFolderName(WScript.ScriptFullName), "Inspect-AiccWebBridgeOwner.ps1")
If Not fs.FileExists(source) Then
  MsgBox "The trusted AICC diagnostic script is missing. No action taken.", 48, "AICC bridge"
  WScript.Quit 1
End If
Set sh = CreateObject("Shell.Application")
sh.ShellExecute "powershell.exe", "-NoProfile -NoExit -File """ & source & """", "", "runas", 1
