# ASMS Web

A/S 접수 관리 웹페이지 (정적 HTML/CSS/JS + Supabase, 반응형).

## 구성

```
asms-web/
├── index.html              # 진입 화면
├── orders.html             # 접수내역 목록
├── order-new.html          # 신규 접수
├── order-detail.html       # 접수 상세/수정
├── products.html           # 부품/상품 관리
├── product-detail.html
├── customers.html          # 고객관리
├── engineers.html          # 엔지니어/사용자 관리
├── login.html
├── css/
├── js/
├── data/                   # 정적 JSON 데이터
│   └── products.json       # 부품/상품 카탈로그 (샘플 4건 포함, 직접 수정 가능)
├── sql/                    # Supabase 스키마 (01_schema, 02_rls, 03_engineers)
└── supabase/functions/     # Edge Function (옵션: 슬랙 신규접수 알림)
```

## 로컬 실행

```powershell
cd asms-web
python -m http.server 8765
# 브라우저: http://localhost:8765
```

`js/supabase-config.js` 값이 비어 있으면 데모 모드(localStorage)로 동작합니다.

## 주요 기능

- 접수내역 목록: 상태별 필터, 고객명/제품명/전화번호/시리얼번호 검색, 페이지네이션
- 접수 상세/수정: 처리 의견 누적, 상태 변경 → 목록 자동 반영
- 부품/상품 관리: 동적 렌더링, 상세 화면
- 고객관리: 접수횟수 정렬, 신규/수정 모달
- 엔지니어/사용자 관리: Edge Function 으로 인증 사용자 생성/삭제
- 반응형 레이아웃 (PC/태블릿/모바일)

## Supabase 연동

### 1) 프로젝트 생성
- https://supabase.com → New Project (Region: Northeast Asia (Seoul) 권장)

### 2) 스키마 실행
- 대시보드 → SQL Editor → New Query
- `sql/01_schema.sql` → Run
- `sql/02_rls.sql` → Run (RLS 활성화)
- `sql/03_engineers.sql` → Run (엔지니어 테이블)

### 3) 클라이언트 설정
`js/supabase-config.js` 의 두 값을 본인 키로 교체:
```js
window.SUPABASE_URL  = "https://xxx.supabase.co";
window.SUPABASE_ANON = "eyJ..."; // anon public key (RLS 적용되어 안전)
```

### 4) 첫 사용자 가입
- 로그인 화면 → "신규 가입" → 이메일/비번
- Supabase 가 인증 메일 발송 → 메일 확인 후 로그인
- 이후 가입을 막으려면: Dashboard → Authentication → Providers → Email → "Enable Sign ups" OFF

### 5) (옵션) 슬랙 신규접수 알림
- `supabase/functions/notify-order/` 배포
- Edge Function Secrets:
  - `SLACK_WEBHOOK_URL` (필수): 슬랙 Incoming Webhook URL
  - `ORDERS_LINK` (옵션): 알림에 표시할 접수내역 페이지 URL

## 브랜드 커스터마이징

`login.html`, `css/partials.js` 의 `{회사명}` 부분을 원하는 회사명으로 치환하세요.

## 배포

- GitHub Pages: 리포지토리 Settings → Pages → main branch 루트
- Netlify / Vercel: 정적 파일만 업로드, 별도 빌드 불필요
