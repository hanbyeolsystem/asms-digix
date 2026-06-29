-- ============================================================
-- 51_device_supplies.sql  (2026-06-28)
-- 장비 상세 — 소모품(토너/잉크) 여분 재고 + 부족 알람 설정.
--   · 교체 이력은 rental_counter_readings 토너 잔량 급상승(+30%p)으로 매번 재계산 (저장 X)
--   · 여분 재고: 사용자가 set_at 시점에 spare_count 를 입력 → 그 이후 감지된 교체 횟수만 차감
--   · 잔량 ≤10% 인데 여분 0 이고 알람 ON 이면 '배송 필요'
-- 멱등 (IF NOT EXISTS) — 재실행 안전
-- ============================================================

-- ===== 1. 색상별 여분 재고 =====
CREATE TABLE IF NOT EXISTS rental_device_supplies (
  id          BIGSERIAL PRIMARY KEY,
  device_id   UUID NOT NULL REFERENCES rental_collector_devices(id) ON DELETE CASCADE,
  color       TEXT NOT NULL CHECK (color IN ('K','C','M','Y')),
  spare_count INT  NOT NULL DEFAULT 0,                 -- set_at 시점의 여분 개수
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),      -- 이 시점 이후 교체만 차감
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, color)
);
CREATE INDEX IF NOT EXISTS idx_rds_device ON rental_device_supplies(device_id);

ALTER TABLE rental_device_supplies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_device_supplies_auth_all ON rental_device_supplies;
CREATE POLICY rental_device_supplies_auth_all ON rental_device_supplies
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE rental_device_supplies IS
  '장비별 색상별 여분 소모품 재고. spare_count = set_at 시점 여분 개수, 이후 감지된 교체만큼 차감.';

-- ===== 2. 장비별 부족 알람 on/off =====
CREATE TABLE IF NOT EXISTS rental_device_supply_config (
  device_id     UUID PRIMARY KEY REFERENCES rental_collector_devices(id) ON DELETE CASCADE,
  alarm_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rental_device_supply_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rental_device_supply_config_auth_all ON rental_device_supply_config;
CREATE POLICY rental_device_supply_config_auth_all ON rental_device_supply_config
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMENT ON TABLE rental_device_supply_config IS
  '장비별 소모품 부족 알람 on/off. 기본 TRUE.';

NOTIFY pgrst, 'reload schema';
