// Supabase Edge Function: notify-order
// 새 A/S 접수 등록 시 슬랙 채널로 알림 발송.
// Secret: SLACK_WEBHOOK_URL (Supabase Edge Function Secrets)
// 인증된 사용자만 호출 가능.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const SLACK_URL = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const SUPA_URL  = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

// TODO: 배포 후 본인 사이트 URL로 교체 (예: https://{org}.github.io/{repo}/orders.html?status=%EC%A0%91%EC%88%98)
const ORDERS_LINK = Deno.env.get("ORDERS_LINK") ?? "";

function buildPayload(o) {
  const phone   = o.cu_mobile || o.cu_tel || "-";
  const want    = (o.cu_want || "").trim();
  const wantOne = want.length > 100 ? want.slice(0, 100) + "..." : want;

  return {
    text: `🔔 새 A/S 접수: ${o.order_no || "-"} / ${o.cu_name || "-"}`, // 푸시 알림 텍스트
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "🔔 새 A/S 접수" },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*접수번호*\n${o.order_no || "-"}` },
          { type: "mrkdwn", text: `*고객*\n${o.cu_name || "-"}` },
          { type: "mrkdwn", text: `*연락처*\n${phone}` },
          { type: "mrkdwn", text: `*제품*\n${o.product || "-"}` },
          { type: "mrkdwn", text: `*방식*\n${o.kind2 || "-"}` },
          { type: "mrkdwn", text: `*처리자*\n${o.receiver || "-"}` },
        ],
      },
      ...(want ? [{
        type: "section",
        text: { type: "mrkdwn", text: `*요청사항*\n${wantOne}` },
      }] : []),
      {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "관리툴 열기" },
          url: ORDERS_LINK,
          style: "primary",
        }],
      },
    ],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  if (!SLACK_URL) return json({ error: "SLACK_WEBHOOK_URL not set in Edge Function secrets" }, 500);

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPA_URL, SUPA_ANON, {
    global: { headers: { Authorization: auth } },
  });
  const { data: ud } = await userClient.auth.getUser();
  if (!ud?.user) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await req.json(); }
  catch { return json({ error: "invalid JSON" }, 400); }

  const order = body.order || {};

  try {
    const r = await fetch(SLACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(order)),
    });
    if (!r.ok) {
      const detail = await r.text();
      return json({ error: "slack post failed", status: r.status, detail }, 500);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
