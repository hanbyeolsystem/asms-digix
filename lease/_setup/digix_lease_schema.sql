-- ============================================================
-- 디직스코리아 임대관리 — 빈 스키마 합본 (한별 totalas DDL 기반)
-- 대상 Supabase: wghjnlhfqypamiwukeio (디직스 전용)
-- 실행: Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 RUN
-- 고객/거래처 데이터는 포함하지 않음 (빈 상태). 범용 품목/프리셋 참조데이터만 포함.
-- ============================================================

-- ===== 0. rental_user_profiles (인증/역할 — auth.js 가 필수로 요구) =====
create table if not exists rental_user_profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  display_id text,
  full_name  text,
  role       text not null default 'engineer',  -- 'admin' | 'engineer'
  active     boolean not null default true,
  created_at timestamptz default now()
);
alter table rental_user_profiles enable row level security;
drop policy if exists rup_all_auth on rental_user_profiles;
create policy rup_all_auth on rental_user_profiles for all to authenticated using (true) with check (true);

-- 기존 디직스 admin(admin@asms.local) 을 임대관리 관리자로 부트스트랩
insert into rental_user_profiles (user_id, display_id, full_name, role, active)
select id, 'admin', '관리자', 'admin', true from auth.users where email = 'admin@asms.local'
on conflict (user_id) do update set role = 'admin', active = true;


-- ============================================================
-- >>> 10_init_schema_v2.sql
-- ============================================================
-- ============================================================
-- 10_init_schema_v2.sql  (2026-05-13, rev2)
-- 한별 임대 v2 스키마 — 4개 모듈(현황/거래처/카운터/청구) 공유.
-- rev2: 완전 재구축 위해 시작 시 기존 rental_* 모두 DROP.
-- ============================================================

-- ===== 0. 기존 객체 정리 (완전 초기화) =====
DROP TABLE IF EXISTS rental_supplies, rental_billings, rental_counters,
                     rental_assignments, rental_items, rental_customers CASCADE;

