@echo off
setlocal
cd /d %~dp0

if exist "dist\digix-collector.exe" (
  start "" "dist\digix-collector.exe" --install
) else if exist "digix-collector.exe" (
  start "" "digix-collector.exe" --install
) else (
  echo digix-collector.exe file was not found.
  echo Build the EXE first, or place this installer next to the EXE.
  pause
)

endlocal
