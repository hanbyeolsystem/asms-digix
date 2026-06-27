// Supabase Edge Function: counter-anomaly-check
// hanbyeol_counters 의 최신 ym 기준 이상치 3종을 감지 → 슬랙 알림.
//
// 호출: pg_cron 이 주 1회 호출.
// 보안: COUNTER_CRON_SECRET 시크릿을 헤더(X-Cron-Secret) 또는 쿼리(?secret=)로 전달해야 통과.
// 시크릿:
//   - SLACK_WEBHOOK_URL         (이미 등록됨, notify-order 와 공유)
//   - SUPABASE_SERVICE_ROLE_KEY (Supabase 기본 환경변수)
//   - SUPABASE_URL              (Supabase 기본 환경변수)
//   - COUNTER_CRON_SECRET       (이 함수 호출 인증용 — 신규)
//
// 응답: { ok, last_ym, surge, stalled, regressed, sent_to_slack }
//   - 이상치 0건이면 슬랙 발송 생략 (silent)

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SLACK_URL  = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const SUPA_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SVC_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("COUNTER_CRON_SECRET") ?? "";

const SURGE_DELTA_MIN = 10000;        // 월간 1만 매 이상 증가만 surge 후보
const SURGE_RATIO     = 3;            // 직전 평균 대비 3배 이상
const STALLED_LIMIT   = 10;           // 정체 상위 N건만 슬랙에 표시
const SURGE_LIMIT     = 10;
const REGRESS_LIMIT   = 10;

function checkSecret(req: Request): boolean {
  if (!CRON_SECRET) return false;
  const h = req.headers.get("x-cron-secret");
  if (h && h === CRON_SECRET) return true;
  const url = new URL(req.url);
  const q = url.searchParams.get("secret");
  return !!q && q === CRON_SECRET;
}

async function detect(sb): Promise<{ surge: any[]; stalled: any[]; regressed: any[]; last_ym: string | null }> {
  // 최신 ym
  const { data: latestRows } = await sb.from("hanbyeol_counters").select("ym").order("ym", { ascending: false }).limit(1);
  const last_ym = latestRows?.[0]?.ym ?? null;
  if (!last_ym) return { surge: [], stalled: [], regressed: [], last_ym: null };

  // 모든 카운터 데이터를 가져와서 JS 에서 시리얼별 분석 (856행, 메모리 부담 없음)
  const { data: rows } = await sb
    .from("hanbyeol_counters")
    .select("serial,customer,model,ym,total,bw,color,match_status")
    .order("ym", { ascending: true });

  const bySerial: Record<string, any[]> = {};
  for (const r of rows || []) {
    if (r.total == null) continue;
    (bySerial[r.serial] = bySerial[r.serial] || []).push(r);
  }

  const surge: any[] = [];
  const stalled: any[] = [];
  const regressed: any[] = [];

  for (const serial of Object.keys(bySerial)) {
    const arr = bySerial[serial];
    const latest = arr[arr.length - 1];
    if (latest.ym !== last_ym) continue;          // 최신 월에 데이터가 있는 시리얼만
    if (arr.length < 2) continue;

    const prev = arr[arr.length - 2];
    const delta = (latest.total || 0) - (prev.total || 0);

    // 1) 급증
    if (delta >= SURGE_DELTA_MIN) {
      // 직전 3개월(있다면) 평균 증분과 비교
      const recent = arr.slice(-4, -1); // last 의 직전 3개
      const deltas: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        deltas.push((recent[i].total || 0) - (recent[i - 1].total || 0));
      }
      const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      if (avg <= 0 || delta >= avg * SURGE_RATIO) {
        surge.push({ serial, customer: latest.customer, model: latest.model, delta, prev_avg: Math.round(avg) });
      }
    }

    // 2) 정체 (이전 월과 카운터 동일 + 0 이 아님)
    if (latest.total === prev.total && latest.total > 0) {
      stalled.push({ serial, customer: latest.customer, model: latest.model, total: latest.total });
    }

    // 3) 감소 (이전 월보다 작음)
    if (latest.total != null && prev.total != null && latest.total < prev.total) {
      regressed.push({ serial, customer: latest.customer, model: latest.model, total: latest.total, prev: prev.total });
    }
  }

  surge.sort((a, b) => b.delta - a.delta);
  stalled.sort((a, b) => b.total - a.total);
  regressed.sort((a, b) => (a.total - a.prev) - (b.total - b.prev));

  return {
    surge: surge.slice(0, SURGE_LIMIT),
    stalled: stalled.slice(0, STALLED_LIMIT),
    regressed: regressed.slice(0, REGRESS_LIMIT),
    last_ym,
  };
}

function fmtRow(r: any, kind: "surge" | "stalled" | "regressed"): string {
  const cu = r.customer ? `*${r.customer}*` : "";
  const md = r.model ? ` (${r.model})` : "";
  const sn = r.serial ? ` \`${r.serial}\`` : "";
  if (kind === "surge")     return `• ${cu}${md}${sn} — 이번 달 +${r.delta.toLocaleString()}장 (직전 평균 ${r.prev_avg.toLocaleString()})`;
  if (kind === "stalled")   return `• ${cu}${md}${sn} — 누적 ${r.total.toLocaleString()}장에서 변동 없음`;
  /* regressed */            return `• ${cu}${md}${sn} — ${r.prev.toLocaleString()} → ${r.total.toLocaleString()} (감소)`;
}

function buildSlackPayload(result: any) {
  const { surge, stalled, regressed, last_ym } = result;
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: `📊 임대카운터 이상치 감지 (${last_ym})` } },
  ];
  if (surge.length) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `*🔺 카운터 급증* (${surge.length}건)\n` + surge.map(r => fmtRow(r, "surge")).join("\n") } },
    );
  }
  if (stalled.length) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `*⏸️ 카운터 정체* (${stalled.length}건) — 사용 안 함 의심\n` + stalled.map(r => fmtRow(r, "stalled")).join("\n") } },
    );
  }
  if (regressed.length) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: `*🔻 카운터 감소* (${regressed.length}건) — 기기 교체/리셋 의심\n` + regressed.map(r => fmtRow(r, "regressed")).join("\n") } },
    );
  }
  blocks.push({
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: "임대카운터 열기" }, url: "https://hanbyeolsystem.github.io/totalas/rental-counters/", style: "primary" }],
  });
  const total = surge.length + stalled.length + regressed.length;
  return { text: `📊 임대카운터 이상치 ${total}건 감지 (${last_ym})`, blocks };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!checkSecret(req))        return json({ error: "forbidden" }, 403);
  if (!SLACK_URL || !SVC_KEY)   return json({ error: "missing secrets" }, 500);

  const sb = createClient(SUPA_URL, SVC_KEY, { auth: { persistSession: false } });
  const result = await detect(sb);
  const total = result.surge.length + result.stalled.length + result.regressed.length;

  let sent = false;
  if (total > 0) {
    const r = await fetch(SLACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackPayload(result)),
    });
    sent = r.ok;
    if (!r.ok) console.warn("[slack post failed]", r.status, await r.text());
  }
  return json({ ok: true, last_ym: result.last_ym, surge: result.surge.length, stalled: result.stalled.length, regressed: result.regressed.length, sent_to_slack: sent });
});