-- ===== 1. rental_customers =====
CREATE TABLE IF NOT EXISTS rental_customers (
  id              TEXT PRIMARY KEY,             -- c_0001 형식
  company         TEXT NOT NULL,
  contact_name    TEXT,
  phone           TEXT,
  mobile          TEXT,
  email           TEXT,
  biz_no          TEXT,
  address         TEXT,
  payment_type    TEXT DEFAULT '선불',          -- 선불 / 후불
  deposit         INTEGER DEFAULT 0,
  invoice_day     TEXT,                          -- 청구일 (자유 텍스트: '1일', '말일' 등)
  notes           TEXT,
  package_flags   JSONB DEFAULT '{}'::jsonb,    -- {has_pc_set:bool, nas_candidate:bool, ...}
  active          BOOLEAN DEFAULT TRUE,
  archived_at     TIMESTAMPTZ,
  archived_reason TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rc_company ON rental_customers (company);
CREATE INDEX IF NOT EXISTS idx_rc_active  ON rental_customers (active);

-- ===== 2. rental_items (자산 마스터) =====
CREATE TABLE IF NOT EXISTS rental_items (
  id            TEXT PRIMARY KEY,                -- it_0001
  category      TEXT NOT NULL,                   -- IT / 출력 / 위생
  subtype       TEXT NOT NULL,                   -- PC / monitor / NAS / 잉크젯 / 레이저 / 복합기 / 웰리스
  brand         TEXT,
  model         TEXT,
  serial        TEXT,
  install_date  DATE,
  status        TEXT DEFAULT 'active',           -- active / replaced / returned / lost
  -- age_months 는 GENERATED 불가(now() 비-IMMUTABLE). 클라이언트가 install_date 로 계산.
  storage_gb    INTEGER,                          -- NAS 전용
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ri_category ON rental_items (category, subtype);
CREATE INDEX IF NOT EXISTS idx_ri_status   ON rental_items (status);
CREATE INDEX IF NOT EXISTS idx_ri_serial   ON rental_items (serial);

-- ===== 3. rental_assignments (거래처-자산 매핑) =====
CREATE TABLE IF NOT EXISTS rental_assignments (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES rental_items(id)     ON DELETE CASCADE,
  customer_id   TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  start_date    DATE,
  end_date      DATE,
  monthly_fee   INTEGER DEFAULT 0,               -- 기본 임대료 (item당)
  bw_free       INTEGER DEFAULT 0,
  co_free       INTEGER DEFAULT 0,
  bw_rate       INTEGER DEFAULT 0,               -- 추가 흑백 장당
  co_rate       INTEGER DEFAULT 0,               -- 추가 컬러 장당
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ra_customer ON rental_assignments (customer_id);
CREATE INDEX IF NOT EXISTS idx_ra_item     ON rental_assignments (item_id);
CREATE INDEX IF NOT EXISTS idx_ra_active   ON rental_assignments (customer_id) WHERE end_date IS NULL;

-- ===== 4. rental_counters (월별 사용량) =====
CREATE TABLE IF NOT EXISTS rental_counters (
  id            BIGSERIAL PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES rental_items(id) ON DELETE CASCADE,
  ym            CHAR(7) NOT NULL,                -- YYYY-MM
  bw            INTEGER DEFAULT 0,               -- 누적 흑백 (출력기기)
  color         INTEGER DEFAULT 0,               -- 누적 컬러
  uptime_hours  INTEGER,                          -- PC/NAS 향후 확장
  read_at       TIMESTAMPTZ DEFAULT now(),
  source        TEXT DEFAULT 'manual',           -- manual / snmp / api
  notes         TEXT,
  UNIQUE (item_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_rcnt_ym ON rental_counters (ym);

-- ===== 5. rental_billings (월 청구 내역) =====
CREATE TABLE IF NOT EXISTS rental_billings (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  ym            CHAR(7) NOT NULL,
  fixed_total   INTEGER DEFAULT 0,               -- 고정 임대료 합
  usage_total   INTEGER DEFAULT 0,               -- 사용량 기반 청구 합
  total         INTEGER GENERATED ALWAYS AS (COALESCE(fixed_total,0) + COALESCE(usage_total,0)) STORED,
  items         JSONB DEFAULT '[]'::jsonb,       -- [{item_id, kind, qty, unit_price, subtotal}]
  status        TEXT DEFAULT 'draft',            -- draft / sent / paid / void
  issued_at     DATE,
  paid_at       DATE,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (customer_id, ym)
);
CREATE INDEX IF NOT EXISTS idx_rb_ym     ON rental_billings (ym);
CREATE INDEX IF NOT EXISTS idx_rb_status ON rental_billings (status);

-- ===== 6. rental_supplies (소모품 교체) =====
CREATE TABLE IF NOT EXISTS rental_supplies (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL REFERENCES rental_items(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- toner / ink / filter / belt / drum
  changed_at    DATE,
  next_due      DATE,
  cost          INTEGER DEFAULT 0,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rs_item ON rental_supplies (item_id);
CREATE INDEX IF NOT EXISTS idx_rs_kind ON rental_supplies (kind);

-- ============================================================
-- RLS: 인증된 사용자 전체 권한
-- ============================================================
ALTER TABLE rental_customers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_counters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_billings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_supplies    ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'rental_customers','rental_items','rental_assignments',
    'rental_counters','rental_billings','rental_supplies'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_auth_all', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        FOR ALL
        TO authenticated
        USING (true)
        WITH CHECK (true)
    $p$, t || '_auth_all', t);
  END LOOP;
END $$;

-- 확인
SELECT table_name
  FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'rental_%'
 ORDER BY table_name;


-- ============================================================
-- >>> 12_create_rental_contracts.sql
-- ============================================================
-- ============================================================
-- 12_create_rental_contracts.sql  (2026-05-13, rev2)
-- rental_contracts — 임대계약서 (PDF 4페이지 양식과 동치)
-- 1p 표지 · 2~3p 이용약관 · 4p 자동출금 이용신청서
-- rev2: 잔존 객체 충돌 회피 위해 시작 시 DROP CASCADE
-- ============================================================

DROP TABLE IF EXISTS rental_contracts CASCADE;

CREATE TABLE IF NOT EXISTS rental_contracts (
  id              TEXT PRIMARY KEY,                          -- ct_xxx
  customer_id     TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  contract_no     TEXT,                                       -- HB-2026-001 등
  contract_date   DATE,
  period_years    INTEGER DEFAULT 3,
  period_start    DATE,
  period_end      DATE,
  deposit         INTEGER DEFAULT 0,
  install_fee     INTEGER DEFAULT 0,
  -- 거래처 스냅샷 (변경되어도 계약서엔 발행 시점 정보 보존)
  company_snapshot      TEXT,
  contact_name_snapshot TEXT,
  biz_no_snapshot       TEXT,
  address_snapshot      TEXT,
  phone_snapshot        TEXT,
  email_snapshot        TEXT,
  -- 항목 (행 추가·삭제 가능)
  items           JSONB DEFAULT '[]'::jsonb,
    -- [{ model, bw_free, co_free, bw_rate, co_rate, qty, monthly_fee, note }]
  -- 약관 (제1~10조 + 부가사항, 체크박스 + 본문 수정 가능)
  terms           JSONB DEFAULT '[]'::jsonb,
    -- [{ article, title, body, confirmed }]
  extras          JSONB DEFAULT '[]'::jsonb,
    -- 부가사항 [{ text, confirmed }]
  special_terms   TEXT,
  -- 자동출금 / 결제
  payment_method  TEXT DEFAULT 'account',                     -- account / card
  payment_info    JSONB DEFAULT '{}'::jsonb,
    -- account: { bank, account_no, holder, biz_no, draft_day }
    -- card:    { card_brand, card_no, expiry, holder, cvc_mask, draft_day }
  -- 서명 (Canvas → PNG base64 data URL)
  sign_supplier   TEXT,
  sign_applicant  TEXT,
  signed_at       TIMESTAMPTZ,
  -- 상태
  status          TEXT DEFAULT 'draft',                       -- draft / signed / active / terminated
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rcontract_customer   ON rental_contracts (customer_id);
CREATE INDEX IF NOT EXISTS idx_rcontract_status     ON rental_contracts (status);
CREATE INDEX IF NOT EXISTS idx_rcontract_date       ON rental_contracts (contract_date DESC);

-- RLS
ALTER TABLE rental_contracts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_contracts_auth_all ON rental_contracts;
CREATE POLICY rental_contracts_auth_all ON rental_contracts
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='rental_contracts'
 ORDER BY ordinal_position;


-- ============================================================
-- >>> 13_contract_attachments.sql
-- ============================================================
-- ============================================================
-- 13_contract_attachments.sql  (2026-05-13)
-- 계약서 첨부 파일 + 서명 방식 컬럼 + Storage 버킷
-- ============================================================

-- 1) 계약서 컬럼 보강
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS contract_scan_path TEXT,       -- 도장/사인 받은 계약서 스캔본 경로 (Storage)
  ADD COLUMN IF NOT EXISTS id_card_path       TEXT,       -- 신분증 사진 경로
  ADD COLUMN IF NOT EXISTS signature_type     TEXT DEFAULT 'digital';
                                                          -- digital / stamp / none

-- 2) Storage 버킷 생성 (없을 때만)
INSERT INTO storage.buckets (id, name, public)
  VALUES ('rental-contracts', 'rental-contracts', false)
  ON CONFLICT (id) DO NOTHING;

-- 3) Storage RLS — authenticated 전체 권한 (개인 도메인 운영, 단일 조직)
DROP POLICY IF EXISTS rental_contracts_storage_all ON storage.objects;
CREATE POLICY rental_contracts_storage_all ON storage.objects
  FOR ALL TO authenticated
  USING (bucket_id = 'rental-contracts')
  WITH CHECK (bucket_id = 'rental-contracts');

-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name='rental_contracts'
   AND column_name IN ('contract_scan_path', 'id_card_path', 'signature_type');

SELECT id, name, public FROM storage.buckets WHERE id='rental-contracts';


-- ============================================================
-- >>> 17_add_bill_combined.sql
-- ============================================================
-- ============================================================
-- 17_add_bill_combined.sql
-- 거래처 단위 "합산 청구" 옵션 추가
-- 한 거래처가 출력기기를 여러 대 사용할 때, 모든 자산의 카운터/기본매수/
-- 추가카운터를 합산하여 단일 청구 항목으로 발행할지 여부.
-- ============================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS bill_combined BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN rental_customers.bill_combined IS
  '여러 출력 자산 보유 시 합산 청구 여부 (TRUE: 합산, FALSE: 자산별 청구)';

-- 확인
SELECT
  COUNT(*) FILTER (WHERE bill_combined = TRUE)  AS combined_count,
  COUNT(*) FILTER (WHERE bill_combined = FALSE) AS separate_count,
  COUNT(*)                                       AS total
FROM rental_customers
WHERE active = TRUE;


-- ============================================================
-- >>> 18_add_billing_period.sql
-- ============================================================
-- ============================================================
-- 18_add_billing_period.sql
-- 거래처 단위 "청구 주기" 옵션 추가
--   1  = 월별   (기본)
--   3  = 3개월 (분기 합산 청구)
--   6  = 6개월 (반기 합산 청구)
--   12 = 1년    (연간 합산 청구)
-- N개월 합산 시: 청구 마감월의 카운터 - (마감월 - N개월)의 카운터 = N개월 누적 사용량
-- 기본매수도 N배로 확장 (예: 3개월 거래처면 bw_free × 3)
-- ============================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_months INTEGER DEFAULT 1
    CHECK (billing_months IN (1, 3, 6, 12));

COMMENT ON COLUMN rental_customers.billing_months IS
  '청구 주기(개월) — 1: 월별, 3: 분기, 6: 반기, 12: 연간 합산';

-- 확인
SELECT
  billing_months,
  COUNT(*) AS customers
FROM rental_customers
WHERE active = TRUE
GROUP BY billing_months
ORDER BY billing_months;


-- ============================================================
-- >>> 19_billing_options_all.sql
-- ============================================================
-- ============================================================
-- 19_billing_options_all.sql
-- 17 + 18 통합본 — Supabase SQL Editor 에 통째로 붙여 넣고 실행.
-- IF NOT EXISTS 라서 이미 실행된 컬럼이 있어도 안전(멱등).
--
--   bill_combined   : 한 거래처의 여러 자산 합산 청구 여부
--   billing_months  : 청구 주기 (1: 월별, 3: 분기, 6: 반기, 12: 연간)
-- ============================================================

-- 합산 청구 옵션
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS bill_combined BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN rental_customers.bill_combined IS
  '여러 출력 자산 보유 시 합산 청구 여부 (TRUE: 합산, FALSE: 자산별 청구)';

-- 청구 주기 옵션
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_months INTEGER DEFAULT 1
    CHECK (billing_months IN (1, 3, 6, 12));

COMMENT ON COLUMN rental_customers.billing_months IS
  '청구 주기(개월) — 1: 월별, 3: 분기, 6: 반기, 12: 연간 합산';

-- 확인
SELECT
  billing_months,
  COUNT(*) FILTER (WHERE bill_combined = TRUE)  AS combined_count,
  COUNT(*) FILTER (WHERE bill_combined = FALSE) AS separate_count,
  COUNT(*)                                       AS total
FROM rental_customers
WHERE active = TRUE
GROUP BY billing_months
ORDER BY billing_months;


-- ============================================================
-- >>> 20_prices_index.sql
-- ============================================================
-- ============================================================
-- 20_prices_index.sql  (2026-05-13)
-- 가격표 페이지 — Supabase Storage 기반 단가표 업로드/조회.
--
-- 구성:
--   1) storage bucket 'prices' (public read, authenticated write)
--   2) DB 테이블 prices_index (label/meta/file_path/ext 메타데이터)
--
-- 한 번 실행하면 멱등 — 재실행해도 안전.
-- ============================================================

-- ===== 1. Storage bucket =====
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('prices', 'prices', TRUE, 52428800)   -- 50 MB
ON CONFLICT (id) DO UPDATE
  SET public = TRUE, file_size_limit = 52428800;

-- 기존 정책 제거 후 재생성 (멱등성)
DROP POLICY IF EXISTS "prices_public_read"   ON storage.objects;
DROP POLICY IF EXISTS "prices_auth_write"    ON storage.objects;
DROP POLICY IF EXISTS "prices_auth_update"   ON storage.objects;
DROP POLICY IF EXISTS "prices_auth_delete"   ON storage.objects;

-- 누구나 읽기 (Office Online Viewer 가 익명으로 fetch 해야 함)
CREATE POLICY "prices_public_read" ON storage.objects FOR SELECT
USING (bucket_id = 'prices');

-- 인증된 사용자만 쓰기 / 수정 / 삭제
CREATE POLICY "prices_auth_write" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (bucket_id = 'prices');

CREATE POLICY "prices_auth_update" ON storage.objects FOR UPDATE
TO authenticated USING (bucket_id = 'prices')
WITH CHECK (bucket_id = 'prices');

CREATE POLICY "prices_auth_delete" ON storage.objects FOR DELETE
TO authenticated USING (bucket_id = 'prices');


-- ===== 2. DB 테이블 — 가격표 인덱스 =====
CREATE TABLE IF NOT EXISTS prices_index (
  id          BIGSERIAL PRIMARY KEY,
  label       TEXT NOT NULL,                            -- 표시명 (예: '교세라 부품 가격표')
  meta        TEXT,                                     -- 부가 설명 (예: '2026.01', '인상')
  file_path   TEXT NOT NULL UNIQUE,                     -- storage 안 경로 (예: 'kyocera_parts_2026_01.xlsx')
  ext         TEXT NOT NULL,                            -- 'xlsx' / 'xls' / 'pdf' / 'docx' 등
  sort_order  INTEGER DEFAULT 0,                        -- 정렬 우선순위 (작을수록 위)
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  created_by  UUID REFERENCES auth.users(id)
);

-- 기존 테이블이 이미 있던 경우 누락 컬럼 보강 (멱등성 보장)
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS label      TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS meta       TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS file_path  TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS ext        TEXT;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE prices_index ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_prices_index_sort
  ON prices_index (sort_order, created_at);

ALTER TABLE prices_index ENABLE ROW LEVEL SECURITY;

-- 인증된 사용자 전체 권한 (임대 모듈과 동일 패턴)
DROP POLICY IF EXISTS "prices_index_all" ON prices_index;
CREATE POLICY "prices_index_all" ON prices_index FOR ALL
TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ===== 3. updated_at 자동 갱신 트리거 =====
CREATE OR REPLACE FUNCTION prices_index_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prices_index_updated_at ON prices_index;
CREATE TRIGGER trg_prices_index_updated_at
  BEFORE UPDATE ON prices_index
  FOR EACH ROW EXECUTE FUNCTION prices_index_touch_updated_at();


-- ===== 확인 쿼리 (실행 후 결과 보기) =====
SELECT 'bucket'    AS kind, id   AS name FROM storage.buckets WHERE id = 'prices'
UNION ALL
SELECT 'policy',   policyname    FROM pg_policies WHERE tablename = 'objects'  AND policyname LIKE 'prices_%'
UNION ALL
SELECT 'policy',   policyname    FROM pg_policies WHERE tablename = 'prices_index'
UNION ALL
SELECT 'table',    'prices_index' WHERE EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'prices_index');


-- ============================================================
-- >>> 22_archive_init.sql
-- ============================================================
-- ============================================================
-- 22_archive_init.sql  (2026-05-13)
-- 고객자료실 — customer_archives + software_licenses + Storage bucket
--
-- 구성:
--   1) storage bucket 'archives' (private — 인증된 사용자만 read)
--   2) customer_archives (NAS설정/소프트웨어/계약서/사진/기타 파일)
--   3) software_licenses (소프트웨어 만기 추적)
--
-- 멱등 — 재실행 안전.
-- 자료는 민감할 수 있어 private bucket. JS 는 createSignedUrl 로 임시 URL 생성.
-- ============================================================

-- ===== 1. Storage bucket 'archives' (private) =====
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('archives', 'archives', FALSE, 104857600)   -- 100 MB, 비공개
ON CONFLICT (id) DO UPDATE
  SET public = FALSE, file_size_limit = 104857600;

DROP POLICY IF EXISTS "archives_auth_read"   ON storage.objects;
DROP POLICY IF EXISTS "archives_auth_write"  ON storage.objects;
DROP POLICY IF EXISTS "archives_auth_update" ON storage.objects;
DROP POLICY IF EXISTS "archives_auth_delete" ON storage.objects;

CREATE POLICY "archives_auth_read" ON storage.objects FOR SELECT
TO authenticated USING (bucket_id = 'archives');

CREATE POLICY "archives_auth_write" ON storage.objects FOR INSERT
TO authenticated WITH CHECK (bucket_id = 'archives');

CREATE POLICY "archives_auth_update" ON storage.objects FOR UPDATE
TO authenticated USING (bucket_id = 'archives')
WITH CHECK (bucket_id = 'archives');

CREATE POLICY "archives_auth_delete" ON storage.objects FOR DELETE
TO authenticated USING (bucket_id = 'archives');


