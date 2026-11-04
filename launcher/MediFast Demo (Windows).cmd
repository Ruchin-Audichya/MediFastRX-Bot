@echo off
title MediFast Demo
cd /d "%~dp0\.."
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Opening the download page...
  echo   Install the LTS version, then double-click this file again.
  start "" "https://nodejs.org/en/download"
  echo.
  pause
  exit /b 1
)
node launcher\launch.mjs %*
