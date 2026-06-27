-- ============================================================
-- 디직스 임대관리 — 유령 컬럼 보강 (코드가 쓰는데 마이그레이션엔 없던 컬럼)
-- 한별 라이브 DB엔 대시보드/MCP로 직접 추가돼 있던 컬럼들이라 추적 SQL에 없었음.
-- 증상: 임대거래처/청구 등에서 "column ... does not exist" 조회 실패.
-- 대상: 디직스 Supabase(wghjnlhfqypamiwukeio) SQL Editor 에서 1회 실행. 멱등.
-- (이미 digix_lease_schema.sql 을 실행한 DB에 추가로 돌리면 됨)
-- ============================================================

-- rental_items: 임대유형(유상 paid / 무상 free)
ALTER TABLE public.rental_items
  ADD COLUMN IF NOT EXISTS rental_type TEXT DEFAULT 'paid';

-- rental_billings: 발송수단 / 카운터할인 / 청구기간 / 실제청구개월
ALTER TABLE public.rental_billings ADD COLUMN IF NOT EXISTS sent_via              TEXT;
ALTER TABLE public.rental_billings ADD COLUMN IF NOT EXISTS counter_discount      INTEGER DEFAULT 0;
ALTER TABLE public.rental_billings ADD COLUMN IF NOT EXISTS billing_period_start  DATE;
ALTER TABLE public.rental_billings ADD COLUMN IF NOT EXISTS billing_period_end    DATE;
ALTER TABLE public.rental_billings ADD COLUMN IF NOT EXISTS billing_months_actual INTEGER;

-- rental_customers: 대표자 / 업태 / 종목 / 팩스 / 계약기간(년)
ALTER TABLE public.rental_customers ADD COLUMN IF NOT EXISTS ceo          TEXT;
ALTER TABLE public.rental_customers ADD COLUMN IF NOT EXISTS biz_type     TEXT;
ALTER TABLE public.rental_customers ADD COLUMN IF NOT EXISTS biz_item     TEXT;
ALTER TABLE public.rental_customers ADD COLUMN IF NOT EXISTS fax          TEXT;
ALTER TABLE public.rental_customers ADD COLUMN IF NOT EXISTS period_years INTEGER;

-- PostgREST 스키마 캐시 즉시 갱신
NOTIFY pgrst, 'reload schema';
