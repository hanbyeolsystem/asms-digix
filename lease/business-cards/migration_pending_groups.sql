-- =====================================================================
-- 명함관리 — 모바일 빠른 입력에서 '그룹 미리 지정' 지원
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣고 Run (1회)
-- 내용:
--   business_cards 에 pending_group_ids uuid[] 컬럼 추가.
--   거래처 미연결 명함도 촬영 시점에 의도한 그룹을 잃지 않도록 보관한다.
--   거래처가 연결되면 card_group_map 으로 옮겨 정리할 수 있다.
-- =====================================================================

alter table business_cards
  add column if not exists pending_group_ids uuid[];

create index if not exists idx_cards_pending_groups
  on business_cards using gin (pending_group_ids);

comment on column business_cards.pending_group_ids is
  '모바일 빠른 입력에서 미리 지정한 그룹 id 목록. 거래처 연결 시 card_group_map 으로 이관할 수 있다.';
