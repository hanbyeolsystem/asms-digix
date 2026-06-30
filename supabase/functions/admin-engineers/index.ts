// Supabase Edge Function: admin-engineers (접수관리툴)
// POST   → 새 계정 생성 (관리자만) — engineers + rental_user_profiles 동시 기록
// PATCH  → 계정 정보 변경 (관리자만) — 양쪽 동기화
// DELETE → 계정 삭제 (관리자만) — auth + 양쪽 프로필 제거
// service_role 키는 함수 env 에만 존재. 호출자는 세션 토큰으로 인증.
//
// 디직스: 접수관리툴(engineers)과 임대관리(rental_user_profiles)가 같은 auth 를 공유.
// 한 곳에서 만들면 양쪽에서 같은 아이디/비밀번호로 동작하도록 두 테이블을 함께 기록한다.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, PATCH, DELETE, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// engineers 의 en_role 을 lease(rental_user_profiles) 의 role 로 매핑.
// admin → admin, 그 외(engineer/office) → engineer.
const leaseRole = (enRole) => (enRole === "admin" ? "admin" : "engineer");

// 호출자가 관리자인지 확인 (레거시 admin@asms.local, engineers.en_role==='admin', 또는 rental_user_profiles.role==='admin')
async function isAdmin(admin, user) {
  if (user.email === "admin@asms.local") return true;
  const { data: e } = await admin
    .from("engineers").select("en_role").eq("user_id", user.id).maybeSingle();
  if (e?.en_role === "admin") return true;
  const { data: p } = await admin
    .from("rental_user_profiles").select("role").eq("user_id", user.id).maybeSingle();
  return p?.role === "admin";
}

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
  if (!ud?.user) return json({ error: "로그인이 필요합니다. 다시 로그인하세요." }, 401);
  const caller = ud.user;

  const admin = createClient(url, service);

  try {
    if (req.method === "POST") {
      // 계정 생성은 관리자만
      if (!(await isAdmin(admin, caller))) return json({ error: "관리자만 계정을 만들 수 있습니다." }, 403);

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
      const uid = created.user.id;

      const finalEnId = en_id || String(email).split("@")[0];
      const { error: e2 } = await admin.from("engineers").upsert({
        en_id:     finalEnId,
        email,
        en_name,
        en_branch: en_branch || "대구",
        en_tel:    en_tel || null,
        en_mobile: en_mobile || null,
        en_role:   en_role  || "engineer",
        user_id:   uid,
      }, { onConflict: "en_id" });
      if (e2) {
        await admin.auth.admin.deleteUser(uid);
        return json({ error: e2.message }, 400);
      }

      // 임대관리(lease) 프로필도 함께 생성 → 같은 아이디/비번으로 양쪽 사용 가능
      const { error: e3 } = await admin.from("rental_user_profiles").upsert({
        user_id:    uid,
        display_id: finalEnId,
        full_name:  en_name,
        role:       leaseRole(en_role || "engineer"),
        active:     true,
      }, { onConflict: "user_id" });
      if (e3) {
        await admin.from("engineers").delete().eq("en_id", finalEnId);
        await admin.auth.admin.deleteUser(uid);
        return json({ error: "임대관리 프로필 생성 실패: " + e3.message }, 400);
      }

      return json({ ok: true, en_id: finalEnId, user_id: uid });
    }

    if (req.method === "PATCH") {
      if (!(await isAdmin(admin, caller))) return json({ error: "관리자만 변경할 수 있습니다." }, 403);
      const body = await req.json();
      const { en_id, en_name, en_branch, en_tel, en_mobile, en_role, password } = body;
      if (!en_id) return json({ error: "en_id 필수" }, 400);

      const update = {};
      if (en_name   !== undefined) update.en_name   = en_name;
      if (en_branch !== undefined) update.en_branch = en_branch || "대구";
      if (en_tel    !== undefined) update.en_tel    = en_tel || null;
      if (en_mobile !== undefined) update.en_mobile = en_mobile || null;
      if (en_role   !== undefined) update.en_role   = en_role || "engineer";

      const { data: row } = await admin.from("engineers").select("user_id").eq("en_id", en_id).maybeSingle();

      if (Object.keys(update).length) {
        const { error: ue } = await admin.from("engineers").update(update).eq("en_id", en_id);
        if (ue) return json({ error: ue.message }, 400);
      }

      // 임대관리 프로필도 동기화 (이름/역할)
      if (row?.user_id) {
        const lp = {};
        if (en_name !== undefined) lp.full_name = en_name;
        if (en_role !== undefined) lp.role = leaseRole(en_role || "engineer");
        if (Object.keys(lp).length) {
          await admin.from("rental_user_profiles").update(lp).eq("user_id", row.user_id);
        }
      }

      // 비밀번호가 들어오면 Auth 계정 비번도 변경 (양쪽 공통 자격증명)
      if (password) {
        if (!row?.user_id) return json({ error: "연결된 로그인 계정을 찾을 수 없습니다." }, 400);
        const { error: pe } = await admin.auth.admin.updateUserById(row.user_id, { password });
        if (pe) return json({ error: "비밀번호 변경 실패: " + pe.message }, 400);
      }
      return json({ ok: true, en_id });
    }

    if (req.method === "DELETE") {
      if (!(await isAdmin(admin, caller))) return json({ error: "관리자만 삭제할 수 있습니다." }, 403);
      const body = await req.json();
      const { en_id, user_id } = body;
      if (!en_id && !user_id) return json({ error: "en_id 또는 user_id 필수" }, 400);

      let uid = user_id;
      if (!uid && en_id) {
        const { data: row } = await admin.from("engineers").select("user_id").eq("en_id", en_id).maybeSingle();
        uid = row?.user_id ?? null;
      }
      // 양쪽 프로필 제거
      if (en_id) await admin.from("engineers").delete().eq("en_id", en_id);
      if (uid) {
        await admin.from("engineers").delete().eq("user_id", uid);
        await admin.from("rental_user_profiles").delete().eq("user_id", uid);
        await admin.auth.admin.deleteUser(uid);
      }
      return json({ ok: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
