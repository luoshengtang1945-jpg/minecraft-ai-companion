@echo off
setlocal
chcp 65001 >nul
title Minecraft AI Companion
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer and try again.
  pause
  exit /b 1
)
node scripts\launch-companion.js
echo.
echo AI Companion stopped. Press any key to close this window.
pause >nul
