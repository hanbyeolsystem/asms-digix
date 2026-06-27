-- ============================================================
-- 04_add_order_count.sql
-- A/S customers 테이블에 order_count(접수횟수) 컬럼 추가.
-- 신규접수 등록 시 고객 자동등록/갱신이 이 컬럼을 사용하는데,
-- 초기 스키마(01_schema.sql)에 없어 INSERT 가 조용히 실패 → 고객관리 미등록 버그.
-- 대상: 디직스 Supabase(wghjnlhfqypamiwukeio) SQL Editor 에서 1회 실행. 멱등.
-- ============================================================

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS order_count INTEGER DEFAULT 0;

-- PostgREST 스키마 캐시 즉시 갱신 (없어도 1분 내 자동 반영)
NOTIFY pgrst, 'reload schema';
