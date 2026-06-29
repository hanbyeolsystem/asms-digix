"""Self-install helper for the collector executable.

고객 입장 — ZIP 압축 푼 후 안의 EXE 더블클릭 1회로:
  1) 업체명 다이얼로그
  2) 기존(이전) 설치본 정리 — 다른 위치 EXE/폴더 삭제 + HKCU Run 항목 정리
  3) LocalAppData\\DigixCollector\\ 로 폴더 전체(EXE + _internal) 복사
  4) HKCU Run 자동시작 등록
  5) 설치된 위치의 EXE 재실행 → 자동 페어링 → 트레이 상주

main.py 의 first-run 감지가 자동으로 본 모듈을 호출. 명시 --install 도 지원.

⚠️ onedir 빌드 (2026-06-11): EXE 옆에 `_internal\` 폴더가 같이 있어야 동작.
   설치는 EXE 의 부모 폴더 전체를 INSTALL_DIR 로 복사하는 방식.

NOTE: tkinter 는 run_install() 안에서 import — 일반 실행(트레이 모드)에서는
Tcl/Tk 로드 안 함 (메모리 절감).
"""
import os
import shutil
import subprocess
import sys
import time

import config
import logger

INSTALL_DIR = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'DigixCollector')
INSTALL_EXE = os.path.join(INSTALL_DIR, 'digix-collector.exe')
RUN_VALUE = 'DigixCollector'

# onedir 빌드의 필수 동반 폴더/파일 — 잔재 청소 시 EXE 와 함께 정리해야 함.
_ONEDIR_LEFTOVERS = (
    '_internal', 'base_library.zip',
)

# onedir 폴더의 표준 이름 — stale 청소 시 폴더째 삭제할지 판단 기준
_ONEDIR_FOLDER_NAME = 'digix-collector'

# 사용자 프로필 안에서 잔존 EXE 를 찾을 후보 경로들 (이전 버전 / 사용자 직접복사 등).
_STALE_SEARCH_ROOTS = (
    os.environ.get('USERPROFILE'),
    os.environ.get('APPDATA'),
    os.environ.get('LOCALAPPDATA'),
    os.path.join(os.environ.get('USERPROFILE', ''), 'Desktop'),
    os.path.join(os.environ.get('USERPROFILE', ''), 'Downloads'),
)
_EXE_NAME = 'digix-collector.exe'
_SEARCH_DEPTH = 4  # 너무 깊이 들어가지 않음 — 사용자 폴더만


def _set_autostart(exe_path: str):
    import winreg
    key = winreg.OpenKey(
        winreg.HKEY_CURRENT_USER,
        r'Software\Microsoft\Windows\CurrentVersion\Run',
        0,
        winreg.KEY_SET_VALUE,
    )
    winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, f'"{exe_path}"')
    winreg.CloseKey(key)


def _clean_stale_run_entries():
    """HKCU Run 에서 DigixCollector 와 비슷한 이름의 옛 항목 제거.
    값 이름이 'DigixCollector' 와 정확히 같으면 _set_autostart 가 덮어쓰므로 OK.
    다른 변형 이름('Digix Collector', 'digixcollector' 등) 만 정리 대상."""
    import winreg
    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r'Software\Microsoft\Windows\CurrentVersion\Run',
            0,
            winreg.KEY_READ | winreg.KEY_SET_VALUE,
        )
    except Exception as e:
        logger.log(f'[installer] open Run key failed: {e}')
        return

    targets = []  # 삭제할 value 이름들
    i = 0
    while True:
        try:
            name, value, _t = winreg.EnumValue(key, i)
        except OSError:
            break
        i += 1
        # 정확히 동일하면 건드리지 않음 (덮어쓰기 대상)
        if name == RUN_VALUE:
            continue
        # 정규화 비교 — 공백/대소문자 제거
        norm = name.lower().replace(' ', '').replace('_', '').replace('-', '')
        if 'digix' in norm and 'collector' in norm:
            targets.append(name)
        elif _EXE_NAME in str(value).lower():
            targets.append(name)

    for n in targets:
        try:
            winreg.DeleteValue(key, n)
            logger.log(f'[installer] removed stale Run entry: {n}')
        except Exception as e:
            logger.log(f'[installer] delete Run {n} failed: {e}')
    winreg.CloseKey(key)


