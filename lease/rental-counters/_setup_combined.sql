-- ============================================================
-- 임대카운터 통합 설정 SQL  (2026-05-27)
-- 한 번에 Supabase SQL Editor 에 붙여넣고 Run 하세요.
--
-- 포함:
--   [PART 1] rental_counter_uploads + Storage 'counter-uploads'
--            + rental_counters.upload_id 컬럼 추가
--   [PART 2] hanbyeol_counters 테이블 (한별 엑셀 원본 보관용)
--
-- 모두 멱등 — 재실행 안전 (IF NOT EXISTS / ON CONFLICT).
-- 실행 순서는 그대로 두세요 (PART 2 가 PART 1 의 테이블을 참조).
-- ============================================================


-- ╔══════════════════════════════════════════════════════════╗
-- ║ [PART 1] rental_counter_uploads + Storage                ║
-- ╚══════════════════════════════════════════════════════════╝

-- ===== 1-1. Storage bucket 'counter-uploads' (private) =====
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


-- ===== 1-2. rental_counter_uploads — 업로드 이력 =====
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

ALTER TABLE rental_counter_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_counter_uploads_auth_all ON rental_counter_uploads;
CREATE POLICY rental_counter_uploads_auth_all ON rental_counter_uploads
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);


-- ===== 1-3. rental_counters 에 upload_id FK 추가 =====
ALTER TABLE rental_counters
  ADD COLUMN IF NOT EXISTS upload_id UUID
    REFERENCES rental_counter_uploads(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_rc_upload ON rental_counters (upload_id);


-- ╔══════════════════════════════════════════════════════════╗
-- ║ [PART 2] hanbyeol_counters — 한별 엑셀 원본 보관         ║
-- ╚══════════════════════════════════════════════════════════╝

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
  item_id       TEXT           REFERENCES rental_items(id) ON DELETE SET NULL,
  match_status  TEXT           DEFAULT 'unmatched'
                               CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
  UNIQUE (serial, ym)
);

CREATE INDEX IF NOT EXISTS idx_hbc_ym       ON hanbyeol_counters (ym);
CREATE INDEX IF NOT EXISTS idx_hbc_customer ON hanbyeol_counters (customer);
CREATE INDEX IF NOT EXISTS idx_hbc_serial   ON hanbyeol_counters (serial);
CREATE INDEX IF NOT EXISTS idx_hbc_item_id  ON hanbyeol_counters (item_id);

ALTER TABLE hanbyeol_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hanbyeol_counters_auth_all ON hanbyeol_counters;
CREATE POLICY hanbyeol_counters_auth_all ON hanbyeol_counters
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);


-- ╔══════════════════════════════════════════════════════════╗
-- ║ 확인 쿼리                                                 ║
-- ╚══════════════════════════════════════════════════════════╝

-- 1) rental_counter_uploads 스키마 확인
SELECT 'rental_counter_uploads' AS table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'rental_counter_uploads'
 ORDER BY ordinal_position;

-- 2) rental_counters 에 upload_id 가 추가됐는지 확인
SELECT 'rental_counters.upload_id' AS check_item, column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'rental_counters' AND column_name = 'upload_id';

-- 3) hanbyeol_counters 스키마 확인
SELECT 'hanbyeol_counters' AS table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_name = 'hanbyeol_counters'
 ORDER BY ordinal_position;
