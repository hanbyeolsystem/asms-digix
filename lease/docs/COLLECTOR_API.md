# 한별 카운터 수집기 ↔ 한별 서버 연동 API

> 본 문서는 **장비관리 페이지** 와 **고객프로그램(클라이언트 EXE)** 의 재구축을 위한
> 서버측 인터페이스 명세입니다. 클라이언트(웹/네이티브)는 어떻게 만들든 본 API 스펙만
> 지키면 한별 서버와 호환됩니다.

## 0. 공통

| 항목 | 값 |
|---|---|
| Supabase URL | `https://wghjnlhfqypamiwukeio.supabase.co` |
| Anon (publishable) key | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnaGpubGhmcXlwYW1pd3VrZWlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTYyODAsImV4cCI6MjA5NjczMjI4MH0.sOjiDveMGn_uIt6fzu4fqQtlDwNWkkoXWrz6gxy0XZg` |
| RLS 정책 | 인증된(authenticated) 사용자 전체 권한. 로그인된 한별 운영자만 직접 접근 가능 |
| 페어링 코드 | **고정 `hanbyeol`** (모든 고객 공통, 향후 변경 시 본 문서 + Edge Function 동시 수정) |
| 메인 totalas 리포 | https://github.com/hanbyeolsystem/totalas |

---

## 1. Supabase 테이블 스키마

### 1-1. 기존 임대관리 코어 (참고)
- `rental_customers` — 거래처 마스터 (id `c_XXXX`, company, contact, address ...)
- `rental_items` — 자산 마스터 (id `it_XXXX`, brand, model, serial, status, toner_pct)
- `rental_assignments` — 거래처-자산 매핑 (item_id, customer_id, monthly_fee, bw_free, ...)
- `rental_counters` — 월별 누적 카운터 (item_id, ym, bw, color)

### 1-2. 실시간 수집기 (collector-agent 연동)

#### `rental_collectors` — PC 단위 에이전트 등록
| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | UUID PK | gen_random_uuid() |
| customer_id | TEXT FK rental_customers(id) ON DELETE SET NULL | NULL=매핑 전, 한별이 장비관리 페이지에서 매핑 |
| pc_name | TEXT | 호스트네임 |
| os_user | TEXT | Windows 사용자 |
| agent_version | TEXT | EXE 버전 |
| token | TEXT UNIQUE NOT NULL | submit-reading 인증용 |
| status | TEXT DEFAULT 'pending' | pending / active / disabled |
| last_seen_at | TIMESTAMPTZ | 최근 heartbeat |
| paired_at | TIMESTAMPTZ DEFAULT now() | |
| notes | TEXT | |
| created_at / updated_at | TIMESTAMPTZ | |

인덱스: `idx_rcl_customer`, `idx_rcl_status`, `idx_rcl_seen`

#### `rental_collector_devices` — collector 가 발견한 프린터
| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | UUID PK | |
| collector_id | UUID FK rental_collectors ON DELETE CASCADE | |
| item_id | TEXT FK rental_items ON DELETE SET NULL | 매핑 후 채움 (자산 마스터와 연결) |
| ip | INET | |
| mac | TEXT | USB 는 `USB:<HOSTNAME>:<PRINTERNAME>` 형식 권장 |
| manufacturer | TEXT | sysDescr 파싱 결과 (hp/canon/kyocera/...) 또는 `USB` |
| model | TEXT | |
| serial_snmp | TEXT | |
| is_color | BOOLEAN | |
| first_seen_at / last_seen_at | TIMESTAMPTZ | |
| online | BOOLEAN DEFAULT TRUE | |
| **hidden** | BOOLEAN DEFAULT FALSE | 장비관리 페이지 ✕ 로 숨김 (34) |
| **registered** | BOOLEAN DEFAULT FALSE | scan_ui 에서 명시 체크된 장비만 TRUE (35) |
| **registered_at** | TIMESTAMPTZ NULL | 최초 등록 시각 (재등록 시 보존) |
| notes | TEXT | |

**UNIQUE (collector_id, mac)** — 동일 collector 가 같은 장비를 중복 등록 못 함

#### `rental_counter_readings` — 실시간 raw 카운터 (append-only)
| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | BIGSERIAL PK | |
| device_id | UUID FK rental_collector_devices ON DELETE CASCADE | |
| bw | INTEGER | 흑백 누적 |
| color | INTEGER | 컬러 누적 |
| total_pages | INTEGER | 총 누적 |
| toner_k / c / m / y | INTEGER | 0~100 % |
| drum_pct | INTEGER | |
| alert_text | TEXT | SNMP prtAlertDescription 또는 클라 메모 |
| read_at | TIMESTAMPTZ DEFAULT now() | |

인덱스: `idx_rcr_device_time (device_id, read_at DESC)`

#### SQL 파일
- `tools/sql/33_collector_init.sql` — 위 3개 테이블 일괄 생성 (Supabase 적용 완료)
- `tools/sql/34_collector_device_hidden.sql` — hidden 컬럼 (장비관리 ✕ 숨김)
- `tools/sql/35_collector_device_registered.sql` — **registered / registered_at 컬럼** (사용자 명시 등록)

---

## 2. Edge Functions

> 두 함수 모두 `verify_jwt=false` (커스텀 인증). Supabase 자동 JWT 검증 없이
> 함수 본문에서 페어링 코드 / Bearer token 직접 검증.

### 2-1. `POST /functions/v1/pair-collector`

EXE 첫 실행 시 페어링.

**요청**
```http
POST https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/pair-collector
Content-Type: application/json

