-- =====================================================================
-- 명함관리 — 자동 동기화 설치 스크립트
-- ✅ 2026-06-16 Supabase MCP 로 한 번에 자동 적용 완료 (project ref: wghjnlhfqypamiwukeio)
--
-- 이 파일은 이미 실행된 마이그레이션의 "기록"입니다.
-- 동일 SQL 을 다시 실행해도 안전(idempotent)하지만 새로 실행할 필요는 없습니다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) phone_norm 컬럼 — 숫자만 추출, 중복 판단/lookup 키.
--    중복 데이터가 있어서 unique 대신 일반 부분 인덱스 사용.
--    충돌 방지는 Edge Function 의 phone_norm SELECT 분기 로직이 담당.
-- ---------------------------------------------------------------------
alter table business_cards
  add column if not exists phone_norm text
  generated always as (
    regexp_replace(coalesce(phone_mobile, phone_office, ''), '[^0-9]', '', 'g')
  ) stored;

create index if not exists idx_cards_phone_norm
  on business_cards (phone_norm)
  where phone_norm is not null and phone_norm <> '';

-- ---------------------------------------------------------------------
-- 2) email_domain 자동 채움 트리거
-- ---------------------------------------------------------------------
create or replace function bc_fill_email_domain() returns trigger as $$
begin
  if new.email is not null and position('@' in new.email) > 0 then
    new.email_domain := lower(split_part(new.email, '@', 2));
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists trg_bc_fill_email_domain on business_cards;
create trigger trg_bc_fill_email_domain
  before insert or update of email on business_cards
  for each row execute function bc_fill_email_domain();

-- ---------------------------------------------------------------------
-- 3) 동기화 실행 이력
-- ---------------------------------------------------------------------
create table if not exists card_import_runs (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz default now(),
  finished_at         timestamptz,
  trigger_source      text,                 -- 'cron' | 'manual' | 'manual+upload' | ...
  files_processed     int default 0,
  inserted_count      int default 0,
  updated_count       int default 0,
  skipped_count       int default 0,
  fixed_normalized    int default 0,
  fixed_email_domain  int default 0,
  merged_duplicates   int default 0,
  relinked_customer   int default 0,
  pending_promoted    int default 0,
  status              text default 'running',  -- 'running'|'ok'|'error'
  error_msg           text,
  detail              jsonb
);
create index if not exists idx_cir_started on card_import_runs (started_at desc);

alter table card_import_runs enable row level security;
drop policy if exists "auth all card_import_runs" on card_import_runs;
create policy "auth all card_import_runs" on card_import_runs
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- 4) Storage 정책 — business-cards 버킷의 imports/ 폴더 사용
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='auth read business-cards'
  ) then
    execute $p$
      create policy "auth read business-cards" on storage.objects
        for select to authenticated
        using (bucket_id = 'business-cards')
    $p$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname='auth write business-cards'
  ) then
    execute $p$
      create policy "auth write business-cards" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'business-cards')
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5) pg_cron 잡 — 매일 03:30 KST (= UTC 18:30) 자동 실행
--    Edge Function 호출 인증은 anon JWT 임베드 (anon 키는 이미 클라이언트 코드에 공개됨).
--    Edge Function 내부는 SUPABASE_SERVICE_ROLE_KEY 환경변수로 RLS 우회.
-- ---------------------------------------------------------------------
do $$
declare
  job_id bigint;
begin
  select jobid into job_id from cron.job where jobname = 'business-cards-daily-sync';
  if job_id is not null then
    perform cron.unschedule(job_id);
  end if;

  perform cron.schedule(
    'business-cards-daily-sync',
    '30 18 * * *',
    $cron$
      select net.http_post(
        url     := 'https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/cards-sync',
        headers := jsonb_build_object(
          'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnaGpubGhmcXlwYW1pd3VrZWlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTYyODAsImV4cCI6MjA5NjczMjI4MH0.sOjiDveMGn_uIt6fzu4fqQtlDwNWkkoXWrz6gxy0XZg',
          'Content-Type',  'application/json'
        ),
        body    := jsonb_build_object('trigger', 'cron')
      );
    $cron$
  );
end $$;

-- ---------------------------------------------------------------------
-- 운영 쿼리 모음
-- ---------------------------------------------------------------------
-- 등록된 cron 잡 확인:
--   select jobid, jobname, schedule, active from cron.job where jobname like 'business-cards%';
--
-- 최근 실행 결과:
--   select started_at, status, files_processed, inserted_count, updated_count,
--          relinked_customer, fixed_normalized, fixed_email_domain, error_msg
--     from card_import_runs
--    order by started_at desc limit 10;
--
-- 핸드폰 중복 진단 (정리 필요 여부 확인):
--   select phone_norm, count(*) from business_cards
--    where phone_norm <> '' group by phone_norm having count(*) > 1;
--
-- 수동 실행:
--   select net.http_post(
--     url     := 'https://wghjnlhfqypamiwukeio.supabase.co/functions/v1/cards-sync',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer <anon JWT>',
--       'Content-Type',  'application/json'),
--     body    := jsonb_build_object('trigger','manual'));
