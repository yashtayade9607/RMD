@echo off
cd /d "%~dp0desktop"
start "" wscript.exe "%~dp0start-host-hidden.vbs"
exit /b
