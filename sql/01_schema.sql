-- ASMS PACAI - Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에서 실행

-- ============================================================
-- 1) products: 부품/상품 마스터
-- ============================================================
CREATE TABLE IF NOT EXISTS public.products (
  seq_no       INTEGER PRIMARY KEY,
  kind         TEXT,            -- '제품' / '부품'
  courier      TEXT,            -- 'YES' / 'NO'
  code         TEXT,            -- 부품/상품 번호
  name         TEXT,            -- 부품/상품 명
  as_count     TEXT,            -- A/S 횟수 (원본이 문자열)
  date         TEXT,            -- 입력/수정일
  money        TEXT,            -- 단가
  number_old   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_products_name ON public.products (name);
CREATE INDEX IF NOT EXISTS idx_products_code ON public.products (code);

-- ============================================================
-- 2) customers: 고객 마스터
-- ============================================================
CREATE TABLE IF NOT EXISTS public.customers (
  cu_number   TEXT PRIMARY KEY,
  cu_kind     TEXT,
  cu_name     TEXT,
  co_name     TEXT,
  cu_mail     TEXT,
  zipcode1    TEXT,
  address1    TEXT,
  address2    TEXT,
  cu_tel      TEXT,
  cu_mobile   TEXT,
  co_tel      TEXT,
  co_fax      TEXT,
  last_seq    INTEGER,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON public.customers (cu_name);
CREATE INDEX IF NOT EXISTS idx_customers_tel  ON public.customers (cu_tel);
CREATE INDEX IF NOT EXISTS idx_customers_mob  ON public.customers (cu_mobile);

-- ============================================================
-- 3) orders: 접수 (목록 + 상세 통합, 1대1)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.orders (
  seq_no        INTEGER PRIMARY KEY,
  -- 목록 정보
  order_no      TEXT,
  branch        TEXT,
  status        TEXT,
  cu_name       TEXT,
  product       TEXT,
  serial        TEXT,
  process_date  TEXT,
  receiver      TEXT,
  kind2         TEXT,
  cu_tel        TEXT,
  cu_mobile     TEXT,
  -- 상세 정보
  en_gubun      TEXT,
  cu_number     TEXT,
  cu_kind       TEXT,
  or_kind1      TEXT,
  or_kind2      TEXT,
  or_kind3      TEXT,
  co_name       TEXT,
  cu_mail       TEXT,
  zipcode1      TEXT,
  address1      TEXT,
  address2      TEXT,
  mo_number     TEXT,
  mo_engname    TEXT,
  mo_serial     TEXT,
  mo_srfr       TEXT,
  mo_number2    TEXT,
  mo_engname2   TEXT,
  mo_money2     TEXT,
  trip_money    TEXT,
  gongim_money  TEXT,
  work_name     TEXT,
  re_now        TEXT,
  mo_etc        JSONB DEFAULT '[]'::jsonb,
  cu_want       TEXT,
  re_content    TEXT,
  co_tel        TEXT,
  co_fax        TEXT,
  -- 메타
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_cu_name    ON public.orders (cu_name);
CREATE INDEX IF NOT EXISTS idx_orders_product    ON public.orders (product);
CREATE INDEX IF NOT EXISTS idx_orders_serial     ON public.orders (serial);
CREATE INDEX IF NOT EXISTS idx_orders_cu_tel     ON public.orders (cu_tel);
CREATE INDEX IF NOT EXISTS idx_orders_cu_mobile  ON public.orders (cu_mobile);
CREATE INDEX IF NOT EXISTS idx_orders_proc_date  ON public.orders (process_date);
CREATE INDEX IF NOT EXISTS idx_orders_branch     ON public.orders (branch);

-- ============================================================
-- 4) updated_at 자동 갱신 트리거
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_updated  ON public.products;
DROP TRIGGER IF EXISTS trg_customers_updated ON public.customers;
DROP TRIGGER IF EXISTS trg_orders_updated    ON public.orders;

CREATE TRIGGER trg_products_updated  BEFORE UPDATE ON public.products  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER trg_orders_updated    BEFORE UPDATE ON public.orders    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
