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
          <a href="orders.html?status=카드">카드</a> |
          <a href="orders.html?status=견적">견적</a> |
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
  });
})();
