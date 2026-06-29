"""
첫 실행 페어링 — tkinter 다이얼로그로 페어링 코드 + 업체명 입력.
- 사용자가 코드/업체명을 직접 입력 (initialvalue 미리 채워둠)
- 입력값을 config 에 저장 후 디직스 서버에 pair-collector 호출 → token 받음
- 결과는 Windows MessageBox(ctypes) 로 표시
"""
import socket, os, ctypes, getpass

import config, uploader, logger

# NOTE: tkinter 는 _PairDialog 안에서 지연 import — 일반 실행에선 로드 안 됨

AGENT_VERSION = '0.2.0'
DEFAULT_PAIRING_CODE = 'digix'

MB_OK              = 0x00000000
MB_ICONINFORMATION = 0x00000040
MB_ICONERROR       = 0x00000010


def _msgbox(text: str, title: str, flags: int = MB_OK | MB_ICONINFORMATION) -> None:
    try:
        ctypes.windll.user32.MessageBoxW(0, text, title, flags)
    except Exception as e:
        logger.log(f'[pair] MessageBox 실패: {e}')


def _pc_name() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return 'unknown-pc'


def _os_user() -> str:
    for fn in (os.getlogin, getpass.getuser):
        try:
            v = fn()
            if v:
                return v
        except Exception:
            continue
    return 'unknown'


class _PairDialog:
    """업체명 + 페어링 코드 입력 다이얼로그.
    Returns: (company, code) 또는 (None, None) if cancelled."""

    def __init__(self, default_company: str, default_code: str):
        import tkinter as tk
        from tkinter import ttk
        self._tk = tk  # _ok/_cancel 에서 재사용
        self.root = tk.Tk()
        self.root.title('프린터카운트수집기 - 첫 실행 설정')
        self.root.geometry('420x240')
        self.root.resizable(False, False)
        self.result = (None, None)

        frm = ttk.Frame(self.root, padding=18)
        frm.pack(fill='both', expand=True)

        ttk.Label(frm, text='업체명', font=('맑은 고딕', 10, 'bold')).grid(row=0, column=0, sticky='w', pady=(0, 4))
        self.company_var = tk.StringVar(value=default_company)
        ttk.Entry(frm, textvariable=self.company_var, width=42).grid(row=1, column=0, sticky='we', pady=(0, 12))

        ttk.Label(frm, text='페어링 코드 (디직스코리아에서 안내받음)', font=('맑은 고딕', 10, 'bold')).grid(row=2, column=0, sticky='w', pady=(0, 4))
        self.code_var = tk.StringVar(value=default_code)
        ttk.Entry(frm, textvariable=self.code_var, width=42).grid(row=3, column=0, sticky='we', pady=(0, 4))
        ttk.Label(frm, text='기본값: digix', foreground='#666').grid(row=4, column=0, sticky='w', pady=(0, 14))

        btns = ttk.Frame(frm)
        btns.grid(row=5, column=0, sticky='e')
        ttk.Button(btns, text='취소', command=self._cancel).pack(side='right', padx=(8, 0))
        ttk.Button(btns, text='연결', command=self._ok).pack(side='right')

        frm.columnconfigure(0, weight=1)
        self.root.bind('<Return>', lambda _e: self._ok())
        self.root.bind('<Escape>', lambda _e: self._cancel())

        self.root.update_idletasks()
        w = self.root.winfo_width(); h = self.root.winfo_height()
        x = (self.root.winfo_screenwidth() - w) // 2
        y = (self.root.winfo_screenheight() - h) // 2
        self.root.geometry(f'+{x}+{y}')
        self.root.attributes('-topmost', True)
        self.root.after(200, lambda: self.root.attributes('-topmost', False))

    def _ok(self):
        from tkinter import messagebox
        company = self.company_var.get().strip()
        code = self.code_var.get().strip() or DEFAULT_PAIRING_CODE
        if not company:
            messagebox.showwarning('업체명 입력', '업체명을 입력해주세요.', parent=self.root)
            return
        self.result = (company, code)
        self.root.destroy()

    def _cancel(self):
        self.result = (None, None)
        self.root.destroy()

    def run(self):
        self.root.mainloop()
        return self.result


def run_auto() -> bool:
    """첫 실행 페어링. 성공 시 True.
    config 에 pairing_code 가 이미 있고 token 있으면 자동 진행.
    아니면 다이얼로그로 업체명+코드 입력 받음."""
    cfg = config.load()
    default_company = cfg.get('company_name') or ''
    default_code    = cfg.get('pairing_code') or DEFAULT_PAIRING_CODE

    dlg = _PairDialog(default_company, default_code)
    company, code = dlg.run()
    if company is None or not code:
        logger.log('[pair] 사용자 취소')
        return False

    pc   = _pc_name()
    user = _os_user()
    logger.log(f'[pair] pairing as pc={pc} company={company} code={code}')

    try:
        res = uploader.pair(code=code, pc_name=pc, os_user=user, agent_version=AGENT_VERSION)
        config.save({
            'company_name': company,
            'pairing_code': code,
            'token':        res['token'],
            'collector_id': res['collector_id'],
        })
        logger.log(f'[pair] OK collector_id={res["collector_id"]}')
        _msgbox(
            f'디직스 서버에 정상 연결되었습니다.\n\n'
            f'업체명: {company}\n'
            f'PC: {pc}\n\n'
            f'10분마다 자동으로 카운터를 업로드합니다.\n'
            f'트레이 아이콘에서 상태를 확인하세요.',
            '✅ 프린터카운트수집기 - 연결 완료',
        )
        return True
    except Exception as e:
        logger.log(f'[pair] 실패: {e}')
        _msgbox(
            f'디직스 서버 연결에 실패했습니다.\n\n원인: {e}\n\n'
            '- 페어링 코드가 정확한지 확인하세요.\n'
            '- 인터넷 연결을 확인하세요.\n'
            '- 잠시 후 다시 실행해주세요.',
            '⚠ 프린터카운트수집기 - 연결 실패',
            MB_OK | MB_ICONERROR,
        )
        return False
