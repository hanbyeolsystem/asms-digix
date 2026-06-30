// Supabase Edge Function: lease-admin-user (임대관리/lease)
// POST   → 새 계정 생성 (관리자만) — rental_user_profiles + engineers 동시 기록
// DELETE → 계정 삭제 (관리자만) — auth + 양쪽 프로필 제거
//
// 디직스: 임대관리(rental_user_profiles)와 접수관리툴(engineers)이 같은 auth 를 공유.
// 한 곳에서 만들면 양쪽에서 같은 아이디/비밀번호로 동작하도록 두 테이블을 함께 기록한다.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const EMAIL_DOMAIN = '@asms.local';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // 1) 호출자 신원 확인
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: '로그인이 필요합니다.' }, 401);

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

  const { data: ures, error: uerr } = await admin.auth.getUser(token);
  if (uerr || !ures?.user) return json({ error: '세션이 유효하지 않습니다. 다시 로그인하세요.' }, 401);
  const callerId = ures.user.id;

  // 2) 관리자 권한 확인 (service_role 로 RLS 우회 조회)
  const { data: prof, error: perr } = await admin
    .from('rental_user_profiles')
    .select('role, active')
    .eq('user_id', callerId)
    .single();
  if (perr || !prof) return json({ error: '프로필을 찾을 수 없습니다.' }, 403);
  if (prof.role !== 'admin' || prof.active === false) {
    return json({ error: '관리자만 사용할 수 있습니다.' }, 403);
  }

  // 3) 작업 분기
  let payload: any = {};
  try { payload = await req.json(); } catch (_) { /* DELETE 일부는 body 없음 */ }

  if (req.method === 'POST') {
    const display_id = String(payload.display_id || '').trim().toLowerCase();
    const password = String(payload.password || '');
    const full_name = String(payload.full_name || '').trim();
    const role = payload.role === 'admin' ? 'admin' : 'engineer';

    if (!/^[a-z0-9_]{3,}$/.test(display_id)) {
      return json({ error: '아이디는 영문/숫자/언더스코어 3자 이상이어야 합니다.' }, 400);
    }
    if (password.length < 6) return json({ error: '비밀번호는 6자 이상이어야 합니다.' }, 400);

    const email = `${display_id}${EMAIL_DOMAIN}`;

    const { data: created, error: cerr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_id, role, full_name },
    });
    if (cerr) return json({ error: `계정 생성 실패: ${cerr.message}` }, 400);

    const uid = created.user.id;
    const { error: ierr } = await admin.from('rental_user_profiles').insert({
      user_id: uid, display_id, full_name, role, active: true,
    });
    if (ierr) {
      // 프로필 실패 시 고아 계정 정리
      await admin.auth.admin.deleteUser(uid);
      return json({ error: `프로필 등록 실패: ${ierr.message}` }, 400);
    }

    // 접수관리툴(engineers) 프로필도 함께 생성 → 같은 아이디/비번으로 양쪽 사용 가능
    const { error: eerr } = await admin.from('engineers').upsert({
      en_id:     display_id,
      email,
      en_name:   full_name || display_id,
      en_branch: '대구',
      en_role:   role,
      user_id:   uid,
    }, { onConflict: 'en_id' });
    if (eerr) {
      await admin.from('rental_user_profiles').delete().eq('user_id', uid);
      await admin.auth.admin.deleteUser(uid);
      return json({ error: `접수관리툴 프로필 생성 실패: ${eerr.message}` }, 400);
    }

    return json({ ok: true, user_id: uid, display_id, role });
  }

  if (req.method === 'DELETE') {
    const targetId = String(payload.user_id || '').trim();
    if (!targetId) return json({ error: '삭제할 사용자 ID가 없습니다.' }, 400);
    if (targetId === callerId) return json({ error: '본인 계정은 삭제할 수 없습니다.' }, 400);
    // 양쪽 프로필 먼저 제거 후 auth 계정 삭제
    await admin.from('rental_user_profiles').delete().eq('user_id', targetId);
    await admin.from('engineers').delete().eq('user_id', targetId);
    const { error: derr } = await admin.auth.admin.deleteUser(targetId);
    if (derr) return json({ error: `삭제 실패: ${derr.message}` }, 400);
    return json({ ok: true });
  }

  return json({ error: '지원하지 않는 요청입니다.' }, 405);
});
