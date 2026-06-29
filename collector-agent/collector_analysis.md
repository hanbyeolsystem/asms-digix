# Printer Counter Collector - Existing Program Analysis

분석 대상: `C:\Users\UserK\Desktop\클로드코드공부\임대관리\collector-agent\dist\digix-collector.exe`

원본 코드 위치: `C:\Users\UserK\Desktop\클로드코드공부\임대관리\collector-agent`

분석일: 2026-05-31

## 1. 결론

기존 프로그램은 Python으로 만든 Windows 트레이 상주형 프린터 카운터 수집기이며, PyInstaller onefile 방식으로 `digix-collector.exe`로 패키징되어 있다.

구조 자체는 고객 PC 설치용 수집기로 적절하다. 다만 LAN 탐색 코드에 즉시 수정해야 하는 치명적 버그가 있고, 실제 운영 수준의 카운터 정확도를 확보하려면 SNMP OID 검증, 장비 식별 방식, 보안, 업로드 정책을 보강해야 한다.

현재 상태를 기준으로는 "참고용 프로토타입"으로 보는 것이 맞고, 그대로 배포용 기반으로 삼기에는 위험하다.

## 2. 실행 파일 정보

- 파일명: `digix-collector.exe`
- 크기: 18,142,316 bytes
- 빌드 방식: PyInstaller onefile, `--noconsole`
- SHA256: `4BF12CC48F6A09AE3C27CF9A307AC5C5AFD5B2953F98930EF8F95F6AD2C51743`
- 생성/수정 시각: 2026-05-31 16:55:46

## 3. 주요 파일과 역할

| 파일 | 역할 |
|---|---|
| `main.py` | 시작점. 페어링 확인 후 폴링 스레드와 트레이 UI 시작 |
| `config.py` | `%APPDATA%\digix-collector\config.json` 설정 저장 |
| `pairing.py` | `digix` 페어링 코드로 서버에서 token 발급 |
| `poller.py` | 5분 주기 수집 루프. SNMP/USB 결과를 서버로 업로드 |
| `discover.py` | LAN CIDR 자동 추정, ping/ARP/SNMP 장비 발견 |
| `snmp_client.py` | `puresnmp` 기반 SNMP GET 래퍼 |
| `brand_oids.py` | 표준/브랜드별 SNMP OID 정의 |
| `usb_printers.py` | Windows PowerShell/WMI로 로컬 프린터 조회 |
| `uploader.py` | Supabase Edge Function 호출 |
| `tray.py` | Windows 트레이 메뉴, 수동 업로드, LAN 진단, 자동시작 |
| `build.bat` | PyInstaller 빌드 스크립트 |

## 4. 동작 흐름

1. `main.py` 실행
2. `%APPDATA%\digix-collector\config.json`에서 token 확인
3. token이 없으면 `pairing.py`가 `pair-collector` API 호출
4. 성공 시 token과 collector_id 저장
5. 트레이 UI 실행
6. 백그라운드 스레드에서 10초 후 첫 수집 시작
7. 이후 5분마다:
   - LAN SNMP 장비 스캔
   - USB/로컬 프린터 조회
   - 카운터/토너/모델/시리얼 수집
   - `submit-reading` API로 업로드

## 5. 서버 연동 구조

Supabase Edge Functions:

- `POST https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/pair-collector`
- `POST https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/submit-reading`

DB 주요 테이블:

- `rental_collectors`: 고객 PC 단위 수집기 등록
- `rental_collector_devices`: 수집기가 발견한 프린터
- `rental_counter_readings`: append-only 카운터 원본 데이터

업로드 payload는 서버 코드와 대체로 일치한다.

## 6. 수집 데이터

장비 메타:

- `mac`
- `ip`
- `manufacturer`
- `model`
- `serial_snmp`
- `is_color`

카운터/상태:

- `bw`
- `color`
- `total_pages`
- `toner_k`
- `toner_c`
- `toner_m`
- `toner_y`
- `alert_text` 일부 USB 경로에서만 사용

## 7. SNMP OID

표준 OID:

- sysDescr: `1.3.6.1.2.1.1.1.0`
- 모델명: `1.3.6.1.2.1.25.3.2.1.3.1`
- 시리얼: `1.3.6.1.2.1.43.5.1.1.17.1`
- 총 카운터: `1.3.6.1.2.1.43.10.2.1.4.1.1`
- 토너 level/max: `1.3.6.1.2.1.43.11.1.1.9.1.N`, `1.3.6.1.2.1.43.11.1.1.8.1.N`

