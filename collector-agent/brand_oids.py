"""
브랜드별 SNMP OID 맵 — ⚠️ 가장 자주 수정되는 파일.

표준 (Printer-MIB, RFC 3805) 은 대부분 동작. 컬러/흑백 분리는 제조사마다 다름.
실 장비에서 안 읽히면 여기 OID 부터 점검하세요.

[참고]
- 표준 총매수: prtMarkerLifeCount 1.3.6.1.2.1.43.10.2.1.4.1.1
- 표준 토너 잔량: prtMarkerSuppliesLevel 1.3.6.1.2.1.43.11.1.1.9.1.{1..N}
- 표준 토너 최대: prtMarkerSuppliesMaxCapacity 1.3.6.1.2.1.43.11.1.1.8.1.{1..N}
  (잔량 % = level/max * 100). -3 은 unknown, -2 는 무한.
"""

# ===== 공통 (표준 MIB) =====
SYS_DESCR    = '1.3.6.1.2.1.1.1.0'
SYS_NAME     = '1.3.6.1.2.1.1.5.0'
HR_DEVICE_DESCR = '1.3.6.1.2.1.25.3.2.1.3.1'   # 모델명 (HostResources-MIB)

STD = {
    'total_pages': '1.3.6.1.2.1.43.10.2.1.4.1.1',
    'model':       HR_DEVICE_DESCR,
    'serial':      '1.3.6.1.2.1.43.5.1.1.17.1',
}

# 토너 잔량 (4색 / 흑백) — 표준
TONER_LEVEL = {
    'k': '1.3.6.1.2.1.43.11.1.1.9.1.1',
    'c': '1.3.6.1.2.1.43.11.1.1.9.1.2',
    'm': '1.3.6.1.2.1.43.11.1.1.9.1.3',
    'y': '1.3.6.1.2.1.43.11.1.1.9.1.4',
}
TONER_MAX = {
    'k': '1.3.6.1.2.1.43.11.1.1.8.1.1',
    'c': '1.3.6.1.2.1.43.11.1.1.8.1.2',
    'm': '1.3.6.1.2.1.43.11.1.1.8.1.3',
    'y': '1.3.6.1.2.1.43.11.1.1.8.1.4',
}

# ===== 브랜드별 enterprise OID (흑백/컬러 분리용) =====
# ⚠️ 아래 OID 들은 일반적인 값이지만 모델에 따라 다를 수 있음.
# 실제 응답이 None/이상값이면 표준 total_pages 만 사용하도록 fallback.
BRANDS = {
    'hp': {
        **STD,
        'bw':    '1.3.6.1.4.1.11.2.3.9.4.2.1.1.16.1.1.1.0',
        'color': '1.3.6.1.4.1.11.2.3.9.4.2.1.1.16.1.1.2.0',
    },
    'canon': {
        **STD,
        'bw':    '1.3.6.1.4.1.1602.1.11.1.3.1.4.301',
        'color': '1.3.6.1.4.1.1602.1.11.1.3.1.4.401',
    },
    'epson': {
        # Epson 일반: 표준 total 만 안정적
        **STD,
    },
    'brother': {
        **STD,
        'bw':    '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.1.1',
        'color': '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.1.2',
    },
    'kyocera': {
        **STD,
        # bw/color 는 snmp_client.kyocera_function_counters() 가 walk 로
        # 기능별(Print/Copy/Fax) × 색상별 합산. 디스플레이 '합계' 행과 일치.
        # 'use_function_counters' 가 True 면 poller 가 함수 호출.
        'use_function_counters': True,
    },
    'samsung': {
        # Samsung 일반: 표준 total + 자체 OID 모델별 상이 — 일단 표준
        **STD,
    },
    'sindoh': {
        # Sindoh 는 Kyocera OEM 인 경우 많음 → 동일 function counters
        **STD,
        'use_function_counters': True,
    },
    'xerox': {
        **STD,
        'bw':    '1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.1',
        'color': '1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.2',
    },
}


def detect_brand(sys_descr: str) -> str | None:
    """sysDescr 응답 텍스트에서 브랜드 추정."""
    s = (sys_descr or '').lower()
    KEYWORDS = [
        ('hewlett-packard', 'hp'),
        ('hewlett packard', 'hp'),
        ('hp', 'hp'),
        ('canon', 'canon'),
        ('epson', 'epson'),
        ('brother', 'brother'),
        ('kyocera', 'kyocera'),
        ('taskalfa', 'kyocera'),
        ('ecosys',   'kyocera'),
        ('samsung', 'samsung'),
        ('sindoh',  'sindoh'),
        ('신도',     'sindoh'),
        ('fuji xerox', 'xerox'),
        ('xerox',   'xerox'),
    ]
    for kw, brand in KEYWORDS:
        if kw in s:
            return brand
    return None


def oids_for(brand: str | None) -> dict:
    if brand and brand in BRANDS:
        return BRANDS[brand]
    return dict(STD)
