// ============================================================
// Edge Function: cards-sync
// 명함관리 자동 동기화:
//   1) Storage business-cards/imports/ 의 파일들을 읽어
//      (.json / .xlsx / .xls / .csv 지원 — 리멤버 Excel 한글 헤더 포함)
//      phone_norm 기준 upsert (insert 또는 빈 필드 보강)
//   2) 처리 완료 파일은 imports/processed/ 로 이동
//   3) 보정 작업: company_normalized, email_domain backfill,
//      미연결 카드 재매칭, pending_group_ids -> card_group_map 승격
//   4) 결과를 card_import_runs 에 기록
//
// 트리거:
//   - pg_cron : Authorization: Bearer <anon JWT> 헤더 + body { trigger:'cron' }
//   - UI 버튼 : 로그인 사용자 JWT + body { trigger:'manual' }
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import * as XLSX from 'npm:xlsx@0.18.5';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};

const BUCKET = 'business-cards';
const IMPORT_DIR = 'imports';
const PROCESSED_DIR = 'imports/processed';

const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com',
  'nate.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

// index.html 의 normalize() 와 동일해야 매칭 결과가 일치한다.
// 공백/괄호/주식회사 등 제거 + 소문자
function normalizeCompany(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\s\(\)\[\]\-_.,/\\&]/g, '')
    .replace(/주식회사|유한회사|\(주\)|㈜|\(유\)|주\)|유\)/g, '')
    .trim();
}

function normalizePhone(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (!c) continue;
    const digits = String(c).replace(/[^0-9]/g, '');
    if (digits) return digits;
  }
  return '';
}

function emailDomainOf(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}

type Card = {
  company_raw?: string | null;
  name?: string | null;
  title?: string | null;
  department?: string | null;
  phone_mobile?: string | null;
  phone_office?: string | null;
  fax?: string | null;
  email?: string | null;
  address?: string | null;
  website?: string | null;
  biz_no?: string | null;
};

// 리멤버 / 일반 엑셀 헤더 → DB 컬럼명 매핑.
// 영문(json) / 한글(리멤버 Excel) 어느 쪽이 와도 동작.
// 헤더 이름은 lower-case + 공백 제거 후 후보와 비교.
function mapImported(row: Record<string, unknown>): Card {
  const norm = new Map<string, string>();
  for (const k of Object.keys(row)) {
    const lk = String(k).toLowerCase().replace(/\s+/g, '');
    norm.set(lk, k);
  }
  const pick = (...candidates: string[]): string | null => {
    for (const cand of candidates) {
      const key = cand.toLowerCase().replace(/\s+/g, '');
      const orig = norm.get(key);
      if (orig === undefined) continue;
      const v = row[orig];
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return null;
  };
  return {
    company_raw:  pick('company', 'company_raw', '회사', '회사명', '직장', '소속', '근무처'),
    name:         pick('name', '이름', '성명', '담당자'),
    title:        pick('title', '직책', '직위', '직급'),
    department:   pick('department', '부서', '부서명', '소속부서'),
    phone_mobile: pick('phone_mobile', 'mobile', 'cellphone', '휴대전화', '휴대폰', '핸드폰', '모바일', 'HP'),
    phone_office: pick('phone_office', 'office', 'phone', 'tel', '전화', '사무실', '사무실전화', '회사전화', '직장전화', '대표번호'),
    fax:          pick('fax', '팩스', 'FAX'),
    email:        pick('email', 'e-mail', 'mail', '이메일', '메일'),
    address:      pick('address', '주소', '회사주소', '직장주소'),
    website:      pick('website', 'url', 'homepage', '홈페이지', '웹사이트'),
    biz_no:       pick('biz_no', 'businessNo', '사업자번호', '사업자등록번호'),
  };
}

// 파일 한 개를 rows 배열로 풀기. .json / .xlsx / .xls / .csv 지원.
async function readRows(blob: Blob, filename: string): Promise<Record<string, unknown>[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) {
    const text = await blob.text();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  // xlsx / xls / csv 는 SheetJS 가 자동 판별
  const buf = await blob.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[firstSheet], {
    defval: null,
    raw: false,  // 숫자 셀도 string 으로 (휴대폰 0 손실 방지)
  });
}

function isSupportedFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.json') || n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const triggerSource = String(body.trigger ?? 'manual');

  // 0) run 로그 시작
  const runIns = await supa
    .from('card_import_runs')
    .insert({ trigger_source: triggerSource, status: 'running' })
    .select('id')
    .single();
  if (runIns.error) return json({ error: runIns.error.message }, 500);
  const runId = runIns.data.id as string;

  const stats = {
    files_processed: 0,
    inserted_count: 0,
    updated_count: 0,
    skipped_count: 0,
    fixed_normalized: 0,
    fixed_email_domain: 0,
    merged_duplicates: 0,
    relinked_customer: 0,
    pending_promoted: 0,
  };
  const detail: Record<string, unknown> = { files: [] as unknown[] };

  try {
    // ---------- 1) Storage imports/ JSON 파일 처리 ----------
    const list = await supa.storage.from(BUCKET).list(IMPORT_DIR, {
      limit: 100,
      sortBy: { column: 'created_at', order: 'asc' },
    });
    if (list.error) throw new Error('storage list: ' + list.error.message);

    const supportedFiles = (list.data ?? []).filter(
      (f) => f.name && isSupportedFile(f.name),
    );

    for (const f of supportedFiles) {
      const fileResult = {
        name: f.name,
        rows: 0, inserted: 0, updated: 0, skipped: 0, error: null as string | null,
      };
      try {
        const dl = await supa.storage.from(BUCKET).download(`${IMPORT_DIR}/${f.name}`);
        if (dl.error) throw new Error(dl.error.message);
        let rows: Record<string, unknown>[];
        try { rows = await readRows(dl.data, f.name); }
        catch (e) { throw new Error('parse failed: ' + (e as Error).message); }
        fileResult.rows = rows.length;

        for (const raw of rows) {
          if (!raw || typeof raw !== 'object') { fileResult.skipped++; continue; }
          const card = mapImported(raw as Record<string, unknown>);
          const phoneNorm = normalizePhone(card.phone_mobile, card.phone_office);
          if (!phoneNorm) {
            // 핸드폰 없는 카드는 중복 판단 불가 → 이메일이라도 있으면 insert,
            // 그것도 없으면 skip
            if (!card.email && !card.name) { fileResult.skipped++; continue; }
            const insertRow = {
              ...card,
              company_normalized: normalizeCompany(card.company_raw),
              email_domain: emailDomainOf(card.email),
              consent_marketing: false,
            };
            const ins = await supa.from('business_cards').insert(insertRow);
            if (ins.error) { fileResult.skipped++; }
            else { fileResult.inserted++; stats.inserted_count++; }
            continue;
          }

          // phone_norm 으로 기존 카드 조회 (generated column 이라 직접 검색 가능)
          const existing = await supa
            .from('business_cards')
            .select('id, company_raw, name, title, department, phone_mobile, phone_office, fax, email, address, website, biz_no, customer_id')
            .eq('phone_norm', phoneNorm)
            .maybeSingle();

          if (existing.data) {
            // 빈 필드만 채워서 update (기존 값 덮어쓰지 않음)
            const cur = existing.data;
            const patch: Record<string, unknown> = {};
            const fillIfEmpty = (k: keyof Card) => {
              if (!cur[k as keyof typeof cur] && card[k]) patch[k] = card[k];
            };
            (['company_raw','name','title','department','phone_mobile','phone_office',
              'fax','email','address','website','biz_no'] as (keyof Card)[]).forEach(fillIfEmpty);

            if (patch.company_raw) patch.company_normalized = normalizeCompany(patch.company_raw as string);
            if (patch.email) patch.email_domain = emailDomainOf(patch.email as string);
            patch.updated_at = new Date().toISOString();

            if (Object.keys(patch).length > 1) {
              const up = await supa.from('business_cards').update(patch).eq('id', cur.id);
              if (up.error) { fileResult.skipped++; }
              else { fileResult.updated++; stats.updated_count++; }
            } else {
              fileResult.skipped++; stats.skipped_count++;
            }
          } else {
            const insertRow = {
              ...card,
              company_normalized: normalizeCompany(card.company_raw),
              email_domain: emailDomainOf(card.email),
              consent_marketing: false,
            };
            const ins = await supa.from('business_cards').insert(insertRow);
            if (ins.error) { fileResult.skipped++; }
            else { fileResult.inserted++; stats.inserted_count++; }
          }
        }

        // 처리 완료 파일 이동
        const mv = await supa.storage.from(BUCKET).move(
          `${IMPORT_DIR}/${f.name}`,
          `${PROCESSED_DIR}/${new Date().toISOString().slice(0,10)}_${f.name}`,
        );
        if (mv.error) {
          // 이동 실패해도 다음 cron 에서 다시 시도하지 않도록 .processed 접미만 붙이는 fallback
          fileResult.error = 'move failed: ' + mv.error.message;
        }
        stats.files_processed++;
      } catch (e) {
        fileResult.error = (e as Error).message;
      }
      (detail.files as unknown[]).push(fileResult);
    }

    // ---------- 2) 보정 작업 ----------

    // 2-a) company_normalized 비어있는 카드 일괄 채움
    const needNorm = await supa
      .from('business_cards')
      .select('id, company_raw')
      .or('company_normalized.is.null,company_normalized.eq.')
      .not('company_raw', 'is', null)
      .limit(500);
    if (!needNorm.error) {
      for (const r of needNorm.data ?? []) {
        const norm = normalizeCompany(r.company_raw);
        if (!norm) continue;
        const u = await supa.from('business_cards').update({ company_normalized: norm }).eq('id', r.id);
        if (!u.error) stats.fixed_normalized++;
      }
    }

    // 2-b) email_domain 비어있는데 email 있는 카드
    const needDomain = await supa
      .from('business_cards')
      .select('id, email')
      .is('email_domain', null)
      .not('email', 'is', null)
      .limit(500);
    if (!needDomain.error) {
      for (const r of needDomain.data ?? []) {
        const d = emailDomainOf(r.email);
        if (!d) continue;
        const u = await supa.from('business_cards').update({ email_domain: d }).eq('id', r.id);
        if (!u.error) stats.fixed_email_domain++;
      }
    }

    // 2-c) customer_id NULL 인 카드를 rental_customers 와 재매칭
    //      매칭 우선순위: 사업자번호 → email_domain (공용 도메인 제외) → company_normalized
    const orphan = await supa
      .from('business_cards')
      .select('id, biz_no, email_domain, company_normalized, pending_group_ids')
      .is('customer_id', null)
      .limit(500);
    if (!orphan.error) {
      // 거래처 인덱스 캐시 (PostgREST 1000 행 제한 고려: 명함 모듈 거래처는 수천 단위라 페이지네이션)
      const customers: { id: string; biz_no: string | null; email_domain: string | null; company_normalized: string | null; }[] = [];
      let from = 0;
      while (true) {
        const cs = await supa
          .from('rental_customers')
          .select('id, biz_no, email_domain, company_normalized')
          .range(from, from + 999);
        if (cs.error || !cs.data || cs.data.length === 0) break;
        customers.push(...(cs.data as typeof customers));
        if (cs.data.length < 1000) break;
        from += 1000;
      }
      const byBiz = new Map<string, string>();
      const byDomain = new Map<string, string>();
      const byNorm = new Map<string, string>();
      for (const c of customers) {
        if (c.biz_no) byBiz.set(c.biz_no.replace(/[^0-9]/g, ''), c.id);
        if (c.email_domain && !PUBLIC_EMAIL_DOMAINS.has(c.email_domain)) byDomain.set(c.email_domain, c.id);
        if (c.company_normalized) byNorm.set(c.company_normalized, c.id);
      }

      for (const card of orphan.data ?? []) {
        let cid: string | null = null;
        if (card.biz_no) {
          const k = String(card.biz_no).replace(/[^0-9]/g, '');
          if (k) cid = byBiz.get(k) ?? null;
        }
        if (!cid && card.email_domain && !PUBLIC_EMAIL_DOMAINS.has(card.email_domain)) {
          cid = byDomain.get(card.email_domain) ?? null;
        }
        if (!cid && card.company_normalized) {
          cid = byNorm.get(card.company_normalized) ?? null;
        }
        if (!cid) continue;

        // 거래처 연결 + pending_group_ids 가 있으면 card_group_map 으로 승격
        const u = await supa.from('business_cards')
          .update({ customer_id: cid, updated_at: new Date().toISOString() })
          .eq('id', card.id);
        if (u.error) continue;
        stats.relinked_customer++;

        const pending: string[] = Array.isArray(card.pending_group_ids) ? card.pending_group_ids : [];
        if (pending.length) {
          const rows = pending.map((gid) => ({ customer_id: cid!, group_id: gid }));
          const ins = await supa.from('card_group_map').upsert(rows, { onConflict: 'customer_id,group_id' });
          if (!ins.error) {
            stats.pending_promoted += pending.length;
            await supa.from('business_cards').update({ pending_group_ids: null }).eq('id', card.id);
          }
        }
      }
    }

    // ---------- 3) 완료 처리 ----------
    await supa.from('card_import_runs').update({
      finished_at: new Date().toISOString(),
      status: 'ok',
      ...stats,
      detail,
    }).eq('id', runId);

    return json({ ok: true, run_id: runId, ...stats, files: detail.files });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await supa.from('card_import_runs').update({
      finished_at: new Date().toISOString(),
      status: 'error',
      error_msg: msg,
      ...stats,
      detail,
    }).eq('id', runId);
    return json({ ok: false, run_id: runId, error: msg, ...stats }, 500);
  }
});