-- ===== 2. customer_archives — 고객별 자료 파일 =====
CREATE TABLE IF NOT EXISTS customer_archives (
  id                  BIGSERIAL PRIMARY KEY,
  customer_name       TEXT NOT NULL,
  rental_customer_id  TEXT REFERENCES rental_customers(id) ON DELETE SET NULL,
  category            TEXT NOT NULL,                  -- 'NAS설정'/'소프트웨어'/'계약서'/'사진'/'기타'
  label               TEXT NOT NULL,
  file_path           TEXT NOT NULL UNIQUE,
  ext                 TEXT NOT NULL,
  file_size           BIGINT,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id)
);

-- 기존 테이블 보강
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS customer_name      TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS rental_customer_id TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS category           TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS label              TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS file_path          TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS ext                TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS file_size          BIGINT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS notes              TEXT;
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE customer_archives ADD COLUMN IF NOT EXISTS created_by         UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_archives_customer     ON customer_archives (customer_name);
CREATE INDEX IF NOT EXISTS idx_archives_category     ON customer_archives (category);
CREATE INDEX IF NOT EXISTS idx_archives_rental_cust  ON customer_archives (rental_customer_id);

ALTER TABLE customer_archives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "archives_all" ON customer_archives;
CREATE POLICY "archives_all" ON customer_archives FOR ALL
TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ===== 3. software_licenses — 소프트웨어 만기 추적 =====
CREATE TABLE IF NOT EXISTS software_licenses (
  id                  BIGSERIAL PRIMARY KEY,
  customer_name       TEXT NOT NULL,
  rental_customer_id  TEXT REFERENCES rental_customers(id) ON DELETE SET NULL,
  software_name       TEXT NOT NULL,
  vendor              TEXT,
  license_key         TEXT,
  seats               INTEGER DEFAULT 1,
  purchase_date       DATE,
  expiry_date         DATE NOT NULL,
  amount              INTEGER,                        -- 원
  alert_days          INTEGER DEFAULT 30,             -- D-N 이내면 알림 강조
  status              TEXT DEFAULT 'active',          -- active / expired / cancelled
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  created_by          UUID REFERENCES auth.users(id)
);

ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS customer_name      TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS rental_customer_id TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS software_name      TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS vendor             TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS license_key        TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS seats              INTEGER DEFAULT 1;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS purchase_date      DATE;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS expiry_date        DATE;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS amount             INTEGER;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS alert_days         INTEGER DEFAULT 30;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS status             TEXT DEFAULT 'active';
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS notes              TEXT;
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT now();
ALTER TABLE software_licenses ADD COLUMN IF NOT EXISTS created_by         UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_licenses_customer ON software_licenses (customer_name);
CREATE INDEX IF NOT EXISTS idx_licenses_expiry   ON software_licenses (expiry_date);
CREATE INDEX IF NOT EXISTS idx_licenses_status   ON software_licenses (status);

ALTER TABLE software_licenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "licenses_all" ON software_licenses;
CREATE POLICY "licenses_all" ON software_licenses FOR ALL
TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ===== 4. updated_at 자동 갱신 트리거 =====
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_archives_touch ON customer_archives;
CREATE TRIGGER trg_customer_archives_touch
  BEFORE UPDATE ON customer_archives
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_software_licenses_touch ON software_licenses;
CREATE TRIGGER trg_software_licenses_touch
  BEFORE UPDATE ON software_licenses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ===== 5. 확인 쿼리 =====
SELECT 'bucket' AS kind, id AS name FROM storage.buckets WHERE id = 'archives'
UNION ALL
SELECT 'table',  tablename FROM pg_tables
  WHERE tablename IN ('customer_archives', 'software_licenses')
UNION ALL
SELECT 'policy', policyname FROM pg_policies
  WHERE (tablename = 'objects' AND policyname LIKE 'archives_auth_%')
     OR policyname IN ('archives_all', 'licenses_all');


-- ============================================================
-- >>> 23_create_rental_repairs.sql
-- ============================================================
-- ============================================================
-- 23_create_rental_repairs.sql  (2026-05-14)
-- rental_repairs — 거래처별 수리내역
-- 품목(출장/부품교체/토너 등) · 작업내용 · 금액(±)
-- ⚠️ 시작 시 DROP CASCADE — 재실행하면 기존 데이터 삭제됨
-- ============================================================

DROP TABLE IF EXISTS rental_repairs CASCADE;

CREATE TABLE rental_repairs (
  id           TEXT PRIMARY KEY,                                       -- rp_xxx
  customer_id  TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  service_date DATE NOT NULL DEFAULT current_date,
  item_type    TEXT NOT NULL,                                          -- 출장 / 부품교체 / 토너 / 기타
  work_desc    TEXT,                                                   -- 작업내용 (자유 입력)
  amount       INTEGER NOT NULL DEFAULT 0,                             -- 금액 (음수 허용)
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rental_repairs_customer ON rental_repairs (customer_id);
CREATE INDEX idx_rental_repairs_date     ON rental_repairs (service_date DESC);

-- RLS — authenticated 전체권한 (다른 rental_* 테이블과 동일)
ALTER TABLE rental_repairs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_repairs_auth_all ON rental_repairs;
CREATE POLICY rental_repairs_auth_all ON rental_repairs
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 확인
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'rental_repairs'
 ORDER BY ordinal_position;


-- ============================================================
-- >>> 24_billing_overrides.sql
-- ============================================================
-- ============================================================
-- 24_billing_overrides.sql  (2026-05-27)
-- rental_billing_overrides — 청구서 인라인 편집 override 저장
--
-- 단가/기본매수/소계를 운영자가 직접 수정할 때 원본값과
-- 수정값을 항목 단위로 기록. computeBilling()이 원본 대신
-- override 값을 우선 사용하도록 연동됨.
--
-- 멱등 — 재실행 안전 (DROP IF EXISTS 후 CREATE).
-- ============================================================

DROP TABLE IF EXISTS rental_billing_overrides CASCADE;

CREATE TABLE rental_billing_overrides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  ym            CHAR(7) NOT NULL,                   -- YYYY-MM
  item_id       TEXT NOT NULL,                      -- rental_items.id (합산 시 콤마 구분 복수 가능)
  kind          TEXT NOT NULL CHECK (kind IN ('fixed','usage')),
  field         TEXT NOT NULL CHECK (field IN ('bw_rate','co_rate','bw_free','co_free','subtotal')),
  original_val  NUMERIC,                            -- 시스템 계산 원본값
  override_val  NUMERIC NOT NULL,                   -- 운영자 수정값
  memo          TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (customer_id, ym, item_id, kind, field)
);

CREATE INDEX IF NOT EXISTS idx_rbo_customer_ym ON rental_billing_overrides (customer_id, ym);
CREATE INDEX IF NOT EXISTS idx_rbo_ym          ON rental_billing_overrides (ym);

-- updated_at 자동 갱신 트리거 (touch_updated_at 함수는 22_archive_init.sql 에서 이미 생성됨)
-- 함수가 없는 경우를 대비해 CREATE OR REPLACE 로 안전하게 재선언
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_billing_overrides_touch ON rental_billing_overrides;
CREATE TRIGGER trg_billing_overrides_touch
  BEFORE UPDATE ON rental_billing_overrides
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS — authenticated 전체권한 (다른 rental_* 테이블과 동일 패턴)
ALTER TABLE rental_billing_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_billing_overrides_auth_all ON rental_billing_overrides;
CREATE POLICY rental_billing_overrides_auth_all ON rental_billing_overrides
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 확인 쿼리
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'rental_billing_overrides'
 ORDER BY ordinal_position;


-- ============================================================
-- >>> 25_counter_uploads.sql
-- ============================================================
-- ============================================================
-- 25_counter_uploads.sql  (2026-05-27)
-- rental_counter_uploads — 엑셀 원본 파일 업로드 이력 + Storage 연동
--
-- 기능:
--   1) Storage bucket 'counter-uploads' (private)
--   2) rental_counter_uploads — 업로드 이력 테이블
--   3) rental_counters 에 upload_id FK 추가 (nullable)
--   4) 삭제 시 rental_counters cascade 자동 삭제
--
-- 멱등 — 재실행 안전 (IF NOT EXISTS / ON CONFLICT).
-- ============================================================

-- ===== 1. Storage bucket 'counter-uploads' (private) =====
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('counter-uploads', 'counter-uploads', FALSE, 52428800)  -- 50 MB, 비공개
ON CONFLICT (id) DO UPDATE
  SET public = FALSE, file_size_limit = 52428800;

DROP POLICY IF EXISTS "counter_uploads_auth_read"   ON storage.objects;
DROP POLICY IF EXISTS "counter_uploads_auth_write"  ON storage.objects;
DROP POLICY IF EXISTS "counter_uploads_auth_update" ON storage.objects;
DROP POLICY IF EXISTS "counter_uploads_auth_delete" ON storage.objects;

CREATE POLICY "counter_uploads_auth_read" ON storage.objects FOR SELECT
  TO authenticated USING (bucket_id = 'counter-uploads');

CREATE POLICY "counter_uploads_auth_write" ON storage.objects FOR INSERT
  TO authenticated WITH CHECK (bucket_id = 'counter-uploads');

CREATE POLICY "counter_uploads_auth_update" ON storage.objects FOR UPDATE
  TO authenticated USING (bucket_id = 'counter-uploads')
  WITH CHECK (bucket_id = 'counter-uploads');

CREATE POLICY "counter_uploads_auth_delete" ON storage.objects FOR DELETE
  TO authenticated USING (bucket_id = 'counter-uploads');


-- ===== 2. rental_counter_uploads — 업로드 이력 =====
CREATE TABLE IF NOT EXISTS rental_counter_uploads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ym            CHAR(7)      NOT NULL,                   -- 'YYYY-MM'
  file_name     TEXT         NOT NULL,                   -- 원본 파일명
  storage_path  TEXT         NOT NULL,                   -- Storage 경로
  file_size     BIGINT,                                  -- 바이트
  uploaded_by   TEXT,                                    -- 사용자 이메일
  uploaded_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  row_count     INT          DEFAULT 0,                  -- 엑셀 행 수
  ok_count      INT          DEFAULT 0,                  -- 매칭 성공 건수
  status        TEXT         NOT NULL DEFAULT 'active'   -- 'active' | 'replaced' | 'deleted'
                             CHECK (status IN ('active', 'replaced', 'deleted')),
  notes         TEXT,
  updated_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rcu_ym     ON rental_counter_uploads (ym);
CREATE INDEX IF NOT EXISTS idx_rcu_status ON rental_counter_uploads (status);