{
  "pairing_code":  "hanbyeol",
  "pc_name":       "DESKTOP-ABC123",
  "os_user":       "사용자",
  "agent_version": "0.1.1"
}
```

**응답 (200)**
```json
{ "collector_id": "<uuid>", "token": "<uuid-uuid>" }
```

**오류**
- 401 `{ "error": "invalid pairing code" }` — 코드 불일치
- 400 `{ "error": "invalid json" }`
- 500 `{ "error": "<DB 에러 메시지>" }`

내부 동작: rental_collectors 에 `status='pending'`, customer_id=NULL 로 INSERT. 한별 관리자가 장비관리 페이지에서 거래처 매핑 후 `status='active'` 로 업데이트.

### 2-2. `POST /functions/v1/submit-reading`

수집기 **백그라운드 폴링(5분 주기)** 정기 업로드.

> ⚠ **변경 (2026-06-02, 35 적용 이후)**:
> readings 는 `registered=TRUE AND hidden=FALSE` 인 device 에 한해 INSERT.
> 미등록 / 숨김 device 는 메타 update 도 하지 않고 readings 폐기.
> 신규 device INSERT 는 더 이상 이 endpoint 의 책임이 아님 (→ `register-devices` 사용).

**요청**
```http
POST https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/submit-reading
Content-Type: application/json
Authorization: Bearer <token>

{
  "devices": [
    {
      "mac": "AA:BB:CC:11:22:33",
      "ip": "192.168.1.10",
      "manufacturer": "Kyocera",
      "model": "TASKalfa 251ci",
      "serial_snmp": "ABCD1234",
      "is_color": true
    }
  ],
  "readings": [
    {
      "mac": "AA:BB:CC:11:22:33",
      "bw": 12345,
      "color": 6789,
      "total_pages": 19134,
      "toner_k": 80,
      "toner_c": 65,
      "toner_m": 70,
      "toner_y": 75,
      "drum_pct": null,
      "alert_text": null
    }
  ]
}
```

**응답 (200)**
```json
{
  "ok": true,
  "collector_id": "<uuid>",
  "devices_updated":    1,
  "readings_inserted":  1,
  "readings_skipped":   0,
  "unregistered_macs":  []
}
```

**오류**
- 401 `{ "error": "no token" }` / `{ "error": "invalid token" }`
- 403 `{ "error": "disabled" }` — status=disabled 인 수집기
- 400 / 500 — JSON 오류 / DB 오류

내부 동작 (35 이후):
1. token → collector 조회 (없으면 401)
2. `rental_collectors.last_seen_at = now()` 업데이트
3. 이 collector 의 등록된(registered=TRUE AND hidden=FALSE) device mac 목록 조회
4. devices 배열 중 등록된 mac 만 메타(ip/model/last_seen/online) update — 미등록은 unregistered_macs 에 수집(최대 100건 응답)
5. readings 배열을 INSERT — 등록된 mac 만, 나머지는 readings_skipped 카운트
6. 결과 카운트 반환

### 2-3. `POST /functions/v1/register-devices`  *(2026-06-02 신설)*

scan_ui("선택 항목 업로드") → 체크된 장비를 장비관리에 명시적으로 등록.

**요청**
```http
POST https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/register-devices
Content-Type: application/json
Authorization: Bearer <token>

