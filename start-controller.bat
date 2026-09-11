@echo off
title Deskly Controller
cd /d "%~dp0desktop"
echo Opening Deskly as the controller...
call npm run controller
pause