-- updated_at 자동 갱신 트리거 (touch_updated_at 함수는 22_archive_init.sql 기준 이미 생성됨)
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_counter_uploads_touch ON rental_counter_uploads;
CREATE TRIGGER trg_counter_uploads_touch
  BEFORE UPDATE ON rental_counter_uploads
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS — authenticated 전체권한 (다른 rental_* 테이블과 동일 패턴)
ALTER TABLE rental_counter_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_counter_uploads_auth_all ON rental_counter_uploads;
CREATE POLICY rental_counter_uploads_auth_all ON rental_counter_uploads
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);


-- ===== 3. rental_counters 에 upload_id FK 추가 =====
-- nullable — 기존 수동 입력 행은 NULL 유지
ALTER TABLE rental_counters
  ADD COLUMN IF NOT EXISTS upload_id UUID
    REFERENCES rental_counter_uploads(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_rc_upload ON rental_counters (upload_id);


-- ===== 확인 쿼리 =====
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'rental_counter_uploads'
 ORDER BY ordinal_position;

SELECT column_name
  FROM information_schema.columns
 WHERE table_name = 'rental_counters' AND column_name = 'upload_id';


-- ============================================================
-- >>> 26_counter_discounts.sql
-- ============================================================
-- ============================================================
-- 26_counter_discounts.sql  (2026-05-28)
-- rental_counter_discounts — 카운터 오버 추가요금 할인 저장
--
-- 거래처 × 월 단위로 추가요금 할인 금액을 기록.
-- rental-counters 모듈의 "카운터 오버 업체" 드릴다운 패널에서
-- 운영자가 직접 입력하고, rental-billing 모듈이 최종 청구액
-- 계산 시 이 금액을 차감한다.
--
-- 멱등 — 재실행 안전 (DROP IF EXISTS 후 CREATE).
-- ============================================================

DROP TABLE IF EXISTS rental_counter_discounts CASCADE;

CREATE TABLE rental_counter_discounts (
  customer_id   TEXT    NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  ym            CHAR(7) NOT NULL,          -- YYYY-MM
  amount        INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
  memo          TEXT,
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (customer_id, ym)
);

CREATE INDEX IF NOT EXISTS idx_rcd_ym ON rental_counter_discounts (ym);

-- updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_counter_discounts_touch ON rental_counter_discounts;
CREATE TRIGGER trg_counter_discounts_touch
  BEFORE UPDATE ON rental_counter_discounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- RLS — authenticated 전체 권한 (다른 rental_* 테이블과 동일 패턴)
ALTER TABLE rental_counter_discounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_counter_discounts_auth_all ON rental_counter_discounts;
CREATE POLICY rental_counter_discounts_auth_all ON rental_counter_discounts
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 확인 쿼리
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'rental_counter_discounts'
 ORDER BY ordinal_position;


-- ============================================================
-- >>> 28_customer_split_fields.sql
-- ============================================================
-- ============================================================
-- 28_customer_split_fields.sql
-- rental_customers 테이블에 거래처상호(trade_name) + 설치주소(install_address) 컬럼 추가
-- 실행 위치: https://supabase.com/dashboard/project/wghjnlhfqypamiwukeio/sql/new
-- ============================================================

-- 1) 신규 컬럼 추가 (이미 존재하면 에러 무시)
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS trade_name      TEXT,
  ADD COLUMN IF NOT EXISTS install_address TEXT;

-- 2) 코멘트
COMMENT ON COLUMN rental_customers.trade_name
  IS '거래처 통상 호칭(별칭/지점명/매장명). 비어 있으면 company(사업자상호)로 fallback.';
COMMENT ON COLUMN rental_customers.install_address
  IS '실제 임대 기기 설치 위치. 비어 있으면 address(사업자주소)로 fallback.';

-- 3) PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- >>> 29_customer_documents.sql
-- ============================================================
-- ==========================================================
-- 29_customer_documents.sql
-- 거래처 문서 첨부 테이블 + Storage 버킷 + RLS
-- 버킷명: customer-documents  (private, public=false)
-- ==========================================================

-- ── 1) 테이블 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_customer_documents (
  id           TEXT PRIMARY KEY,          -- doc_xxx
  customer_id  TEXT NOT NULL REFERENCES rental_customers(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,             -- 'contract_stamped' | 'id_card' | 'bankbook'
  storage_path TEXT NOT NULL,
  file_name    TEXT NOT NULL,             -- 원본 파일명 (한글 보존)
  mime_type    TEXT,
  size_bytes   INTEGER,
  uploaded_at  TIMESTAMPTZ DEFAULT now(),
  note         TEXT
);

-- 인덱스: 거래처별 조회
CREATE INDEX IF NOT EXISTS idx_rental_customer_docs_cust
  ON rental_customer_documents (customer_id, kind, uploaded_at DESC);

-- ── 2) RLS ────────────────────────────────────────────────
ALTER TABLE rental_customer_documents ENABLE ROW LEVEL SECURITY;

-- authenticated 사용자: 전체 권한 (다른 rental_* 테이블과 동일 패턴)
CREATE POLICY "authenticated full access"
  ON rental_customer_documents
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── 3) Storage 버킷 (대시보드 UI 또는 아래 함수로 생성) ──
-- Supabase Dashboard → Storage → New bucket
--   이름: customer-documents
--   Public:  OFF (private)
--   파일 크기 제한: 20 MB 권장
-- 또는 아래 SQL 실행 (supabase_storage_admin role 필요):
/*
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'customer-documents',
  'customer-documents',
  false,
  20971520,   -- 20 MB
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT (id) DO NOTHING;
*/

-- Storage RLS (Supabase Storage policy)
-- Dashboard → Storage → customer-documents → Policies → Add policy
-- 또는:
/*
CREATE POLICY "authenticated read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'customer-documents');

CREATE POLICY "authenticated insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'customer-documents');

CREATE POLICY "authenticated delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'customer-documents');
*/


-- ============================================================
-- >>> 30_billing_started_at.sql
-- ============================================================
-- ==========================================================
-- 30_billing_started_at.sql
-- rental_customers 에 billing_started_at 컬럼 추가
-- Phase 2: 청구 주기별 발행 시점 + 첫 청구 부분 기간 로직
-- ==========================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_started_at DATE;

COMMENT ON COLUMN rental_customers.billing_started_at
  IS '청구 주기 계산의 시작일. 다개월(3/6/12) 주기에서 첫 청구 부분 기간 계산에 사용. NULL 이면 자산의 가장 빠른 install_date 로 폴백.';

NOTIFY pgrst, 'reload schema';


-- ============================================================
-- >>> 31_item_rate_history.sql
-- ============================================================
-- ============================================================
-- 31_item_rate_history.sql
-- 자산별 단가·기본매수 변경 이력 관리 (Phase 3)
-- 실행 방법: Supabase SQL Editor에서 전체 복사 후 Run
-- ============================================================

-- ── 이력 테이블 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rental_item_rate_history (
  id              TEXT PRIMARY KEY,            -- rh_xxxx
  item_id         TEXT NOT NULL REFERENCES rental_items(id) ON DELETE CASCADE,
  effective_date  DATE NOT NULL,               -- 이 날짜부터 적용
  bw_free         INTEGER,
  co_free         INTEGER,
  bw_rate         NUMERIC,
  co_rate         NUMERIC,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rrh_item_effective
  ON rental_item_rate_history (item_id, effective_date DESC);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE rental_item_rate_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rrh_auth_all ON rental_item_rate_history;
CREATE POLICY rrh_auth_all ON rental_item_rate_history
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 확인 ────────────────────────────────────────────────────
-- SELECT * FROM rental_item_rate_history LIMIT 5;


-- ============================================================
-- >>> 32_add_toner_pct.sql
-- ============================================================
-- ============================================================
-- 32_add_toner_pct.sql  (2026-05-31)
-- rental_items.toner_pct (0~100) 컬럼 추가 — 장비관리 모듈용.
-- NULL = 미입력. 수동 인라인 편집으로 채워짐.
-- ============================================================
ALTER TABLE rental_items
  ADD COLUMN IF NOT EXISTS toner_pct INTEGER
  CHECK (toner_pct IS NULL OR (toner_pct BETWEEN 0 AND 100));

COMMENT ON COLUMN rental_items.toner_pct IS '토너 잔량 % (수동입력, 0~100, NULL=미입력)';


-- ============================================================
-- >>> 33_collector_init.sql
-- ============================================================
-- ============================================================
-- 33_collector_init.sql  (2026-05-31)
-- 장비관리(rental-equipment) 실시간 수집기 — Phase A.1 스키마.
-- 고정 페어링 코드: 'hanbyeol' (rental-equipment/index.js 와 collector EXE 모두 동일).
-- ============================================================

-- ===== 1. rental_collectors — PC 단위 에이전트 등록 =====
-- 한 고객 PC에 EXE 1개 설치 = 행 1개. customer_id 는 처음엔 NULL,
-- 한별 관리자가 장비관리 페이지에서 드롭다운으로 매핑.
CREATE TABLE IF NOT EXISTS rental_collectors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     TEXT REFERENCES rental_customers(id) ON DELETE SET NULL,
  pc_name         TEXT,                                 -- 고객 PC 호스트네임
  os_user         TEXT,                                 -- 설치한 Windows 사용자
  agent_version   TEXT,
  token           TEXT NOT NULL UNIQUE,                 -- 수집기 인증용 (페어링 시 발급)
  status          TEXT NOT NULL DEFAULT 'pending',      -- pending(매핑전) / active / disabled
  last_seen_at    TIMESTAMPTZ,                          -- 마지막 heartbeat/upload 시각
  paired_at       TIMESTAMPTZ DEFAULT now(),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rcl_customer ON rental_collectors (customer_id);
CREATE INDEX IF NOT EXISTS idx_rcl_status   ON rental_collectors (status);
CREATE INDEX IF NOT EXISTS idx_rcl_seen     ON rental_collectors (last_seen_at);

-- ===== 2. rental_collector_devices — collector 가 발견한 프린터 =====
-- LAN SNMP 스캔으로 발견된 장비. item_id 는 매핑 후 채워짐(rental_items 와 연결).
CREATE TABLE IF NOT EXISTS rental_collector_devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_id    UUID NOT NULL REFERENCES rental_collectors(id) ON DELETE CASCADE,
  item_id         TEXT REFERENCES rental_items(id) ON DELETE SET NULL,  -- 매핑 후 채움
  ip              INET,
  mac             TEXT,
  manufacturer    TEXT,                                 -- SNMP sysDescr 파싱
  model           TEXT,
  serial_snmp     TEXT,                                 -- prtMarkerLifeCount 직전 OID 등
  is_color        BOOLEAN,
  first_seen_at   TIMESTAMPTZ DEFAULT now(),
  last_seen_at    TIMESTAMPTZ DEFAULT now(),
  online          BOOLEAN DEFAULT TRUE,
  notes           TEXT,
  UNIQUE (collector_id, mac)
);
CREATE INDEX IF NOT EXISTS idx_rcd_collector ON rental_collector_devices (collector_id);
CREATE INDEX IF NOT EXISTS idx_rcd_item      ON rental_collector_devices (item_id);
CREATE INDEX IF NOT EXISTS idx_rcd_online    ON rental_collector_devices (online);

