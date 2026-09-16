@echo off
title Deskly install
cd /d "%~dp0"
echo Installing Deskly (this can take a few minutes)...
call npm install --prefix api
call npm install --prefix desktop
echo.
echo Done. Next: start-api.bat, then start-host.bat and start-controller.bat
pause
