// Supabase 클라이언트 설정 (publishable 키만 사용 — RLS로 안전)
window.TOTALAS = {
  URL:         'https://wghjnlhfqypamiwukeio.supabase.co',
  PUBLISHABLE: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnaGpubGhmcXlwYW1pd3VrZWlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTYyODAsImV4cCI6MjA5NjczMjI4MH0.sOjiDveMGn_uIt6fzu4fqQtlDwNWkkoXWrz6gxy0XZg',
  AUTH_KEY:    'digix-lease-auth',       // 세션 storage key (한별 totalas 와 동일 오리진 충돌 방지)
  EMAIL_DOMAIN:'@asms.local',            // id → email 매핑 (디직스 기존 admin@asms.local 재사용)
};

/**
 * 캐시 우회 새로고침 — Ctrl+F5 와 유사한 효과.
 */
window.hardReload = function hardReload() {
  const win = (window.parent && window.parent !== window) ? window.parent : window;
  try {
    const url = new URL(win.location.href);
    url.searchParams.set('_t', Date.now());
    win.location.replace(url.toString());
  } catch (e) {
    window.location.reload();
  }
};

/**
 * 기기 공용 Gemini API 키 자동 동기화
 * PC에서 1회 입력하면 핸드폰 등 모든 기기에서 재입력 없이 자동 적용된다.
 * - 키는 Supabase의 app_settings 테이블에 저장(로그인 직원만 접근 — RLS).
 * - 로컬(bc_cfg)에 키가 없으면 DB에서 받아 채운다.
 * - index.html / quick.html 둘 다 config.js 를 로드하므로 한 곳만 고치면 양쪽 적용.
 */
(function () {
  var BC_KEY = 'digix_bc_cfg';
  function readCfg() { try { return JSON.parse(localStorage.getItem(BC_KEY) || '{}'); } catch (e) { return {}; } }
  async function syncGeminiKey() {
    try {
      var supa = window.totalasAuth;
      if (!supa) return;
      var c = readCfg();
      if (c.apikey) return;
      var r = await supa.from('app_settings').select('key,value').in('key', ['gemini_apikey', 'gemini_model']);
      if (r.error || !r.data || !r.data.length) return;
      var map = {}; r.data.forEach(function (x) { map[x.key] = x.value; });
      if (map.gemini_apikey) {
        c.apikey = map.gemini_apikey;
        c.model = map.gemini_model || c.model || 'gemini-2.5-flash';
        localStorage.setItem(BC_KEY, JSON.stringify(c));
        try { document.dispatchEvent(new CustomEvent('bc:keysynced')); } catch (e) {}
      }
    } catch (e) {}
  }
  document.addEventListener('totalas:ready', syncGeminiKey, { once: false });
  setTimeout(syncGeminiKey, 1500);
  setTimeout(syncGeminiKey, 4000);
})();