{
  "devices": [
    { "mac": "AA:BB:CC:11:22:33", "ip": "192.168.1.10", "manufacturer": "Kyocera",
      "model": "TASKalfa 251ci", "serial_snmp": "ABCD1234", "is_color": true }
  ],
  "readings": [
    { "mac": "AA:BB:CC:11:22:33", "bw": 12345, "color": 6789, "total_pages": 19134,
      "toner_k": 80, "toner_c": 65, "toner_m": 70, "toner_y": 75 }
  ]
}
```

**응답 (200)**
```json
{
  "ok": true,
  "collector_id": "<uuid>",
  "newly_registered":   1,   // 처음 등록된 장비
  "already_registered": 0,   // 이미 등록되어 있던 장비 (중복 차단)
  "readings_inserted":  1,
  "registered_macs":    ["AA:BB:CC:11:22:33"]
}
```

내부 동작:
1. token → collector (disabled 면 403)
2. heartbeat
3. 각 device 별 (collector_id, mac) upsert:
   - 신규 INSERT → `registered=TRUE, registered_at=now(), hidden=FALSE`
   - 기존 + registered=FALSE → UPDATE `registered=TRUE, registered_at=now()` (재등록)
   - 기존 + registered=TRUE → 메타만 update, `registered_at 보존` (중복 차단, `already_registered++`)
   - 기존 + hidden=TRUE → `hidden=FALSE` 로 풀고 등록 (사용자 명시 의도 우선)
4. readings INSERT (등록된 device 만)
5. 결과 + registered_macs 반환 (클라이언트가 캐시 가능)

**중복 차단**: 같은 (collector_id, mac) 을 두 번 등록 요청해도 첫 번째만 newly, 두 번째 이후는 already 로 카운트. UNIQUE 제약으로 자연스럽게 보장.

### 2-4. 향후 추가 예정 함수
- `GET /functions/v1/list-customers` — 페어링 코드로 인증 후 거래처 목록 반환. EXE 가 거래처 드롭다운 표시할 때 사용
- pair-collector 확장: 요청 body 에 `customer_id` 추가 받으면 곧바로 `status='active'` 로 매핑

---

## 3. 권장 클라이언트 동작 흐름

### EXE (collector-agent)
1. **첫 실행**: pair-collector 호출 → token 저장 (영구)
2. **장비 등록** (사용자 인터랙티브):
   - 트레이 → LAN 스캔 → 한별 제품 체크박스 선택 → "선택 항목 업로드"
   - `register-devices` 호출 → 서버가 (collector_id, mac) 기준 중복 차단 + registered=TRUE 마킹
3. **백그라운드 폴링** (5분 권장):
   - LAN SNMP 스캔 + 로컬 USB 프린터(WMI) 수집
   - `submit-reading` 호출 — 모든 발견 장비 송신해도 서버가 미등록 readings 자동 폐기
   - **컴퓨터 재부팅 후에도 등록된 장비만 카운터가 갱신됨**
4. 토큰은 `%APPDATA%\hanbyeol-collector\config.json` 또는 동등 위치
5. 페어링 코드는 클라이언트에 박지 말고 첫 실행 시 입력받기 권장

### 장비관리 페이지 (웹)
- 현재 임대관리 사이트 (`asms.html` 해시 라우팅) 안에서 `rental-equipment/index.html` 로 동작
- Supabase publishable key + 인증된 운영자 세션 사용 (auth.js)
- 핵심 화면: 자산 리스트 (rental_items + 최신 reading 머지) + 수집기 패널 + 신규 매핑 모달
- 엑셀 다운로드 / 메일 발송 시점 설정 / 거래처 매핑 UI 권장

---

## 4. 보안 메모

- 페어링 코드 `hanbyeol` 은 누구나 호출 가능 → 누구나 collector 등록 가능 (트레이드오프 인지)
- 등록만으로는 데이터 매칭 안 됨 (customer_id NULL, status=pending)
- 한별 관리자가 장비관리 페이지에서 매핑할 때까지 실제 자산과 연결되지 않음
- 향후 보안 강화 시: 고객별 1회용 페어링 코드 발급 시스템 또는 `list-customers` 인증 강화 검토

---

## 5. 변경 이력

| 일자 | 항목 | 비고 |
|---|---|---|
| 2026-05-31 | 초기 스키마 + Edge Function 2개 + 페어링 코드 hanbyeol 확정 | Phase A.1/A.2 완료 |
| 2026-05-31 | 본 문서 정리 — 클라이언트 재구축 위한 인터페이스 보존 | |
| 2026-06-02 | **35 + register-devices + submit-reading 정책 변경**: 사용자 명시 등록 장비만 readings 저장. scan_ui 체크박스 흐름 정식화. 페이지도 registered=TRUE 만 표시. | |
