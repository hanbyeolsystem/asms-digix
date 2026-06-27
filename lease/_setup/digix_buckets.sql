-- ============================================================
-- 디직스코리아 임대관리 — 누락 Storage 버킷 보완
-- 대상 Supabase: wghjnlhfqypamiwukeio (디직스 전용)
-- digix_lease_schema.sql 이 이미 만드는 버킷: rental-contracts, prices,
--   archives, counter-uploads, customer-documents (5종)
-- 이 파일은 나머지 2종(business-cards, meeting-audio)만 생성한다. 멱등.
-- 실행: digix_lease_schema.sql 실행 후 SQL Editor 에 붙여넣고 RUN.
-- ============================================================

-- 명함 이미지 (비공개)
insert into storage.buckets (id, name, public, file_size_limit)
values ('business-cards', 'business-cards', false, 52428800)   -- 50 MB
on conflict (id) do nothing;

-- 음성미팅 오디오 (비공개, 200 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meeting-audio', 'meeting-audio', false, 209715200, array['audio/*','video/*'])
on conflict (id) do nothing;

-- ===== storage.objects RLS — authenticated 전체권한 (한별 모델 동일) =====
drop policy if exists digix_bc_objs   on storage.objects;
drop policy if exists digix_ma_objs   on storage.objects;

create policy digix_bc_objs on storage.objects for all to authenticated
  using (bucket_id = 'business-cards') with check (bucket_id = 'business-cards');

create policy digix_ma_objs on storage.objects for all to authenticated
  using (bucket_id = 'meeting-audio') with check (bucket_id = 'meeting-audio');
