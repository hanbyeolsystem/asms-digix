# 📇 명함관리 모듈 — 설치 가이드

기존 `임대관리` 시스템(asms.html)에 통합되는 명함관리 모듈입니다.
사이드바 "📇 명함관리" 메뉴가 이미 이 폴더를 가리키고 있어, **DB 설정만 마치면 즉시 동작**합니다.

## 구성 파일
- `index.html` — 모듈 본체 (업로드 → OCR → 거래처 매칭 → 그룹 → 발송)
- `quick.html` — 📱 핸드폰 빠른 입력 전용 페이지 (사진 한 장 → 자동 저장)
- `schema.sql` — Supabase 테이블/뷰/RLS/기본그룹 (1회 실행)
- `deploy-business-cards.bat` — GitHub Pages 배포 헬퍼 (Windows)
- `README.md` — 이 파일

## 📱 핸드폰 빠른 입력 (`quick.html`)
한 손 조작 최적화된 모바일 전용 페이지입니다.
- 큰 [📷 명함 촬영] 버튼 → 폰 카메라 즉시 열림
- 촬영 즉시 Storage 업로드 + OCR → 폼 자동 채움
- 거래처 자동 매칭 결과 표시 (기존 거래처 / 신규)
- 수신동의 토글 (기본 OFF)
- [저장하고 다음 명함] 버튼 → 저장 + 카메라 자동 재진입
- 첫 진입 시 ⚙️ 에서 OpenAI 키 1회 설정

직접 URL: `https://hanbyeolsystem.github.io/totalas/business-cards/quick.html`
(로그인 필요 — 비로그인 시 로그인 페이지로 안내)

## 설치 (3단계)

### 1단계 — DB 테이블 생성
1. Supabase Dashboard 접속 → 프로젝트(`wghjnlhfqypamiwukeio`) → **SQL Editor**
2. `schema.sql` 전체 내용을 붙여넣고 **Run**
3. `business_cards`, `card_groups`, `card_group_map`, `card_send_logs`, `card_templates` 테이블과 `sendable_cards` 뷰가 생성됩니다. 기본 그룹 12개도 자동 입력됩니다.

### 2단계 — 명함 이미지 저장소(선택)
- Supabase → **Storage** → New bucket → 이름 `business-cards`, Public **OFF**
- (버킷이 없어도 모듈은 동작하며, 이미지 없이 텍스트만 저장됩니다)

### 3단계 — OCR API 키 입력 (Google Gemini · 무료)
1. https://aistudio.google.com/app/apikey 접속 → "Create API key" → 키 복사 (`AIzaSy...` 형식)
   - **결제 카드 등록 불필요**, 무료 tier 로 발급 가능 (분당 15회, 일 1,500회 — 명함 입력 용도엔 충분)
2. asms.html에서 "📇 명함관리" 메뉴 클릭 → 우측 상단 **⚙️** 버튼 → 키 붙여넣기 → 저장
   - 모바일이면 `quick.html` 에서 ⚙️ → 키 입력
   - 키는 **이 브라우저에만** 저장됩니다(localStorage). 서버 전송 없음.
   - 기본 모델: `gemini-2.5-flash` (속도/정확도 균형). 더 빠르게 원하면 `gemini-2.5-flash-lite` 도 사용 가능.

## 사용법
1. **＋ 명함 추가** → 사진 업로드(또는 드래그) → AI가 자동으로 필드 추출
2. 추출 결과 확인/수정 → **수신동의** 체크(받은 경우만) → 저장
3. 저장 시 기존 거래처(`rental_customers`)와 **자동 매칭**:
   - 사업자번호 / 이메일 도메인 / 회사명 순으로 동일 거래처 판정 → 자동 묶음
   - 유사 회사는 확인창 표시, 신규는 상단에 **🆕 신규** 배지로 노출
4. 회사별 **🏷 그룹 지정** (제조/NAS구축/견적진행 등)
5. **📨 그룹 발송** → 그룹 선택 → 대상 확인 → 발송
   - **수신동의자 + 이메일 보유자만** 자동 필터링
   - 야간(21~08시) 광고 발송 자동 차단
   - 본문에 `(광고)` 표기 + 무료수신거부 안내 자동 삽입

