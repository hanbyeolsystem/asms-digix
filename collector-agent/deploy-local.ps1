# ============================================================
# deploy-local.ps1
# 새로 빌드한 collector 를 본 PC 의 설치 위치(%LOCALAPPDATA%\HanbyeolCollector\) 에 자동 교체.
# onefile / onedir 빌드 모두 자동 감지.
#
# 흐름:
#   1) 기존 collector 프로세스 종료
#   2) INSTALL_DIR 백업 → 정리
#   3) 빌드 결과 복사 (onefile: EXE 1개 / onedir: 폴더 전체)
#   4) HKCU Run 자동시작 등록 갱신
#   5) 새 EXE 시작
#
# 사용:
#   PowerShell 에서:  .\deploy-local.ps1
#   옵션:             .\deploy-local.ps1 -NoStart    (자동 시작 X)
#                     .\deploy-local.ps1 -KeepBackup (백업 폴더 보존)
#
# 토큰/설정(%APPDATA%\digix-collector\config.json) 은 건드리지 않음 -> 페어링 유지.
# ============================================================
param(
  [switch]$NoStart,
  [switch]$KeepBackup
)

$ErrorActionPreference = 'Stop'

$DIST_DIR        = Join-Path $PSScriptRoot 'dist'
$SRC_ONEDIR      = Join-Path $DIST_DIR 'digix-collector'
$SRC_ONEFILE_EXE = Join-Path $DIST_DIR 'digix-collector.exe'
$INSTALL_DIR     = Join-Path $env:LOCALAPPDATA 'HanbyeolCollector'
$INSTALL_EXE     = Join-Path $INSTALL_DIR 'digix-collector.exe'
$RUN_VALUE       = 'HanbyeolCollector'
$BACKUP_DIR      = "$INSTALL_DIR.bak"

function Write-Step($msg) { Write-Host "[deploy] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  OK $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  X $msg" -ForegroundColor Red }

# ===== 0. 빌드 모드 자동 감지 =====
Write-Step '빌드 결과 확인'
$mode = $null
# 우선순위: onedir 폴더 -> onefile EXE (onedir 이 더 정합성 있음)
if ((Test-Path $SRC_ONEDIR) -and (Test-Path (Join-Path $SRC_ONEDIR 'digix-collector.exe'))) {
  $mode = 'onedir'
  Write-OK "onedir 빌드 감지: $SRC_ONEDIR"
} elseif (Test-Path $SRC_ONEFILE_EXE) {
  $mode = 'onefile'
  $exeInfo = Get-Item $SRC_ONEFILE_EXE
  Write-OK "onefile 빌드 감지: $SRC_ONEFILE_EXE ($([math]::Round($exeInfo.Length/1MB,1))MB)"
} else {
  Write-Err "빌드 결과가 없습니다. build.bat (onefile) 또는 build-onedir.bat 먼저 실행하세요."
  exit 1
}

# ===== 1. 기존 프로세스 종료 =====
Write-Step '실행 중인 collector 프로세스 종료'
$killed = 0
Get-Process -Name 'digix-collector' -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Stop-Process -Id $_.Id -Force -ErrorAction Stop
    Write-OK "PID=$($_.Id) 종료"
    $killed++
  } catch {
    Write-Warn2 "PID=$($_.Id) 종료 실패: $($_.Exception.Message)"
  }
}
if ($killed -eq 0) { Write-OK '실행 중인 프로세스 없음' }
Start-Sleep -Milliseconds 800

# ===== 2. 기존 INSTALL_DIR 백업 → 정리 =====
Write-Step 'INSTALL_DIR 백업 및 정리'
if (Test-Path $INSTALL_DIR) {
  if (Test-Path $BACKUP_DIR) {
    Remove-Item $BACKUP_DIR -Recurse -Force -ErrorAction SilentlyContinue
  }
  try {
    Rename-Item -Path $INSTALL_DIR -NewName "$(Split-Path $BACKUP_DIR -Leaf)" -ErrorAction Stop
    Write-OK "백업: $BACKUP_DIR"
  } catch {
    Write-Warn2 "rename 실패 - in-place 정리 시도"
    try {
      Remove-Item "$INSTALL_DIR\*" -Recurse -Force -ErrorAction Stop
      Write-OK '기존 내용 삭제됨 (백업 없음)'
    } catch {
      Write-Err "정리 실패: $($_.Exception.Message)"
      Write-Err "직접 폴더 정리 후 재시도하세요: $INSTALL_DIR"
      exit 1
    }
  }
}
New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null

