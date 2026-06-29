@echo off
REM ===========================================================
REM 디직스 카운터 수집기 onedir 빌드 — V3/백신 false positive 회피
REM 결과: dist\digix-collector\ 폴더 + dist\digix-collector.zip
REM ===========================================================
setlocal
cd /d %~dp0

echo [1/4] 의존성 설치 (Python 3.14)
py -3.14 -m pip install --upgrade pip
py -3.14 -m pip install -r requirements.txt
if errorlevel 1 goto :err

echo.
echo [2/4] 이전 빌드 정리
if exist build rmdir /s /q build
if exist dist  rmdir /s /q dist
if exist digix-collector.spec del digix-collector.spec

echo.
echo [3/4] PyInstaller --onedir 빌드 (압축 풀림 없는 폴더 형태 — V3 회피)
py -3.14 -m PyInstaller ^
  --noconsole ^
  --onedir ^
  --contents-directory _internal ^
  --name digix-collector ^
  --version-file version_info.txt ^
  --hidden-import puresnmp ^
  --hidden-import pystray._win32 ^
  --collect-submodules puresnmp ^
  --collect-all puresnmp_plugins ^
  --copy-metadata puresnmp ^
  --copy-metadata x690 ^
  --copy-metadata t61codec ^
  main.py
if errorlevel 1 goto :err

echo.
echo [4/4] ZIP 패키징 (고객 배포용)
powershell -NoProfile -Command "Compress-Archive -Path 'dist\digix-collector' -DestinationPath 'dist\digix-collector.zip' -Force"
if errorlevel 1 goto :err

echo.
echo ===========================================================
echo  빌드 완료
echo  - 폴더: dist\digix-collector\digix-collector.exe
echo  - 배포 ZIP: dist\digix-collector.zip
echo  고객에게 ZIP 전달 -^> 압축 풀기 -^> EXE 더블클릭
echo ===========================================================
goto :end

:err
echo.
echo *** 빌드 실패 — 에러 로그 확인 ***
exit /b 1

:end
endlocal
