@echo off
title McAfee Controller
cd /d "%~dp0desktop"
echo Opening McAfee as the controller...
call npm run controller
pause
