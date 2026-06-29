"""Windows tray UI."""
import ctypes
import os
import sys
import threading

import pystray
from PIL import Image

import config
import logger
import poller
import system_utils
# scan_ui 는 사용자가 메뉴에서 LAN 스캔 열 때만 import — 트레이 상주 모드의 평시
# 메모리 절감 (tkinter / Tcl·Tk 미로드)

MB_OK = 0x00000000
MB_ICONINFORMATION = 0x00000040
MB_ICONWARNING = 0x00000030
MB_ICONERROR = 0x00000010


def _msgbox(text: str, title: str, flags: int = MB_OK | MB_ICONINFORMATION) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(0, text, title, flags)
    except Exception as e:
        logger.log(f'[tray] MessageBox failed: {e}')


# 전역 트레이 아이콘 참조 — poller 가 풍선 알림 띄울 때 사용
_icon = None


def notify(title: str, message: str) -> None:
    """Windows 풍선 알림. 트레이 아이콘 떠 있을 때만 동작."""
    if not _icon:
        return
    if not config.load().get('notify_on_upload', False):
        return
    try:
        _icon.notify(message, title)
    except Exception as e:
        logger.log(f'[tray] notify failed: {e}')


def _resource_path(name: str) -> str:
    """PyInstaller frozen 모드에서는 sys._MEIPASS, 개발 모드에서는 __file__ 기준."""
    if getattr(sys, 'frozen', False):
        base = getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, name)


def _make_icon():
    """디직스코리아 HB 육각형 로고 아이콘 (assets/icon.png) 로드.
    실패 시 폴백으로 단색 정사각."""
    path = _resource_path(os.path.join('assets', 'icon.png'))
    try:
        return Image.open(path)
    except Exception as e:
        logger.log(f'[tray] icon load fail ({path}): {e} — fallback solid')
        return Image.new('RGB', (64, 64), (30, 64, 175))


def _open_log_folder(icon=None, item=None):
    try:
        os.startfile(config.BASE)
    except Exception as e:
        logger.log(f'[tray] open folder failed: {e}')


def _scan_window_async(icon=None, item=None):
    def _open():
        import scan_ui  # 지연 import — tkinter 첫 사용 시 로드
        try:
            scan_ui.open_scan_window()
        finally:
            # 창 닫힌 뒤 working set 트림 — Tk/Tcl 사용 페이지 OS 에 반납
            system_utils.trim_working_set()
    threading.Thread(target=_open, daemon=True).start()


def _samples_summary(samples: list) -> str:
    if not samples:
        return '(샘플 없음)'
    lines = []
    for s in samples[:8]:
        line = f"  {s.get('ip') or '-'}  comm={s.get('community')}  {s.get('brand') or '?'}"
        if s.get('model'):
            line += f"  {s.get('model')}"
        if s.get('total_pages') is not None:
            line += f"  총 {s['total_pages']:,}"
        if s.get('toner_k') is not None:
            line += f"  K {s['toner_k']}%"
        lines.append(line)
    if len(samples) > 8:
        lines.append(f"  외 {len(samples) - 8}대")
    return '\n'.join(lines)


def _run_once_async(icon=None, item=None):
    def task():
        res = poller.run_once()
        if res.get('error') == 'no token':
            _msgbox('서버 페어링이 아직 완료되지 않았습니다.', '프린터카운트수집기', MB_OK | MB_ICONWARNING)
            return
        head = f"발견: {res.get('discovered', 0)}대 | 업로드: {res.get('readings_inserted', 0)}건"
        body = _samples_summary(res.get('samples') or [])
        sub_err = res.get('submit_error')
        if sub_err:
            body += f"\n\n서버 업로드 실패: {sub_err}"
            _msgbox(head + '\n\n' + body, '업로드 결과', MB_OK | MB_ICONWARNING)
        else:
            _msgbox(head + '\n\n' + body, '업로드 결과', MB_OK | MB_ICONINFORMATION)

    threading.Thread(target=task, daemon=True).start()


def _toggle_autostart(icon=None, item=None):
    cur = config.load()
    new = not cur.get('autostart', False)
    _set_autostart(new)
    config.save({'autostart': new})
    logger.log(f'[tray] autostart={new}')


def _is_autostart_checked(item):
    return config.load().get('autostart', False)


def _toggle_notify(icon=None, item=None):
    cur = config.load()
    new = not cur.get('notify_on_upload', False)
    config.save({'notify_on_upload': new})
    logger.log(f'[tray] notify_on_upload={new}')


def _is_notify_checked(item):
    return config.load().get('notify_on_upload', False)


def _set_autostart(enabled: bool):
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r'Software\Microsoft\Windows\CurrentVersion\Run',
            0,
            winreg.KEY_SET_VALUE,
        )
        if enabled:
            winreg.SetValueEx(key, 'DigixCollector', 0, winreg.REG_SZ, f'"{sys.executable}"')
        else:
            try:
                winreg.DeleteValue(key, 'DigixCollector')
            except FileNotFoundError:
                pass
        winreg.CloseKey(key)
    except Exception as e:
        logger.log(f'[tray] autostart failed: {e}')


def _quit(icon, item):
    logger.log('[tray] quit')
    icon.stop()


def run():
    global _icon
    cfg = config.load()
    company = cfg.get('company_name') or '업체명 미설정'
    menu = pystray.Menu(
        pystray.MenuItem('LAN 스캔 / 목록 확인 / 업로드', _scan_window_async),
        pystray.MenuItem('지금 자동 수집 업로드', _run_once_async),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('업로드 시 알림 표시', _toggle_notify, checked=_is_notify_checked),
        pystray.MenuItem('Windows 시작 시 자동 실행', _toggle_autostart, checked=_is_autostart_checked),
        pystray.MenuItem('설정/로그 폴더 열기', _open_log_folder),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('종료', _quit),
    )
    _icon = pystray.Icon(
        'digix-collector',
        _make_icon(),
        f'프린터카운트수집기 - {company}',
        menu=menu,
    )
    _icon.run()
