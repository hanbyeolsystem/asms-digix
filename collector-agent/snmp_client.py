"""
SNMP 호출 추상화 (puresnmp 래핑).
- 라이브러리 교체 시 이 파일만 갈아끼우면 된다.
- get / get_many 두 함수만 외부에 노출.
"""
import asyncio
import threading
import logger

# 모듈-레벨 lock — puresnmp 의 UDP source port 가 동시 호출 시 race 로
# 응답을 흘리는 버그가 PyInstaller frozen 환경에서 더 자주 발생.
# 모든 SNMP 호출을 시리얼화하면 100% 안정. 1회 폴링 = 5분 주기라
# 시리얼이어도 충분히 빠름 (3대 × ~0.5s = 2초).
_SNMP_LOCK = threading.Lock()

# 단일 이벤트 루프 재사용 — _get_loop().run_until_complete() 매번 새 loop 만들 때
# frozen 환경에서 UDP source port cleanup 지연으로 다음 호출 응답 흘림.
_LOOP = None


def _get_loop():
    global _LOOP
    if _LOOP is None or _LOOP.is_closed():
        _LOOP = asyncio.new_event_loop()
    return _LOOP

try:
    from puresnmp import Client, V2C, V1, PyWrapper  # noqa
    _HAS_PURESNMP = True
except Exception as e:
    _HAS_PURESNMP = False
    logger.log(f'[snmp] puresnmp import 실패: {e}')


def _decode(value):
    """puresnmp 응답을 단순 str/int 로 변환."""
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        try:
            return value.decode('utf-8', errors='replace').strip('\x00').strip()
        except Exception:
            return None
    if isinstance(value, (int, float)):
        return value
    s = str(value)
    return s


async def _get_async(ip: str, community: str, oid: str, timeout: float, version: str = 'v2c'):
    # puresnmp 2.x: Client(ip, credentials, port=161, ...) — timeout 인자 없음.
    # 외부에서 asyncio.wait_for 로 강제 타임아웃 적용.
    creds = V1(community) if version == 'v1' else V2C(community)
    client = PyWrapper(Client(ip, creds))
    try:
        v = await asyncio.wait_for(client.get(oid), timeout=timeout)
        return _decode(v)
    except (asyncio.TimeoutError, Exception):
        return None


def get(ip: str, oid: str, community: str = 'public', timeout: float = 2.0, retries: int = 1):
    """단일 OID GET. 실패/타임아웃 시 None 반환.
    동시 SNMP UDP race 가 있어 1회 retry. v2c 실패 시 v1 도 시도.
    _SNMP_LOCK 으로 시리얼화 — frozen EXE 안정성 위해."""
    if not _HAS_PURESNMP:
        return None
    with _SNMP_LOCK:
        for version in ('v2c', 'v1'):
            for _ in range(max(1, retries + 1)):
                try:
                    v = _get_loop().run_until_complete(_get_async(ip, community, oid, timeout, version))
                except Exception:
                    v = None
                if v is not None:
                    return v
    return None


def get_many(ip: str, oids: dict, community: str = 'public', timeout: float = 2.0) -> dict:
    """{key: oid} 여러 개를 순차 GET. 결과는 {key: value|None}."""
    out = {}
    for k, oid in oids.items():
        out[k] = get(ip, oid, community, timeout)
    return out


# ===== walk =====
async def _walk_async(ip: str, community: str, base_oid: str, timeout: float,
                       max_rows: int = 50, version: str = 'v2c'):
    creds = V1(community) if version == 'v1' else V2C(community)
    client = PyWrapper(Client(ip, creds))
    out = []
    try:
        async def _do():
            async for binding in client.walk(base_oid):
                v = binding.value
                if isinstance(v, (bytes, bytearray)):
                    try: v = v.decode('utf-8', errors='replace').strip('\x00').strip()
                    except Exception: v = None
                out.append((str(binding.oid), v))
                if len(out) >= max_rows:
                    break
        await asyncio.wait_for(_do(), timeout=timeout)
    except (asyncio.TimeoutError, Exception):
        pass
    return out


