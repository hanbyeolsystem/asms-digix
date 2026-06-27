# 디직스 임대관리 — Supabase 초기 셋업

대상 프로젝트: **wghjnlhfqypamiwukeio** (디직스 전용 · 한별 ref 아님)
모든 데이터는 **빈 상태**로 시작합니다(범용 품목·프리셋 참조데이터만 들어감).

## 실행 순서 (Supabase 대시보드 → SQL Editor)

1. **`digix_lease_schema.sql`** 전체 복사 → SQL Editor 붙여넣기 → **RUN**
   - 임대 관련 테이블 ~30종 + 인증 테이블(`rental_user_profiles`) + 버킷 5종 생성
   - 맨 앞에서 기존 `admin@asms.local` 계정을 **임대관리 관리자**로 자동 등록
     → 디직스 기존 **admin / admin** 으로 임대관리도 바로 로그인 가능
2. **`digix_buckets.sql`** 붙여넣기 → **RUN** (명함·음성미팅 버킷 2종 보완)

> 멱등(IF NOT EXISTS / ON CONFLICT)이라 두 번 실행해도 안전합니다.
> 단, 스키마의 맨 앞 `10_init_schema_v2` 구간은 `rental_*` 테이블을 DROP 후 재생성하므로
> **이미 운영 데이터가 들어간 뒤에는 재실행 금지**(데이터 날아감).

## 로그인 확인
- 임대관리: `https://digix.co.kr/lease/asms.html`
- 아이디 `admin` / 비번 `admin` (A/S 와 동일 계정 공용)
- 추가 직원 계정은 [사용자 관리] 메뉴에서 발급(Supabase service key 필요).

## 아직 안 된 것 (후속 단계 — 별도 진행)
- **Edge Function 5종**(pair-collector / register-devices / submit-reading / cards-sync / counter-anomaly-check)
  디직스 프로젝트에 배포 + 시크릿 등록 필요. 미배포 시 실시간 수집기·명함자동동기화·이상치알림만 비활성.
- **카운터 수집기 EXE** 디직스용 재빌드(페어링코드/함수URL 교체).
- **외부 API 키**: Gemini(명함·미팅 분석), Slack 웹훅 — 디직스 키 등록 시 활성화.
- 위 기능을 안 써도 임대현황/거래처/카운터(수동)/청구/장비/계약서/가격표/자료실은 정상 동작.