-- ===== 3. rental_counter_readings — 실시간 raw 카운터 =====
-- 수집기가 5분 폴링하며 값이 바뀐 경우에만 INSERT. 변경 없으면 last_seen_at 만 UPDATE.
CREATE TABLE IF NOT EXISTS rental_counter_readings (
  id              BIGSERIAL PRIMARY KEY,
  device_id       UUID NOT NULL REFERENCES rental_collector_devices(id) ON DELETE CASCADE,
  bw              INTEGER,
  color           INTEGER,
  total_pages     INTEGER,
  toner_k         INTEGER,                              -- 0~100
  toner_c         INTEGER,
  toner_m         INTEGER,
  toner_y         INTEGER,
  drum_pct        INTEGER,
  alert_text      TEXT,                                 -- SNMP prtAlertDescription 등
  read_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rcr_device_time ON rental_counter_readings (device_id, read_at DESC);

-- ===== 4. RLS =====
ALTER TABLE rental_collectors        ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_collector_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE rental_counter_readings  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'rental_collectors','rental_collector_devices','rental_counter_readings'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_auth_all', t);
    EXECUTE format($p$
      CREATE POLICY %I ON %I
        FOR ALL
        TO authenticated
        USING (true)
        WITH CHECK (true)
    $p$, t || '_auth_all', t);
  END LOOP;
END $$;

-- 확인
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'rental_collector%' OR table_name='rental_counter_readings'
 ORDER BY table_name;


-- ============================================================
-- >>> 34_collector_device_hidden.sql
-- ============================================================
-- ============================================================
-- 34_collector_device_hidden.sql  (2026-06-01)
-- 실시간 수집 데이터에서 '한별 제품 아님' 등 사용자가 삭제하고 싶은
-- device 를 soft-hide. 다음 폴링에서도 재등장 안 됨.
-- ============================================================
ALTER TABLE rental_collector_devices
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_rcd_hidden
  ON rental_collector_devices(hidden)
  WHERE hidden = FALSE;

COMMENT ON COLUMN rental_collector_devices.hidden IS
  '장비관리 페이지에서 사용자가 ✕ 눌러 숨긴 장비. submit-reading 이 이 행은 update/insert 안 함.';


-- ============================================================
-- >>> 35_collector_device_registered.sql
-- ============================================================
-- ============================================================
-- 35_collector_device_registered.sql  (2026-06-02)
-- 사용자가 카운터프로그램(collector-agent / scan_ui)에서 명시적으로
-- 체크하고 "선택 항목 업로드" 를 누른 장비만 장비관리에 "등록" 처리.
--
-- registered=TRUE 인 device 만:
--   - submit-reading 의 readings INSERT 대상이 됨 (백그라운드 폴링은
--     모든 발견 장비를 보내지만 서버가 미등록 readings 를 폐기)
--   - rental-equipment 페이지 실시간 표에 표시됨
--
-- 등록 흐름:
--   1) 페어링 → scan_ui 의 LAN 스캔
--   2) 한별 제품인 장비만 체크 → "선택 항목 업로드"
--   3) /functions/v1/register-devices 호출 → registered=TRUE 마킹
--   4) (이후) 같은 (collector_id, mac) 재등록 시도 → 이미 registered=TRUE 면 중복 차단
-- ============================================================

ALTER TABLE rental_collector_devices
  ADD COLUMN IF NOT EXISTS registered    BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NULL;

-- 부분 인덱스 — registered=TRUE 인 행만 인덱싱 (대부분 미등록 상태 가정)
CREATE INDEX IF NOT EXISTS idx_rcd_registered
  ON rental_collector_devices (collector_id, registered)
  WHERE registered = TRUE;

COMMENT ON COLUMN rental_collector_devices.registered IS
  'scan_ui 에서 한별 운영자/고객이 명시적으로 체크/업로드한 장비.
   기본 FALSE. submit-reading 의 readings 는 registered=TRUE AND hidden=FALSE 인 device 에 한해 INSERT.
   장비관리 페이지 실시간 표도 registered=TRUE 만 표시.';

COMMENT ON COLUMN rental_collector_devices.registered_at IS
  '등록 시각. 재등록 시도 시 갱신하지 않음(최초 등록 시점 보존).';

-- 확인
SELECT
  COUNT(*) FILTER (WHERE registered = TRUE)  AS registered_count,
  COUNT(*) FILTER (WHERE registered = FALSE) AS unregistered_count,
  COUNT(*) AS total
FROM rental_collector_devices;


-- ============================================================
-- >>> 36_archive_file_optional.sql
-- ============================================================
-- ============================================================
-- 36_archive_file_optional.sql  (2026-06-05)
-- 소프트웨어고객자료실(archive) 글 작성 시 파일 첨부 선택사항으로 변경.
-- file_path / ext 모두 NULL 허용 — 메모만 있는 글도 등록 가능.
-- file_size 는 이미 NULL 허용.
-- ============================================================

ALTER TABLE customer_archives
  ALTER COLUMN file_path DROP NOT NULL,
  ALTER COLUMN ext       DROP NOT NULL;

COMMENT ON COLUMN customer_archives.file_path IS
  'Supabase Storage 경로. NULL 가능 (메모만 작성하는 글).';
COMMENT ON COLUMN customer_archives.ext IS
  '파일 확장자(소문자). NULL 가능 (파일 없을 때).';

-- 확인
SELECT column_name, is_nullable
FROM information_schema.columns
WHERE table_name = 'customer_archives'
  AND column_name IN ('file_path', 'ext', 'file_size')
ORDER BY column_name;


-- ============================================================
-- >>> 37_customer_payment_methods.sql
-- ============================================================
-- ============================================================
-- 37_customer_payment_methods.sql  (2026-06-05)
-- 거래처(rental_customers) 결제내역 컬럼 추가 — CMS계좌 / CMS카드 / 입금 다중 체크
-- ============================================================
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS payment_methods TEXT[] NULL;

COMMENT ON COLUMN rental_customers.payment_methods IS
  '거래처 결제 수단 (다중 선택, 체크박스). 가능 값: CMS계좌 / CMS카드 / 입금. NULL=미지정.';

-- 확인
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'rental_customers' AND column_name = 'payment_methods';


-- ============================================================
-- >>> 38_customer_billing_types.sql
-- ============================================================
-- ============================================================
-- 38_customer_billing_types.sql  (2026-06-05)
-- 발행 구분 다중 선택 컬럼 추가 — billing_types TEXT[].
-- 기존 단일 컬럼 billing_type 은 호환성 보존(다른 모듈 사용).
-- 폼 저장 시 billing_types 의 첫 번째 값으로 billing_type 동기화.
-- ============================================================

ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_types TEXT[] NULL;

COMMENT ON COLUMN rental_customers.billing_types IS
  '발행 구분 다중 선택 (체크박스). 가능 값: 전자세금계산서 / 거래명세표 / (예전: 종이세금계산서 / 현금영수증).
   기존 billing_type 단일 컬럼도 호환성 유지(첫 번째 값과 동기화).';

-- (디직스 보강) 호환용 단일 컬럼 billing_type — 한별 원본은 MCP로 직접 추가돼 있던 컬럼이라
-- 추적된 마이그레이션엔 없어 빈 디직스 DB엔 존재하지 않음. 먼저 만들어 둔다.
ALTER TABLE rental_customers
  ADD COLUMN IF NOT EXISTS billing_type TEXT NULL;

-- 기존 데이터 마이그레이션 — billing_type 에 값 있고 billing_types 가 NULL 이면 1원소 배열로 채움
UPDATE rental_customers
   SET billing_types = ARRAY[billing_type]
 WHERE billing_type IS NOT NULL
   AND billing_types IS NULL;

-- 확인
SELECT
  COUNT(*) FILTER (WHERE billing_types IS NOT NULL) AS migrated_count,
  COUNT(*) AS total
FROM rental_customers;


-- ============================================================
-- >>> 39_rental_item_types_master.sql
-- ============================================================
-- ============================================================
-- 39_rental_item_types_master.sql  (2026-06-05)
-- 품목 마스터 테이블 — 모든 모듈이 공통으로 사용.
-- 한 곳(임대거래처 ⚙ 품목 관리) 에서 수정하면 다른 모듈도 다음 진입 시 자동 반영.
-- ============================================================

