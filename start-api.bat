@echo off
title McAfee API
cd /d "%~dp0api"
echo Starting McAfee API server...
call npm start
pause
