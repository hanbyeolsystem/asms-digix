# 🖥 장비관리 (rental-equipment)

> ⚠ **재구축 예정 (2026-05-31~)** — 본 페이지는 차후 별도 환경(Claude Code 새 세션)에서
> 처음부터 다시 만들 예정입니다. **서버측 인프라(Supabase 스키마 + Edge Function)는
> 그대로 유지** — 새 페이지가 동일 데이터 모델만 따르면 즉시 호환됩니다.
>
> **연동 API 명세**: [`../docs/COLLECTOR_API.md`](../docs/COLLECTOR_API.md)
>
> 현재 폴더의 index.html / index.js 는 참고/회복용으로 보존. 새 작업 시작할 때 정리 결정.

## 사용자 호칭
- **"장비관리"** = 본 폴더 (`rental-equipment/`).

## 위치
- 라이브: `https://hanbyeolsystem.github.io/totalas/asms.html#rental-equipment/index.html`
- 사이드바 임대 그룹: 임대현황 → 임대거래처 → **장비관리** → 임대카운터 → 임대추가요금청구

## 데이터 모델 (재구축 시 그대로 유지)
- `rental_items` (브랜드/모델/serial/status/toner_pct)
- `rental_assignments` (활성 배정으로 customer 매핑)
- `rental_customers` (company)
- `rental_counters` (월별 누적 카운터)
- `rental_collectors` / `rental_collector_devices` / `rental_counter_readings` (실시간 — 자세한 스키마는 docs/COLLECTOR_API.md)

## 현재 구현된 주요 기능 (참고용)
- 8컬럼 자산 리스트: 브랜드 / 일련번호·모델 / 거래처 / 흑백합계 / 컬러합계 / 상태 / 토너잔량 / 마지막카운트
- 통합 검색 (브랜드·모델·serial·company)
- 상태 / 토너 필터
- 토너잔량 셀 인라인 편집 → `rental_items.toner_pct` UPDATE
- 수집기 안내 패널 (페어링 코드 `hanbyeol` 클릭 복사)
- 신규 수집기 거래처 매핑 모달 (status=pending → active)

## 페이지에 미반영된 사용자 요구 (재구축 시 반영 대상)
- 카운터 연동된 거래처만 보이는 필터 (디폴트)
- 연동 끊김 / 신규 발견 상태 뱃지
- 엑셀 다운로드
- 메일 발송 시점 설정 UI (관리자 일일/월간 요약 메일)