def walk(ip: str, base_oid: str, community: str = 'public', timeout: float = 5.0,
         max_rows: int = 50):
    """SNMP walk. (oid, value) 리스트 반환. v2c → v1 폴백.
    _SNMP_LOCK 으로 시리얼화."""
    if not _HAS_PURESNMP:
        return []
    with _SNMP_LOCK:
        for version in ('v2c', 'v1'):
            try:
                res = _get_loop().run_until_complete(_walk_async(ip, community, base_oid, timeout, max_rows, version))
                if res:
                    return res
            except Exception:
                pass
    return []


# ===== 토너 동적 매핑 =====
# prtMarkerSupplies 표준 트리
_SUP_DESCR = '1.3.6.1.2.1.43.11.1.1.6'   # 라벨
_SUP_LEVEL = '1.3.6.1.2.1.43.11.1.1.9'   # 잔량
_SUP_MAX   = '1.3.6.1.2.1.43.11.1.1.8'   # 최대

# 라벨 → 색상 키워드 (대문자 매칭)
_COLOR_PATTERNS = [
    ('y', ['YELLOW', 'YEL ', 'YEL.']),
    ('m', ['MAGENTA', 'MGT', 'MAG ', 'MAG.']),
    ('c', ['CYAN', 'CYN ', 'CYN.']),
    ('k', ['BLACK', 'BLK ', 'BLK.', 'MONO']),
]


def _color_from_label(label: str) -> str | None:
    """토너 라벨에서 색상 추론. Kyocera 'TK-5244KC' → 'c' / HP 'Cyan Cartridge' → 'c' 등."""
    if not label:
        return None
    s = str(label).upper()
    for key, patterns in _COLOR_PATTERNS:
        for p in patterns:
            if p in s:
                return key
    # Kyocera 패턴: 'TK-5244-KC' 또는 'TK-5244KC' 등 — 끝부분 KC/KM/KY/KK
    # 단 'BLK'/'BLACK' 같은 게 우선이라 위에서 안 잡힌 케이스
    m = s.rstrip('. -')
    for suffix, key in [('KC', 'c'), ('KM', 'm'), ('KY', 'y'), ('KK', 'k')]:
        if m.endswith(suffix):
            return key
    # 단일 글자 K/C/M/Y 끝 (예: 'Toner C', 'Cart-Y')
    last = m[-1:]
    if last in ('K', 'C', 'M', 'Y'):
        return {'K': 'k', 'C': 'c', 'M': 'm', 'Y': 'y'}[last]
    return None


def kyocera_function_counters(ip: str, community: str = 'public', timeout: float = 5.0) -> dict:
    """Kyocera/Sindoh 의 기능별 흑백/컬러 카운터 합산.

    KMPRINTERMIB OID: 1.3.6.1.4.1.1347.42.3.1.2.1.1.{function}.{color}
      function: 1=Print, 2=Copy, 3=(스캐너/기타), 4=Fax, 5+ ...
      color:    1=Black & White, 2=Color

    모든 function 의 흑백/컬러를 합산해 디스플레이의
    '합계 흑백 / 합계 컬러' 와 동일한 값을 만든다.
    """
    rows = walk(ip, '1.3.6.1.4.1.1347.42.3.1.2.1.1', community, timeout, max_rows=80)
    bw, color = 0, 0
    seen_bw, seen_color = False, False
    for oid, v in rows:
        try:
            parts = str(oid).split('.')
            color_idx = int(parts[-1])
            val = int(v) if v is not None else 0
        except Exception:
            continue
        if color_idx == 1:
            # color_idx 1 = Black & White (Mono)
            bw += val
            seen_bw = True
        else:
            # color_idx 2,3,4... = Single Color / Full Color / 기타 색상 — 모두 컬러로 합산
            color += val
            seen_color = True
    return {
        'bw':    bw    if seen_bw    else None,
        'color': color if seen_color else None,
    }


