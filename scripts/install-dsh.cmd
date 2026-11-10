@echo off
rem One-click installer for dsh-web-search. Bypasses the script execution policy for this run only.
setlocal
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-dsh.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-dsh.ps1" %*
)
set rc=%errorlevel%
if "%~1"=="" pause
exit /b %rc%