## ⚠️ 발송 컴플라이언스 (중요)
영리 목적 광고성 메시지는 **정보통신망법 §50**에 따라 사전 수신동의자에게만 발송 가능합니다.
명함을 받았다는 사실만으로는 동의가 아닙니다. 상담/거래 과정에서 명시적 동의를 받고 체크하세요.
거래·서비스 안내 등 정보성 메시지는 광고가 아니므로 예외입니다.

## 🔁 자동 동기화 (주기적 import + 보정)

✅ **2026-06-16 운영 적용 완료** — DB 마이그레이션 / Edge Function `cards-sync` 배포 / `pg_cron` 잡 등록 모두 자동 설치됨. 별도 절차 없이 바로 사용 가능.

### 동기화가 하는 일
1. `business-cards/imports/` 폴더에 쌓인 JSON 파일을 모두 처리
   - 핸드폰 정규화 값(`phone_norm`) 으로 중복 판정 → 같으면 빈 필드만 채우기
   - 신규는 그대로 insert (수신동의 OFF, 회사명/도메인 자동 정규화)
   - 처리 끝난 파일은 `imports/processed/YYYY-MM-DD_원본파일명.json` 으로 자동 이동
2. `customer_id` 가 비어있는 명함을 `rental_customers` 와 다시 매칭
   - 우선순위: 사업자번호 → 이메일 도메인(공용 도메인 제외) → 회사명 정규화 정확매칭
   - 매칭 성공 시 `pending_group_ids` 에 들어 있던 그룹도 `card_group_map` 으로 자동 승격
3. `company_normalized` / `email_domain` 비어있는 행 일괄 보정
4. 결과를 `card_import_runs` 테이블에 기록

### 트리거 두 가지
- **매일 03:30 KST** — `pg_cron` 잡 `business-cards-daily-sync` 가 자동 실행
- **즉시** — 명함관리 헤더 [🔁 자동 동기화] 버튼 → "확인=JSON 업로드 후 동기화" 또는 "취소=보정만"

### 리멤버 명함 export 받는 법
리멤버는 공식 API 가 없어 export 는 수동입니다:
1. 리멤버 앱 → 설정 → 내 명함첩 백업/내보내기 → JSON 또는 CSV 받기
2. CSV 인 경우 JSON 배열로 변환 (필드: `name`, `company`, `title`, `department`, `phone_mobile`, `phone_office`, `email`)
3. 명함관리 [🔁 자동 동기화] → "새 JSON 파일 업로드" 선택. 또는 그냥 다음 새벽까지 두면 자동 처리됨.

### 직전 실행 결과 확인
```sql
select started_at, status, trigger_source,
       files_processed, inserted_count, updated_count,
       relinked_customer, fixed_normalized, fixed_email_domain
  from card_import_runs
 order by started_at desc
 limit 10;
```

### 핸드폰 중복 진단/정리
```sql
select phone_norm, count(*) from business_cards
 where phone_norm <> '' group by phone_norm having count(*) > 1;
```
(2026-06-16 기준 4쌍 존재. Edge Function 의 phone_norm SELECT 분기로 신규 import 시 충돌은 발생하지 않지만,
정리하고 싶으면 명함관리 UI 에서 직접 한쪽을 삭제하거나 두 행을 머지)

### 재설치/재배포가 필요한 경우 (참고)
- DB 변경 재적용: `business-cards/sync_setup.sql` 전체를 Supabase SQL Editor 에 붙여넣고 실행 (idempotent)
- Edge Function 재배포: `supabase functions deploy cards-sync --project-ref wghjnlhfqypamiwukeio`

## 실제 메일/카톡 전송 연동 (다음 단계)
현재 발송은 `card_send_logs`에 **이력만 기록**합니다. 실제 전송을 붙이려면:
- **메일**: Supabase Edge Function에서 SMTP(SendGrid/Naver/Gmail) 호출. `doSend()`의 insert 직전에 메일 발송 호출 추가.
- **카카오**: 카카오 비즈니스 채널 + 알림톡/친구톡 API 연동. (개인 카톡 대량발송은 정책 위반)

원하시면 이 연동 코드를 추가로 작성해 드립니다.

## 기존 시스템과의 관계
- 회사(거래처) 원장은 **기존 `rental_customers`를 그대로 재활용**합니다. 명함이 새 거래처를 만들지 않고, 임대거래처와 한 몸으로 묶입니다.
- 인증·스타일은 기존 `auth.js` / `styles.css` / `config.js`를 공유합니다.
- 해시/iframe 라우팅, embed 모드 모두 기존 패턴을 따릅니다.
