// ============================================================
// Edge Function: submit-reading
// 수집기 백그라운드 폴링(5분 주기) 정기 업로드.
// 헤더:  Authorization: Bearer <token>   (pair-collector 에서 발급)
// 입력 body:
//   {
//     devices:  [{ mac, ip, manufacturer, model, serial_snmp, is_color }],
//     readings: [{ mac, bw, color, total_pages, toner_k/c/m/y, drum_pct, alert_text }]
//   }
// 출력:
//   {
//     ok: true,
//     collector_id,
//     devices_updated:    N,   // 등록된 장비 중 메타 update 한 수
//     readings_inserted:  K,
//     readings_skipped:   J,   // 미등록 또는 hidden 장비에 대한 reading (폐기)
//     unregistered_macs:  [...] // 폴링에 들어왔지만 미등록인 mac (참고용)
//   }
//
// 정책 (2026-06-02 35_collector_device_registered.sql 이후):
//   - 미등록(registered=FALSE) 또는 숨김(hidden=TRUE) 장비는 readings 폐기
//   - 신규 device 도 INSERT 하지 않음 (등록은 register-devices 책임)
//   - 등록된 장비는 메타(ip/model/last_seen_at/online) 만 갱신
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

  // 3) 이 collector 의 등록된 device 목록 조회 (mac → device 맵)
  //    usb_baseline / usb_last_raw 는 USB 평생누적 계산에 사용 (49_usb_counter_baseline.sql)
  const { data: registeredRows, error: regErr } = await supa
    .from('rental_collector_devices')
    .select('id, mac, hidden, registered, usb_baseline, usb_last_raw')
    .eq('collector_id', collector.id)
    .eq('registered', true)
    .eq('hidden', false);
  if (regErr) return json({ error: regErr.message }, 500);

  type DeviceRow = {
    id: string;
    usb_baseline: number | null;
    usb_last_raw: number | null;
  };
  const registeredMacToDevice: Record<string, DeviceRow> = {};
  for (const r of registeredRows ?? []) {
    if (r.mac) registeredMacToDevice[r.mac] = {
      id:           r.id,
      usb_baseline: r.usb_baseline ?? 0,
      usb_last_raw: r.usb_last_raw ?? null,
    };
  }
  const registeredMacToId: Record<string, string> = {};
  for (const mac in registeredMacToDevice) {
    registeredMacToId[mac] = registeredMacToDevice[mac].id;
  }

  // 4) 등록된 device 만 메타 update (미등록 / 신규는 무시 — register-devices 책임)
  let devicesUpdated = 0;
  const unregisteredMacs: string[] = [];
  for (const d of devices) {
    const mac = String(d?.mac ?? '').trim();
    if (!mac) continue;
    const deviceId = registeredMacToId[mac];
    if (!deviceId) {
      unregisteredMacs.push(mac);
      continue;
    }
    await supa.from('rental_collector_devices')
      .update({
        ip:           d.ip ?? null,
        manufacturer: d.manufacturer ?? null,
        model:        d.model ?? null,
        serial_snmp:  d.serial_snmp ?? null,
        is_color:     typeof d.is_color === 'boolean' ? d.is_color : null,
        last_seen_at: nowIso,
        online:       true,
      })
      .eq('id', deviceId);
    devicesUpdated++;
  }

  // 5) readings INSERT — 등록된 device 만
  //    USB 장비(mac이 'USB:'로 시작)는 클라이언트가 보낸 raw 가 "부팅 후 누적" 이므로
  //    서버에서 평생누적으로 보정 후 저장. baseline 은 device 행에 영구 저장.
  let insertedReadings = 0;
  let skippedReadings  = 0;
  if (readings.length) {
    const toInsert: any[] = [];
    for (const r of readings) {
      const mac = String(r?.mac ?? '').trim();
      const device = registeredMacToDevice[mac];
      if (!device) {
        skippedReadings++;
        continue;
      }

      const rawTotal = (typeof r.total_pages === 'number') ? r.total_pages : null;
      let cumulativeTotal: number | null = rawTotal;

      if (mac.startsWith('USB:') && rawTotal !== null) {
        const prevBaseline = device.usb_baseline ?? 0;
        const prevLastRaw  = device.usb_last_raw;
        let newBaseline = prevBaseline;
        if (prevLastRaw !== null && rawTotal < prevLastRaw) {
          // 재부팅/스풀러 재시작 등으로 raw 가 줄어듦 → 리셋 감지
          newBaseline = prevBaseline + prevLastRaw;
        }
        cumulativeTotal = newBaseline + rawTotal;
        // device 행에 baseline / last_raw 갱신 (다음 reading 의 기준)
        await supa.from('rental_collector_devices')
          .update({ usb_baseline: newBaseline, usb_last_raw: rawTotal })
          .eq('id', device.id);
        device.usb_baseline = newBaseline;
        device.usb_last_raw = rawTotal;
      }

      toInsert.push({
        device_id:       device.id,
        bw:              r.bw          ?? null,
        color:           r.color       ?? null,
        total_pages:     cumulativeTotal,
        total_pages_raw: mac.startsWith('USB:') ? rawTotal : null,
        toner_k:         r.toner_k     ?? null,
        toner_c:         r.toner_c     ?? null,
        toner_m:         r.toner_m     ?? null,
        toner_y:         r.toner_y     ?? null,
        drum_pct:        r.drum_pct    ?? null,
        alert_text:      r.alert_text  ?? null,
        read_at:         r.read_at     ?? nowIso,
      });
    }
    if (toInsert.length) {
      const { error: rErr } = await supa.from('rental_counter_readings').insert(toInsert);
      if (rErr) return json({ error: rErr.message, partial: true }, 500);
      insertedReadings = toInsert.length;
    }
  }

  return json({
    ok: true,
    collector_id: collector.id,
    devices_updated: devicesUpdated,
    readings_inserted: insertedReadings,
    readings_skipped: skippedReadings,
    // 첫 100건만 응답 — 클라가 캐시 무효화 신호로 사용 가능
    unregistered_macs: unregisteredMacs.slice(0, 100),
  }, 200);
});
