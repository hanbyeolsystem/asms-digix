"""LAN discovery for SNMP printers and printer-port candidates."""
import concurrent.futures
import ipaddress
import re
import socket
import subprocess

import config
import logger
import snmp_client
from brand_oids import SYS_DESCR

# 2-stage discover:
#  Stage 1) 포트 스캔은 TCP 라 빠르고 안전 — 큰 동시성 OK
#  Stage 2) SNMP 는 UDP 동시 요청이 많으면 puresnmp source port 가 race
#           로 응답 흘림 — 작은 동시성으로 제한
PORT_THREADS = 48
SNMP_THREADS = 4
THREADS = PORT_THREADS  # 하위 호환
PRINTER_PORTS = (9100, 515, 631)
_NO_WINDOW = 0x08000000


def _run(cmd, **kw):
    return subprocess.run(cmd, creationflags=_NO_WINDOW, **kw)


def _check_output(cmd, **kw):
    return subprocess.check_output(cmd, creationflags=_NO_WINDOW, **kw)


def _local_ipv4s_via_hostname() -> list[str]:
    try:
        return [a for a in socket.gethostbyname_ex(socket.gethostname())[2] if not a.startswith('127.')]
    except Exception:
        return []


def _local_ipv4s_via_ipconfig() -> list[str]:
    try:
        out = _check_output(['ipconfig'], stderr=subprocess.DEVNULL, timeout=5, text=True, encoding='cp949')
    except Exception:
        return []
    ips = re.findall(r'IPv4[^\n]*?:\s*([\d.]+)', out)
    return [ip for ip in ips if not ip.startswith('127.')]


def _local_ipv4s_via_udp() -> list[str]:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 53))
        ip = s.getsockname()[0]
        s.close()
        return [ip]
    except Exception:
        return []


def auto_cidrs() -> list[str]:
    seen = set()
    for src in (_local_ipv4s_via_ipconfig(), _local_ipv4s_via_hostname(), _local_ipv4s_via_udp()):
        for ip in src:
            if ip.startswith('169.254.'):
                continue
            seen.add(ip.rsplit('.', 1)[0] + '.0/24')
    return sorted(seen)


