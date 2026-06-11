// Supabase Edge Function: admin-engineers
// POST   → 새 엔지니어(사용자) 생성
// DELETE → 엔지니어 삭제
// 인증된 사용자만 호출 가능 (verify_jwt = true)

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url     = Deno.env.get("SUPABASE_URL");
  const anon    = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  const auth = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });
  const { data: ud } = await userClient.auth.getUser();
  if (!ud?.user) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(url, service);

  try {
    if (req.method === "POST") {
      const body = await req.json();
      const { username, email: rawEmail, password, en_id, en_name, en_branch, en_tel, en_mobile, en_role } = body;
      // username 또는 email 중 하나만 와도 받기. '@' 없으면 fake domain 부착.
      let email = rawEmail || username;
      if (email && !email.includes("@")) email = email + "@asms.local";
      if (!email || !password || !en_name) {
        return json({ error: "username(또는 email), password, en_name 필수" }, 400);
      }
      const { data: created, error: e1 } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name: en_name },
      });
      if (e1) return json({ error: e1.message }, 400);

      const finalEnId = en_id || String(email).split("@")[0];
      const { error: e2 } = await admin.from("engineers").upsert({
        en_id:     finalEnId,
        email,
        en_name,
        en_branch: en_branch || "대구",
        en_tel:    en_tel || null,
        en_mobile: en_mobile || null,
        en_role:   en_role  || "engineer",
        user_id:   created.user.id,
      }, { onConflict: "en_id" });
      if (e2) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: e2.message }, 400);
      }
      return json({ ok: true, en_id: finalEnId, user_id: created.user.id });
    }

    if (req.method === "DELETE") {
      const body = await req.json();
      const { en_id, user_id } = body;
      if (!en_id && !user_id) return json({ error: "en_id 또는 user_id 필수" }, 400);

      let uid = user_id;
      if (!uid && en_id) {
        const { data: row } = await admin.from("engineers").select("user_id").eq("en_id", en_id).maybeSingle();
        uid = row?.user_id ?? null;
      }
      if (uid) {
        await admin.auth.admin.deleteUser(uid);
      } else if (en_id) {
        await admin.from("engineers").delete().eq("en_id", en_id);
      }
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
