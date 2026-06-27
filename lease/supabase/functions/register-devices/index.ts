// ============================================================
// Edge Function: register-devices
// 카운터프로그램(collector-agent / scan_ui)에서 사용자가 명시적으로
// "선택 항목 업로드" 를 눌렀을 때 호출. 체크된 device 를 장비관리에 등록.
//
// 헤더: Authorization: Bearer <token>   (pair-collector 에서 발급)
// 입력 body:
//   {
//     devices:  [{ mac, ip, manufacturer, model, serial_snmp, is_color }],
//     readings: [{ mac, bw, color, total_pages, toner_k/c/m/y, drum_pct, alert_text, read_at }]
//   }
// 출력:
//   {
//     ok: true,
//     collector_id,
//     newly_registered: N,         // 처음 등록된 장비
//     already_registered: M,       // 이미 등록되어 있던 장비 (중복 차단)
//     readings_inserted: K,        // 같이 보낸 첫 카운터 INSERT 수
//     registered_macs: [...]       // 클라이언트가 캐시할 등록된 mac 목록
//   }
//
// 흐름:
//   1) 토큰 → collector
//   2) heartbeat
//   3) 각 device 에 대해:
//      - 신규 → INSERT registered=TRUE, registered_at=now()
//      - 기존 registered=FALSE → UPDATE registered=TRUE, registered_at=now() (재등록)
//      - 기존 registered=TRUE → already_registered 카운트만 증가, registered_at 보존
//      - hidden=TRUE 였던 장비 → hidden=FALSE 로 풀고 등록 (사용자 명시 의도 우선)
//   4) readings INSERT (등록된 device 만)
// ============================================================
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

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

  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'no token' }, 401);

  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1) 토큰 → collector
  const { data: collector, error: cErr } = await supa
    .from('rental_collectors')
    .select('id, status')
    .eq('token', token)
    .maybeSingle();
  if (cErr) return json({ error: cErr.message }, 500);
  if (!collector) return json({ error: 'invalid token' }, 401);
  if (collector.status === 'disabled') return json({ error: 'disabled' }, 403);

  let body: { devices?: any[]; readings?: any[] } = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const devices  = Array.isArray(body.devices)  ? body.devices  : [];
  const readings = Array.isArray(body.readings) ? body.readings : [];

  // 2) heartbeat
  const nowIso = new Date().toISOString();
  await supa.from('rental_collectors')
    .update({ last_seen_at: nowIso, updated_at: nowIso })
    .eq('id', collector.id);

  // 3) device 별 등록 처리
  const macToDeviceId: Record<string, string> = {};
  let newlyRegistered = 0;
  let alreadyRegistered = 0;

  for (const d of devices) {
    const mac = String(d?.mac ?? '').trim();
    if (!mac) continue;

    const { data: existing } = await supa
      .from('rental_collector_devices')
      .select('id, registered, hidden')
      .eq('collector_id', collector.id)
      .eq('mac', mac)
      .maybeSingle();

    const fields = {
      ip:           d.ip ?? null,
      manufacturer: d.manufacturer ?? null,
      model:        d.model ?? null,
      serial_snmp:  d.serial_snmp ?? null,
      is_color:     typeof d.is_color === 'boolean' ? d.is_color : null,
      last_seen_at: nowIso,
      online:       true,
    };

    if (existing) {
      // hidden 이었던 장비도 사용자가 명시적으로 체크했으므로 hide 해제
      const patch: Record<string, unknown> = {
        ...fields,
        hidden: false,
      };
      if (existing.registered) {
        // 이미 등록 — registered_at 은 보존, 메타만 갱신
        alreadyRegistered++;
      } else {
        // 미등록 → 등록 마킹
        patch.registered = true;
        patch.registered_at = nowIso;
        newlyRegistered++;
      }
      await supa.from('rental_collector_devices')
        .update(patch)
        .eq('id', existing.id);
      macToDeviceId[mac] = existing.id;
    } else {
      // 신규 INSERT — 처음부터 registered=TRUE
      const { data: ins, error: insErr } = await supa
        .from('rental_collector_devices')
        .insert({
          collector_id:  collector.id,
          mac,
          ...fields,
          hidden:        false,
          registered:    true,
          registered_at: nowIso,
        })
        .select('id')
        .single();
      if (insErr) return json({ error: insErr.message, partial: true }, 500);
      if (ins) {
        macToDeviceId[mac] = ins.id;
        newlyRegistered++;
      }
    }
  }

  // 4) readings INSERT (등록된 device 만 — macToDeviceId 안에 있는 것만)
  let insertedReadings = 0;
  if (readings.length) {
    const toInsert = readings
      .map((r) => {
        const mac = String(r?.mac ?? '').trim();
        const device_id = macToDeviceId[mac];
        if (!device_id) return null;
        return {
          device_id,
          bw:          r.bw          ?? null,
          color:       r.color       ?? null,
          total_pages: r.total_pages ?? null,
          toner_k:     r.toner_k     ?? null,
          toner_c:     r.toner_c     ?? null,
          toner_m:     r.toner_m     ?? null,
          toner_y:     r.toner_y     ?? null,
          drum_pct:    r.drum_pct    ?? null,
          alert_text:  r.alert_text  ?? null,
          read_at:     r.read_at     ?? nowIso,
        };
      })
      .filter(Boolean) as any[];
    if (toInsert.length) {
      const { error: rErr } = await supa.from('rental_counter_readings').insert(toInsert);
      if (rErr) return json({ error: rErr.message, partial: true }, 500);
      insertedReadings = toInsert.length;
    }
  }

  // 5) 응답 — 클라이언트가 캐시할 registered_macs 도 함께
  return json({
    ok: true,
    collector_id: collector.id,
    newly_registered: newlyRegistered,
    already_registered: alreadyRegistered,
    readings_inserted: insertedReadings,
    registered_macs: Object.keys(macToDeviceId),
  }, 200);
});
