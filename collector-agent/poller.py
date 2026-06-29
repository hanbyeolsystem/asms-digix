"""Printer polling and upload orchestration."""
import gc
import time
import traceback

import brand_oids as B
import config
import discover
import logger
import snmp_client
import system_utils
import uploader
import usb_printers

POLL_INTERVAL_SEC = 10 * 60  # 기본 10분, config 'poll_interval_min' 으로 override


def _int(v):
    if v is None:
        return None
    try:
        return int(v)
    except Exception:
        try:
            return int(float(v))
        except Exception:
            return None


def _pct(level, max_):
    l, m = _int(level), _int(max_)
    if l is None or m is None or m <= 0 or l < 0:
        return None
    return max(0, min(100, round(l / m * 100)))


def collect_one(dev: dict) -> tuple[dict, dict]:
    if dev.get('community') == 'PORT' or dev.get('probe') == 'port':
        ports = ','.join(map(str, dev.get('ports') or []))
        device = {
            'mac': dev['mac'],
            'ip': dev['ip'],
            'manufacturer': None,
            'model': f'Network printer candidate ({ports})' if ports else 'Network printer candidate',
            'serial_snmp': None,
            'is_color': None,
        }
        reading = {
            'mac': dev['mac'],
            'bw': None,
            'color': None,
            'total_pages': None,
            'toner_k': None,
            'toner_c': None,
            'toner_m': None,
            'toner_y': None,
            'alert_text': 'Detected by printer TCP port. Enable SNMP for page counters.',
        }
        return device, reading

    brand = B.detect_brand(dev.get('sys_descr', ''))
    oids = B.oids_for(brand)
    comm = dev.get('community') or 'public'

    # use_function_counters 플래그(Kyocera/Sindoh) 가 있으면 단순 get 으로
    # bw/color 가져오는 대신 walk 기반 기능별 합산 함수 사용 → 디스플레이
    # '합계' 행과 동일. 그 외 브랜드는 static OID get_many.
    use_funcs = bool(oids.get('use_function_counters'))
    fetch_oids = {k: v for k, v in oids.items()
                  if k not in ('use_function_counters', 'bw', 'color', 'color_single')}
    main = snmp_client.get_many(dev['ip'], fetch_oids, community=comm)

    if use_funcs:
        funcs = snmp_client.kyocera_function_counters(dev['ip'], community=comm, timeout=5.0)
        bw_val    = funcs.get('bw')
        color_val = funcs.get('color')
    else:
        # 다른 브랜드: 단순 OID get
        bw_oid = oids.get('bw')
        co_oid = oids.get('color')
        if bw_oid:
            bw_val = _int(snmp_client.get(dev['ip'], bw_oid, community=comm))
        else:
            bw_val = None
        if co_oid:
            color_val = _int(snmp_client.get(dev['ip'], co_oid, community=comm))
        else:
            color_val = None

    is_color = color_val is not None and color_val > 0

    # 토너 잔량 — 라벨 walk 기반 동적 매핑 (모델/슬롯 순서 무관)
    toner = snmp_client.read_toner_pct(dev['ip'], community=comm, timeout=3.0)

    # 프린터 오류 상태 — hrPrinterDetectedErrorState 비트 디코드 (용지걸림/에러 등)
    # 표준 미지원 모델은 빈 리스트 → alert_text=None (UI 에 배지 미표시)
    try:
        alerts = snmp_client.read_printer_alerts(dev['ip'], community=comm, timeout=2.0)
    except Exception:
        alerts = []
    alert_text = ', '.join(alerts) if alerts else None

    device = {
        'mac': dev['mac'],
        'ip': dev['ip'],
        'manufacturer': brand,
        'model': str(main.get('model') or '').strip() or None,
        'serial_snmp': str(main.get('serial') or '').strip() or None,
        'is_color': bool(is_color),
    }
    # total_pages = 흑백 + 컬러 합계 ('합계매수').
    # 표준 prtMarkerLifeCount 는 모델별로 산정 기준이 달라 디스플레이의
    # 합계와 안 맞는 케이스 다수 — bw+color 가 더 신뢰 가능.
    if bw_val is not None or color_val is not None:
        total_val = (bw_val or 0) + (color_val or 0)
    else:
        total_val = _int(main.get('total_pages'))

    reading = {
        'mac': dev['mac'],
        'bw': bw_val,
        'color': color_val,
        'total_pages': total_val,
        'toner_k': toner.get('k'),
        'toner_c': toner.get('c'),
        'toner_m': toner.get('m'),
        'toner_y': toner.get('y'),
        'alert_text': alert_text,
    }
    return device, reading


