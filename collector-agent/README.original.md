# 디직스 카운터 수집기 (digix-collector)

고객 PC 에 설치되어 LAN 내 프린터의 카운터/토너 정보를 5분마다 디직스 서버로 자동 업로드합니다.

## 지원 브랜드
HP · Canon · Epson · Brother · Kyocera(교세라) · Samsung · Sindoh(신도) · Xerox

## 개발 환경

Python 3.10+ (Windows)

```cmd
cd collector-agent
pip install -r requirements.txt
python main.py
```

## EXE 빌드

```cmd
build.bat
```

→ `dist\digix-collector.exe` 생성.

## 고객 설치 흐름

1. `digix-collector.exe` 더블클릭
2. 첫 실행 → "페어링 코드 입력" 다이얼로그 → `digix` 입력
3. 트레이에 상주, 자동으로 5분마다 SNMP 폴링 + 업로드
4. (선택) Windows 시작 시 자동 실행 등록은 트레이 메뉴에서

## 데이터 저장 위치 (고객 PC)

- 설정: `%APPDATA%\digix-collector\config.json`
- 로그: `%APPDATA%\digix-collector\agent.log`

## 트러블슈팅

| 증상 | 확인 |
|---|---|
| 페어링 안 됨 | 인터넷 / 방화벽이 supabase.co 차단? |
| 장비 발견 0 | 같은 LAN 인지? SNMP community 가 `public` 인지? |
| 컬러 카운트 0 | `brand_oids.py` 의 해당 브랜드 OID 확인 (모델별 다를 수 있음) |
| 업로드 실패 | `agent.log` 확인 |

자세한 가이드는 [`CLAUDE.md`](CLAUDE.md) 참조.
