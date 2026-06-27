// ============================================================
// item-types.js — 품목 마스터 공용 fetcher
//   모든 모듈(임대거래처/현황/계약서/장비관리 등) 공통 사용.
//   한 곳(임대거래처 ⚙ 품목 관리)에서 수정 → window.invalidateItemTypes() →
//   다른 모듈 다음 로드 시 자동 반영.
//
// 사용:
//   const types = await window.loadItemTypes();
//   // types: [{ id, label, category, icon, sort_order, form_label, is_print, active }, ...]
//
//   // 수정 후 캐시 비움:
//   window.invalidateItemTypes();
//
// 의존: window.totalasAuth (auth.js 가 세팅하는 supabase 클라이언트)
// ============================================================
(function () {
  'use strict';

  let cache = null;
  let inflight = null;

  async function loadItemTypes(opts) {
    if (cache && !(opts && opts.force)) return cache;
    if (inflight) return inflight;

    const supa = window.totalasAuth;
    if (!supa) {
      // auth.js 가 아직 준비 안 됨 — 안전한 빈 배열 폴백
      return [];
    }

    inflight = (async () => {
      const { data, error } = await supa
        .from('rental_item_types')
        .select('*')
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (error) {
        console.warn('[item-types] load failed (마이그레이션 39 미적용?):', error.message);
        cache = [];
      } else {
        cache = data || [];
      }
      inflight = null;
      return cache;
    })();
    return inflight;
  }

  function invalidateItemTypes() {
    cache = null;
    inflight = null;
  }

  // 정규화 — DB 의 다양한 표기(영문/한글)를 마스터 라벨로 통일
  function normalizeSubtype(subtype) {
    const s = String(subtype || '').trim();
    if (!s) return '기타';
    if (/노트북|notebook|laptop/i.test(s)) return '노트북';
    if (/^pc$|^컴퓨터$|^데스크탑$/i.test(s) || /\bpc\b/i.test(s.toLowerCase()) || /컴퓨터|데스크탑/.test(s)) return '컴퓨터';
    if (/^monitor$|^모니터$/i.test(s) || /\bmonitor\b/i.test(s.toLowerCase()) || /모니터/.test(s)) return '모니터';
    if (/^nas$|^나스$/i.test(s) || /\bnas\b/i.test(s.toLowerCase()) || /나스/.test(s)) return '나스';
    if (/유지보수|maintenance|maintain/i.test(s)) return 'PC유지보수';
    if (/웰리스|wellis|wellness|제균기/i.test(s)) return '웰리스';
    return s;
  }

  window.loadItemTypes       = loadItemTypes;
  window.invalidateItemTypes = invalidateItemTypes;
  window.normalizeSubtype    = normalizeSubtype;
})();
