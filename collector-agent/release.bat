@echo off
REM ASCII-only wrapper — runs release.ps1 (PowerShell handles UTF-8 / Korean safely)
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0release.ps1"
set _rc=%errorlevel%
echo.
if %_rc% NEQ 0 (
  echo *** RELEASE FAILED — check messages above. exit code: %_rc%
) else (
  echo *** RELEASE OK — GitHub Pages reflects in 1~2 min
)
pause
exit /b %_rc%