CREATE TABLE IF NOT EXISTS rental_item_types (
  id          BIGSERIAL PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,            -- 내부 식별/DB 저장값. 예: '컴퓨터'
  category    TEXT NOT NULL DEFAULT '기타',    -- '출력' / 'IT' / '위생' / '기타'
  icon        TEXT,                            -- '💻' '🖨' 등 (그룹 헤더 표시용)
  sort_order  INTEGER NOT NULL DEFAULT 0,      -- 표시 순서 (오름차순)
  form_label  TEXT,                            -- 폼/계약서 select 표시명. 예: '흑백복사기(A3)'
  is_print    BOOLEAN NOT NULL DEFAULT FALSE,  -- 카운터/빌링 대상 여부
  active      BOOLEAN NOT NULL DEFAULT TRUE,   -- false=숨김 (옵션에서 제외)
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rit_active_sort ON rental_item_types (active, sort_order);

ALTER TABLE rental_item_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_item_types_auth_all ON rental_item_types;
CREATE POLICY rental_item_types_auth_all ON rental_item_types
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 시드 (기존 11종) — ON CONFLICT(label) 로 멱등 (재실행 안전)
INSERT INTO rental_item_types (label, category, icon, sort_order, form_label, is_print, active) VALUES
  ('흑백복사기',   '출력', '🖨', 10, '흑백복사기(A3)',         TRUE,  TRUE),
  ('컬러복사기',   '출력', '🖨', 20, '컬러복사기(A3)',         TRUE,  TRUE),
  ('흑백레이저',   '출력', '🖨', 30, '흑백레이저/복합기(A4)',  TRUE,  TRUE),
  ('컬러레이저',   '출력', '🖨', 40, '컬러레이저/복합기(A4)',  TRUE,  TRUE),
  ('잉크젯',       '출력', '🖨', 50, '잉크젯',                 TRUE,  TRUE),
  ('컴퓨터',       'IT',   '💻', 60, '컴퓨터',                 FALSE, TRUE),
  ('노트북',       'IT',   '💻', 70, '노트북',                 FALSE, TRUE),
  ('모니터',       'IT',   '🖥', 80, '모니터',                 FALSE, TRUE),
  ('PC유지보수',   'IT',   '🛠', 90, 'PC유지보수',             FALSE, TRUE),
  ('웰리스',       '위생', '🌿', 100,'웰리스',                 FALSE, TRUE),
  ('나스',         'IT',   '📦', 110,'나스',                   FALSE, TRUE)
ON CONFLICT (label) DO NOTHING;

SELECT label, category, icon, sort_order, form_label, is_print, active FROM rental_item_types ORDER BY sort_order;


-- ============================================================
-- >>> 40_rental_item_presets.sql
-- ============================================================
-- ============================================================
-- 40_rental_item_presets.sql
-- 브랜드 / 모델 자동 학습 테이블
-- 자산 등록/수정 시 입력값을 upsert하여 다음 등록 시 datalist 에 표시
-- ============================================================

-- ── 테이블 생성 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rental_item_presets (
  id            BIGSERIAL    PRIMARY KEY,
  type          TEXT         NOT NULL CHECK (type IN ('brand', 'model')),
  value         TEXT         NOT NULL,
  parent_brand  TEXT         DEFAULT NULL,   -- model 행인 경우 부모 브랜드
  usage_count   INT          NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── UNIQUE INDEX (expression — PG는 CONSTRAINT 안에서 함수 불가) ──
-- brand 행: parent_brand 가 NULL → ''로 정규화
-- model 행: (type, value, parent_brand) 조합이 unique
CREATE UNIQUE INDEX IF NOT EXISTS rental_item_presets_unique_idx
  ON public.rental_item_presets (type, value, COALESCE(parent_brand, ''));

-- ── RLS (다른 임대 테이블과 동일: authenticated 전체 권한) ────
ALTER TABLE public.rental_item_presets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rental_item_presets_auth_all ON public.rental_item_presets;
CREATE POLICY rental_item_presets_auth_all
  ON public.rental_item_presets
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── updated_at 자동 갱신 트리거 ──────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rental_item_presets_updated_at ON public.rental_item_presets;
CREATE TRIGGER rental_item_presets_updated_at
  BEFORE UPDATE ON public.rental_item_presets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 시드 데이터 ───────────────────────────────────────────────
-- 브랜드
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('brand', '교세라',   NULL, 10),
  ('brand', '엡손',     NULL, 5),
  ('brand', '브라더',   NULL, 5),
  ('brand', '캐논',     NULL, 5),
  ('brand', '조립',     NULL, 3),
  ('brand', '위더스',   NULL, 3),
  ('brand', '삼성',     NULL, 3),
  ('brand', '유디아',   NULL, 2),
  ('brand', '삼보',     NULL, 2),
  ('brand', '시놀로지', NULL, 3),
  ('brand', '웰리스',   NULL, 3),
  ('brand', '기타',     NULL, 1)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 교세라 모델
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', 'TASKalfa 251ci',    '교세라', 8),
  ('model', 'TASKalfa 351ci',    '교세라', 6),
  ('model', 'TASKalfa 2553ci',   '교세라', 5),
  ('model', 'TASKalfa 2552ci',   '교세라', 5),
  ('model', 'TASKalfa 3252ci',   '교세라', 4),
  ('model', 'TASKalfa 3253ci',   '교세라', 4),
  ('model', 'ECOSYS M5526cdn',   '교세라', 3)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 엡손 모델
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', 'EcoTank L3250',       '엡손', 3),
  ('model', 'EcoTank L5290',       '엡손', 2),
  ('model', 'WorkForce WF-2930',   '엡손', 2)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 브라더 모델
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', 'Brother MFC-J2740DW',  '브라더', 5),
  ('model', 'Brother MFC-L2700DW',  '브라더', 3),
  ('model', 'Brother DCP-L2550DW',  '브라더', 2)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 캐논 모델
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', 'imageRUNNER 2206N', '캐논', 3),
  ('model', 'imageRUNNER 2425',  '캐논', 3),
  ('model', 'MF445dw',           '캐논', 2)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 시놀로지 모델
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', 'DS220+',  '시놀로지', 3),
  ('model', 'DS420+',  '시놀로지', 3),
  ('model', 'DS720+',  '시놀로지', 2),
  ('model', 'DS920+',  '시놀로지', 2),
  ('model', 'DS1621+', '시놀로지', 1)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 웰리스 모델
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', 'Wellis W100', '웰리스', 2),
  ('model', 'Wellis W200', '웰리스', 1)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();

-- 브랜드 없는 공통 모델 (기타)
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('model', '기타', NULL, 1)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO UPDATE SET usage_count = rental_item_presets.usage_count + 1,
             updated_at   = now();


-- ============================================================
-- >>> 41_rental_item_presets_brand_update.sql
-- ============================================================
-- ============================================================
-- 41_rental_item_presets_brand_update.sql
-- 브랜드 목록 갱신: '컴퓨터', '모니터' 제거 + 새 브랜드 5개 추가
-- 멱등성 보장 (재실행 안전)
-- 실행 일자: 2026-06-08
-- ============================================================

-- ── '컴퓨터', '모니터' 브랜드 행 삭제 ────────────────────────
-- 주의: rental_items 테이블에 brand='컴퓨터' 또는 '모니터'로
--       입력된 자산 데이터는 영향 없음 (이 테이블은 마스터/추천 목록만 관리).
DELETE FROM public.rental_item_presets
WHERE type = 'brand'
  AND value IN ('컴퓨터', '모니터');

-- ── 새 브랜드 5개 추가 ───────────────────────────────────────
-- 이미 존재하는 경우 충돌 무시 (멱등)
INSERT INTO public.rental_item_presets (type, value, parent_brand, usage_count)
VALUES
  ('brand', '조립',   NULL, 3),
  ('brand', '위더스', NULL, 3),
  ('brand', '삼성',   NULL, 3),
  ('brand', '유디아', NULL, 2),
  ('brand', '삼보',   NULL, 2)
ON CONFLICT (type, value, COALESCE(parent_brand, ''))
DO NOTHING;


-- ============================================================
-- >>> 42_rental_items_total_counter.sql
-- ============================================================
-- 42_rental_items_total_counter.sql
-- 목적: rental_items 테이블에 합계 카운터 청구 모드 지원 컬럼 추가
-- 작성일: 2026-06-08
-- 멱등 (IF NOT EXISTS) — 중복 실행 안전

-- 1) counter_mode: 'split'(기본, 흑백+컬러 분리) | 'total'(합계 카운터 단일 청구)
ALTER TABLE public.rental_items
  ADD COLUMN IF NOT EXISTS counter_mode TEXT NOT NULL DEFAULT 'split'
    CHECK (counter_mode IN ('split', 'total'));

-- 2) total_unit_price: 합계 모드일 때 사용하는 매수당 단가 (원)
ALTER TABLE public.rental_items
  ADD COLUMN IF NOT EXISTS total_unit_price NUMERIC DEFAULT 0;

-- 기존 데이터 보정: NULL 이 들어간 경우 기본값으로 채움
UPDATE public.rental_items
  SET counter_mode = 'split'
  WHERE counter_mode IS NULL;

UPDATE public.rental_items
  SET total_unit_price = 0
  WHERE total_unit_price IS NULL;


-- ============================================================
-- >>> 43_rental_items_total_free_count.sql
-- ============================================================
-- 43_rental_items_total_free_count.sql
-- 목적: rental_items 테이블에 합계 카운터 모드 전용 무료 기본매수 컬럼 추가
-- 작성일: 2026-06-08
-- 멱등 (IF NOT EXISTS) — 중복 실행 안전
-- 관련 컬럼: counter_mode (split|total), total_unit_price (초과 단가), total_free_count (무료 기본매수)

-- total_free_count: 합계 모드일 때 무료로 제공하는 기본 매수 (이 매수까지는 무료, 초과분만 total_unit_price 로 청구)
ALTER TABLE public.rental_items
  ADD COLUMN IF NOT EXISTS total_free_count INT NOT NULL DEFAULT 0;

-- 기존 데이터 보정: NULL 이 들어간 경우 기본값으로 채움
UPDATE public.rental_items
  SET total_free_count = 0
  WHERE total_free_count IS NULL;

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';


-- ============================================================
-- >>> 44_rate_history_total_mode.sql
-- ============================================================
-- ============================================================
-- 44_rate_history_total_mode.sql
-- rental_item_rate_history 에 합계(total) 카운터 모드 컬럼 추가
-- 실행 방법: Supabase SQL Editor에서 전체 복사 후 Run
-- ============================================================

ALTER TABLE rental_item_rate_history
  ADD COLUMN IF NOT EXISTS total_free_count  INTEGER,   -- 합계 모드: 무료 매수
  ADD COLUMN IF NOT EXISTS total_unit_price  NUMERIC;   -- 합계 모드: 매수당 단가

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';

-- ── 확인 ────────────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name = 'rental_item_rate_history'
-- ORDER BY ordinal_position;


-- ============================================================
-- >>> 45_rental_billing_groups.sql
-- ============================================================
-- ============================================================
-- 45_rental_billing_groups.sql  (2026-06-09)
-- rental_billing_groups: 사업자(법인) 단위 청구 그룹
-- - rental_customers 는 사업장 단위 그대로 유지
-- - 같은 사업자번호로 여러 사업장(본점/지점/공장)이 있을 때 묶음
-- - 청구서·세금계산서·CMS 정보는 그룹에 저장하고 사업장에서 상속
--
-- ⚠️ 멱등 (IF NOT EXISTS) — 중복 실행 안전. 기존 데이터 영향 없음.
-- 안전 정책: 데이터 마이그레이션 안 함. UI 에서 그룹 우선 / 그룹 없으면 기존 값 사용.
-- ============================================================

