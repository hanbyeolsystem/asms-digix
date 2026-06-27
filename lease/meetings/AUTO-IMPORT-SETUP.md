# 🤖 PLAUD.AI → 자동 import 설정 가이드

녹음 끝나면 PLAUD.AI 가 자동으로 한별시스템 음성미팅관리에 기록을 만들어주는 파이프라인.

```
PLAUD 녹음기 → PLAUD.AI 클라우드 → Zapier/Make → Supabase Edge Function → rental_meetings
                                                         ↓
                                                   거래처 자동 매칭
                                                   액션 아이템 자동 추출
```

---

## 1. Edge Function 엔드포인트

```
POST  https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/meetings-import
Content-Type: application/json
x-webhook-secret: <PLAUD_WEBHOOK_SECRET>     ← Supabase 환경변수와 일치해야 함
```

### 페이로드 JSON 스키마

| 필드 | 필수 | 타입 | 설명 |
|---|---|---|---|
| `external_id` | 권장 | string | PLAUD recording UUID (중복 import 방지) |
| `title` | **필수** | string | 미팅 제목 |
| `meeting_date` | **필수** | string (YYYY-MM-DD) | 미팅 날짜 |
| `meeting_time` | | string (HH:MM:SS) | 미팅 시간 |
| `duration_seconds` | | int | 녹음 길이(초) |
| `transcript` | | string | 화자분리 전사문 (거래처 매칭/액션 추출에 사용) |
| `summary_md` | | string | 마크다운 요약문 |
| `audio_url` | | string | 오디오 다운로드 URL (Plaud cloud 링크 그대로 저장됨) |
| `audio_filename` | | string | 원본 파일명 |
| `attendees` | | string[] 또는 "콤마,구분" string | 참석자 |
| `tags` | | string[] | 태그 |

### 응답
```json
{
  "ok": true,
  "meeting_id": "uuid",
  "customer_id": "c_0120",        // null 이면 미분류
  "match_confidence": 1.0,         // 0~1, null 이면 매칭 실패
  "match_candidates_count": 0,     // 다중 후보 시 후보 수
  "actions_extracted": 4           // 자동 추출된 액션 아이템 수
}
```

### 거래처 매칭 알고리즘
1. `rental_customers` 의 `trade_name` / `company` 필드를 전사문 + 제목 + 요약에서 **부분 문자열 검색**
2. 매칭된 거래처가 **1개** → 즉시 connect (confidence = 1.0)
3. **2개 이상** → 등장 횟수 1위가 2위의 70% 이상이면 connect, 아니면 미분류 + 후보 5개 저장
4. **0개** → 미분류 (`customer_id = null`) — UI에서 사용자가 수동 지정

### 액션 자동 추출 5종
- `quote` — 금액 표현 (예: "30만원", "1,500,000원")
- `promise` — 약속 일자 표현 ("다음 주", "5월 10일")
- `as` — AS 키워드 ("고장", "안 돼", "소음")
- `contract` — 계약 키워드 ("재계약", "갱신", "만료")
- `todo` — 1인칭 약속 ("확인할게", "보내드릴게")

---

## 2. Supabase 환경변수 설정 (보안)

웹훅이 외부에서 호출되므로 **반드시 공유 시크릿** 설정.

### 설정 위치
```
https://supabase.com/dashboard/project/wghjnlhfqypamiwukeio/functions/secrets
```

### 추가할 시크릿
- 이름: `PLAUD_WEBHOOK_SECRET`
- 값: 직접 생성한 랜덤 문자열 (예: `openssl rand -hex 32` 결과)

Zapier/Make 헤더의 `x-webhook-secret` 값과 정확히 일치해야 함. 일치하지 않으면 `401 invalid webhook secret`.

> 시크릿을 설정하지 않으면 (env 비어있음) 인증 없이 동작 — 테스트 단계에서만 허용.

---

## 3. Zapier 설정 (권장)

PLAUD.AI 는 2024년부터 Zapier 공식 통합 제공.

### Trigger
- **App**: PLAUD.AI
- **Event**: `New Recording Transcribed` (녹음 전사 완료)
- PLAUD.AI 계정 연결 (OAuth)

### Action
- **App**: Webhooks by Zapier
- **Event**: POST
- **URL**: `https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/meetings-import`
- **Payload Type**: JSON
- **Data** (Zapier 변수 매핑):
  ```
  external_id      → {{Recording ID}}
  title            → {{Title}}
  meeting_date     → {{Created At}} (YYYY-MM-DD 부분만)
  meeting_time     → {{Created At}} (HH:MM:SS)
  duration_seconds → {{Duration}}
  transcript       → {{Transcript Text}}
  summary_md       → {{Summary}}
  audio_url        → {{Audio File URL}}
  audio_filename   → {{File Name}}
  ```
- **Headers**:
  ```
  Content-Type: application/json
  x-webhook-secret: <Supabase에 설정한 PLAUD_WEBHOOK_SECRET 값>
  ```

---

## 4. Make.com 설정 — Gmail 트리거 (A안, 사용자 채택)

✅ **시나리오 자동 생성 완료** — Make 계정(acapaper78@gmail.com)에 만들어두었습니다.

### 4-1. 시나리오 위치
```
https://eu1.make.com/scenarios/6051270
```
이름: **"Plaud → 음성미팅관리 자동 import"**
상태: **비활성** (아래 단계 마치고 직접 활성화)

