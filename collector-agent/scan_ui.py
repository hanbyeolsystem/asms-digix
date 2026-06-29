"""Interactive LAN scan window."""
import queue
import threading
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk

import config
import discover
import logger
import poller
import usb_printers


def _split_values(text: str) -> list[str]:
    values = []
    for raw in text.replace('\n', ',').replace(';', ',').split(','):
        value = raw.strip()
        if value:
            values.append(value)
    return values


# 체크박스 컬럼에 표시할 문자
CHK = '☑'   # ☑ 체크됨
UNC = '☐'   # ☐ 미체크


class ScanWindow:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title('프린터카운트수집기 - LAN 스캔')
        self.root.geometry('1040x640')
        self.root.minsize(900, 540)
        self.events = queue.Queue()
        self.raw_found = []
        self.batch = {'devices': [], 'readings': [], 'samples': []}
        self.scanning = False
        # 실시간 수집 워커 — discover 가 snmp_found 이벤트 흘리면 큐로 받아
        # collect_one 직렬 실행 (UDP race 회피).
        self._collect_queue = queue.Queue()
        self._collect_in_flight = 0
        self._scan_thread_done = False
        self._next_iid = 0
        self._collect_worker = threading.Thread(target=self._collect_worker_loop, daemon=True)
        self._collect_worker.start()
        self._build()
        self._load_defaults()
        self.root.after(100, self._drain_events)

    def _build(self):
        top = ttk.Frame(self.root, padding=12)
        top.pack(fill='x')

        cfg = ttk.Frame(top)
        cfg.pack(fill='x')
        ttk.Label(cfg, text='업체명').grid(row=0, column=0, sticky='w')
        self.company_var = tk.StringVar()
        ttk.Entry(cfg, textvariable=self.company_var, width=28).grid(row=0, column=1, sticky='we', padx=(6, 16))

        ttk.Label(cfg, text='스캔 대역').grid(row=0, column=2, sticky='w')
        self.cidrs_var = tk.StringVar()
        ttk.Entry(cfg, textvariable=self.cidrs_var).grid(row=0, column=3, sticky='we', padx=(6, 16))

        ttk.Label(cfg, text='직접 IP').grid(row=1, column=0, sticky='w', pady=(8, 0))
        manual_row = ttk.Frame(cfg)
        manual_row.grid(row=1, column=1, columnspan=3, sticky='we', padx=(6, 16), pady=(8, 0))
        self.manual_ips_var = tk.StringVar()
        ttk.Entry(manual_row, textvariable=self.manual_ips_var).pack(side='left', fill='x', expand=True)
        self.find_btn = ttk.Button(manual_row, text='찾기', command=self.find_manual_ips, width=8)
        self.find_btn.pack(side='left', padx=(8, 0))

        ttk.Label(cfg, text='SNMP community').grid(row=2, column=0, sticky='w', pady=(8, 0))
        self.communities_var = tk.StringVar()
        ttk.Entry(cfg, textvariable=self.communities_var).grid(row=2, column=1, columnspan=3, sticky='we', padx=(6, 16), pady=(8, 0))
        ttk.Label(
            cfg,
            text='예: 192.168.0.0/24, 192.168.0.1-254, 192.168.0.* / 직접 IP는 쉼표로 여러 개 입력 / SNMP 응답하는 온라인 장비만 노출',
            foreground='#555555',
        ).grid(row=3, column=1, columnspan=3, sticky='w', padx=(6, 16), pady=(6, 0))
        cfg.columnconfigure(3, weight=1)

        buttons = ttk.Frame(top)
        buttons.pack(fill='x', pady=(12, 0))
        self.scan_btn = ttk.Button(buttons, text='스캔 시작', command=self.start_scan)
        self.scan_btn.pack(side='left')
        self.upload_btn = ttk.Button(buttons, text='선택 항목 업로드', command=self.upload_selected, state='disabled')
        self.upload_btn.pack(side='left', padx=(8, 0))
        self.web_btn = ttk.Button(buttons, text='관리 페이지 열기', command=self.open_admin_pages, state='disabled')
        self.web_btn.pack(side='left', padx=(8, 0))
        ttk.Button(buttons, text='설정 저장', command=self.save_settings).pack(side='left', padx=(8, 0))
        ttk.Button(buttons, text='닫기', command=self.root.destroy).pack(side='right')

        progress = ttk.Frame(self.root, padding=(12, 0, 12, 8))
        progress.pack(fill='x')
        self.status_var = tk.StringVar(value='대기 중')
        ttk.Label(progress, textvariable=self.status_var).pack(anchor='w')
        self.progress = ttk.Progressbar(progress, mode='determinate')
        self.progress.pack(fill='x', pady=(4, 0))

        cols = ('check', 'ip', 'community', 'snmp', 'brand', 'model', 'total', 'bw', 'color', 'toner')
        self.tree = ttk.Treeview(self.root, columns=cols, show='headings', selectmode='extended')
        headings = {
            'check': UNC,           # 헤더 클릭 시 전체 체크/해제 토글
            'ip': 'IP',
            'community': 'Community',
            'snmp': 'SNMP 상태',
            'brand': '제조사',
            'model': '모델/상태',
            'total': '총 카운터',
            'bw': '흑백',
            'color': '컬러',
            'toner': 'K 토너',
        }
        widths = {
            'check': 50,
            'ip': 120,
            'community': 100,
            'snmp': 130,
            'brand': 90,
            'model': 260,
            'total': 100,
            'bw': 90,
            'color': 90,
            'toner': 80,
        }
        for col in cols:
            if col == 'check':
                # 헤더 클릭 → 전체 토글
                self.tree.heading(col, text=headings[col], command=self._toggle_all, anchor='center')
                self.tree.column(col, width=widths[col], minwidth=40, stretch=False, anchor='center')
            else:
                self.tree.heading(col, text=headings[col])
                self.tree.column(col, width=widths[col], minwidth=60, stretch=(col == 'model'))
        self.tree.pack(fill='both', expand=True, padx=12, pady=(0, 12))
        # 단일 클릭으로 체크박스 토글 (체크 컬럼만)
        self.tree.bind('<Button-1>', self._on_click)

    def _load_defaults(self):
        cfg = config.load()
        self.company_var.set(cfg.get('company_name') or '')
        self.cidrs_var.set(', '.join(cfg.get('lan_cidrs') or discover.auto_cidrs()))
        self.manual_ips_var.set(', '.join(cfg.get('manual_ips') or []))
        self.communities_var.set(', '.join(cfg.get('snmp_communities') or ['public']))

    def save_settings(self):
        config.save({
            'company_name': self.company_var.get().strip(),
            'lan_cidrs': _split_values(self.cidrs_var.get()) or None,
            'manual_ips': _split_values(self.manual_ips_var.get()),
            'snmp_communities': _split_values(self.communities_var.get()) or ['public'],
        })
        messagebox.showinfo('저장 완료', '설정을 저장했습니다.')

    def start_scan(self):
        if self.scanning:
            return
        cidrs = _split_values(self.cidrs_var.get())
        manual_ips = _split_values(self.manual_ips_var.get())
        communities = _split_values(self.communities_var.get()) or ['public']
        self._begin_scan('스캔 준비 중...')

        def progress(event):
            self.events.put(('progress', event))

        def worker():
            # USB 먼저 — 로컬 WMI 라 빠르고, 사용자에게 즉시 결과 보여줌
            try:
                usb_devs, usb_reads = usb_printers.to_devices_and_readings()
                self.events.put(('usb_batch', (usb_devs, usb_reads)))
            except Exception as e:
                logger.log(f'[scan-ui] USB collect failed: {e}')
            # LAN 스캔 — snmp_found 이벤트 별도 발사
            try:
                found = discover.scan(cidrs=cidrs, manual_ips=manual_ips, communities=communities, progress=progress)
                self.events.put(('scan_done', found))
            except Exception as e:
                logger.log(f'[scan-ui] scan failed: {e}')
                self.events.put(('error', str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def find_manual_ips(self):
        """직접 IP 입력란의 IP만 즉시 점검 → 결과창에 추가."""
        if self.scanning:
            return
        manual_ips = _split_values(self.manual_ips_var.get())
        if not manual_ips:
            messagebox.showwarning(
                '직접 IP 찾기',
                '직접 IP 입력란이 비어 있습니다.\n예: 192.168.0.10, 192.168.0.20',
            )
            return
        communities = _split_values(self.communities_var.get()) or ['public']
        self._begin_scan(f'직접 IP 찾는 중... ({len(manual_ips)}개)')

        def progress(event):
            self.events.put(('progress', event))

        def worker():
            # 직접 IP 찾기는 USB 포함 안 함 (사용자가 입력한 IP 만 점검)
            try:
                found = discover.scan(
                    cidrs=[], manual_ips=manual_ips, communities=communities,
                    progress=progress, manual_only=True,
                )
                self.events.put(('scan_done', found))
            except Exception as e:
                logger.log(f'[scan-ui] find failed: {e}')
                self.events.put(('error', str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def _begin_scan(self, status_msg: str):
        """스캔/찾기 공통 진입 — 상태 초기화 + 버튼 잠금."""
        self.scanning = True
        self.raw_found = []
        self.batch = {'devices': [], 'readings': [], 'samples': []}
        self._collect_in_flight = 0
        self._scan_thread_done = False
        self._next_iid = 0
        self.upload_btn.configure(state='disabled')
        self.web_btn.configure(state='disabled')
        self.scan_btn.configure(state='disabled')
        self.find_btn.configure(state='disabled')
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.tree.heading('check', text=UNC)
        self.progress.configure(value=0, maximum=100)
        self.status_var.set(status_msg)

    def _drain_events(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == 'progress':
                    self._handle_progress(payload)
                elif kind == 'usb_batch':
                    self._handle_usb_batch(payload)
                elif kind == 'device_collected':
                    self._handle_device_collected(payload)
                elif kind == 'device_collect_error':
                    self._handle_device_collect_error(payload)
                elif kind == 'scan_done':
                    self._handle_scan_done(payload)
                elif kind == 'upload_done':
                    self._handle_upload_done(payload)
                elif kind == 'error':
                    self._finish_with_error(payload)
        except queue.Empty:
            pass
        self.root.after(100, self._drain_events)

    def _handle_progress(self, event):
        total = max(1, int(event.get('total') or 1))
        done = int(event.get('done') or 0)
        ev = event.get('event')
        if ev == 'start':
            self.progress.configure(maximum=total, value=0)
            self.status_var.set(f'스캔 시작: 대상 {total}개')
        elif ev == 'progress':
            self.progress.configure(maximum=total, value=done)
            self.status_var.set(f"스캔 중: {event.get('ip')} ({done}/{total})")
        elif ev == 'snmp_found':
            # SNMP 응답 받은 장비 — 즉시 행 추가 + collect 큐 push
            dev = event.get('device') or {}
            self._add_pending_row(dev)

    def _add_pending_row(self, dev: dict):
        """발견된 SNMP 장비를 트리에 placeholder 행으로 즉시 삽입 + collect 큐 push.
        실제 모델/카운터/토너 값은 collect 워커가 끝나면 _handle_device_collected 가 채움."""
        idx = self._next_iid
        self._next_iid += 1
        self.batch['devices'].append(None)
        self.batch['readings'].append(None)
        self.batch['samples'].append(None)
        self._collect_in_flight += 1
        values = (
            UNC,
            dev.get('ip') or '',
            dev.get('community') or '',
            '온라인',
            '',                 # 제조사 — 수집 후 채움
            '(수집 중...)',     # 모델/상태
            '', '', '', '',
        )
        self.tree.insert('', 'end', iid=str(idx), values=values)
        self.raw_found.append(dev)
        self._collect_queue.put((idx, dev))
        self.status_var.set(f"발견 {self._next_iid}대 · 카운터 수집 대기 {self._collect_in_flight}대")

    def _collect_worker_loop(self):
        """collect_one 직렬 실행 워커 — UDP source-port race 회피.
        큐에 들어온 (idx, dev) 를 하나씩 처리 → 결과를 events 큐로 전달."""
        while True:
            try:
                idx, dev = self._collect_queue.get()
            except Exception:
                continue
            try:
                device, reading = poller.collect_one(dev)
                sample = {
                    'ip': dev.get('ip'),
                    'community': dev.get('community'),
                    'brand': device.get('manufacturer'),
                    'model': device.get('model'),
                    'total_pages': reading.get('total_pages'),
                    'bw': reading.get('bw'),
                    'color': reading.get('color'),
                    'toner_k': reading.get('toner_k'),
                }
                self.events.put(('device_collected', (idx, device, reading, sample)))
            except Exception as e:
                logger.log(f'[scan-ui] collect_one failed for {dev.get("ip")}: {e}')
                self.events.put(('device_collect_error', (idx, dev, str(e))))

    def _handle_usb_batch(self, payload):
        """USB 프린터는 collect 가 이미 끝난 상태로 들어옴 — 트리에 바로 채움."""
        usb_devs, usb_reads = payload
        reads_by_mac = {r.get('mac'): r for r in usb_reads}
        for d in usb_devs:
            r = reads_by_mac.get(d.get('mac')) or {}
            idx = self._next_iid
            self._next_iid += 1
            sample = {
                'ip': d.get('serial_snmp') or 'USB',
                'community': 'USB',
                'brand': d.get('manufacturer'),
                'model': d.get('model'),
                'total_pages': r.get('total_pages'),
                'bw': r.get('bw'),
                'color': r.get('color'),
                'toner_k': r.get('toner_k'),
            }
            self.batch['devices'].append(d)
            self.batch['readings'].append(r)
            self.batch['samples'].append(sample)
            values = (
                UNC,
                sample['ip'] or '',
                'USB',
                'USB',
                sample.get('brand') or '',
                sample.get('model') or '',
                sample.get('total_pages') if sample.get('total_pages') is not None else '',
                sample.get('bw') if sample.get('bw') is not None else '',
                sample.get('color') if sample.get('color') is not None else '',
                f"{sample.get('toner_k')}%" if sample.get('toner_k') is not None else '',
            )
            self.tree.insert('', 'end', iid=str(idx), values=values)
        if usb_devs:
            self.status_var.set(f"USB 프린터 {len(usb_devs)}대 감지 · LAN 스캔 계속...")

    def _handle_device_collected(self, payload):
        idx, device, reading, sample = payload
        if idx < len(self.batch['devices']):
            self.batch['devices'][idx] = device
            self.batch['readings'][idx] = reading
            self.batch['samples'][idx] = sample
        iid = str(idx)
        if self.tree.exists(iid):
            cur = list(self.tree.item(iid, 'values'))
            new_values = (
                cur[0],  # 체크 상태 보존
                sample.get('ip') or cur[1],
                sample.get('community') or cur[2],
                '온라인',
                sample.get('brand') or '',
                sample.get('model') or '',
                sample.get('total_pages') if sample.get('total_pages') is not None else '',
                sample.get('bw') if sample.get('bw') is not None else '',
                sample.get('color') if sample.get('color') is not None else '',
                f"{sample.get('toner_k')}%" if sample.get('toner_k') is not None else '',
            )
            self.tree.item(iid, values=new_values)
        self._collect_in_flight -= 1
        self._check_scan_finished()

    def _handle_device_collect_error(self, payload):
        idx, dev, msg = payload
        iid = str(idx)
        if self.tree.exists(iid):
            cur = list(self.tree.item(iid, 'values'))
            new_values = (
                cur[0], cur[1], cur[2], '수집 실패',
                '', f'(오류: {msg[:60]})', '', '', '', '',
            )
            self.tree.item(iid, values=new_values)
        self._collect_in_flight -= 1
        self._check_scan_finished()

    def _handle_scan_done(self, found):
        """discover.scan() 종료 시점 — 아직 collect 큐에 남은 항목이 있을 수 있음."""
        self._scan_thread_done = True
        all_found = found or []
        snmp_count = sum(1 for d in all_found if d.get('probe') == 'snmp')
        skipped = len(all_found) - snmp_count
        if self._collect_in_flight > 0:
            tail = f' (SNMP 미응답 {skipped}대 제외)' if skipped else ''
            self.status_var.set(f'LAN 스캔 완료 — 카운터 수집 대기 {self._collect_in_flight}대{tail}')
        self._check_scan_finished()

    def _check_scan_finished(self):
        """스캔 thread 와 collect 큐가 모두 끝났으면 버튼 풀고 상태바 마무리."""
        if not (self._scan_thread_done and self._collect_in_flight <= 0):
            return
        total = sum(1 for d in self.batch['devices'] if d is not None)
        self.status_var.set(
            f"스캔 완료: 온라인 장비 {total}대 — 추가할 항목을 체크하세요 (헤더 ☐ 클릭 시 전체 선택)"
        )
        self.scan_btn.configure(state='normal')
        self.find_btn.configure(state='normal')
        self.upload_btn.configure(state='normal' if total else 'disabled')
        self.web_btn.configure(state='normal' if total else 'disabled')
        self._update_header()
        self.scanning = False

    def _finish_with_error(self, text):
        self.scanning = False
        self.scan_btn.configure(state='normal')
        self.find_btn.configure(state='normal')
        self.status_var.set('오류 발생')
        messagebox.showerror('오류', text)

    # ===== 체크박스 컬럼 동작 =====
    def _set_check(self, iid: str, checked: bool):
        values = list(self.tree.item(iid, 'values'))
        if not values:
            return
        values[0] = CHK if checked else UNC
        self.tree.item(iid, values=values)

    def _is_checked(self, iid: str) -> bool:
        values = self.tree.item(iid, 'values')
        return bool(values) and values[0] == CHK

    def _selected_iids(self) -> list[str]:
        return [iid for iid in self.tree.get_children() if self._is_checked(iid)]

    def _on_click(self, event):
        """단일 클릭 — 체크 컬럼이면 그 행만 토글."""
        region = self.tree.identify('region', event.x, event.y)
        if region != 'cell':
            return
        if self.tree.identify_column(event.x) != '#1':
            return  # 체크 컬럼이 아니면 기본 selection 동작 유지
        iid = self.tree.identify_row(event.y)
        if not iid:
            return
        self._set_check(iid, not self._is_checked(iid))
        self._update_header()

    def _toggle_all(self):
        """헤더 클릭 — 전체 체크 또는 전체 해제 (현재 상태에 따라 반전)."""
        children = list(self.tree.get_children())
        if not children:
            return
        all_checked = all(self._is_checked(iid) for iid in children)
        target = not all_checked
        for iid in children:
            self._set_check(iid, target)
        self._update_header()

    def _update_header(self):
        """체크 컬럼 헤더 텍스트 + 상태바에 선택 카운트 표시."""
        children = list(self.tree.get_children())
        total = len(children)
        checked = sum(1 for iid in children if self._is_checked(iid))
        if total == 0:
            header = UNC
        elif checked == total:
            header = CHK
        elif checked == 0:
            header = UNC
        else:
            header = '◧'  # 일부 선택
        self.tree.heading('check', text=header)
        # 업로드 버튼 활성/비활성
        self.upload_btn.configure(state='normal' if checked > 0 else 'disabled')
        # 상태바 갱신 (스캔 진행 중이 아니면)
        if not self.scanning and total > 0:
            self.status_var.set(f'온라인 {total}대 · 선택 {checked}대 — "선택 항목 업로드" 클릭')

    def open_admin_pages(self):
        selected = list(self.tree.selection()) or list(self.tree.get_children())
        opened = 0
        for iid in selected[:5]:
            values = self.tree.item(iid, 'values')
            if not values or not values[1]:
                continue
            webbrowser.open(f'http://{values[1]}')
            opened += 1
        if opened:
            messagebox.showinfo(
                'SNMP 설정 안내',
                '프린터 관리 페이지를 열었습니다.\n\n'
                '관리자 계정으로 로그인한 뒤 네트워크/프로토콜/SNMP 메뉴에서 '
                'SNMP v1/v2c를 켜고 community를 public으로 설정한 다음 다시 스캔하세요.'
            )
        else:
            messagebox.showwarning('관리 페이지 열기', '열 수 있는 IP가 없습니다.')

    def upload_selected(self):
        """체크된 장비를 임대장비관리에 등록.
        register-devices 호출 — 같은 장비 두 번 체크해도 서버가 중복 차단."""
        if not self.batch or not self.batch.get('devices'):
            return
        selected_indexes = [int(iid) for iid in self._selected_iids()]
        # collect_one 실패한 행은 self.batch.devices[i] == None → 제외
        selected_indexes = [
            i for i in selected_indexes
            if i < len(self.batch['devices']) and self.batch['devices'][i] is not None
        ]
        if not selected_indexes:
            messagebox.showwarning(
                '업로드 불가',
                '업로드할 프린터를 선택하세요.\n'
                '체크박스(☐)를 클릭하면 해당 행이 선택(☑)되고, 헤더를 클릭하면 전체 선택/해제됩니다.',
            )
            return

        devices = [self.batch['devices'][i] for i in selected_indexes]
        readings = [self.batch['readings'][i] for i in selected_indexes]
        self.upload_btn.configure(state='disabled')
        self.status_var.set('임대장비관리에 등록 중...')

        def worker():
            try:
                self.events.put(('upload_done', poller.register_batch({'devices': devices, 'readings': readings})))
            except Exception as e:
                logger.log(f'[scan-ui] register failed: {e}')
                self.events.put(('error', str(e)))

        threading.Thread(target=worker, daemon=True).start()

    def _handle_upload_done(self, res):
        self.upload_btn.configure(state='normal')
        if res.get('error') == 'no token':
            messagebox.showwarning('업로드 불가', '서버 페어링이 아직 완료되지 않았습니다. 프로그램을 다시 실행해 페어링을 먼저 완료하세요.')
            self.status_var.set('업로드 실패: 페어링 필요')
            return
        newly = int(res.get('newly_registered', 0))
        already = int(res.get('already_registered', 0))
        readings = int(res.get('readings_inserted', 0))
        self.status_var.set(f'임대장비관리 등록 완료: 신규 {newly}대 / 이미 등록 {already}대 / 카운터 {readings}건')
        if newly == 0 and already > 0:
            # 모두 중복인 경우 — 사용자가 헷갈리지 않도록 명확히 안내
            messagebox.showinfo(
                '이미 등록된 장비',
                f'선택한 {already}대는 이미 임대장비관리에 등록되어 있습니다.\n\n'
                '재등록은 되지 않았고, 카운터만 갱신되었습니다.',
            )
        else:
            messagebox.showinfo(
                '임대장비관리 등록 완료',
                f'임대장비관리에 등록되었습니다.\n\n'
                f'  • 신규 등록: {newly}대\n'
                f'  • 이미 등록: {already}대 (중복 차단)\n'
                f'  • 카운터: {readings}건\n\n'
                f'재부팅 후에도 등록된 장비만 자동 송신됩니다.',
            )

    def run(self):
        self.root.mainloop()
        # mainloop 종료(창 닫힘) 후 큰 객체 해제
        self.batch = {'devices': [], 'readings': [], 'samples': []}
        self.raw_found = []


def open_scan_window(auto_scan: bool = False):
    """LAN 스캔 창 오픈. auto_scan=True 면 mainloop 진입 직후 자동으로 스캔 시작
    (첫 설치 흐름에서 사용)."""
    import gc
    win = ScanWindow()
    if auto_scan:
        # 창이 화면에 그려진 뒤 호출 — 700ms 여유 (Tk 초기화 완료 대기)
        win.root.after(700, win.start_scan)
    win.run()
    gc.collect()  # 창 닫힘 후 Tk 위젯 객체 / batch 데이터 회수