# ===== 3. 빌드 결과 복사 =====
Write-Step "빌드 결과 복사 ($mode)"
try {
  if ($mode -eq 'onedir') {
    Copy-Item -Path "$SRC_ONEDIR\*" -Destination $INSTALL_DIR -Recurse -Force -ErrorAction Stop
    $fileCount = (Get-ChildItem $INSTALL_DIR -Recurse -File).Count
    Write-OK "$fileCount 파일 복사됨"
  } else {
    Copy-Item -Path $SRC_ONEFILE_EXE -Destination $INSTALL_EXE -Force -ErrorAction Stop
    Write-OK "EXE 1개 복사됨"
  }
} catch {
  Write-Err "복사 실패: $($_.Exception.Message)"
  exit 1
}

if (-not (Test-Path $INSTALL_EXE)) {
  Write-Err "복사 후 EXE 없음: $INSTALL_EXE"
  exit 1
}
$exe = Get-Item $INSTALL_EXE
Write-OK "EXE: $([math]::Round($exe.Length/1MB,1))MB mtime=$($exe.LastWriteTime)"

if ($mode -eq 'onedir') {
  $tclOk = Test-Path "$INSTALL_DIR\_internal\_tcl_data"
  $tkOk  = Test-Path "$INSTALL_DIR\_internal\_tk_data"
  if (-not $tclOk -or -not $tkOk) {
    Write-Warn2 "_tcl_data=$tclOk / _tk_data=$tkOk - tkinter 다이얼로그가 실패할 수 있습니다."
  } else {
    Write-OK '_tcl_data / _tk_data OK'
  }
}

# ===== 4. HKCU Run 자동시작 등록 =====
Write-Step 'HKCU Run 자동시작 등록'
try {
  Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name $RUN_VALUE -Value "`"$INSTALL_EXE`"" -Type String -Force
  Write-OK "HKCU Run\$RUN_VALUE = $INSTALL_EXE"
} catch {
  Write-Warn2 "autostart 등록 실패: $($_.Exception.Message)"
}

# ===== 5. 새 EXE 시작 =====
if (-not $NoStart) {
  Write-Step '새 collector 시작'
  try {
    Start-Process -FilePath $INSTALL_EXE -WorkingDirectory $INSTALL_DIR
    Start-Sleep -Seconds 1
    $running = Get-Process -Name 'digix-collector' -ErrorAction SilentlyContinue
    if ($running) {
      Write-OK "PID=$($running.Id) 시작됨"
    } else {
      Write-Warn2 '프로세스가 떠 있지 않음 - 수동 더블클릭 권장'
    }
  } catch {
    Write-Warn2 "시작 실패: $($_.Exception.Message) - 수동 실행하세요: $INSTALL_EXE"
  }
} else {
  Write-OK '시작 건너뜀 (-NoStart)'
}

# ===== 6. 백업 정리 (옵션) =====
if (-not $KeepBackup -and (Test-Path $BACKUP_DIR)) {
  try {
    Remove-Item $BACKUP_DIR -Recurse -Force -ErrorAction Stop
    Write-OK "백업 삭제됨: $BACKUP_DIR"
  } catch {
    Write-Warn2 "백업 삭제 실패 (무시 가능): $($_.Exception.Message)"
  }
} elseif ($KeepBackup -and (Test-Path $BACKUP_DIR)) {
  Write-OK "백업 보존: $BACKUP_DIR"
}

Write-Host ''
Write-Host '=== 배포 완료 ===' -ForegroundColor Green
Write-Host "  모드:      $mode"
Write-Host "  설치 위치: $INSTALL_DIR"
Write-Host "  EXE 크기:  $([math]::Round((Get-Item $INSTALL_EXE).Length/1MB,1))MB"
Write-Host "  config:    $env:APPDATA\digix-collector\config.json (보존됨)"
