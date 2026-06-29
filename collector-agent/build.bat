@echo off
REM ASCII-only wrapper — runs build.ps1 (PowerShell handles UTF-8 / Korean safely)
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0build.ps1"
set _rc=%errorlevel%
echo.
if %_rc% NEQ 0 (
  echo *** BUILD FAILED — check messages above. exit code: %_rc%
) else (
  echo *** BUILD OK
)
pause
exit /b %_rc%
