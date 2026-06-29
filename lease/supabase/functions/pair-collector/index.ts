// ============================================================
// Edge Function: pair-collector
// 수집기 EXE 최초 실행 시 페어링 코드 검증 후 token 발급.
// 입력: { pairing_code, pc_name, os_user, agent_version }
// 출력: { collector_id, token }
// 인증: 페어링 코드 == 'digix' (커스텀, verify_jwt=false)
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const PAIRING_CODE = 'digix';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const code = String(body.pairing_code ?? '');
  if (code !== PAIRING_CODE) return json({ error: 'invalid pairing code' }, 401);

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 토큰: UUID 두 개 합쳐 충돌 확률 거의 0
  const token = crypto.randomUUID() + '-' + crypto.randomUUID().slice(0, 12);

  const { data, error } = await supa
    .from('rental_collectors')
    .insert({
      pc_name:       String(body.pc_name ?? '').slice(0, 200) || null,
      os_user:       String(body.os_user ?? '').slice(0, 200) || null,
      agent_version: String(body.agent_version ?? '').slice(0, 50) || null,
      token,
      status:        'pending',
      paired_at:     new Date().toISOString(),
      last_seen_at:  new Date().toISOString(),
    })
    .select('id, token')
    .single();

  if (error) return json({ error: error.message }, 500);
  return json({ collector_id: data.id, token: data.token }, 200);
});