def collect_batch(devices_raw: list[dict], include_usb: bool = True) -> dict:
    """Create an upload-ready batch without sending it."""
    devices, readings, samples = [], [], []

    if include_usb:
        try:
            usb_devs, usb_reads = usb_printers.to_devices_and_readings()
            reads_by_mac = {r.get('mac'): r for r in usb_reads}
            for d in usb_devs:
                devices.append(d)
                r = reads_by_mac.get(d.get('mac')) or {}
                samples.append({
                    'ip': d.get('serial_snmp') or 'USB',
                    'community': 'USB',
                    'brand': d.get('manufacturer'),
                    'model': d.get('model'),
                    'total_pages': r.get('total_pages'),
                    'bw': r.get('bw'),
                    'color': r.get('color'),
                    'toner_k': r.get('toner_k'),
                })
            readings.extend(usb_reads)
            logger.log(f'[poll] USB printers added: {len(usb_devs)}')
        except Exception as e:
            logger.log(f'[poll] USB collection failed: {e}')

    for d in devices_raw:
        try:
            dev, rd = collect_one(d)
            devices.append(dev)
            readings.append(rd)
            samples.append({
                'ip': d.get('ip'),
                'community': d.get('community'),
                'brand': dev.get('manufacturer'),
                'model': dev.get('model'),
                'total_pages': rd.get('total_pages'),
                'bw': rd.get('bw'),
                'color': rd.get('color'),
                'toner_k': rd.get('toner_k'),
            })
        except Exception as e:
            logger.log(f'[poll] collect_one failed for {d.get("ip")}: {e}')

    return {
        'discovered': len(devices_raw),
        'devices': devices,
        'readings': readings,
        'samples': samples,
    }


def submit_batch(batch: dict) -> dict:
    """백그라운드 폴링 — 모든 발견 장비 전송. 서버가 등록된 것만 readings 저장."""
    token = config.load().get('token')
    if not token:
        logger.log('[poll] NO_TOKEN - pairing required')
        return {'error': 'no token'}
    devices = batch.get('devices') or []
    readings = batch.get('readings') or []
    if not devices:
        logger.log('[poll] no devices to submit')
        return {'devices_updated': 0, 'readings_inserted': 0}
    res = uploader.submit(token, devices, readings)
    logger.log(f'[poll] submit ok: {res}')
    return res


def register_batch(batch: dict) -> dict:
    """scan_ui 의 "선택 항목 업로드" 진입점.

    체크된 device + 첫 readings 를 register-devices 로 보내 장비관리에 등록.
    응답: { ok, newly_registered, already_registered, readings_inserted, registered_macs }
    """
    token = config.load().get('token')
    if not token:
        logger.log('[register] NO_TOKEN - pairing required')
        return {'error': 'no token'}
    devices = batch.get('devices') or []
    readings = batch.get('readings') or []
    if not devices:
        logger.log('[register] no devices to register')
        return {'newly_registered': 0, 'already_registered': 0, 'readings_inserted': 0}
    res = uploader.register(token, devices, readings)
    logger.log(f'[register] ok: {res}')
    return res


def run_once() -> dict:
    if not config.load().get('token'):
        logger.log('[poll] NO_TOKEN - pairing required')
        return {'error': 'no token'}

    devices_raw = discover.scan()
    batch = collect_batch(devices_raw)
    summary = {
        'discovered': batch['discovered'],
        'devices': len(batch['devices']),
        'samples': batch['samples'],
    }

    try:
        res = submit_batch(batch)
        if res.get('error'):
            summary['submit_error'] = res['error']
        summary['readings_inserted'] = res.get('readings_inserted', 0)
    except Exception as e:
        logger.log(f'[poll] submit failed: {e}')
        summary['submit_error'] = str(e)

    # 폴링 완료 시 트레이 풍선 알림 (config.notify_on_upload=True 일 때)
    try:
        import tray
        if summary.get('submit_error'):
            tray.notify('⚠ 프린터카운트수집기 업로드 실패', f'에러: {summary["submit_error"][:100]}')
        else:
            n_dev = summary.get('devices', 0)
            n_read = summary.get('readings_inserted', 0)
            tray.notify(
                '✅ 프린터카운트수집기 업로드 완료',
                f'장비 {n_dev}대 · 카운터 {n_read}건 전송됨',
            )
    except Exception as e:
        logger.log(f'[poll] notify failed: {e}')

    return summary


def _current_interval_sec() -> int:
    try:
        m = int(config.load().get('poll_interval_min') or 10)
        return max(60, m * 60)  # 최소 1분 안전 floor
    except Exception:
        return POLL_INTERVAL_SEC


def run_forever():
    logger.log(f'[poll] start (default interval={POLL_INTERVAL_SEC}s)')
    while True:
        try:
            run_once()
        except Exception as e:
            logger.log(f'[poll] loop error: {e}\n{traceback.format_exc()}')
        # 폴링 사이클 후 메모리 회수 — SNMP/HTTP/USB 임시 버퍼 해제
        gc.collect()
        system_utils.trim_working_set()
        interval = _current_interval_sec()
        logger.log(f'[poll] sleep {interval}s')
        time.sleep(interval)
