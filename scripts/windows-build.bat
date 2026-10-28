@echo off
chcp 65001 >nul
rem Сборка установщика Кабинета для Windows. Запускать двойным щелчком.
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install the LTS version from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo.
echo [1/2] Installing dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail
echo.
echo [2/2] Building the installer...
rem Without the code-signing tools: they need the right to create symbolic links and fail on most PCs.
rem The icon is written into the .exe by scripts\after-pack.js instead.
call npm run dist:win-nosign
if errorlevel 1 goto fail
:done
echo.
echo Done. The installer is in the "dist" folder: Kabinet-Setup-*.exe
explorer dist
pause
exit /b 0

:fail
echo.
echo Something went wrong. Scroll up to read the reason.
echo If you see "symbolic link": turn on Developer Mode (Settings - System - For developers) or run this file as administrator.
pause
exit /b 1
