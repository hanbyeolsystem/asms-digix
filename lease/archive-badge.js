// archive-badge.js
// 사이드바 "소프트웨어고객자료실" 메뉴 옆에 만기 임박 라이선스 건수를 빨간 배지로 표시.
//
// 동작:
//  - DOMContentLoaded 시 archive 링크에 .archive-alert-badge 노드를 자동 주입(HTML 무수정 운영 가능)
//  - 인증 완료(totalas:ready) 후 software_licenses 를 조회해 D-day ≤ alert_days(기본 30) 인
//    active 라이선스 건수로 배지 갱신
//  - 5분 주기로 자동 재조회
//
// 의존: window.totalasAuth (auth.js 가 노출하는 Supabase client)
(function () {
  'use strict';

  function injectBadges() {
    // archive 경로 변형 모두 매칭 (각 페이지의 사이드바 href 가 다름):
    //   asms.html      → "archive/index.html"
    //   index.html     → "archive.html"
    //   admin/errorcode → "lease/archive.html"
    const SELECTORS = [
      'a[href$="archive/index.html"]',
      'a[href$="/archive.html"]',
      'a[href="archive.html"]',
      'a[href$="lease/archive.html"]',
    ];
    document.querySelectorAll(SELECTORS.join(',')).forEach((a) => {
      if (a.querySelector('.archive-alert-badge')) return;
      const badge = document.createElement('span');
      badge.className = 'archive-alert-badge';
      badge.style.cssText = [
        'display:none',
        'background:#dc2626',
        'color:#fff',
        'font-size:10.5px',
        'font-weight:700',
        'border-radius:10px',
        'padding:1px 7px',
        'margin-left:auto',
        'min-width:18px',
        'text-align:center',
        'line-height:1.6',
        'box-shadow:0 0 0 2px #fff',
        'animation:archive-badge-pulse 2.2s ease-in-out infinite',
      ].join(';');
      badge.title = '만기 임박 소프트웨어 라이선스 건수';
      a.appendChild(badge);
    });
  }

  function applyCount(n, urgent) {
    document.querySelectorAll('.archive-alert-badge').forEach((el) => {
      if (n > 0) {
        el.textContent = n;
        el.style.display = '';
        // 만료/D-7 이내가 1건이라도 있으면 더 진한 빨간색 + 펄스 강화
        el.style.background = urgent ? '#b91c1c' : '#dc2626';
        el.style.animationDuration = urgent ? '1.2s' : '2.2s';
      } else {
        el.style.display = 'none';
      }
    });
  }

  function dday(expiryStr) {
    if (!expiryStr) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const exp = new Date(expiryStr); exp.setHours(0, 0, 0, 0);
    return Math.round((exp - today) / 86400000);
  }

  async function refresh() {
    const sb = window.totalasAuth;
    if (!sb) return;
    try {
      const { data, error } = await sb.from('software_licenses')
        .select('expiry_date, alert_days, status')
        .eq('status', 'active');
      if (error) {
        // 테이블 미생성/권한 등 — 조용히 무시
        if (!/permission|does not exist|relation/i.test(error.message || '')) {
          console.warn('[archive-badge] load error:', error.message);
        }
        return;
      }
      let n = 0, urgent = false;
      (data || []).forEach((r) => {
        const d = dday(r.expiry_date);
        if (d == null) return;
        if (d <= (r.alert_days || 30)) {
          n++;
          if (d <= 7) urgent = true;
        }
      });
      applyCount(n, urgent);
    } catch (e) {
      console.warn('[archive-badge] unexpected error:', e);
    }
  }

  // 펄스 키프레임 (1회만 주입)
  function injectKeyframes() {
    if (document.getElementById('archive-badge-kf')) return;
    const s = document.createElement('style');
    s.id = 'archive-badge-kf';
    s.textContent = `
      @keyframes archive-badge-pulse {
        0%, 100% { transform: scale(1);   opacity: 1; }
        50%      { transform: scale(1.18); opacity: .85; }
      }`;
    document.head.appendChild(s);
  }

  function start() {
    injectKeyframes();
    injectBadges();
    if (window.currentUser) {
      refresh();
    } else {
      document.addEventListener('totalas:ready', refresh, { once: true });
      // 안전망 — 인증이 끝났는데 이벤트를 놓친 경우
      setTimeout(() => { if (window.currentUser) refresh(); }, 3500);
    }
    // 5분 주기 갱신
    setInterval(refresh, 5 * 60 * 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
