// 정적 HTML에서 헤더/푸터 공통 마크업을 주입하는 헬퍼.
// 각 페이지가 <div id="app-header"></div> 와 <div id="app-footer"></div> 를 포함하면
// 자동으로 마크업이 채워집니다.

(function () {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const dayNames = ["일요일","월요일","화요일","수요일","목요일","금요일","토요일"];

  const headerHtml = `
    <div class="top-bar">
      <div class="top-bar-row1">
        <div class="brand">
          <a href="orders.html"><span class="brand-logo">디직스코리아</span></a>
          <span class="branch-tag">[관리자]</span>
        </div>
        <div class="top-menu-wrap">
          <a href="orders.html"><b>A/S Management System</b></a> &nbsp;&nbsp;&nbsp;
          <a href="order-new.html">신규접수</a> <span class="sep">|</span>
          <a href="orders.html" class="m-hide">접수내역</a> <span class="sep m-hide">|</span>
          <a href="customers.html" class="m-hide">고객관리</a> <span class="sep m-hide">|</span>
          <a href="products.html" class="m-hide">부품/상품관리</a> <span class="sep m-hide">|</span>
          <a href="engineers.html" class="m-hide">엔지니어</a> <span class="sep m-hide">|</span>
          <a href="#" id="pwChangeLink">비밀번호변경</a> <span class="sep">|</span>
          <a href="#" id="logoutLink">로그아웃</a>
        </div>
      </div>
      <div class="top-bar-divider1"></div>
      <div class="top-bar-divider2"></div>
      <div class="top-bar-row2">
        <b>${yyyy}년 ${mm}월 ${dd}일</b>&nbsp;
        <b>${dayNames[today.getDay()]}</b>
        <span id="clock" style="margin-left:8px;"></span>
        <span class="gap"></span>
        <span class="quick">
          <a href="orders.html">전체</a> |
          <a href="orders.html?status=접수">접수</a> |
          <a href="orders.html?status=진행">진행</a> |
          <a href="orders.html?status=센터">센터</a> |
          <a href="orders.html?status=카드">카드</a> |
          <a href="orders.html?status=택배">택배</a> |
          <a href="orders.html?status=완료">완료</a> |
          <a href="orders.html?status=출고">출고</a>
        </span>
        <span class="gap"></span>
        <span id="userBadge">…님</span> ※ 오늘 완료 건수는
      </div>
    </div>
  `;

  const footerHtml = `
    <div class="foot-line"></div>
    <div class="foot-bar">A/S Management System.</div>
  `;

  const pwModalHtml = `
    <div id="pwModal" class="pw-modal-backdrop" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;align-items:center;justify-content:center;">
      <div style="background:#fff;width:380px;max-width:92vw;border-radius:6px;overflow:hidden;">
        <div style="background:#1e2939;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:bold;font-size:14px;">비밀번호 변경</span>
          <button type="button" id="pwCloseBtn" style="background:none;border:none;color:#fff;font-size:18px;cursor:pointer;">×</button>
        </div>
        <div style="padding:16px;">
          <form id="pwForm" onsubmit="event.preventDefault();">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:6px 4px;font-size:13px;color:#555;width:110px;">현재 비밀번호</td>
                  <td style="padding:6px 4px;"><input type="password" id="pwCurrent" autocomplete="current-password" style="width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;font-size:13px;"></td></tr>
              <tr><td style="padding:6px 4px;font-size:13px;color:#555;">새 비밀번호</td>
                  <td style="padding:6px 4px;"><input type="password" id="pwNew" autocomplete="new-password" style="width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;font-size:13px;"></td></tr>
              <tr><td style="padding:6px 4px;font-size:13px;color:#555;">새 비밀번호 확인</td>
                  <td style="padding:6px 4px;"><input type="password" id="pwConfirm" autocomplete="new-password" style="width:100%;padding:6px 8px;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;font-size:13px;"></td></tr>
            </table>
            <div style="font-size:11px;color:#888;margin-top:6px;">※ 비밀번호는 6자 이상이어야 합니다.</div>
          </form>
        </div>
        <div id="pwMsg" style="font-size:12px;min-height:16px;padding:0 16px 6px;"></div>
        <div style="padding:10px 14px;border-top:1px solid #eee;text-align:right;">
          <button type="button" id="pwCancelBtn" style="padding:6px 14px;font-size:13px;cursor:pointer;margin-left:6px;">취소</button>
          <button type="button" id="pwSaveBtn" style="padding:6px 14px;font-size:13px;cursor:pointer;margin-left:6px;">변경</button>
        </div>
      </div>
    </div>
  `;

  function showPwMsg(text, kind) {
    const el = document.getElementById("pwMsg");
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === "err" ? "#c00" : (kind === "ok" ? "#060" : "#555");
  }

  function openPwModal() {
    const m = document.getElementById("pwModal");
    if (!m) return;
    document.getElementById("pwCurrent").value = "";
    document.getElementById("pwNew").value = "";
    document.getElementById("pwConfirm").value = "";
    showPwMsg("", "");
    m.style.display = "flex";
    setTimeout(() => document.getElementById("pwCurrent").focus(), 50);
  }

  function closePwModal() {
    const m = document.getElementById("pwModal");
    if (m) m.style.display = "none";
  }

  async function submitPwChange() {
    if (!window.SB_CONFIGURED || !window.sb) {
      showPwMsg("Supabase 미설정 상태에서는 변경할 수 없습니다.", "err");
      return;
    }
    const cur = document.getElementById("pwCurrent").value;
    const np  = document.getElementById("pwNew").value;
    const cf  = document.getElementById("pwConfirm").value;
    if (!cur || !np || !cf) { showPwMsg("모든 항목을 입력하세요.", "err"); return; }
    if (np.length < 6) { showPwMsg("새 비밀번호는 6자 이상이어야 합니다.", "err"); return; }
    if (np !== cf) { showPwMsg("새 비밀번호 확인이 일치하지 않습니다.", "err"); return; }
    if (np === cur) { showPwMsg("새 비밀번호가 현재 비밀번호와 같습니다.", "err"); return; }

    const btn = document.getElementById("pwSaveBtn");
    btn.disabled = true;
    showPwMsg("처리 중...", "");
    try {
      const { data: { user } } = await window.sb.auth.getUser();
      if (!user?.email) throw new Error("로그인 정보를 확인할 수 없습니다.");

      // 1) 현재 비밀번호 검증: 동일 이메일/현재pw 로 재로그인 시도
      const { error: reErr } = await window.sb.auth.signInWithPassword({
        email: user.email, password: cur,
      });
      if (reErr) throw new Error("현재 비밀번호가 올바르지 않습니다.");

      // 2) 신규 비밀번호로 변경
      const { error: upErr } = await window.sb.auth.updateUser({ password: np });
      if (upErr) throw upErr;

      showPwMsg("변경되었습니다. 다시 로그인해주세요.", "ok");
      setTimeout(async () => {
        await window.sb.auth.signOut();
        location.href = "login.html";
      }, 900);
    } catch (e) {
      showPwMsg(e.message || String(e), "err");
      btn.disabled = false;
    }
  }

  function tick() {
    const n = new Date();
    let h = n.getHours();
    const ampm = h < 12 ? "오전" : "오후";
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    const m = String(n.getMinutes()).padStart(2, "0");
    const s = String(n.getSeconds()).padStart(2, "0");
    const el = document.getElementById("clock");
    if (el) el.innerHTML = `<b>${ampm} ${h}:${m}:${s}</b>`;
  }

  document.addEventListener("DOMContentLoaded", async function () {
    const h = document.getElementById("app-header");
    const f = document.getElementById("app-footer");
    if (h) h.innerHTML = headerHtml;
    if (f) f.innerHTML = footerHtml;
    // 비밀번호 변경 모달을 body 끝에 한 번만 주입
    if (!document.getElementById("pwModal")) {
      const wrap = document.createElement("div");
      wrap.innerHTML = pwModalHtml;
      document.body.appendChild(wrap.firstElementChild);
      document.getElementById("pwCloseBtn").addEventListener("click", closePwModal);
      document.getElementById("pwCancelBtn").addEventListener("click", closePwModal);
      document.getElementById("pwSaveBtn").addEventListener("click", submitPwChange);
      document.getElementById("pwModal").addEventListener("click", (e) => {
        if (e.target.id === "pwModal") closePwModal();
      });
      document.getElementById("pwConfirm").addEventListener("keypress", (e) => {
        if ((e.keyCode || e.which) === 13) submitPwChange();
      });
    }
    tick();
    setInterval(tick, 1000);

    // 현재 메뉴 강조
    const path = location.pathname.split("/").pop();
    document.querySelectorAll(".top-menu-wrap a").forEach(a => {
      if (a.getAttribute("href") === path) a.style.color = "#0000ff";
    });

    // 로그아웃 링크 → supabase signOut
    const out = document.getElementById("logoutLink");
    if (out) out.addEventListener("click", e => {
      e.preventDefault();
      if (typeof window.logout === "function") window.logout();
      else location.href = "login.html";
    });

    // 비밀번호 변경 링크 → 모달 오픈
    const pwLink = document.getElementById("pwChangeLink");
    if (pwLink) pwLink.addEventListener("click", e => {
      e.preventDefault();
      openPwModal();
    });

    // 인증 가드 (login.html / index.html 제외) — 미로그인 시 login.html 로
    const noGuard = ["login.html", "index.html", ""];
    if (!noGuard.includes(path) && typeof window.requireLogin === "function") {
      await window.requireLogin();
    }

    // 사용자 이름 표시
    const badge = document.getElementById("userBadge");
    if (badge && typeof window.currentUserName === "function") {
      const n = await window.currentUserName();
      badge.textContent = (n || "사용자") + "님";
      try { localStorage.setItem("current_user", n || ""); } catch (e) {}
    }

    // 공지사항 (로그인 페이지 제외)
    if (!["login.html", ""].includes(path)) initNotice();
  });

  /* ══════════════ 공지사항 ══════════════
     저장: board_posts (자료실과 공용) — pinned=true 인 글이 공지로 표시됨
     내용(content)이 http.. 로 시작하면 클릭 시 그 주소를 새 창으로 연다. */
  const NOTICE_CSS = `
    <style id="notice-style">
      .nt-box { max-width:1200px; margin:8px auto 0; background:#fff; border:1px solid #d8dee7;
                border-radius:4px; font-size:13px; }
      .nt-head { display:flex; align-items:center; justify-content:space-between;
                 padding:6px 12px; border-bottom:1px solid #eef1f5; background:#f7f9fb; }
      .nt-head b { font-size:13px; color:#1e2939; }
      .nt-btn { background:#fff; border:1px solid #c2c8d0; border-radius:3px; padding:2px 9px;
                font-size:12px; cursor:pointer; }
      .nt-btn:hover { background:#f1f3f6; }
      .nt-list { list-style:none; margin:0; padding:0; }
      .nt-list li { display:flex; align-items:center; gap:8px; padding:6px 12px;
                    border-bottom:1px solid #f3f5f8; }
      .nt-list li:last-child { border-bottom:none; }
      .nt-tag { background:#fdecec; color:#b42121; border:1px solid #f5c9c9; border-radius:3px;
                font-size:11px; padding:1px 6px; white-space:nowrap; }
      .nt-title { color:#1d4ed8; text-decoration:none; flex:1; overflow:hidden;
                  text-overflow:ellipsis; white-space:nowrap; }
      .nt-title:hover { text-decoration:underline; }
      .nt-date { color:#98a2b3; font-size:11.5px; white-space:nowrap; }
      .nt-del { color:#c0392b; cursor:pointer; font-size:12px; }
      .nt-empty { padding:8px 12px; color:#98a2b3; }
      .nt-modal { position:fixed; inset:0; background:rgba(0,0,0,.42); display:none;
                  align-items:center; justify-content:center; z-index:1200; }
      .nt-modal.show { display:flex; }
      .nt-modal-box { background:#fff; width:520px; max-width:94vw; border-radius:6px; overflow:hidden; }
      .nt-modal-head { background:#1e2939; color:#fff; padding:9px 13px; font-weight:bold; font-size:14px;
                       display:flex; justify-content:space-between; align-items:center; }
      .nt-modal-head button { background:none; border:none; color:#fff; font-size:17px; cursor:pointer; }
      .nt-modal-body { padding:14px; }
      .nt-modal-body label { display:block; font-size:12px; font-weight:600; margin:0 0 4px; color:#374151; }
      .nt-modal-body input, .nt-modal-body textarea {
        width:100%; box-sizing:border-box; padding:7px 9px; border:1px solid #ccc;
        border-radius:3px; font-size:13px; margin-bottom:10px; font-family:inherit; }
      .nt-modal-body textarea { min-height:110px; resize:vertical; }
      .nt-hint { font-size:11.5px; color:#888; margin:-6px 0 10px; }
      .nt-modal-foot { padding:10px 13px; border-top:1px solid #eee; text-align:right; }
      .nt-modal-foot button { padding:6px 14px; font-size:13px; cursor:pointer; margin-left:6px; }
      @media (max-width:640px){ .nt-date { display:none; } }
    </style>`;

  function noticeSb() { return window.sb; }
  function ntEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, m =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  }

  async function initNotice() {
    if (!window.SB_CONFIGURED || !noticeSb()) return;
    // 헤더 바로 아래에 공지 영역 삽입
    if (!document.getElementById("notice-style")) {
      document.head.insertAdjacentHTML("beforeend", NOTICE_CSS);
    }
    const header = document.getElementById("app-header");
    if (!header || document.getElementById("nt-box")) return;
    const box = document.createElement("div");
    box.className = "nt-box";
    box.id = "nt-box";
    box.innerHTML = `
      <div class="nt-head">
        <b>📢 공지사항</b>
        <span id="nt-admin-area"></span>
      </div>
      <ul class="nt-list" id="nt-list"><li class="nt-empty">불러오는 중…</li></ul>`;
    header.insertAdjacentElement("afterend", box);

    const isAdmin = (typeof window.currentIsAdmin === "function") ? await window.currentIsAdmin() : false;
    if (isAdmin) {
      document.getElementById("nt-admin-area").innerHTML =
        `<button class="nt-btn" id="nt-write">+ 공지쓰기</button>`;
      document.getElementById("nt-write").addEventListener("click", () => openNoticeModal());
      await seedDefaultNotices();
    }
    await loadNotices(isAdmin);
  }

  async function loadNotices(isAdmin) {
    const ul = document.getElementById("nt-list");
    if (!ul) return;
    const { data, error } = await noticeSb()
      .from("board_posts").select("id, title, content, created_at")
      .eq("pinned", true).order("created_at", { ascending: false }).limit(10);
    if (error) { ul.innerHTML = `<li class="nt-empty">공지를 불러오지 못했습니다.</li>`; return; }
    if (!data || !data.length) { ul.innerHTML = `<li class="nt-empty">등록된 공지가 없습니다.</li>`; return; }
    ul.innerHTML = data.map(p => `
      <li>
        <span class="nt-tag">공지</span>
        <a class="nt-title" href="#" data-nt="${p.id}">${ntEsc(p.title)}</a>
        <span class="nt-date">${(p.created_at || "").slice(0, 10)}</span>
        ${isAdmin ? `<span class="nt-del" data-ntdel="${p.id}" title="삭제">✕</span>` : ""}
      </li>`).join("");
    ul.querySelectorAll("[data-nt]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault();
      const post = data.find(x => x.id === a.dataset.nt);
      if (post) openNoticeView(post);
    }));
    ul.querySelectorAll("[data-ntdel]").forEach(s => s.addEventListener("click", async () => {
      if (!confirm("이 공지를 삭제할까요?")) return;
      const { error: e2 } = await noticeSb().from("board_posts").delete().eq("id", s.dataset.ntdel);
      if (e2) { alert("삭제 실패: " + e2.message); return; }
      await loadNotices(true);
    }));
  }

  /** 공지 클릭 — 내용이 URL 이면 그 주소를, 아니면 내용을 새 창으로 */
  function openNoticeView(post) {
    const body = (post.content || "").trim();
    if (/^https?:\/\//i.test(body)) { window.open(body, "_blank", "noopener"); return; }
    const w = window.open("", "_blank");
    if (!w) { alert("팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요."); return; }
    w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
      <title>${ntEsc(post.title)}</title>
      <style>body{font-family:'Malgun Gothic',sans-serif;max-width:820px;margin:30px auto;padding:0 18px;line-height:1.8;color:#222;}
      h1{font-size:20px;border-bottom:2px solid #1e2939;padding-bottom:10px;}
      .d{color:#888;font-size:13px;margin-bottom:18px;} .c{white-space:pre-wrap;font-size:14.5px;}</style>
      </head><body><h1>${ntEsc(post.title)}</h1>
      <div class="d">${(post.created_at || "").slice(0, 10)}</div>
      <div class="c">${ntEsc(body)}</div></body></html>`);
    w.document.close();
  }

  function openNoticeModal() {
    if (!document.getElementById("nt-modal")) {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <div class="nt-modal" id="nt-modal">
          <div class="nt-modal-box">
            <div class="nt-modal-head"><span>공지 등록</span><button type="button" id="nt-x">×</button></div>
            <div class="nt-modal-body">
              <label>제목 *</label>
              <input type="text" id="nt-t" placeholder="예: 2026-07 업데이트 안내">
              <label>내용 또는 링크</label>
              <textarea id="nt-c" placeholder="내용을 입력하세요.&#10;링크만 넣으면(https://...) 클릭 시 그 페이지가 새 창으로 열립니다."></textarea>
              <div class="nt-hint">※ https:// 로 시작하는 주소만 넣으면 클릭 시 바로 그 페이지가 열립니다.</div>
              <div id="nt-msg" style="font-size:12px;color:#c0392b;min-height:15px;"></div>
            </div>
            <div class="nt-modal-foot">
              <button type="button" id="nt-cancel">취소</button>
              <button type="button" id="nt-save" style="background:#1e2939;color:#fff;border:1px solid #1e2939;">등록</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(wrap.firstElementChild);
      const close = () => document.getElementById("nt-modal").classList.remove("show");
      document.getElementById("nt-x").addEventListener("click", close);
      document.getElementById("nt-cancel").addEventListener("click", close);
      document.getElementById("nt-modal").addEventListener("click", e => {
        if (e.target.id === "nt-modal") close();
      });
      document.getElementById("nt-save").addEventListener("click", saveNotice);
    }
    document.getElementById("nt-t").value = "";
    document.getElementById("nt-c").value = "";
    document.getElementById("nt-msg").textContent = "";
    document.getElementById("nt-modal").classList.add("show");
    setTimeout(() => document.getElementById("nt-t").focus(), 50);
  }

  async function saveNotice() {
    const title = document.getElementById("nt-t").value.trim();
    const content = document.getElementById("nt-c").value.trim();
    const msg = document.getElementById("nt-msg");
    if (!title) { msg.textContent = "제목을 입력하세요."; return; }
    const btn = document.getElementById("nt-save");
    btn.disabled = true; msg.textContent = "등록 중…";
    const author = localStorage.getItem("current_user") || "관리자";
    const { error } = await noticeSb().from("board_posts")
      .insert({ title, content, author, pinned: true });
    btn.disabled = false;
    if (error) { msg.textContent = "등록 실패: " + error.message; return; }
    document.getElementById("nt-modal").classList.remove("show");
    await loadNotices(true);
  }

  /** 사용방법 공지 2건이 없으면 자동 등록 (관리자 접속 시 1회) */
  async function seedDefaultNotices() {
    const defaults = [
      { title: "접수관리툴 사용방법 안내", content: window.GUIDE_ASMS_URL || "" },
      { title: "임대관리 사용방법 안내",   content: window.GUIDE_LEASE_URL || "" },
    ].filter(d => d.content);
    if (!defaults.length) return;
    const { data } = await noticeSb().from("board_posts")
      .select("title").in("title", defaults.map(d => d.title));
    const exists = new Set((data || []).map(x => x.title));
    const rows = defaults.filter(d => !exists.has(d.title))
      .map(d => ({ title: d.title, content: d.content, author: "시스템", pinned: true }));
    if (rows.length) await noticeSb().from("board_posts").insert(rows);
  }
})();
