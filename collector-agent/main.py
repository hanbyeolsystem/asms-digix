"""Entry point for the Digix printer counter collector."""
import os
import sys
import threading
import time

import config
import logger
import system_utils

FIRST_POLL_DELAY_SEC = 10


def _delayed_poll_loop():
    time.sleep(FIRST_POLL_DELAY_SEC)
    import poller  # 지연 import — main 진입 직후 메모리 최소화
    poller.run_forever()


def _is_running_from_install_dir() -> bool:
    """현재 EXE 가 LocalAppData 설치 위치에서 실행 중인지 판정."""
    try:
        import installer
        current = os.path.abspath(sys.executable).lower()
        target  = os.path.abspath(installer.INSTALL_EXE).lower()
        return current == target
    except Exception:
        return False


def _should_auto_install() -> bool:
    """첫 실행 자동 설치 진입 조건:
    1) PyInstaller frozen (EXE 로 실행됨, 개발 중 python main.py 는 제외)
    2) 현재 실행 위치가 INSTALL_EXE 가 아님 (다운로드/바탕화면 등에서 클릭한 경우)
    3) --no-install 인자 없음 (강제 우회용)
    """
    if '--no-install' in sys.argv:
        return False
    if not getattr(sys, 'frozen', False):
        return False
    return not _is_running_from_install_dir()


def main():
    # 명시적 분기 (수동 재설치 옵션 — 기존 호환)
    if '--install' in sys.argv:
        import installer
        sys.exit(installer.run_install())

    # 첫 실행 자동 설치 — 고객이 EXE 더블클릭 한 번으로 설치 완료
    if _should_auto_install():
        logger.log('[main] auto-install (first run from non-install location)')
        import installer
        sys.exit(installer.run_install())

    # 단일 인스턴스 보장 — 이미 실행 중이면 즉시 종료 (2중 실행 방지)
    if not system_utils.acquire_single_instance():
        logger.log('[main] another instance running — exit')
        sys.exit(0)

    logger.log('[main] start')
    cfg = config.load()

    just_installed = False  # 첫 페어링 직후 = 첫 설치 후 첫 실행
    if not cfg.get('token'):
        import pairing  # 지연 import — 페어링 완료된 일반 실행에선 tkinter 안 로드
        ok = pairing.run_auto()
        if not ok:
            logger.log('[main] pairing failed; exit')
            sys.exit(0)
        just_installed = True

    t = threading.Thread(target=_delayed_poll_loop, daemon=True)
    t.start()
    # 폴링 시작 직전 초기 working set 트림 — import 부산물 정리
    system_utils.trim_working_set()

    if just_installed:
        # 첫 설치 직후 — LAN 스캔 창 자동 오픈 + 자동 스캔 시작
        def _open_scan_first():
            time.sleep(1.0)  # 트레이 아이콘 먼저 자리 잡게
            import scan_ui
            try:
                scan_ui.open_scan_window(auto_scan=True)
            finally:
                system_utils.trim_working_set()
        threading.Thread(target=_open_scan_first, daemon=True).start()
        logger.log('[main] first-install scan window scheduled')

    import tray  # 지연 import — 트레이는 EXE 모드에서만 의미 있음
    tray.run()
    logger.log('[main] exit')


if __name__ == '__main__':
    main()