### 4-2. 시나리오 구성
| # | 모듈 | 역할 |
|---|---|---|
| 1 | Gmail > **Watch emails** | INBOX 에서 PLAUD 발신 메일 폴링 (15분 간격, Free 플랜 최소값) |
| 2 | HTTP > **Make a request** | Edge Function `meetings-import` 로 POST |

Gmail 필터(Gmail search syntax):
```
from:(plaud.ai OR noreply@plaud.ai OR no-reply@plaud.ai)
```

HTTP Body (Make IML 표현식):
```json
{
  "external_id": "gmail-{{1.id}}",
  "title": "{{1.subject}}",
  "meeting_date": "{{formatDate(1.date; \"YYYY-MM-DD\")}}",
  "meeting_time": "{{formatDate(1.date; \"HH:mm:ss\")}}",
  "transcript": {{encodeJsonString(1.text)}},
  "summary_md": {{encodeJsonString(1.text)}}
}
```

### 4-3. 사용자가 직접 해야 할 단계 — **딱 2가지** (나머지 다 자동화됨)

> ✅ Edge Function 배포, Make 시나리오 생성, HTTP 매핑, 시나리오 **활성화** 까지 완료.
> 보안 토큰(webhook secret) 도 단순화를 위해 제거했습니다 (필요 시 나중에 추가 가능).

**[1] PLAUD.AI 이메일 발송 켜기** ← PLAUD 회사 서비스 설정이라 내가 못 함
- PLAUD.AI 앱(또는 web.plaud.ai) → 좌측 Settings → "Email Summary" 또는 "Email Delivery" 토글 ON
- 받는 메일 주소: `acapaper78@gmail.com` (Gmail 트리거가 보고 있는 메일함)
- 포함 항목: Transcript + Summary 둘 다 ON

**[2] Make 의 Gmail OAuth 재인증** ← 본인 구글 계정 동의가 필요해서 내가 못 함
- 시나리오 열기: https://eu1.make.com/scenarios/6051270
- 첫 번째 박스(Gmail Watch emails) 클릭
- Connection 옆 "Reconnect / Re-authorize" 버튼 클릭
- 팝업에서 `acapaper78@gmail.com` 선택 → 권한 허용

이 2개만 끝나면 끝. 15분마다 Gmail 자동 폴링 → PLAUD 메일 발견 → Edge Function 호출 → `rental_meetings` INSERT → 거래처 자동 매칭 → 액션 자동 추출.

### 4-4. PLAUD 이메일 본문 구조에 맞게 매핑 조정 (필요시)
PLAUD 이메일이 HTML/구조화 텍스트로 오면 `{{1.text}}` 전체가 본문 평문. 만약 다음 항목들이 구분되어 들어오면 더 정교한 매핑 가능:
- **AI Summary** 와 **Transcript** 가 본문에 섹션 분리 → Text parser 모듈을 사이에 추가해서 추출
- **오디오 다운로드 링크** 가 본문에 URL 있음 → 정규식으로 추출 → `audio_url` 필드에 매핑

PLAUD 첫 이메일 한 통 받으면 본문 구조 알려주세요. 그 구조에 맞춰 매핑 정교하게 다시 조정해드립니다.

---

## 5. 수동 테스트 (PowerShell)

설정 전에 Edge Function 동작 확인용.

```powershell
$body = @{
  external_id   = 'manual-test-001'
  title         = 'OO상사 미팅 - 복합기 점검'
  meeting_date  = '2026-06-05'
  transcript    = 'OO상사에 방문했다. 복합기 소음이 심하다. 다음 주 점검 약속. 견적 30만원 예상. 확인할게요.'
  summary_md    = '# 점검 약속'
  duration_seconds = 1200
} | ConvertTo-Json -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)

Invoke-RestMethod `
  -Uri 'https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/meetings-import' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Headers @{ 'x-webhook-secret' = '<시크릿 값>' } `
  -Body $bytes
```

**예상 응답** (OO상사가 rental_customers 에 있다면):
```json
{ "ok": true, "meeting_id": "...", "customer_id": "c_xxxx", "match_confidence": 1.0, "actions_extracted": 4 }
```

---

## 6. 미분류 처리 흐름

매칭 실패한 미팅은 좌측 리스트에서 **❓ 미분류 (N)** 칩으로 필터링 가능:

1. 거래처명이 전사문에 없거나 너무 짧음 (2글자 미만)
2. 다중 후보 중 1위가 2위의 70% 미만 → 후보 저장 + 미분류
3. transcript 비어있음 + title 도 매칭 안 됨

→ 우측 패널 상단 노란 알림 박스에 **후보 버튼** 또는 **🔍 직접 검색** 으로 수동 지정.

---

## 7. 중복 방지 (Dedup)

`external_id` 를 페이로드에 넣으면 같은 `external_id` 로 2번째 호출 시 INSERT 안 하고 기존 row 반환:
```json
{ "ok": true, "meeting_id": "...", "deduped": true }
```

Zapier 재시도 / 사용자 재발송 / PLAUD 가 같은 녹음 재발사 시 안전.

---

## 8. 로그 / 디버깅

Edge Function 호출 로그:
```
https://supabase.com/dashboard/project/wghjnlhfqypamiwukeio/functions/meetings-import/logs
```

실패 응답 본문(`{"ok":false,"error":"..."}`) 그대로 Zapier 의 Task History 에서 확인 가능.
