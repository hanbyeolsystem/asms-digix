-- =====================================================================
-- 누락된 pending_group_ids 컬럼 추가 (그룹 저장 오류 fix)
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣고 1회 실행
-- 증상: "Could not find the 'pending_group_ids' column of 'business_cards'
--       in the schema cache"
-- 원인: 명함관리 초기 schema 적용 후 pending_group_ids 컬럼이 추가됐는데
--       기존 DB에 반영이 안 된 상태.
-- =====================================================================

alter table business_cards
  add column if not exists pending_group_ids uuid[];

create index if not exists idx_cards_pending_groups
  on business_cards using gin (pending_group_ids);

-- 스키마 캐시 즉시 리프레시 (Supabase PostgREST)
notify pgrst, 'reload schema';
