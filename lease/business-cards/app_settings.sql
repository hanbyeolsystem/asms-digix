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
