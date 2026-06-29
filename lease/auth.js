// ===========================================================
// totalas — 인증 가드 + 사이드바 사용자 UI + role 기반 메뉴
// 로드 위치: 모든 인증 필요 페이지의 <head> 또는 첫 <script> 위치
// 의존: config.js (window.TOTALAS), supabase-js v2 UMD
// ===========================================================
(function(){
  // embed 모드 표시 — asms.html iframe 안에서 띄울 때 자체 사이드바 숨김 (CSS rule)
  if (new URLSearchParams(location.search).get('embed') === '1') {
    if (document.body) document.body.setAttribute('data-embed', '1');
    else document.addEventListener('DOMContentLoaded', () =>
      document.body.setAttribute('data-embed', '1'));
  }

  // 페이지 단위 role 가드: <html data-page-role="admin"> 선언 페이지는
  // 권한 확인 전까지 본문을 가려(플래시 방지) 비관리자 접근을 차단한다.
  const PAGE_ROLE = document.documentElement.dataset.pageRole || '';
  if (PAGE_ROLE) {
    const st = document.createElement('style');
    st.id = '__role_guard_style';
    st.textContent = 'body{visibility:hidden!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  function revealPage() {
    const s = document.getElementById('__role_guard_style');
    if (s) s.remove();
  }
  function denyPageAccess() {
    revealPage();
    document.documentElement.dataset.authed = '0';
    const msg = '<div style="min-height:60vh;display:flex;flex-direction:column;align-items:center;'
      + 'justify-content:center;gap:10px;font-family:system-ui,sans-serif;color:#374151;text-align:center;padding:24px">'
      + '<div style="font-size:40px">🔒</div>'
      + '<div style="font-size:18px;font-weight:700">관리자 전용 페이지입니다</div>'
      + '<div style="font-size:14px;color:#6b7280">이 페이지는 관리자 계정만 열람할 수 있습니다.</div></div>';
    if (document.body) document.body.innerHTML = msg;
    else document.addEventListener('DOMContentLoaded', () => { document.body.innerHTML = msg; });
  }

  if (!window.supabase || !window.TOTALAS) {
    console.error('[auth] supabase-js 또는 config.js 가 먼저 로드돼야 합니다');
    return;
  }
  const T = window.TOTALAS;
  const supa = supabase.createClient(T.URL, T.PUBLISHABLE, {
    auth: { storageKey: T.AUTH_KEY, persistSession: true, autoRefreshToken: true }
  });
  window.totalasAuth = supa;

  // 미인증 → login으로 리다이렉트
  function gotoLogin() {
    const next = encodeURIComponent(location.pathname.split('/').pop() || 'index.html');
    location.replace(`login.html?next=${next}`);
  }

  // 사용자 정보 로드 + UI 부착
  async function bootstrap() {
    const { data: { session }, error } = await supa.auth.getSession();
    if (error || !session) { gotoLogin(); return; }

    // 프로필 조회
    let profile = null;
    try {
      const r = await supa.from('rental_user_profiles')
        .select('display_id, full_name, role, active')
        .eq('user_id', session.user.id).single();
      profile = r.data;
    } catch (e) {}
    if (!profile) {
      // 프로필이 없으면 로그아웃 처리
      console.warn('[auth] 프로필 없음 — 로그아웃');
      await supa.auth.signOut();
      gotoLogin();
      return;
    }
    if (profile.active === false) {
      alert('비활성화된 계정입니다. 관리자에게 문의하세요.');
      await supa.auth.signOut();
      gotoLogin();
      return;
    }

    // 페이지 단위 role 가드 — admin 전용 페이지에 비관리자 접근 시 차단
    if (PAGE_ROLE && PAGE_ROLE !== profile.role) {
      denyPageAccess();
      return;
    }

    window.currentUser = {
      id: session.user.id,
      email: session.user.email,
      ...profile,
    };
    document.documentElement.dataset.role = profile.role;
    document.documentElement.dataset.authed = '1';

    revealPage();
    attachSidebarUI(profile);
    applyRoleVisibility(profile.role);

    // 다른 곳에서 await 가능하도록 한 번 발행
    document.dispatchEvent(new CustomEvent('totalas:ready', { detail: window.currentUser }));
  }

  function attachSidebarUI(profile) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;

    // 이미 있으면 갱신
    let bar = sidebar.querySelector('.sidebar-userbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'sidebar-userbar';
      const foot = sidebar.querySelector('.sidebar-foot');
      sidebar.insertBefore(bar, foot || null);
    }
    const roleLabel = profile.role === 'admin' ? '👑 관리자' : '🛠 엔지니어';
    bar.innerHTML = `
      <div class="user-row">
        <div class="user-avatar">${(profile.full_name || profile.display_id || '?').charAt(0)}</div>
        <div class="user-info">
          <div class="user-name">${escapeHtml(profile.full_name || profile.display_id)}</div>
          <div class="user-role">${roleLabel}</div>
        </div>
      </div>
      <button class="btn-logout" id="btn-logout" title="로그아웃">로그아웃</button>
    `;
    bar.querySelector('#btn-logout').addEventListener('click', async () => {
      if (!confirm('로그아웃 하시겠습니까?')) return;
      await supa.auth.signOut();
      gotoLogin();
    });
  }

  function applyRoleVisibility(role) {
    // [data-role-only="admin"] 인 요소는 admin 만 보임
    document.querySelectorAll('[data-role-only]').forEach(el => {
      const need = el.dataset.roleOnly;
      if (need !== role) el.style.display = 'none';
    });
    // [data-role-hide="engineer"] 처럼 특정 role 한테는 숨김
    document.querySelectorAll('[data-role-hide]').forEach(el => {
      if (el.dataset.roleHide === role) el.style.display = 'none';
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // 페이지가 인증 면제 (login.html 등) 인지 체크
  const isLogin = /(?:^|\/)login\.html$/.test(location.pathname);
  if (!isLogin) bootstrap();
})();
