"""
설정/토큰 영구 저장.
- 위치: %APPDATA%\\digix-collector\\config.json
- 키:
    token, collector_id          (페어링 후 자동)
    pairing_code                 (override, 미설정 시 'digix')
    snmp_communities  : list[str]  ['public','private','kmcommunity','admin']
    lan_cidrs         : list[str]  ['192.168.1.0/24', ...] (None=자동)
    snmp_timeout      : float       (초)
    autostart         : bool
- 이전 단일 키 (snmp_community, lan_cidr) 도 list 로 자동 흡수.
"""
import os, json

BASE = os.path.join(
    os.environ.get('APPDATA', os.path.expanduser('~')),
    'digix-collector',
)
os.makedirs(BASE, exist_ok=True)

PATH = os.path.join(BASE, 'config.json')

DEFAULTS = {
    'company_name':     '',
    'pairing_code':     '',      # 빈 문자열 = 첫 실행 다이얼로그에서 입력 / 그 외 override
    'snmp_communities': ['public', 'private', 'kmcommunity', 'admin'],
    'lan_cidrs':        None,    # None = 자동 추정 (모든 NIC /24)
    'manual_ips':       [],
    'snmp_timeout':     2.5,
    'autostart':        True,    # 첫 설치 시 Windows 시작 자동실행 기본 ON
    'notify_on_upload': False,   # 폴링/업로드 완료 시 Windows 풍선 알림 (기본 OFF)
    'poll_interval_min': 10,     # 자동 업로드 주기 (분)
}


def _normalize_lists(d: dict) -> dict:
    """이전 키(snmp_community/lan_cidr) → list 키로 흡수.
    값이 None/빈문자열이면 그냥 무시 (None 이 [None] 리스트로 들어가는 사고 방지)."""
    if d.get('snmp_community') and not d.get('snmp_communities'):
        d['snmp_communities'] = [d['snmp_community']]
    if d.get('lan_cidr') and not d.get('lan_cidrs'):
        d['lan_cidrs'] = [d['lan_cidr']]
    # 혹시 lan_cidrs/snmp_communities 안에 None 이 끼어있으면 정리
    if isinstance(d.get('lan_cidrs'), list):
        d['lan_cidrs'] = [c for c in d['lan_cidrs'] if c]
        if not d['lan_cidrs']:
            d['lan_cidrs'] = None
    if isinstance(d.get('snmp_communities'), list):
        d['snmp_communities'] = [c for c in d['snmp_communities'] if c]
        if not d['snmp_communities']:
            d['snmp_communities'] = None
    if isinstance(d.get('manual_ips'), list):
        d['manual_ips'] = [str(ip).strip() for ip in d['manual_ips'] if str(ip).strip()]
    # snmp_timeout floor — 너무 짧으면 동시 UDP race 로 응답 흘림 (실측 ≥2.0s 필요).
    try:
        if d.get('snmp_timeout') is not None and float(d['snmp_timeout']) < 2.0:
            d['snmp_timeout'] = 2.5
    except (TypeError, ValueError):
        d['snmp_timeout'] = 2.5
    return d


def load() -> dict:
    if not os.path.exists(PATH):
        return dict(DEFAULTS)
    try:
        with open(PATH, 'r', encoding='utf-8') as f:
            d = json.load(f)
        d = _normalize_lists(d)
        merged = dict(DEFAULTS)
        merged.update(d)
        return merged
    except Exception:
        return dict(DEFAULTS)


def save(patch: dict) -> None:
    cur = load()
    cur.update(patch or {})
    tmp = PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(cur, f, ensure_ascii=False, indent=2)
    os.replace(tmp, PATH)
