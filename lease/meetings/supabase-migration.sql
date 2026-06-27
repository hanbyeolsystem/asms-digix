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