-- 1) 청구 그룹 마스터
CREATE TABLE IF NOT EXISTS public.rental_billing_groups (
  id              TEXT PRIMARY KEY,                          -- bg_xxx
  name            TEXT NOT NULL,                             -- 그룹 표시명 (예: '홈마트')
  biz_no          TEXT,                                      -- 사업자번호
  ceo             TEXT,                                      -- 대표자
  biz_type        TEXT,                                      -- 업태
  biz_item        TEXT,                                      -- 종목
  fax             TEXT,                                      -- 사업자 팩스
  billing_type    TEXT,                                      -- '전자세금계산서' | '거래명세표'
  payment_type    TEXT,                                      -- 결제수단 분류
  payment_methods TEXT[],                                    -- 다중 결제수단
  billing_types   TEXT[],                                    -- 다중 청구방식
  bill_combined   BOOLEAN DEFAULT TRUE,                      -- 그룹 통합 발행 여부 (TRUE 면 1장 합산)
  billing_months  INT,                                       -- N개월 단위 청구
  invoice_day     TEXT,                                      -- 청구일 (예: '25')
  notes           TEXT,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rental_billing_groups_name   ON public.rental_billing_groups(name);
CREATE INDEX IF NOT EXISTS idx_rental_billing_groups_biz_no ON public.rental_billing_groups(biz_no);

-- RLS — 다른 rental_* 테이블과 동일 (authenticated 전체권한)
ALTER TABLE public.rental_billing_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_billing_groups_auth_all ON public.rental_billing_groups;
CREATE POLICY rental_billing_groups_auth_all ON public.rental_billing_groups
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- 2) rental_customers 에 그룹 연결 컬럼
ALTER TABLE public.rental_customers
  ADD COLUMN IF NOT EXISTS billing_group_id TEXT
    REFERENCES public.rental_billing_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_rental_customers_billing_group
  ON public.rental_customers(billing_group_id);

-- 3) updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION public.rental_billing_groups_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_rental_billing_groups_touch ON public.rental_billing_groups;
CREATE TRIGGER tr_rental_billing_groups_touch
  BEFORE UPDATE ON public.rental_billing_groups
  FOR EACH ROW
  EXECUTE FUNCTION public.rental_billing_groups_touch_updated_at();

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';

-- 확인
SELECT 'rental_billing_groups created' AS result;


-- ============================================================
-- >>> 46_customer_billing_individual.sql
-- ============================================================
-- ============================================================
-- 46_customer_billing_individual.sql  (2026-06-09)
-- rental_customers.billing_individual: 그룹 통합 발행이라도 이 사업장만 별도 발행하도록 표시
-- 우선순위:
--   1) 그룹 bill_combined=false → 모든 사업장 따로 (사업장 individual 무시)
--   2) 그룹 bill_combined=true  + customer.billing_individual=true → 이 사업장만 별도 1장
--   3) 그룹 bill_combined=true  + customer.billing_individual=false → 그룹 통합에 포함 (기본)
--
-- ⚠️ 멱등 (IF NOT EXISTS) — 중복 실행 안전. 기본값 FALSE 라 기존 데이터는 기본 동작 유지.
-- ============================================================

ALTER TABLE public.rental_customers
  ADD COLUMN IF NOT EXISTS billing_individual BOOLEAN NOT NULL DEFAULT FALSE;

NOTIFY pgrst, 'reload schema';

SELECT 'rental_customers.billing_individual added' AS result;


-- ============================================================
-- >>> 47_rental_items_asset_number.sql
-- ============================================================
-- ============================================================
-- 47_rental_items_asset_number.sql  (2026-06-09)
-- rental_items.asset_number: 한별이 자체 부여하는 자산번호 (시리얼과 별개)
--
-- 매칭 우선순위 (rental-counters 엑셀 업로드):
--   1차: asset_number (최소 2자 이상일 때만 정확 일치)
--   2차: serial
--   3차: company + model
--
-- 도입 사유: 시리얼만으로 매칭하면 장비를 다른 회사로 이전한 경우 잘못 매칭됨.
-- 자산번호는 거래처 이전과 무관하게 한별이 추적하는 고유 코드.
--
-- ⚠️ 멱등 (IF NOT EXISTS) — 중복 실행 안전. 기존 데이터 NULL 유지.
-- ============================================================

ALTER TABLE public.rental_items
  ADD COLUMN IF NOT EXISTS asset_number TEXT;

CREATE INDEX IF NOT EXISTS idx_rental_items_asset_number
  ON public.rental_items(asset_number);

NOTIFY pgrst, 'reload schema';

SELECT 'rental_items.asset_number added' AS result;


-- ============================================================
-- >>> 48_collector_devices_asset_number.sql
-- ============================================================
-- ============================================================
-- 48_collector_devices_asset_number.sql  (2026-06-09)
-- rental_collector_devices.asset_number: 임대장비관리 표에서 device 별 수기 입력
--
-- 왜 device 에 직접: 한 거래처에 동일 모델 2대 이상이면 device 의 item_id 자동 매핑이
-- 모호. 사용자가 device 별로 자산번호를 명시 입력해두면 임대카운터 매칭
-- (rental_items.asset_number) 과 일관되게 식별 가능.
--
-- ⚠️ 멱등 (IF NOT EXISTS). 기존 데이터 영향 없음 (기본 NULL).
-- ============================================================

ALTER TABLE public.rental_collector_devices
  ADD COLUMN IF NOT EXISTS asset_number TEXT;

CREATE INDEX IF NOT EXISTS idx_rental_collector_devices_asset_number
  ON public.rental_collector_devices(asset_number);

NOTIFY pgrst, 'reload schema';

SELECT 'rental_collector_devices.asset_number added' AS result;


-- ============================================================
-- >>> 49_usb_counter_baseline.sql
-- ============================================================
-- ============================================================
-- 49_usb_counter_baseline.sql  (2026-06-17)
-- USB 프린터 카운터 평생누적 보정.
--
-- 배경: collector-agent/usb_printers.py 가 보내는 total_pages 는
--   Win32 PerfFormattedData "TotalPagesPrinted" — PC 재부팅/스풀러
--   재시작 시 0 으로 리셋되는 "부팅 후 누적".
--   네트워크(SNMP) 프린터는 펌웨어가 평생누적을 들고 있으므로 불필요.
--
-- 해결: 서버에서 직전 raw 값과 비교해 리셋을 감지하고 baseline 누적.
--   cumulative = usb_baseline + raw
--   raw < usb_last_raw  →  usb_baseline += usb_last_raw (리셋 감지)
--   raw >= usb_last_raw →  usb_baseline 유지
--   둘 다 항상 usb_last_raw = raw 로 갱신
--
-- 컬럼 추가 위치:
--   rental_collector_devices : usb_baseline, usb_last_raw (상태 보존)
--   rental_counter_readings  : total_pages_raw (감사용 — 원본 raw 값)
-- ============================================================

ALTER TABLE rental_collector_devices
  ADD COLUMN IF NOT EXISTS usb_baseline BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usb_last_raw BIGINT;

ALTER TABLE rental_counter_readings
  ADD COLUMN IF NOT EXISTS total_pages_raw INTEGER;

COMMENT ON COLUMN rental_collector_devices.usb_baseline IS
  'USB 프린터 전용. 과거 리셋들에서 누적한 페이지 합. cumulative = usb_baseline + 현재 raw.';
COMMENT ON COLUMN rental_collector_devices.usb_last_raw IS
  'USB 프린터 전용. 직전 보고된 raw(부팅 후 누적). 다음 reading 의 리셋 감지 기준.';
COMMENT ON COLUMN rental_counter_readings.total_pages_raw IS
  'USB 프린터 전용. 클라이언트가 보낸 부팅 후 누적 raw 값(감사용). total_pages 는 평생누적.';

-- 확인
SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'rental_collector_devices'
   AND column_name IN ('usb_baseline', 'usb_last_raw');


-- ============================================================
-- >>> app_settings.sql
-- ============================================================
-- =====================================================================
-- 앱 공용 설정 테이블 — 기기 공용 키 저장 (PC·핸드폰 한 번만 입력)
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣고 실행
-- 용도: Gemini API 키 등 설정을 DB에 저장해, 어느 기기에서 로그인하든 자동 로드
-- =====================================================================

create table if not exists app_settings (
  key        text primary key,        -- 'gemini_apikey', 'gemini_model' 등
  value      text,
  updated_at timestamptz default now()
);

alter table app_settings enable row level security;

-- 로그인(authenticated) 사용자만 읽기/쓰기 (기존 totalas 패턴과 동일 — 외부 노출 차단)
drop policy if exists "auth all app_settings" on app_settings;
create policy "auth all app_settings"
  on app_settings for all
  to authenticated
  using (true) with check (true);


-- ============================================================
-- >>> schema.sql
-- ============================================================
-- =====================================================================
-- 한별시스템 명함관리 모듈 — Supabase 스키마
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣고 실행
-- 설계: 기존 rental_customers(거래처 원장)를 재활용해 명함을 매칭/연결한다.
--       회사(거래처) = rental_customers, 담당자(명함) = business_cards
-- =====================================================================

-- 0) 유사도 검색용 확장 (회사명 fuzzy 매칭)
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- 1) 명함(담당자) 테이블
--    customer_id 가 채워지면 = 기존 거래처에 묶인 상태
--    customer_id 가 null 이면 = 아직 거래처 미연결(신규/미분류)
-- ---------------------------------------------------------------------
create table if not exists business_cards (
  id                uuid primary key default gen_random_uuid(),
  customer_id       text references rental_customers(id) on delete set null,  -- 기존 거래처 연결 (rental_customers.id 는 text)
  company_raw       text,                 -- 명함에 적힌 회사명 원본
  company_normalized text,                -- 정규화 회사명(매칭 키)
  name              text,                 -- 담당자 이름
  title             text,                 -- 직책
  department        text,                 -- 부서
  phone_mobile      text,
  phone_office      text,
  fax               text,
  email             text,
  email_domain      text,                 -- 식별 보조키
  address           text,
  website           text,
  biz_no            text,                 -- 사업자등록번호
  consent_marketing boolean default false,-- ★ 광고 수신동의 (정보통신망법 §50)
  consent_date      timestamptz,
  card_image_url    text,                 -- Storage 경로
  raw_text          text,                 -- OCR 원문
  memo              text,                 -- 영업 메모
  pending_group_ids uuid[],                -- 모바일 촬영 시 미리 지정한 그룹 (거래처 연결 시 card_group_map 으로 이관 가능)
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_cards_customer  on business_cards (customer_id);
create index if not exists idx_cards_norm      on business_cards using gin (company_normalized gin_trgm_ops);
create index if not exists idx_cards_email      on business_cards (email);
create index if not exists idx_cards_consent    on business_cards (consent_marketing);
create index if not exists idx_cards_bizno      on business_cards (biz_no);
create index if not exists idx_cards_pending_groups on business_cards using gin (pending_group_ids);

-- ---------------------------------------------------------------------
-- 2) 그룹(수동 태그)
-- ---------------------------------------------------------------------
create table if not exists card_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  category    text,                       -- 업종 / 거래단계 / 서비스 / 지역
  color       text default '#2563eb',
  created_at  timestamptz default now()
);

