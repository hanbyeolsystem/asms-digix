"""
이 PC 에 직접 연결된 (USB/LPT/공유) 프린터 수집.
- PowerShell Get-Printer / Win32_Printer 사용 (외부 의존 0, Windows 10+ 기본)
- 정확한 누적 페이지 카운터는 SNMP 가 아니면 OS 가 알지 못함.
  WMI 의 JobCountSinceLastReset 은 '재부팅 후 작업 수' — 참고 지표.
- device.mac 대용 키: 'USB:<HOSTNAME>:<PRINTERNAME>' (DB unique 보장용)
"""
import socket, json, subprocess
import logger

_NO_WINDOW = 0x08000000  # subprocess.CREATE_NO_WINDOW

PS_QUERY = r"""
# Force UTF-8 stdout so Python can decode Korean printer names correctly.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'SilentlyContinue'

# Bulk fetch — N+1 쿼리 제거. 각 클래스 1회만 호출.
$wmis = @{}
Get-CimInstance Win32_Printer | ForEach-Object { $wmis[$_.Name] = $_ }

# Performance counter: 부팅 후 누적 페이지 수 (TotalPagesPrinted, TotalJobsPrinted).
# 일부 시스템에서 느릴 수 있어 try/catch — 실패해도 기본 정보는 계속.
$perf = @{}
try {
    Get-CimInstance Win32_PerfFormattedData_Spooler_PrintQueue -ErrorAction Stop | ForEach-Object {
        $perf[$_.Name] = $_
    }
} catch {
    # perf counter 미동작 — 그냥 비워둠
}

$out = @()
Get-Printer | ForEach-Object {
    $p   = $_
    $wmi = $wmis[$p.Name]
    $pc  = $perf[$p.Name]
    $out += [PSCustomObject]@{
        name        = $p.Name
        port        = $p.PortName
        driver      = $p.DriverName
        type        = $p.Type.ToString()
        printer_state = $p.PrinterStatus.ToString()
        is_local    = if ($wmi) { $wmi.Local }    else { $null }
        is_network  = if ($wmi) { $wmi.Network }  else { $null }
        is_shared   = if ($wmi) { $wmi.Shared }   else { $null }
        work_offline = if ($wmi) { $wmi.WorkOffline } else { $null }
        jobs_since_reset    = if ($wmi) { $wmi.JobCountSinceLastReset } else { $null }
        total_pages_printed = if ($pc)  { [int64]$pc.TotalPagesPrinted } else { $null }
        total_jobs_printed  = if ($pc)  { [int64]$pc.TotalJobsPrinted  } else { $null }
        jobs_in_queue       = if ($pc)  { [int]$pc.Jobs } else { $null }
        status_code         = if ($wmi) { $wmi.PrinterStatus } else { $null }
    }
}
$out | ConvertTo-Json -Compress -Depth 3
"""


def _hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return 'PC'


def list_local() -> list[dict]:
    """이 PC 의 모든 프린터. type 또는 is_local/is_network 로 USB 여부 추정."""
    try:
        out = subprocess.check_output(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_QUERY],
            stderr=subprocess.DEVNULL,
            timeout=40,
            text=True,
            encoding='utf-8',
            errors='replace',
            creationflags=_NO_WINDOW,
        )
    except Exception as e:
        logger.log(f'[usb] PowerShell 실패: {e}')
        return []
    out = (out or '').strip()
    if not out:
        return []
    try:
        data = json.loads(out)
    except Exception as e:
        logger.log(f'[usb] JSON 파싱 실패: {e}')
        return []
    if isinstance(data, dict):
        data = [data]
    return data


