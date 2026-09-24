@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto :fail
start "" http://localhost:8080
node server.js
goto :eof
:fail
echo.
echo Node.js 20+ is required. Install it once, then run this file again.
pause