def _walk_limited(root: str, max_depth: int):
    """os.walk wrapper — 깊이 제한 + 무거운 시스템 폴더 제외.
    사용자 프로필 전체를 재귀하면 너무 느림."""
    skip_dir_names = {'node_modules', '.git', 'AppData', '$Recycle.Bin', 'Windows', 'Program Files', 'Program Files (x86)'}
    root = os.path.abspath(root)
    root_depth = root.count(os.sep)
    for cur, dirs, files in os.walk(root, topdown=True):
        depth = cur.count(os.sep) - root_depth
        if depth >= max_depth:
            dirs[:] = []
        # 본인이 AppData 일 수도 있으므로 root 가 AppData 면 통과시킴
        dirs[:] = [d for d in dirs if d not in skip_dir_names or os.path.basename(root) == d]
        yield cur, files


def _find_stale_exes(skip_path: str) -> list[str]:
    """skip_path(=현재 실행 EXE) 와 INSTALL_EXE 를 제외한 잔존 digix-collector.exe 위치 수집."""
    skip_lower = os.path.abspath(skip_path).lower()
    install_lower = os.path.abspath(INSTALL_EXE).lower()
    found = []
    seen = set()
    for root in _STALE_SEARCH_ROOTS:
        if not root or not os.path.isdir(root):
            continue
        try:
            for cur, files in _walk_limited(root, _SEARCH_DEPTH):
                if _EXE_NAME not in {f.lower() for f in files}:
                    continue
                # 대소문자 보존된 실제 파일명 찾기
                actual = next((f for f in files if f.lower() == _EXE_NAME), None)
                if not actual:
                    continue
                p = os.path.abspath(os.path.join(cur, actual))
                low = p.lower()
                if low in (skip_lower, install_lower) or low in seen:
                    continue
                seen.add(low)
                found.append(p)
        except Exception as e:
            logger.log(f'[installer] walk {root} failed (ignored): {e}')
    return found


def _delete_stale_exes(paths: list[str]) -> int:
    """잔존 EXE/폴더 삭제. 실패해도 계속 진행.

    onedir 구조: EXE 옆에 `_internal\` 폴더가 동반. 이 경우 부모 폴더 이름이
    `digix-collector` 이고 INSTALL_DIR 이 아니면 폴더 전체를 삭제.
    onefile 구버전 잔재(단일 EXE) 는 EXE 만 삭제.
    """
    install_lower = os.path.abspath(INSTALL_DIR).lower()
    removed = 0
    handled_dirs: set[str] = set()
    for p in paths:
        try:
            parent = os.path.dirname(p)
            parent_lower = os.path.abspath(parent).lower()
            if parent_lower in handled_dirs:
                continue
            parent_name = os.path.basename(parent).lower()
            has_internal = os.path.isdir(os.path.join(parent, '_internal'))

            if (
                has_internal
                and parent_name == _ONEDIR_FOLDER_NAME
                and parent_lower != install_lower
            ):
                # onedir 폴더 전체 삭제 (EXE + _internal + 동반 파일)
                shutil.rmtree(parent, ignore_errors=True)
                handled_dirs.add(parent_lower)
                logger.log(f'[installer] removed stale onedir folder: {parent}')
                removed += 1
                continue

            # 단일 EXE 잔재 (구버전 onefile)
            os.remove(p)
            logger.log(f'[installer] removed stale exe: {p}')
            removed += 1
            # 같은 폴더에 PyInstaller 부산물이 남아 있으면 정리
            for name in _ONEDIR_LEFTOVERS:
                target = os.path.join(parent, name)
                if os.path.exists(target) and parent_lower != install_lower:
                    try:
                        if os.path.isdir(target):
                            shutil.rmtree(target, ignore_errors=True)
                        else:
                            os.remove(target)
                    except Exception:
                        pass
        except Exception as e:
            logger.log(f'[installer] delete {p} failed (ignored): {e}')
    return removed


def _stop_existing(current_exe: str):
    script = (
        "$cur = [System.IO.Path]::GetFullPath('" + current_exe.replace("'", "''") + "');"
        "Get-CimInstance Win32_Process -Filter \"Name='digix-collector.exe'\" | "
        "Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ne $cur) } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    try:
        subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=10,
            creationflags=0x08000000,
        )
    except Exception as e:
        logger.log(f'[installer] stop existing failed: {e}')
    # 종료 후 파일 핸들 release 대기 (lock 해제)
    time.sleep(0.5)


