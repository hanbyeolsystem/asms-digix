// Supabase 클라이언트 + 인증/데이터 래퍼.
// supabase-config.js 가 먼저 로드되어 있어야 함.
// supabase-js v2 UMD 가 window.supabase 로 노출됨.

(function () {
  const URL  = window.SUPABASE_URL;
  const ANON = window.SUPABASE_ANON;

  function isConfigured() {
    return URL && ANON
        && URL  !== "https://YOUR_PROJECT.supabase.co"
        && ANON !== "YOUR_ANON_KEY";
  }
  window.SB_CONFIGURED = isConfigured();

  if (!isConfigured()) {
    console.warn("[supabase] 설정 미완료 — 데모 폴백 모드로 동작 (js/supabase-config.js 참고)");
    window.sb = null;
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    console.error("[supabase] supabase-js UMD 로드 실패 — <script src='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'></script> 가 먼저 있어야 합니다");
    window.sb = null;
    return;
  }

  window.sb = window.supabase.createClient(URL, ANON, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
})();

// ---------- 인증 가드: 로그인 안 됐으면 login.html 로 ----------
async function requireLogin() {
  if (!window.SB_CONFIGURED) return null;       // 데모 모드는 게이트 안 함
  const { data: { session } } = await window.sb.auth.getSession();
  const here = location.pathname.split("/").pop();
  if (!session && here !== "login.html") {
    location.href = "login.html?next=" + encodeURIComponent(here || "orders.html");
    return null;
  }
  return session;
}
window.requireLogin = requireLogin;

async function logout() {
  if (window.sb) await window.sb.auth.signOut();
  location.href = "login.html";
}
window.logout = logout;

// ---------- 데이터 래퍼 ----------
const sb = () => window.sb;

async function dbFetchAll(table, orderCol, ascending = false) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb()
      .from(table).select("*").order(orderCol, { ascending }).range(from, from + PAGE - 1);
    if (error) { console.error(error); return all; }
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function dbOrdersAll() {
  if (!window.SB_CONFIGURED) return null;
  return await dbFetchAll("orders", "seq_no", false);
}

// 서버 측 페이지네이션 + 필터 (대용량 테이블용)
// count 옵션: 검색/필터 없으면 estimated(빠른 통계값), 있으면 exact 가 필요한데
// trgm 인덱스 덕에 ilike 도 빨라져 그대로 exact 로 두어도 부담 적음.
// 다만 4만 행 ilike 의 정확 카운트는 여전히 느릴 수 있으므로 검색 시에도 estimated 사용.
async function dbOrdersPage({ page = 1, pageSize = 15, status = "", searchField = "", searchValue = "" } = {}) {
  if (!window.SB_CONFIGURED) return null;
  const from = (page - 1) * pageSize;
  const to   = from + pageSize - 1;
  let q = sb().from("orders").select("*", { count: "estimated" });
  if (status) q = q.eq("status", status);
  if (searchValue) {
    const v = String(searchValue).replace(/%/g, "");
    if (searchField === "phone") {
      q = q.or(`cu_tel.ilike.%${v}%,cu_mobile.ilike.%${v}%`);
    } else if (searchField) {
      q = q.ilike(searchField, `%${v}%`);
    }
  }
  q = q.order("seq_no", { ascending: false }).range(from, to);
  const { data, count, error } = await q;
  if (error) { console.error(error); return { rows: [], total: 0 }; }
  return { rows: data || [], total: count || 0 };
}
window.dbOrdersPage = dbOrdersPage;

// 서버측 customers 검색 (order-new.html lazy 검색용)
// q 가 비면 order_count 상위 limit 건만 반환. q 있으면 cu_name/co_name/cu_kind/cu_tel/cu_mobile/address1 ilike OR 검색.
async function dbCustomersSearch(q, limit = 50) {
  if (!window.SB_CONFIGURED) return [];
  let query = sb().from("customers").select("*")
    .order("order_count", { ascending: false })
    .order("cu_name", { ascending: true })
    .limit(limit);
  const v = String(q || "").trim().replace(/%/g, "");
  if (v) {
    query = query.or([
      `cu_name.ilike.%${v}%`,
      `co_name.ilike.%${v}%`,
      `cu_kind.ilike.%${v}%`,
      `cu_tel.ilike.%${v}%`,
      `cu_mobile.ilike.%${v}%`,
      `address1.ilike.%${v}%`,
    ].join(","));
  }
  const { data, error } = await query;
  if (error) { console.error("[dbCustomersSearch]", error); return []; }
  return data || [];
}
window.dbCustomersSearch = dbCustomersSearch;

// customers 전체 행 수 (모달 헤더 "전체 N명" 표시용)
async function dbCustomersCount() {
  if (!window.SB_CONFIGURED) return 0;
  const { count, error } = await sb().from("customers").select("cu_number", { count: "estimated", head: true });
  if (error) { console.error("[dbCustomersCount]", error); return 0; }
  return count || 0;
}
window.dbCustomersCount = dbCustomersCount;

async function dbOrderBySeq(seq) {
  if (!window.SB_CONFIGURED) return null;
  const { data, error } = await sb()
    .from("orders").select("*").eq("seq_no", Number(seq)).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

async function dbOrderNoBySeqs(seqs) {
  if (!window.SB_CONFIGURED || !seqs?.length) return {};
  const { data, error } = await sb()
    .from("orders").select("seq_no,order_no").in("seq_no", seqs.map(Number));
  if (error) { console.error("[dbOrderNoBySeqs]", error); return {}; }
  const m = {};
  for (const r of data || []) m[r.seq_no] = r.order_no || "";
  return m;
}

async function dbOrderUpsert(row) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb()
    .from("orders").upsert(row, { onConflict: "seq_no" }).select().maybeSingle();
  if (error) { console.error("[dbOrderUpsert]", error); return { error: error.message }; }
  return { data };
}

async function dbOrderDelete(seq) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { error } = await sb().from("orders").delete().eq("seq_no", Number(seq));
  if (error) { console.error("[dbOrderDelete]", error); return { error: error.message }; }
  return { ok: true };
}