-- 거래처-그룹 다대다 (그룹은 거래처 단위로 묶는다 → 명함이 여러 장이어도 회사 하나로 타겟팅)
create table if not exists card_group_map (
  customer_id text references rental_customers(id) on delete cascade,
  group_id    uuid references card_groups(id) on delete cascade,
  primary key (customer_id, group_id)
);

-- ---------------------------------------------------------------------
-- 3) 발송 이력
-- ---------------------------------------------------------------------
create table if not exists card_send_logs (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid references business_cards(id) on delete set null,
  customer_id text references rental_customers(id) on delete set null,
  channel     text,                       -- 'kakao' | 'email'
  template_id uuid,
  subject     text,
  body        text,                       -- 치환 완료된 실제 발송 본문
  status      text default 'sent',        -- 'sent' | 'failed' | 'opened' | 'replied'
  is_ad       boolean default true,
  sent_at     timestamptz default now(),
  error_msg   text
);
create index if not exists idx_sendlogs_card on card_send_logs (card_id);

-- ---------------------------------------------------------------------
-- 4) 메시지 템플릿
-- ---------------------------------------------------------------------
create table if not exists card_templates (
  id        uuid primary key default gen_random_uuid(),
  name      text,
  channel   text,                         -- 'kakao' | 'email'
  subject   text,                         -- 메일 제목
  body      text,                         -- {{company}} {{name}} {{title}} 변수 포함
  is_ad     boolean default true,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 5) ★ 발송 가능 대상 뷰 — 동의자만 노출(위법 발송 구조적 차단)
-- ---------------------------------------------------------------------
create or replace view sendable_cards as
select
  bc.id          as card_id,
  bc.customer_id,
  bc.name,
  bc.title,
  bc.email,
  bc.phone_mobile,
  coalesce(rc.company, bc.company_raw) as company_name
from business_cards bc
left join rental_customers rc on bc.customer_id = rc.id
where bc.consent_marketing = true;

-- ---------------------------------------------------------------------
-- 6) RLS — 로그인 사용자만 접근 (기존 totalas auth 패턴과 동일)
-- ---------------------------------------------------------------------
alter table business_cards  enable row level security;
alter table card_groups     enable row level security;
alter table card_group_map  enable row level security;
alter table card_send_logs  enable row level security;
alter table card_templates  enable row level security;

-- 로그인(authenticated) 사용자에게 전체 권한 (기존 모듈과 동일 정책)
do $$
declare t text;
begin
  foreach t in array array['business_cards','card_groups','card_group_map','card_send_logs','card_templates']
  loop
    execute format('drop policy if exists "auth all %1$s" on %1$s;', t);
    execute format('create policy "auth all %1$s" on %1$s for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7) 기본 그룹 시드 (한별시스템 맞춤) — 중복 방지
-- ---------------------------------------------------------------------
insert into card_groups (name, category, color)
select * from (values
  ('제조',       '업종',     '#2563eb'),
  ('병원',       '업종',     '#0ea5e9'),
  ('관공서',     '업종',     '#7c3aed'),
  ('학교',       '업종',     '#059669'),
  ('잠재고객',   '거래단계', '#f59e0b'),
  ('견적진행',   '거래단계', '#f97316'),
  ('계약완료',   '거래단계', '#16a34a'),
  ('유지보수중', '거래단계', '#0d9488'),
  ('NAS구축',    '서비스',   '#4f46e5'),
  ('프린터렌탈', '서비스',   '#db2777'),
  ('컴퓨터렌탈', '서비스',   '#9333ea'),
  ('특수장비',   '서비스',   '#dc2626')
) as v(name, category, color)
where not exists (select 1 from card_groups cg where cg.name = v.name);

-- ---------------------------------------------------------------------
-- 8) 명함 이미지 Storage 버킷 (비공개) — 아래는 참고용. Dashboard에서 만들어도 됨.
--    Storage → New bucket → name: business-cards, Public: OFF
-- ---------------------------------------------------------------------
-- insert into storage.buckets (id, name, public) values ('business-cards','business-cards', false)
--   on conflict (id) do nothing;


-- ============================================================
-- >>> schema.sql
-- ============================================================
-- ============================================================
-- rental-counters/schema.sql  (2026-05-27)
-- 한별카운터 엑셀 직접 업로드용 보조 테이블
--
-- 기존 rental_counters 는 item_id (rental_items FK) 기반이라
-- 자산 매칭이 안 된 기기를 저장할 수 없음.
-- hanbyeol_counters 는 serial(일련번호)을 기본 키로 하여
-- 매칭 여부와 관계없이 모든 기기 카운터를 보존.
--
-- 멱등 — 재실행 안전 (IF NOT EXISTS / ON CONFLICT DO NOTHING)
-- ============================================================

-- ===== 1. hanbyeol_counters — 한별 파일 원본 카운터 =====
CREATE TABLE IF NOT EXISTS hanbyeol_counters (
  id            BIGSERIAL      PRIMARY KEY,
  ym            TEXT           NOT NULL,        -- 'YYYY-MM'  (폴더명 기준)
  serial        TEXT           NOT NULL,        -- 열3: 일련번호 (고유 식별자)
  customer      TEXT,                           -- 열0 (열0='1임대제품'이면 열5 대체)
  location      TEXT,                           -- 열5: 자산번호/설치위치
  model         TEXT,                           -- 열2: 모델명
  ip_address    TEXT,                           -- 열6: IP 주소
  bw            INTEGER,                        -- 열13: 흑백 누적 카운터
  color         INTEGER,                        -- 열14: 컬러 누적 (흑백 전용기는 NULL)
  total         INTEGER,                        -- 열12: 결합 합계
  last_update   DATE,                           -- 열9: 마지막 업데이트(검침일)
  uploaded_at   TIMESTAMPTZ    DEFAULT now(),
  upload_id     UUID           REFERENCES rental_counter_uploads(id) ON DELETE CASCADE,
  -- 자산 매칭 결과 (매칭 성공 시 채워짐)
  item_id       TEXT           REFERENCES rental_items(id) ON DELETE SET NULL,
  match_status  TEXT           DEFAULT 'unmatched'  -- 'matched' | 'unmatched' | 'ambiguous'
                               CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
  UNIQUE (serial, ym)
);

CREATE INDEX IF NOT EXISTS idx_hbc_ym       ON hanbyeol_counters (ym);
CREATE INDEX IF NOT EXISTS idx_hbc_customer ON hanbyeol_counters (customer);
CREATE INDEX IF NOT EXISTS idx_hbc_serial   ON hanbyeol_counters (serial);
CREATE INDEX IF NOT EXISTS idx_hbc_item_id  ON hanbyeol_counters (item_id);

-- RLS — authenticated 전체권한
ALTER TABLE hanbyeol_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hanbyeol_counters_auth_all ON hanbyeol_counters;
CREATE POLICY hanbyeol_counters_auth_all ON hanbyeol_counters
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);


-- ===== 2. 확인 쿼리 =====
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'hanbyeol_counters'
 ORDER BY ordinal_position;


-- ============================================================
-- >>> supabase-migration.sql
-- ============================================================
-- ============================================================
-- meetings/supabase-migration.sql  (2026-06-07 v2)
-- 음성미팅관리 모듈 - Plaud 3-Track + AutoFlow(Gmail) 자동 연동
--
-- 적용 방법:
--   1) Supabase Studio > SQL Editor 에서 본 파일 내용을 그대로 실행
--   2) Supabase Studio > Storage > New bucket: `meeting-audio`
--      - Public: OFF (Private)
--      - File size limit: 200 MB 권장
--      - Allowed MIME types: audio/*
--
-- 의존 테이블: rental_customers(id uuid)
-- v2 변경: source, plaud_message_id, suggested, approved 추가 + anon RLS
-- ============================================================

-- ===== 1. rental_meetings — 미팅 본문 =====
create table if not exists rental_meetings (
  id uuid primary key default gen_random_uuid(),
  customer_id text references rental_customers(id),     -- NULL 허용: 자동 import 후 수동 매핑
  meeting_date date not null,
  meeting_time time,
  duration_seconds int,
  title text not null,
  attendees text[],
  tags text[],
  audio_path text,
  audio_filename text,
  transcript_text text,
  summary_md text,
  -- AutoFlow 연동 필드
  source text not null default 'manual'
    check (source in ('manual', 'plaud_autoflow')),
  plaud_message_id text unique,                          -- Gmail Message-ID (중복 방지)
  auto_imported boolean default false,
  import_source text,
  match_confidence numeric,
  match_candidates jsonb,
  external_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_meetings_customer_date
  on rental_meetings(customer_id, meeting_date desc);
create index if not exists idx_meetings_transcript_gin
  on rental_meetings using gin(to_tsvector('simple', coalesce(transcript_text,'')));

-- ===== 2. rental_meeting_actions — 자동 추출 액션 아이템 =====
create table if not exists rental_meeting_actions (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references rental_meetings(id) on delete cascade,
  action_type text check (action_type in ('quote','promise','as','contract','todo')),
  content text not null,
  amount numeric,
  due_date date,
  status text default 'open' check (status in ('open','done','cancelled')),
  linked_item_id uuid,
  linked_billing_id uuid,
  -- 제안 모드 필드 (클라이언트 자동 추출 → 사용자 승인 전까지 suggested=true)
  suggested boolean not null default false,
  approved  boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists idx_meeting_actions_meeting_status
  on rental_meeting_actions(meeting_id, status);

-- ===== 3. RLS — anon + authenticated 전체권한 (내부 관리툴) =====
alter table rental_meetings        enable row level security;
alter table rental_meeting_actions enable row level security;

drop policy if exists "authenticated all" on rental_meetings;
create policy "authenticated all" on rental_meetings
  for all to authenticated using (true) with check (true);

drop policy if exists "anon all" on rental_meetings;
create policy "anon all" on rental_meetings
  for all to anon using (true) with check (true);

drop policy if exists "authenticated all" on rental_meeting_actions;
create policy "authenticated all" on rental_meeting_actions
  for all to authenticated using (true) with check (true);

drop policy if exists "anon all" on rental_meeting_actions;
create policy "anon all" on rental_meeting_actions
  for all to anon using (true) with check (true);

-- ===== 4. 확인 쿼리 =====
select 'rental_meetings' as table_name, count(*) from rental_meetings
union all
select 'rental_meeting_actions', count(*) from rental_meeting_actions;



-- ============================================================
-- >>> (보강) MCP-유령 컬럼 — 코드 참조 but 마이그레이션 부재분
-- ============================================================
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
