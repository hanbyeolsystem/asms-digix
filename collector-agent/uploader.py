"""
디직스 Supabase Edge Function 호출.
- pair():     페어링 코드로 token 발급
- register(): scan_ui 의 "선택 항목 업로드" 가 호출 — 체크된 장비를 장비관리에 등록
- submit():   5분 폴링 결과 업로드 (등록된 장비만 readings 저장됨)
URL/스키마는 [[project_rental_equipment]] / docs/COLLECTOR_API.md 참고.
"""
import requests

FN_BASE = 'https://wghjnlhfqypamiwukeio.supabase.co/functions/v1'
TIMEOUT_PAIR     = 15
TIMEOUT_SUBMIT   = 30
TIMEOUT_REGISTER = 30


def pair(code: str, pc_name: str, os_user: str, agent_version: str) -> dict:
    r = requests.post(
        f'{FN_BASE}/pair-collector',
        json={
            'pairing_code':  code,
            'pc_name':       pc_name,
            'os_user':       os_user,
            'agent_version': agent_version,
        },
        timeout=TIMEOUT_PAIR,
    )
    if r.status_code != 200:
        try:
            msg = r.json().get('error', r.text)
        except Exception:
            msg = r.text
        raise RuntimeError(f'pair failed [{r.status_code}]: {msg}')
    return r.json()


def submit(token: str, devices: list, readings: list) -> dict:
    """백그라운드 폴링(5분) 정기 업로드.
    응답: { ok, devices_updated, readings_inserted, readings_skipped, unregistered_macs }
    등록되지 않은 장비의 readings 는 서버에서 폐기됨.
    """
    r = requests.post(
        f'{FN_BASE}/submit-reading',
        headers={
            'authorization': f'Bearer {token}',
            'content-type':  'application/json',
        },
        json={'devices': devices, 'readings': readings},
        timeout=TIMEOUT_SUBMIT,
    )
    if r.status_code != 200:
        try:
            msg = r.json().get('error', r.text)
        except Exception:
            msg = r.text
        raise RuntimeError(f'submit failed [{r.status_code}]: {msg}')
    return r.json()


def register(token: str, devices: list, readings: list) -> dict:
    """scan_ui 의 "선택 항목 업로드" 가 호출 — 체크된 장비를 장비관리에 등록.

    응답: {
      ok, collector_id,
      newly_registered:    N,   # 처음 등록된 장비
      already_registered:  M,   # 이미 등록되어 있던 장비 (중복 차단)
      readings_inserted:   K,
      registered_macs:     [...]
    }
    """
    r = requests.post(
        f'{FN_BASE}/register-devices',
        headers={
            'authorization': f'Bearer {token}',
            'content-type':  'application/json',
        },
        json={'devices': devices, 'readings': readings},
        timeout=TIMEOUT_REGISTER,
    )
    if r.status_code != 200:
        try:
            msg = r.json().get('error', r.text)
        except Exception:
            msg = r.text
        raise RuntimeError(f'register failed [{r.status_code}]: {msg}')
    return r.json()