def _is_virtual_printer(name: str, port_u: str, driver: str) -> bool:
    """Windows 가상/시스템 프린터 판별 (PDF/XPS/OneNote/Fax 등 — 카운터 의미 없음)."""
    n = (name or '').lower()
    d = (driver or '').lower()
    # 포트 기반 — 가상 출력은 거의 모두 특수 포트명 사용
    virtual_ports = ('PORTPROMPT:', 'NUL:', 'FILE:', 'XPSPORT:', 'SHRFAX:')
    if port_u in virtual_ports:
        return True
    if port_u.startswith('ONENOTE') or port_u.startswith('MICROSOFT.OFFICE') \
       or port_u.startswith('WPDBUSENUMROOT'):
        return True
    # 이름/드라이버 기반 — Windows 기본 가상 프린터
    virtual_keywords = (
        'microsoft print to pdf',
        'microsoft xps document writer',
        'send to onenote',
        'onenote (desktop)',
        'onenote for windows 10',
        'fax',
        'snagit',          # 캡처 툴 가상 프린터
        'foxit reader pdf',
        'cute pdf', 'cutepdf',
        'pdfcreator',
        'doPDF', 'do pdf',
    )
    for kw in virtual_keywords:
        if kw in n or kw in d:
            return True
    return False


def to_devices_and_readings() -> tuple[list[dict], list[dict]]:
    """SNMP 결과와 같은 스키마로 변환 — uploader.submit 에 그대로 사용.

    활성/실물 로컬 프린터만 통과 — 가상(PDF/XPS/OneNote/Fax) 및 오프라인 항목 제외.
    """
    host = _hostname()
    devices, readings = [], []
    for p in list_local():
        name = (p.get('name') or '').strip()
        if not name:
            continue

        # 네트워크 프린터는 SNMP 가 처리
        if p.get('is_network') is True:
            continue

        port_u = (p.get('port') or '').upper()
        ptype  = (p.get('type') or '').lower()
        driver = (p.get('driver') or '').strip()

        # 가상/시스템 프린터 제외 (PDF/XPS/OneNote/Fax 등)
        if _is_virtual_printer(name, port_u, driver):
            logger.log(f'[usb] skip virtual: {name} (port={port_u})')
            continue

        # 사용자가 오프라인 토글한 항목 제외
        if p.get('work_offline') is True:
            logger.log(f'[usb] skip offline (WorkOffline): {name}')
            continue

        # PrinterStatus=7 (Offline) 제외 — 케이블 빠짐/전원 꺼짐
        # 1=Other, 2=Unknown, 3=Idle, 4=Printing, 5=Warmup, 6=Stopped, 7=Offline
        if p.get('status_code') == 7:
            logger.log(f'[usb] skip offline (status=7): {name}')
            continue

        # 로컬/USB 신호 — WMI is_local / Type='Local' / 포트명에 USB·LPT 중 하나
        is_usb_port = port_u.startswith('USB') or port_u.startswith('LPT') or 'USB' in port_u
        if not (p.get('is_local') or ptype == 'local' or is_usb_port):
            continue
        mac = f'USB:{host}:{name}'[:200]
        devices.append({
            'mac':          mac,
            'ip':           None,
            'manufacturer': 'USB',
            'model':        (p.get('driver') or '').strip() or name,
            'serial_snmp':  (p.get('port') or '').strip() or None,
            'is_color':     None,
        })
        def _ival(v):
            try:
                return int(v) if v is not None else None
            except Exception:
                try:
                    return int(float(v))
                except Exception:
                    return None
        # 우선순위: 부팅 후 누적 페이지 수(perf counter) → 작업 수(WMI fallback)
        total_pages   = _ival(p.get('total_pages_printed'))
        total_jobs    = _ival(p.get('total_jobs_printed'))
        jobs_in_queue = _ival(p.get('jobs_in_queue'))
        jobs_reset    = _ival(p.get('jobs_since_reset'))
        # readings.total_pages 에 실제 페이지 수 우선 채움
        rd_total = total_pages if total_pages is not None else jobs_reset
        alert_parts = ['USB local printer']
        if total_pages is not None:
            alert_parts.append(f'TotalPagesPrinted={total_pages}')
        if total_jobs is not None:
            alert_parts.append(f'TotalJobsPrinted={total_jobs}')
        if jobs_in_queue is not None:
            alert_parts.append(f'queue={jobs_in_queue}')
        readings.append({
            'mac':         mac,
            'bw':          None,
            'color':       None,
            'total_pages': rd_total,
            'toner_k':     None,
            'toner_c':     None,
            'toner_m':     None,
            'toner_y':     None,
            'alert_text':  ' · '.join(alert_parts),
        })
    return devices, readings
