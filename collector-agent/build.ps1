# =====================================================================
#  디직스 카운터 수집기 EXE 빌드 (PyInstaller --onedir)
#  결과: dist\digix-collector\digix-collector.exe + _internal\
#
#  V3 / 안랩 오탐 회피를 위한 옵션 풀세트:
#   --onedir / --noupx / --version-file / --manifest / --icon
#
#  실행: powershell -ExecutionPolicy Bypass -File build.ps1
#  또는: build.bat (wrapper) 더블클릭
# =====================================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "[1/3] 의존성 설치 (Python 3.14)" -ForegroundColor Cyan
& py -3.14 -m pip install --upgrade pip
& py -3.14 -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw "의존성 설치 실패" }

Write-Host ""
Write-Host "[2/3] 이전 빌드 정리" -ForegroundColor Cyan
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force dist  -ErrorAction SilentlyContinue
Remove-Item -Force digix-collector.spec -ErrorAction SilentlyContinue
Write-Host "  cleaned: build\, dist\, digix-collector.spec"

Write-Host ""
Write-Host "[3/3] PyInstaller 빌드 (onedir + 메타데이터 + 디직스 아이콘)" -ForegroundColor Cyan
$pyiArgs = @(
  '-3.14','-m','PyInstaller',
  '--noconsole','--onedir','--noupx',
  '--contents-directory','_internal',
  '--name','digix-collector',
  '--icon','assets\icon.ico',
  '--version-file','version_info.txt',
  '--manifest','app.manifest',
  '--add-data','assets\icon.png;assets',
  '--hidden-import','puresnmp',
  '--hidden-import','pystray._win32',
  '--hidden-import','tkinter',
  '--hidden-import','tkinter.ttk',
  '--hidden-import','tkinter.messagebox',
  '--hidden-import','tkinter.simpledialog',
  '--collect-submodules','puresnmp',
  '--collect-submodules','tkinter',
  '--collect-all','puresnmp_plugins',
  '--copy-metadata','puresnmp',
  '--copy-metadata','x690',
  '--copy-metadata','t61codec',
  'main.py'
)
& py @pyiArgs
if ($LASTEXITCODE -ne 0) { throw "PyInstaller 빌드 실패" }

$exe = Join-Path $PSScriptRoot 'dist\digix-collector\digix-collector.exe'
if (-not (Test-Path $exe)) { throw "EXE 가 생성되지 않았습니다: $exe" }
$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " 빌드 완료" -ForegroundColor Green
Write-Host "  폴더 : dist\digix-collector\" -ForegroundColor Green
Write-Host "  EXE  : digix-collector.exe  ($sizeMb MB)" -ForegroundColor Green
Write-Host " ZIP 패키징은 release.ps1 / release.bat 가 수행" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
