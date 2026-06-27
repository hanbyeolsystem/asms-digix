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
