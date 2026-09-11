@echo off
title Deskly API
cd /d "%~dp0api"
echo Starting Deskly API server...
call npm start
pause