def _purge_install_dir():
    """기존 INSTALL_DIR 내용을 비움 (재설치 시 깨끗한 상태에서 새 폴더 복사).

    INSTALL_DIR 자체는 유지(권한/링크 보전). 안의 digix-collector.exe 와
    _internal\\, base_library.zip 등 모든 PyInstaller 산출물 삭제. 실패해도
    무시 — copytree 의 dirs_exist_ok 가 덮어쓰므로 치명적이지 않음.

    NOTE: config.json 은 %APPDATA%\\digix-collector\\ 에 있으므로 영향 없음.
    """
    if not os.path.isdir(INSTALL_DIR):
        return
    try:
        for name in os.listdir(INSTALL_DIR):
            target = os.path.join(INSTALL_DIR, name)
            try:
                if os.path.isdir(target):
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    os.remove(target)
            except Exception as e:
                logger.log(f'[installer] purge {name} failed (ignored): {e}')
        logger.log('[installer] purged INSTALL_DIR contents')
    except Exception as e:
        logger.log(f'[installer] purge INSTALL_DIR failed (ignored): {e}')


def run_install():
    # tkinter 는 설치 다이얼로그에서만 필요 — 여기서 import (모듈 import 시 미로드)
    import tkinter as tk
    from tkinter import messagebox, simpledialog

    root = tk.Tk()
    root.withdraw()

    cfg = config.load()
    company = simpledialog.askstring(
        '프린터카운트수집기 설치',
        '업체명을 입력하세요.',
        initialvalue=cfg.get('company_name') or '',
        parent=root,
    )
    if company is None:
        return 1
    company = company.strip()
    if not company:
        messagebox.showwarning('설치 중단', '업체명을 입력해야 설치할 수 있습니다.', parent=root)
        return 1

    current_exe = os.path.abspath(sys.executable)
    source_dir = os.path.dirname(current_exe)  # onedir: 부모 폴더 안에 EXE + _internal\
    os.makedirs(INSTALL_DIR, exist_ok=True)

    # 1) 실행 중인 모든 다른 인스턴스 강제 종료 (2중 실행 방지)
    _stop_existing(current_exe)

    # 2) 잔존 EXE / 폴더 / Run 항목 정리 — '기존동일한 프로그램이 설치된경우 삭제후 설치'
    stale = _find_stale_exes(current_exe)
    removed = _delete_stale_exes(stale)
    _clean_stale_run_entries()
    if removed:
        logger.log(f'[installer] cleaned {removed} stale installation(s)')

    # 3) 새 폴더 통째 복사 + 자동시작 등록 (onedir 빌드 — EXE 단독 복사 X)
    try:
        source_lower = os.path.abspath(source_dir).lower()
        install_lower = os.path.abspath(INSTALL_DIR).lower()
        if source_lower != install_lower:
            # onedir 구조 검증 — _internal 폴더가 EXE 옆에 있어야 정상 빌드
            if not os.path.isdir(os.path.join(source_dir, '_internal')):
                messagebox.showerror(
                    '설치 실패',
                    '설치 파일 구조가 손상되었습니다.\n\n'
                    'ZIP 압축을 풀 때 digix-collector 폴더 안의 _internal 폴더가 '
                    '함께 풀려 있어야 합니다. 압축을 다시 풀어 주세요.',
                    parent=root,
                )
                return 1
            # 기존 설치 내용 비우기 → 폴더 전체 복사
            _purge_install_dir()
            shutil.copytree(source_dir, INSTALL_DIR, dirs_exist_ok=True)
            logger.log(f'[installer] copied onedir tree: {source_dir} -> {INSTALL_DIR}')
        config.save({'company_name': company, 'autostart': True})
        _set_autostart(INSTALL_EXE)
    except Exception as e:
        messagebox.showerror('설치 실패', f'설치 중 오류가 발생했습니다.\n\n{e}', parent=root)
        return 1

    extra = f'\n\n이전 설치본 {removed}개 정리됨' if removed else ''
    messagebox.showinfo(
        '설치 완료',
        f'설치가 완료되었습니다.{extra}\n\n업체명: {company}\n설치 위치: {INSTALL_EXE}\n\n프로그램을 시작합니다.',
        parent=root,
    )

    # 설치 완료 즉시 INSTALL_EXE 자동 실행. 항상 띄움 — 재설치/같은 경로에서 --install
    # 한 경우에도 부모 프로세스가 곧 종료되므로 새 인스턴스가 필요. 단일 인스턴스 mutex
    # 가 중복 방지하므로 안전.
    # DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP = 부모 종료해도 자식 살아남음
    # CREATE_NO_WINDOW (0x08000000) = 콘솔 창 깜빡임 방지
    try:
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        CREATE_NO_WINDOW = 0x08000000
        subprocess.Popen(
            [INSTALL_EXE],
            close_fds=True,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW,
        )
        logger.log(f'[installer] launched after install: {INSTALL_EXE}')
    except Exception as e:
        logger.log(f'[installer] auto-launch failed: {e}')
    return 0
