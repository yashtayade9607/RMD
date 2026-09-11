Option Explicit

' Starts the development Host without showing a Command Prompt window.
Dim shell, fileSystem, projectFolder
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
projectFolder = fileSystem.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = projectFolder & "\desktop"
shell.Run "cmd.exe /c npm run host", 0, False