브랜드별로 HP, Canon, Brother, Kyocera, Sindoh, Xerox 일부 흑백/컬러 OID가 들어 있다. Epson/Samsung은 사실상 표준 total_pages 중심이다.

## 8. 치명적 문제

`discover.py`의 `_run`, `_check_output`이 자기 자신을 재귀 호출한다.

```python
def _run(cmd, **kw):
    return _run(cmd, creationflags=_NO_WINDOW, **kw)

def _check_output(cmd, **kw):
    return _check_output(cmd, creationflags=_NO_WINDOW, **kw)
```

이 코드는 다음처럼 되어야 한다.

```python
def _run(cmd, **kw):
    return subprocess.run(cmd, creationflags=_NO_WINDOW, **kw)

def _check_output(cmd, **kw):
    return subprocess.check_output(cmd, creationflags=_NO_WINDOW, **kw)
```

영향:

- `ipconfig` 기반 NIC 탐색 실패
- `ping` sweep 실패
- `arp` 조회 실패
- LAN 진단 메뉴 실패
- SNMP 장비 발견이 0대로 나오거나 루프 내부 에러가 누락될 가능성

## 9. 운영상 한계

- SNMP community 후보가 고정되어 있어 고객사 장비 설정에 따라 발견률이 낮을 수 있다.
- 브랜드별 흑백/컬러 OID는 모델별 차이가 커서 실장비 검증이 필요하다.
- USB 프린터의 `JobCountSinceLastReset`은 누적 페이지 카운터가 아니므로 정산 데이터로 쓰기 어렵다.
- MAC 주소를 얻지 못하면 `NOMAC-<ip>`를 쓰는데, IP 변경 시 같은 장비를 새 장비로 볼 수 있다.
- 페어링 코드 `digix`이 클라이언트와 서버에 하드코딩되어 있다.
- 서버의 `submit-reading`은 `pending` 상태 collector도 업로드 가능하다. 운영 정책에 따라 막거나 별도 표시가 필요하다.
- SNMP GET이 OID별 순차 호출이라 장비 수가 많으면 느려질 수 있다.
- 카운터 감소, 비정상 증가, 중복 수집, offline 처리 같은 품질 검증 로직이 부족하다.

## 10. 재사용할 부분

- Windows 트레이 상주 앱 구조
- `%APPDATA%` 기반 설정/로그 위치
- Supabase Edge Function 연동 방식
- `devices/readings` payload 구조
- 5분 주기 수집 루프
- PyInstaller onefile 배포 방식
- LAN 진단 메뉴 아이디어

## 11. 새 프로그램에서 개선할 부분

우선순위 1:

- `discover.py` 재귀 버그 수정
- SNMP 탐색/수집을 예외가 보이도록 로깅 강화
- 수동 진단 결과를 파일에도 저장
- 장비 식별 키를 MAC, serial, sysName, IP 조합으로 보강

우선순위 2:

- 장비별 OID 프로파일 구조화
- 실제 제조사/모델별 OID 테스트 데이터 축적
- 카운터 변화량 검증: 감소, 과도 증가, null 연속 발생
- offline 장비 처리
- 업로드 실패 시 로컬 큐 저장 후 재전송

우선순위 3:

- 고객별 페어링 코드 또는 일회성 등록 코드
- 설정 UI 또는 config 편집 도구
- Windows 서비스 방식 검토
- 설치/업데이트 방식 정리

## 12. 권장 개발 방향

처음부터 완전 재작성하기보다 다음 순서가 좋다.

1. 현재 Python 구조를 작업 폴더로 가져와 최소 수정판을 만든다.
2. LAN 탐색 버그를 고치고 로컬 진단 명령을 만든다.
3. 실제 네트워크에서 SNMP 발견률을 확인한다.
4. 카운터 수집 결과를 CSV/JSON으로 먼저 저장해 검증한다.
5. Supabase 업로드는 검증 후 연결한다.
6. 이후 트레이 UI와 자동시작을 붙인다.

이렇게 하면 "프린터를 찾는가", "카운터가 맞는가", "서버에 잘 들어가는가"를 단계별로 확인할 수 있다.

