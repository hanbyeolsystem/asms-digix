-- ASMS PACAI - Row Level Security 정책
-- 마이그레이션 완료 후 실행 (그 전에 실행하면 import 가 막힐 수 있음)

ALTER TABLE public.orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

-- 정책: 인증된(=로그인한) 사용자만 모든 작업 가능
-- 익명(anon) 키는 read 조차 안 됨 → PII 노출 차단

DROP POLICY IF EXISTS "auth all - orders"    ON public.orders;
DROP POLICY IF EXISTS "auth all - products"  ON public.products;
DROP POLICY IF EXISTS "auth all - customers" ON public.customers;

CREATE POLICY "auth all - orders"
  ON public.orders FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth all - products"
  ON public.products FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "auth all - customers"
  ON public.customers FOR ALL
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
