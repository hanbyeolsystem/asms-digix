-- ============================================================
-- 50_device_notes.sql  (2026-06-28)
-- 장비 상세페이지 — 장비별 메모/관리 이력 (점검·AS·토너교체 기록 등).
-- rental_collector_devices 1건당 여러 메모를 시간순으로 누적.
-- ============================================================
CREATE TABLE IF NOT EXISTS rental_device_notes (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES rental_collector_devices(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rdn_device_time
  ON rental_device_notes(device_id, created_at DESC);

ALTER TABLE rental_device_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rental_device_notes_auth_all ON rental_device_notes;
CREATE POLICY rental_device_notes_auth_all ON rental_device_notes
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE rental_device_notes IS
  '장비 상세페이지 메모/관리 이력 — device 1건당 다건. 점검·AS·교체 기록 등.';
