@echo off
chcp 65001 >nul
rem Запуск Кабинета из исходников без установки (Windows).
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install --no-audit --no-fund
  if errorlevel 1 ( pause & exit /b 1 )
)
call npm start
