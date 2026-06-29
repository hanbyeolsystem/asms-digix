"""Windows-only 시스템 유틸 — 단일 인스턴스 락.

가벼움이 중요: 이 모듈은 ctypes 만 쓰고 추가 패키지 의존 없음.
"""
import ctypes
from ctypes import wintypes

import logger

_MUTEX_NAME = 'Global\\HanbyeolCollector_SingleInstance_v1'
_ERROR_ALREADY_EXISTS = 183

# 모듈-레벨 유지 — handle 이 GC 되면 mutex 도 해제되어 의미 상실
_mutex_handle = None


def acquire_single_instance() -> bool:
    """이 프로세스가 유일 인스턴스이면 True, 이미 다른 인스턴스가 떠 있으면 False.
    True 반환 시 핸들을 모듈에 보관 → 프로세스 종료까지 mutex 유지."""
    global _mutex_handle
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        h = kernel32.CreateMutexW(None, False, _MUTEX_NAME)
        last_err = ctypes.GetLastError()
        if not h:
            logger.log(f'[single-inst] CreateMutex 실패 err={last_err} — 진행 허용')
            return True  # mutex 못 만들면 차단하지 않음 (안전 fallback)
        if last_err == _ERROR_ALREADY_EXISTS:
            logger.log('[single-inst] 이미 실행 중 — 종료')
            kernel32.CloseHandle(h)
            return False
        _mutex_handle = h
        return True
    except Exception as e:
        logger.log(f'[single-inst] 예외(무시): {e}')
        return True


def trim_working_set() -> None:
    """과거 EmptyWorkingSet 호출이 있었으나 안랩 Safe Transaction
    "메모리 조작" 휴리스틱 오탐 회피를 위해 2026-06-17 제거.
    호출처 호환 위해 no-op 로 유지 — gc.collect() 가 충분히 대체."""
    return
