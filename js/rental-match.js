// 임대거래처 매칭 헬퍼
// rental_customers(company / trade_name) 정규화 Set 을 한 번 로드해
// 화면에서 고객명 옆에 "임대" 배지를 표시할 수 있게 한다.
//
// 정규화 규칙: '(주)' / '㈜' / '주식회사' / 공백 제거 + 소문자
// → '경진기계' = '경진기계(주)' = '㈜경진기계' 모두 동일
//
// 호출:
//   await window.ensureRentalMatchCache();
//   window.isRentalCustomer(name)  →  true/false
//   window.rentalBadgeHtml()       →  배지 HTML 문자열

(function () {
  function normalize(s) {
    if (s == null) return "";
    return String(s)
      .replace(/\(주\)|㈜|주식회사/g, "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  let SET = null;
  let LOADING = null;
  const TTL_MS = 5 * 60 * 1000;
  let LOADED_AT = 0;

  async function load() {
    if (!window.sb || !window.SB_CONFIGURED) return new Set();
    try {
      const s = new Set();
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await window.sb
          .from("rental_customers")
          .select("company,trade_name,active")
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        for (const r of data) {
          // active=false(만기) 거래처는 라벨 대상에서 제외. NULL/TRUE 는 활성으로 간주.
          if (r.active === false) continue;
          const nc = normalize(r.company);
          const nt = normalize(r.trade_name);
          if (nc) s.add(nc);
          if (nt) s.add(nt);
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return s;
    } catch (e) {
      console.warn("[rental-match] 로드 실패:", e.message || e);
      return new Set();
    }
  }

  window.ensureRentalMatchCache = async function () {
    const now = Date.now();
    if (SET && now - LOADED_AT < TTL_MS) return SET;
    if (LOADING) return LOADING;
    LOADING = load().then((s) => {
      SET = s;
      LOADED_AT = Date.now();
      LOADING = null;
      return s;
    });
    return LOADING;
  };

  window.isRentalCustomer = function (name) {
    if (!SET) return false;
    const k = normalize(name);
    if (!k) return false;
    return SET.has(k);
  };

  window.rentalBadgeHtml = function () {
    return '<span class="rental-badge" title="임대거래처로 등록되어 있음" '
      + 'style="display:inline-block;margin-left:4px;padding:1px 5px;'
      + 'font-size:10px;font-weight:600;line-height:1.4;color:#fff;'
      + 'background:#059669;border-radius:3px;vertical-align:middle;">임대</span>';
  };

  window.rentalBadgeSuffix = function (name) {
    return window.isRentalCustomer(name) ? window.rentalBadgeHtml() : "";
  };

  // 하위 호환: 기존 호출명도 유지 (위치는 동일하게 'suffix' 동작)
  window.rentalBadgePrefix = window.rentalBadgeSuffix;
})();
