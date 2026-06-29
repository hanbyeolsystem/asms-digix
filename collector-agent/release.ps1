# =====================================================================
#  디직스 카운터 수집기 — 빌드 + ZIP 패키징 + 자동 배포 (GitHub Pages)
#
#  단계:
#   1) build.ps1 호출 (PyInstaller onedir)
#   2) dist\digix-collector\ 폴더 → ZIP
#   3) ZIP → ..\downloads\digix-collector.zip
#   4) downloads\collector-version.json 갱신
#   5) git add + commit + push (GitHub Pages 자동 반영)
#
#  실행: powershell -ExecutionPolicy Bypass -File release.ps1
#  또는: release.bat (wrapper) 더블클릭
# =====================================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$work     = $PSScriptRoot
$repo     = Split-Path $PSScriptRoot -Parent
$distRoot = Join-Path $work 'dist'
$srcDir   = Join-Path $distRoot 'digix-collector'
$zipLocal = Join-Path $distRoot 'digix-collector.zip'
$downloads= Join-Path $repo 'downloads'
$zipPub   = Join-Path $downloads 'digix-collector.zip'
$exePub   = Join-Path $downloads 'digix-collector.exe'
$jsonPub  = Join-Path $downloads 'collector-version.json'

Write-Host ""
Write-Host "=== [1/5] EXE 빌드 ===" -ForegroundColor Cyan
& "$PSScriptRoot\build.ps1"
if ($LASTEXITCODE -ne 0) { throw "build.ps1 실패" }
if (-not (Test-Path (Join-Path $srcDir 'digix-collector.exe'))) { throw "EXE 누락" }

Write-Host ""
Write-Host "=== [2/5] ZIP 패키징 ===" -ForegroundColor Cyan
if (Test-Path $zipLocal) { Remove-Item $zipLocal -Force }
Compress-Archive -Path $srcDir -DestinationPath $zipLocal -Force
Write-Host "  created: dist\digix-collector.zip"

Write-Host ""
Write-Host "=== [3/5] downloads 폴더로 복사 ===" -ForegroundColor Cyan
if (-not (Test-Path $downloads)) { New-Item -ItemType Directory -Path $downloads | Out-Null }
Copy-Item $zipLocal $zipPub -Force
Write-Host "  copied: downloads\digix-collector.zip"
if (Test-Path $exePub) {
  Remove-Item $exePub -Force
  Write-Host "  removed legacy onefile EXE"
}

Write-Host ""
Write-Host "=== [4/5] collector-version.json 생성 ===" -ForegroundColor Cyan
$now    = Get-Date
$sizeMb = [math]::Round((Get-Item $zipPub).Length / 1MB, 1)
$info   = [ordered]@{
  version      = $now.ToString('yyyyMMdd-HHmm')
  updated_at   = $now.ToString('yyyy-MM-dd HH:mm')
  filename     = 'digix-collector.zip'
  format       = 'zip'
  size_mb      = $sizeMb
  install_note = 'ZIP 압축을 풀고 digix-collector 폴더 안의 digix-collector.exe 더블클릭'
}
$info | ConvertTo-Json | Set-Content -Encoding UTF8 $jsonPub
Get-Content $jsonPub

Write-Host ""
Write-Host "=== [5/5] git commit + push ===" -ForegroundColor Cyan
Set-Location $repo
& git add downloads\digix-collector.zip downloads\collector-version.json
# 구버전 EXE 가 git 에 있으면 같이 정리 (없으면 무시)
& git rm -f --ignore-unmatch downloads\digix-collector.exe 2>$null

$commitMsg = "deploy: 카운터 수집기 ZIP 자동 배포 ($($now.ToString('yyyy-MM-dd HH:mm')))"
& git commit -m $commitMsg
if ($LASTEXITCODE -ne 0) {
  Write-Host "  (변경사항 없음 — push 만 시도)"
}
& git push origin main
if ($LASTEXITCODE -ne 0) { throw "git push 실패" }

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " 배포 완료 — GitHub Pages 반영까지 약 1~2분" -ForegroundColor Green
Write-Host "  https://hanbyeolsystem.github.io/asms-digix/" -ForegroundColor Green
Write-Host "  → 임대거래처 또는 장비관리 페이지의 '고객 카운터프로그램 (ZIP)' 버튼" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