# ===== 프린터 오류 상태 (hrPrinterDetectedErrorState) =====
# RFC 1514 HOST-RESOURCES-MIB. OCTET STRING (2 bytes 권장, 첫 바이트가 비트 플래그).
# 비트 정의 (큰엔디안): 0x80=lowPaper, 0x40=noPaper, 0x20=lowToner, 0x10=noToner,
#                       0x08=doorOpen, 0x04=jammed, 0x02=offline, 0x01=serviceRequested
_HR_PRINTER_DETECTED_ERR = '1.3.6.1.2.1.25.3.5.1.2.1'

_HR_ERR_BITS = [
    (0x80, '용지부족'),
    (0x40, '용지없음'),
    (0x20, '토너부족'),
    (0x10, '토너없음'),
    (0x08, '도어열림'),
    (0x04, '용지걸림'),
    (0x02, '오프라인'),
    (0x01, '서비스요청'),
]


def _to_first_byte(val):
    """SNMP OCTET STRING(1~2바이트) → 비트 플래그 정수.
    puresnmp 가 bytes / str(escape) / int 어느 것으로 돌려줘도 안전 변환."""
    if val is None:
        return None
    try:
        if isinstance(val, int):
            return val & 0xFF
        if isinstance(val, (bytes, bytearray)):
            return val[0] if len(val) else 0
        if isinstance(val, str):
            s = val.strip()
            if s.isdigit():
                return int(s) & 0xFF
            if not s:
                return 0
            # _decode 가 utf-8 로 디코드한 1바이트(예: '\x04') 첫 글자 코드포인트
            return ord(s[0]) & 0xFF
    except Exception:
        return None
    return None


def read_printer_alerts(ip: str, community: str = 'public', timeout: float = 2.0) -> list[str]:
    """프린터 오류 상태 한국어 메시지 리스트.
    표준 hrPrinterDetectedErrorState 비트 디코드. 지원 안 하는 모델은 빈 리스트."""
    val = get(ip, _HR_PRINTER_DETECTED_ERR, community, timeout)
    byte = _to_first_byte(val)
    if byte is None or byte == 0:
        return []
    msgs = []
    for mask, name in _HR_ERR_BITS:
        if byte & mask:
            msgs.append(name)
    return msgs


def read_toner_pct(ip: str, community: str = 'public', timeout: float = 3.0) -> dict:
    """라벨 walk → 색상 추론 → 각 색상의 잔량 % (0~100). 모델/브랜드 무관."""
    out = {'k': None, 'c': None, 'm': None, 'y': None}
    labels = walk(ip, _SUP_DESCR, community, timeout, max_rows=20)
    if not labels:
        return out
    # 각 행의 마지막 인덱스 추출 — 'a.b.c.d.6.1.N' → N
    levels_raw = walk(ip, _SUP_LEVEL, community, timeout, max_rows=20)
    maxs_raw   = walk(ip, _SUP_MAX,   community, timeout, max_rows=20)
    def _by_idx(rows):
        d = {}
        for oid, v in rows:
            try:
                idx = int(str(oid).rsplit('.', 1)[-1])
                d[idx] = v
            except Exception:
                continue
        return d
    levels = _by_idx(levels_raw)
    maxs   = _by_idx(maxs_raw)
    for oid, label in labels:
        try:
            idx = int(str(oid).rsplit('.', 1)[-1])
        except Exception:
            continue
        color = _color_from_label(label)
        if not color:
            continue
        try:
            lv = int(levels.get(idx)) if levels.get(idx) is not None else None
            mx = int(maxs.get(idx))   if maxs.get(idx)   is not None else None
        except (TypeError, ValueError):
            lv, mx = None, None
        if lv is None or mx is None or mx <= 0 or lv < 0:
            continue
        pct = max(0, min(100, round(lv / mx * 100)))
        # 이미 같은 색상 슬롯이 있으면 더 낮은 % 우선 (가장 부족한 것)
        if out[color] is None or pct < out[color]:
            out[color] = pct
    return out
