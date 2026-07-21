-- ============================================================
-- 53_customer_bill_same_month.sql  (2026-07-21)
--
-- 은행/관공서형 거래처: 매월 20일 등 월 중간에 검침하고 그 자리에서 청구.
--   예) 구지농협 — 7/20 검침 → 7월 계산서 발행 (기존 로직은 8월로 밀림)
--
--   bill_same_month = true  → 데이터월 = 청구월      (검침한 달에 바로 청구)
--   bill_same_month = false → 데이터월 = 청구월 - 1  (기존 동작, 기본값)
--
--   reading_day = 검침일(1~31). NULL 이면 월말 검침으로 간주.
--   계산서 "사용 기간" 문구를 실제 검침 구간으로 찍는 데 쓰인다.
--     reading_day=20 → "6월 20일부터 7월 19일까지"
--     reading_day=NULL → "7월 1일부터 7월 31일까지" (기존 그대로)
--
-- 멱등 — 재실행 안전
-- ============================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS bill_same_month BOOLEAN DEFAULT false;

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS reading_day SMALLINT
    CHECK (reading_day IS NULL OR (reading_day BETWEEN 1 AND 31));

-- 기존 행 NULL 방지 (기본값은 기존 동작 유지)
UPDATE rental_customers SET bill_same_month = false WHERE bill_same_month IS NULL;

COMMENT ON COLUMN rental_customers.bill_same_month IS
  '검침한 달에 바로 청구(은행/관공서형). true = 데이터월과 청구월이 같은 달';
COMMENT ON COLUMN rental_customers.reading_day IS
  '검침일 1~31. NULL = 월말 검침. 계산서 사용기간 문구 산출에 사용';

-- ===== 확인 =====
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'rental_customers'
   AND column_name IN ('bill_same_month', 'reading_day')
 ORDER BY column_name;