async function dbProductsAll() {
  if (!window.SB_CONFIGURED) return null;
  return await dbFetchAll("products", "seq_no", false);
}

async function dbProductBySeq(seq) {
  if (!window.SB_CONFIGURED) return null;
  const { data, error } = await sb()
    .from("products").select("*").eq("seq_no", Number(seq)).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}

async function dbProductNextSeq() {
  if (!window.SB_CONFIGURED) return null;
  const { data, error } = await sb()
    .from("products").select("seq_no").order("seq_no", { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error("[dbProductNextSeq]", error); return null; }
  return (data?.seq_no || 0) + 1;
}

async function dbProductInsert(row) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb().from("products").insert(row).select().maybeSingle();
  if (error) { console.error("[dbProductInsert]", error); return { error: error.message }; }
  return { data };
}

async function dbProductUpdate(seq_no, patch) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb().from("products").update(patch).eq("seq_no", Number(seq_no)).select().maybeSingle();
  if (error) { console.error("[dbProductUpdate]", error); return { error: error.message }; }
  return { data };
}

async function dbProductDelete(seq_no) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { error } = await sb().from("products").delete().eq("seq_no", Number(seq_no));
  if (error) { console.error("[dbProductDelete]", error); return { error: error.message }; }
  return { ok: true };
}

async function dbCustomersAll() {
  if (!window.SB_CONFIGURED) return null;
  // 접수 횟수 많은 순으로 정렬
  const PAGE = 1000; const all = []; let from = 0;
  while (true) {
    const { data, error } = await sb()
      .from("customers").select("*")
      .order("order_count", { ascending: false })
      .order("cu_name", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error(error); return all; }
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function dbCustomerInsert(row) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb().from("customers").insert(row).select().maybeSingle();
  if (error) { console.error("[dbCustomerInsert]", error); return { error: error.message }; }
  return { data };
}

async function dbCustomerUpdate(cu_number, patch) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb().from("customers").update(patch).eq("cu_number", cu_number).select().maybeSingle();
  if (error) { console.error("[dbCustomerUpdate]", error); return { error: error.message }; }
  return { data };
}

async function dbCustomerDelete(cu_number) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { error } = await sb().from("customers").delete().eq("cu_number", cu_number);
  if (error) { console.error("[dbCustomerDelete]", error); return { error: error.message }; }
  return { ok: true };
}

async function dbEngineersAll() {
  if (!window.SB_CONFIGURED) return null;
  const { data, error } = await sb()
    .from("engineers").select("*").order("created_at", { ascending: false });
  if (error) { console.error(error); return []; }
  return data;
}

async function fnCreateEngineer(payload) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb().functions.invoke("admin-engineers", {
    method: "POST",
    body: payload,
  });
  if (error) return { error: error.message };
  if (data?.error) return { error: data.error };
  return { data };
}

async function fnDeleteEngineer(en_id) {
  if (!window.SB_CONFIGURED) return { error: "Supabase 미설정" };
  const { data, error } = await sb().functions.invoke("admin-engineers", {
    method: "DELETE",
    body: { en_id },
  });
  if (error) return { error: error.message };
  if (data?.error) return { error: data.error };
  return { data };
}

window.dbOrdersAll      = dbOrdersAll;
window.dbOrderBySeq     = dbOrderBySeq;
window.dbOrderNoBySeqs  = dbOrderNoBySeqs;
window.dbOrderUpsert    = dbOrderUpsert;
window.dbOrderDelete    = dbOrderDelete;
window.dbProductsAll    = dbProductsAll;
window.dbProductBySeq   = dbProductBySeq;
window.dbProductNextSeq = dbProductNextSeq;
window.dbProductInsert  = dbProductInsert;
window.dbProductUpdate  = dbProductUpdate;
window.dbProductDelete  = dbProductDelete;
window.dbCustomersAll   = dbCustomersAll;
window.dbEngineersAll   = dbEngineersAll;
window.fnCreateEngineer = fnCreateEngineer;
window.fnDeleteEngineer = fnDeleteEngineer;
window.dbCustomerInsert = dbCustomerInsert;
window.dbCustomerUpdate = dbCustomerUpdate;
window.dbCustomerDelete = dbCustomerDelete;

// ---------- 현재 사용자 이름 (헤더용) ----------
async function currentUserName() {
  if (!window.SB_CONFIGURED) return localStorage.getItem("current_user") || "데모";
  const { data: { user } } = await window.sb.auth.getUser();
  if (!user) return null;
  return user.user_metadata?.name || user.email?.split("@")[0] || user.email || "사용자";
}
window.currentUserName = currentUserName;

// ---------- 관리자 권한 체크 ----------
async function currentIsAdmin() {
  if (!window.SB_CONFIGURED) return true;            // 데모 모드: 항상 admin
  const { data: { user } } = await window.sb.auth.getUser();
  if (!user) return false;
  if (user.email === "admin@asms.local") return true; // 레거시 admin 계정
  try {
    const { data } = await sb()
      .from("engineers").select("en_role").eq("user_id", user.id).maybeSingle();
    return data?.en_role === "admin";
  } catch (e) { return false; }
}
window.currentIsAdmin = currentIsAdmin;
