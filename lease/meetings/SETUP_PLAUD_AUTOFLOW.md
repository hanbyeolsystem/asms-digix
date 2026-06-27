# Plaud AutoFlow 자동 연동 설정 가이드

Plaud 녹음기로 미팅을 녹음하면 5분 안에 음성미팅관리 모듈에 자동으로 기록됩니다.
Zapier 없이 **Gmail + Google Apps Script + Supabase** 만 사용합니다.

---

## 전체 흐름

```
Plaud 녹음기
    ↓ (전사 완료 후 자동 발송)
Gmail (acapaper78@gmail.com)
    ↓ (5분마다 폴링)
Google Apps Script
    ↓ (REST API POST)
Supabase rental_meetings
    ↓
음성미팅관리 모듈 자동 표시
```

---

## 단계 1. Plaud 앱 — 이메일 자동 발송 켜기

예상 소요시간: 3분

1. 스마트폰에서 **PLAUD.AI 앱** 실행
2. 하단 탭 **Profile(프로필)** 또는 **Settings(설정)** 진입
3. **Email Summary** 또는 **Email Delivery** 항목 찾기
4. 토글 **ON** 으로 변경
5. 수신 이메일 주소: `acapaper78@gmail.com` 입력
6. 포함 항목 체크:
   - Transcript (전사문) — 필수
   - AI Summary (요약) — 권장
7. 저장

[스크린샷 위치: PLAUD.AI 앱 Settings > Email Delivery 화면]

> **확인 방법**: 짧은 녹음 1건 진행 후 10분 내 acapaper78@gmail.com 으로 메일이 오면 정상.

---

## 단계 2. Gmail 필터 설정 — 라벨 자동 부여

예상 소요시간: 2분

Gmail에 'Plaud' 라벨이 있어야 Apps Script 가 빠르게 찾을 수 있습니다.
(없어도 동작하지만, 발신 주소 검색이 느릴 수 있음)

1. Gmail (PC 또는 모바일 웹) 접속
2. 검색창 오른쪽 **설정 아이콘(필터 만들기)**
3. **보낸사람** 필드에 입력:
   ```
   plaud.ai
   ```
4. **필터 만들기** 클릭
5. **라벨 적용** 체크 → **새 라벨** → `Plaud` 입력
6. **필터 만들기** 완료

[스크린샷 위치: Gmail 필터 설정 화면]

> Apps Script 가 `label:Plaud is:unread` 로 검색합니다.
> 라벨 미설정 시 `from:plaud.ai is:unread newer_than:2d` 로 폴백 동작합니다.

---

## 단계 3. Google Apps Script 배포

예상 소요시간: 5분

### 3-1. 새 프로젝트 만들기

1. PC 브라우저에서 https://script.google.com 접속
2. **새 프로젝트** 클릭
3. 프로젝트 이름: `Plaud-AutoFlow-Bridge` (아무 이름이나 가능)

### 3-2. 코드 붙여넣기

1. 편집기 왼쪽 `Code.gs` 파일 클릭
2. 기존 내용 **전체 삭제**
3. `임대관리/meetings/plaud-autoflow-bridge.gs` 파일 내용 **전체 복사**해서 붙여넣기

[스크린샷 위치: Apps Script 편집기 화면]

### 3-3. Supabase Anon Key 입력

파일 상단 2번째 상수를 채웁니다.

```javascript
var SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY_HERE';
```

Anon Key 확인 방법:
- https://supabase.com/dashboard/project/wghjnlhfqypamiwukeio/settings/api
- **Project API keys** 섹션 > **anon public** 값 복사

> SUPABASE_URL 은 이미 입력되어 있습니다: `https://wghjnlhfqypamiwukeio.supabase.co`

### 3-4. 트리거 설치 (1회만)

1. 편집기 상단 함수 선택 드롭다운에서 **`installTrigger`** 선택
2. **실행(▶)** 클릭
3. **Google 권한 허용** 팝업 → `acapaper78@gmail.com` 선택 → **고급** → **Plaud-AutoFlow-Bridge(안전하지 않음)로 이동** → **허용**

[스크린샷 위치: 권한 허용 팝업]

### 3-5. 트리거 확인

1. 왼쪽 **시계 아이콘(트리거)** 클릭
2. `processPlaudEmails` 함수가 **5분마다** 실행으로 등록되어 있으면 완료

---

## 단계 4. 첫 테스트

예상 소요시간: 10분

1. Plaud 로 짧은 녹음 1건 진행 (30초 이상)
2. 전사 완료 대기 (보통 2~5분)
3. acapaper78@gmail.com 으로 이메일 수신 확인
4. 최대 5분 대기 (Apps Script 트리거 간격)
5. 음성미팅관리 모듈 접속 → 좌측 리스트에 **🤖 자동 import** 뱃지와 함께 미팅 등장

> 미팅이 나타나면 우측 패널에서 거래처를 수동으로 지정해주세요.
> 거래처 지정 전까지는 **❓ 미분류** 상태로 표시됩니다.

---

## 자주 발생하는 문제

### Q. 5분이 지났는데 미팅이 안 나와요.

1. Apps Script 편집기 > **`testRun`** 함수 실행
2. **실행 로그** 확인 (하단 패널)
3. 아래 메시지 중 해당하는 것 확인:
   - `처리 대상 스레드: 0건` → Gmail 라벨 또는 발신 주소 필터 문제
   - `INSERT 실패: [HTTP 401]` → SUPABASE_ANON_KEY 미입력
   - `INSERT 실패: [HTTP 409]` → 중복 메시지 (정상, 이미 저장됨)

### Q. Gmail 라벨 'Plaud' 를 못 찾아요.

단계 2 Gmail 필터를 건너뛰어도 동작합니다.
Apps Script 가 `from:plaud.ai is:unread` 로 폴백 검색합니다.

### Q. 권한 오류가 납니다.

- 오류 메시지: `Exception: You do not have permission to call GmailApp.search`
- 해결: `installTrigger()` 를 다시 실행하고 권한 허용 화면에서 모든 항목 허용

### Q. customer_id 가 NULL 이에요. (거래처 미지정)

정상입니다. Apps Script 는 텍스트 매칭을 하지 않고 미팅만 생성합니다.
음성미팅관리 모듈에서 해당 미팅 선택 → 노란 알림 박스 → 거래처 검색해서 직접 지정하세요.

### Q. 전사문과 요약문이 분리가 안 되고 하나로 합쳐져요.

Plaud 이메일 본문 구조에 따라 파싱 방식이 달라집니다.
첫 수신 이메일을 Claude Code 에 공유하면 파싱 로직을 정교하게 조정해드립니다.
(`plaud-autoflow-bridge.gs` 파일의 `_parseBody` 함수 수정)

### Q. 같은 미팅이 두 번 들어왔어요.

`plaud_message_id` (Gmail 메시지 ID) 를 UNIQUE 키로 중복 방지합니다.
두 번째 시도는 `[HTTP 409]` 로 자동 차단됩니다.

---

## 운영 메모

- Apps Script 무료 플랜 실행 제한: 하루 6분 / 월 90분. 미팅이 하루 수십 건 이상이면 Google Workspace 계정 필요.
- 트리거 중지: Apps Script > 시계 아이콘 > 해당 트리거 삭제 또는 `uninstallTrigger()` 실행.
- 이메일 재처리: Gmail 에서 해당 메일을 **읽음 취소(안읽음)** 으로 변경하면 다음 폴링 때 재처리.
