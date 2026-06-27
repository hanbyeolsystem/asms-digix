-- =====================================================================
-- 한별시스템 명함관리 모듈 — Supabase 스키마
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣고 실행
-- 설계: 기존 rental_customers(거래처 원장)를 재활용해 명함을 매칭/연결한다.
--       회사(거래처) = rental_customers, 담당자(명함) = business_cards
-- =====================================================================

-- 0) 유사도 검색용 확장 (회사명 fuzzy 매칭)
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------
-- 1) 명함(담당자) 테이블
--    customer_id 가 채워지면 = 기존 거래처에 묶인 상태
--    customer_id 가 null 이면 = 아직 거래처 미연결(신규/미분류)
-- ---------------------------------------------------------------------
create table if not exists business_cards (
  id                uuid primary key default gen_random_uuid(),
  customer_id       text references rental_customers(id) on delete set null,  -- 기존 거래처 연결 (rental_customers.id 는 text)
  company_raw       text,                 -- 명함에 적힌 회사명 원본
  company_normalized text,                -- 정규화 회사명(매칭 키)
  name              text,                 -- 담당자 이름
  title             text,                 -- 직책
  department        text,                 -- 부서
  phone_mobile      text,
  phone_office      text,
  fax               text,
  email             text,
  email_domain      text,                 -- 식별 보조키
  address           text,
  website           text,
  biz_no            text,                 -- 사업자등록번호
  consent_marketing boolean default false,-- ★ 광고 수신동의 (정보통신망법 §50)
  consent_date      timestamptz,
  card_image_url    text,                 -- Storage 경로
  raw_text          text,                 -- OCR 원문
  memo              text,                 -- 영업 메모
  pending_group_ids uuid[],                -- 모바일 촬영 시 미리 지정한 그룹 (거래처 연결 시 card_group_map 으로 이관 가능)
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create index if not exists idx_cards_customer  on business_cards (customer_id);
create index if not exists idx_cards_norm      on business_cards using gin (company_normalized gin_trgm_ops);
create index if not exists idx_cards_email      on business_cards (email);
create index if not exists idx_cards_consent    on business_cards (consent_marketing);
create index if not exists idx_cards_bizno      on business_cards (biz_no);
create index if not exists idx_cards_pending_groups on business_cards using gin (pending_group_ids);

-- ---------------------------------------------------------------------
-- 2) 그룹(수동 태그)
-- ---------------------------------------------------------------------
create table if not exists card_groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  category    text,                       -- 업종 / 거래단계 / 서비스 / 지역
  color       text default '#2563eb',
  created_at  timestamptz default now()
);

-- 거래처-그룹 다대다 (그룹은 거래처 단위로 묶는다 → 명함이 여러 장이어도 회사 하나로 타겟팅)
create table if not exists card_group_map (
  customer_id text references rental_customers(id) on delete cascade,
  group_id    uuid references card_groups(id) on delete cascade,
  primary key (customer_id, group_id)
);

-- ---------------------------------------------------------------------
-- 3) 발송 이력
-- ---------------------------------------------------------------------
create table if not exists card_send_logs (
  id          uuid primary key default gen_random_uuid(),
  card_id     uuid references business_cards(id) on delete set null,
  customer_id text references rental_customers(id) on delete set null,
  channel     text,                       -- 'kakao' | 'email'
  template_id uuid,
  subject     text,
  body        text,                       -- 치환 완료된 실제 발송 본문
  status      text default 'sent',        -- 'sent' | 'failed' | 'opened' | 'replied'
  is_ad       boolean default true,
  sent_at     timestamptz default now(),
  error_msg   text
);
create index if not exists idx_sendlogs_card on card_send_logs (card_id);

-- ---------------------------------------------------------------------
-- 4) 메시지 템플릿
-- ---------------------------------------------------------------------
create table if not exists card_templates (
  id        uuid primary key default gen_random_uuid(),
  name      text,
  channel   text,                         -- 'kakao' | 'email'
  subject   text,                         -- 메일 제목
  body      text,                         -- {{company}} {{name}} {{title}} 변수 포함
  is_ad     boolean default true,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 5) ★ 발송 가능 대상 뷰 — 동의자만 노출(위법 발송 구조적 차단)
-- ---------------------------------------------------------------------
create or replace view sendable_cards as
select
  bc.id          as card_id,
  bc.customer_id,
  bc.name,
  bc.title,
  bc.email,
  bc.phone_mobile,
  coalesce(rc.company, bc.company_raw) as company_name
from business_cards bc
left join rental_customers rc on bc.customer_id = rc.id
where bc.consent_marketing = true;

-- ---------------------------------------------------------------------
-- 6) RLS — 로그인 사용자만 접근 (기존 totalas auth 패턴과 동일)
-- ---------------------------------------------------------------------
alter table business_cards  enable row level security;
alter table card_groups     enable row level security;
alter table card_group_map  enable row level security;
alter table card_send_logs  enable row level security;
alter table card_templates  enable row level security;

-- 로그인(authenticated) 사용자에게 전체 권한 (기존 모듈과 동일 정책)
do $$
declare t text;
begin
  foreach t in array array['business_cards','card_groups','card_group_map','card_send_logs','card_templates']
  loop
    execute format('drop policy if exists "auth all %1$s" on %1$s;', t);
    execute format('create policy "auth all %1$s" on %1$s for all to authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7) 기본 그룹 시드 (한별시스템 맞춤) — 중복 방지
-- ---------------------------------------------------------------------
insert into card_groups (name, category, color)
select * from (values
  ('제조',       '업종',     '#2563eb'),
  ('병원',       '업종',     '#0ea5e9'),
  ('관공서',     '업종',     '#7c3aed'),
  ('학교',       '업종',     '#059669'),
  ('잠재고객',   '거래단계', '#f59e0b'),
  ('견적진행',   '거래단계', '#f97316'),
  ('계약완료',   '거래단계', '#16a34a'),
  ('유지보수중', '거래단계', '#0d9488'),
  ('NAS구축',    '서비스',   '#4f46e5'),
  ('프린터렌탈', '서비스',   '#db2777'),
  ('컴퓨터렌탈', '서비스',   '#9333ea'),
  ('특수장비',   '서비스',   '#dc2626')
) as v(name, category, color)
where not exists (select 1 from card_groups cg where cg.name = v.name);

-- ---------------------------------------------------------------------
-- 8) 명함 이미지 Storage 버킷 (비공개) — 아래는 참고용. Dashboard에서 만들어도 됨.
--    Storage → New bucket → name: business-cards, Public: OFF
-- ---------------------------------------------------------------------
-- insert into storage.buckets (id, name, public) values ('business-cards','business-cards', false)
--   on conflict (id) do nothing;