def _ping(ip: str, wait_ms: int = 250) -> bool:
    try:
        r = _run(
            ['ping', '-n', '1', '-w', str(wait_ms), ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return r.returncode == 0
    except Exception:
        return False


def _arp_mac(ip: str) -> str | None:
    try:
        out = _check_output(['arp', '-a', ip], stderr=subprocess.DEVNULL, timeout=3, text=True)
        m = re.search(r'([0-9a-f]{2}[-:]){5}[0-9a-f]{2}', out, re.I)
        if m:
            return m.group(0).replace('-', ':').upper()
    except Exception:
        return None
    return None


def _open_printer_ports(ip: str, timeout: float = 0.35) -> list[int]:
    ports = []
    for port in PRINTER_PORTS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect((ip, port))
            ports.append(port)
        except Exception:
            pass
        finally:
            try:
                s.close()
            except Exception:
                pass
    return ports


def _probe(ip: str, communities: list[str], timeout: float, include_ports: bool = True):
    # Port-first discovery is much faster in offices where SNMP is disabled.
    ports = _open_printer_ports(ip) if include_ports else []
    if include_ports and not ports:
        return None

    for comm in communities:
        descr = snmp_client.get(ip, SYS_DESCR, comm, timeout=timeout)
        if descr:
            _ping(ip)
            mac = _arp_mac(ip) or f'NOMAC-{ip}'
            return {
                'ip': ip,
                'mac': mac,
                'sys_descr': str(descr),
                'community': comm,
                'ports': ports,
                'probe': 'snmp',
            }

    if ports:
        _ping(ip)
        mac = _arp_mac(ip) or f'NOMAC-{ip}'
        return {
            'ip': ip,
            'mac': mac,
            'sys_descr': f'Printer port candidate: {",".join(map(str, ports))}',
            'community': 'PORT',
            'ports': ports,
            'probe': 'port',
        }
    return None


def _clean(lst):
    return [str(x).strip() for x in (lst or []) if str(x).strip()]


def _snmp_only(ip: str, communities: list[str], timeout: float):
    """SNMP probe only (포트 검사 없이). 시리얼-친화. Stage 2 에서 사용."""
    for comm in communities:
        descr = snmp_client.get(ip, SYS_DESCR, comm, timeout=timeout)
        if descr:
            _ping(ip)
            mac = _arp_mac(ip) or f'NOMAC-{ip}'
            return {
                'ip':         ip,
                'mac':        mac,
                'sys_descr':  str(descr),
                'community':  comm,
            }
    return None


def _port_only(ip: str, ports: list[int]) -> dict:
    """SNMP 응답 없고 포트만 응답한 경우의 결과."""
    _ping(ip)
    mac = _arp_mac(ip) or f'NOMAC-{ip}'
    return {
        'ip':         ip,
        'mac':        mac,
        'sys_descr':  f'Printer port candidate: {",".join(map(str, ports))}',
        'community':  'PORT',
        'ports':      ports,
        'probe':      'port',
    }


def arp_table() -> list[dict]:
    try:
        out = _check_output(['arp', '-a'], stderr=subprocess.DEVNULL, timeout=5, text=True, encoding='cp949')
    except Exception as e:
        logger.log(f'[discover] arp -a failed: {e}')
        return []
    rows = []
    for line in out.splitlines():
        m = re.search(r'\s(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F\-:]{11,17})\s+(\S+)', line)
        if not m:
            continue
        ip, mac, kind = m.group(1), m.group(2).replace('-', ':').upper(), m.group(3)
        if ip.endswith('.255') or ip.startswith('224.') or ip.startswith('239.'):
            continue
        rows.append({'ip': ip, 'mac': mac, 'kind': kind})
    return rows


def _expand_target(target: str) -> list[str]:
    target = str(target).strip()
    if not target:
        return []
    if target.endswith('.*'):
        prefix = target[:-2]
        if len(prefix.split('.')) == 3:
            return [f'{prefix}.{last}' for last in range(1, 255)]
    m = re.match(r'^(\d+\.\d+\.\d+\.)(\d+)-(\d+)$', target)
    if m:
        prefix, start, end = m.group(1), int(m.group(2)), int(m.group(3))
        start, end = max(1, start), min(254, end)
        if start <= end:
            return [f'{prefix}{last}' for last in range(start, end + 1)]
    if '/' in target:
        return [str(ip) for ip in ipaddress.IPv4Network(target, strict=False).hosts()]
    return [str(ipaddress.IPv4Address(target))]


def _expand_hosts(scan_targets: list[str] | None, manual_ips: list[str] | None = None) -> list[str]:
    hosts = []
    for target in (manual_ips or []) + (scan_targets or []):
        try:
            hosts.extend(_expand_target(target))
        except Exception as e:
            logger.log(f'[discover] invalid scan target {target}: {e}')
    return list(dict.fromkeys(hosts))


def ping_sweep(cidrs: list[str]) -> int:
    targets = _expand_hosts(cidrs)
    if not targets:
        return 0
    alive = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
        for ok in ex.map(_ping, targets):
            if ok:
                alive += 1
    return alive


def scan(
    cidrs: list[str] | None = None,
    communities: list[str] | None = None,
    timeout: float | None = None,
    manual_ips: list[str] | None = None,
    include_ports: bool = True,
    progress=None,
    manual_only: bool = False,
) -> list[dict]:
    cfg = config.load()
    if manual_only:
        # 찾기 버튼 — manual_ips 만 점검. lan_cidrs 폴백 금지.
        cidrs = []
    else:
        cidrs = _clean(cidrs) or _clean(cfg.get('lan_cidrs')) or auto_cidrs()
    communities = _clean(communities) or _clean(cfg.get('snmp_communities')) or ['public']
    timeout = timeout if timeout is not None else cfg.get('snmp_timeout', 1.0)
    manual_ips = _clean(manual_ips) or _clean(cfg.get('manual_ips'))

    if not cidrs and not manual_ips:
        logger.log('[discover] no scan target')
        return []

    hosts = _expand_hosts(cidrs, manual_ips)
    logger.log(
        f'[discover] scan targets={cidrs} manual_ips={manual_ips} hosts={len(hosts)} '
        f'communities={communities} timeout={timeout}s include_ports={include_ports}'
    )
    if progress:
        progress({'event': 'start', 'total': len(hosts), 'cidrs': cidrs, 'manual_ips': manual_ips})

    found = []
    if include_ports:
        # Stage 1: 포트 스캔만 — 큰 동시성
        port_results = {}  # ip → list[int]
        with concurrent.futures.ThreadPoolExecutor(max_workers=PORT_THREADS) as ex:
            futs = {ex.submit(_open_printer_ports, ip): ip for ip in hosts}
            done = 0
            for fut in concurrent.futures.as_completed(futs):
                ip = futs[fut]
                done += 1
                try:
                    ports = fut.result()
                    if ports:
                        port_results[ip] = ports
                except Exception:
                    pass
                if progress:
                    progress({'event': 'progress', 'done': done, 'total': len(hosts), 'ip': ip})
        logger.log(f'[discover] stage1 port scan: {len(port_results)} candidates / {len(hosts)} hosts')

        # Stage 2: SNMP probe — 작은 동시성 (UDP race 방지)
        # 결과가 나오는 즉시 progress({'event': 'snmp_found', ...}) 로 흘려보내
        # scan_ui 가 실시간으로 목록에 추가할 수 있게 함.
        snmp_done = {}  # ip → snmp result
        snmp_idx = 0
        snmp_total = len(port_results)
        with concurrent.futures.ThreadPoolExecutor(max_workers=SNMP_THREADS) as ex:
            futs = {ex.submit(_snmp_only, ip, communities, timeout): ip for ip in port_results}
            for fut in concurrent.futures.as_completed(futs):
                ip = futs[fut]
                snmp_idx += 1
                try:
                    r = fut.result()
                    if r:
                        snmp_done[ip] = r
                        if progress:
                            emit = dict(r)
                            emit['ports'] = port_results.get(ip, [])
                            emit['probe'] = 'snmp'
                            progress({
                                'event': 'snmp_found',
                                'device': emit,
                                'done': snmp_idx,
                                'total': snmp_total,
                            })
                except Exception as e:
                    logger.log(f'[discover] snmp probe failed for {ip}: {e}')
        logger.log(f'[discover] stage2 snmp probe: {len(snmp_done)} / {len(port_results)} candidates')

        # 합치기: SNMP 응답 받은 건 'snmp', 포트만 있는 건 'port'
        for ip, ports in port_results.items():
            if ip in snmp_done:
                r = snmp_done[ip]
                r['ports'] = ports
                r['probe'] = 'snmp'
                found.append(r)
            else:
                found.append(_port_only(ip, ports))
    else:
        # include_ports=False 인 경우 기존 단일 probe (SNMP-only, 작은 동시성)
        with concurrent.futures.ThreadPoolExecutor(max_workers=SNMP_THREADS) as ex:
            futs = {ex.submit(_probe, ip, communities, timeout, False): ip for ip in hosts}
            for fut in concurrent.futures.as_completed(futs):
                try:
                    r = fut.result()
                    if r:
                        found.append(r)
                except Exception:
                    pass

    found.sort(key=lambda d: tuple(int(x) for x in d['ip'].split('.')))
    logger.log(f'[discover] found {len(found)} device(s) / {len(hosts)} hosts')
    if progress:
        progress({'event': 'done', 'done': len(hosts), 'total': len(hosts), 'found': found})
    return found
