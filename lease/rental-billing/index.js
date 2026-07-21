// ============================================================
// rental-billing/index.js — 임대추가요금청구 (Supabase 실데이터)
// 하이브리드 빌링: 고정료 + 사용량 초과 과금
// 의존: ../config.js, ../auth.js (window.totalasAuth)
// 스키마: rental_customers, rental_items, rental_assignments,
//        rental_counters, rental_billings, rental_billing_overrides
// ============================================================
'use strict';

(function () {
  // ── 전역 상태 ───────────────────────────────────────────────
  const LS_ONLY_OVERAGE       = 'rental-billing:only-overage';
  const LS_COLLAPSED_PERIODS  = 'rb.collapsedPeriods';

  const state = {
    ym: '',                  // 'YYYY-MM'
    customers: [],           // [{id, company, biz_no, payment_type, invoice_day, ...}]
    items: new Map(),        // item_id -> {id, category, subtype, brand, model, ...}
    assignments: [],         // [{id, item_id, customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate, end_date}]
    counters: new Map(),     // `${item_id}|${ym}` -> {bw, color, uptime_hours}
    prevCounters: new Map(), // item_id -> {bw, color}  (전월 카운터)
    billings: new Map(),     // customer_id -> billing row (for current ym)
    overrides: new Map(),    // `${customer_id}|${item_id}|${kind}|${field}` -> override row
    discounts: new Map(),    // customer_id -> amount (카운터 오버 추가요금 할인)
    rateHistory: [],         // rental_item_rate_history 전체 (로드 범위 내)
    prevBillingsTotal: 0,    // 지난달 추가요금 발행액 (할인 후, = prevUsageNet)
    prevUsageGross: 0,       // 지난달 추가요금 총액 (할인 전)
    prevUsageNet: 0,         // 지난달 추가요금 발행액 (할인 후)
    prevBillingsCount: 0,    // 지난달 발행 업체 수
    selectedCustomerId: null,
    filterText: '',
    loading: false,
    onlyOverage: localStorage.getItem(LS_ONLY_OVERAGE) !== 'false', // 기본값 true
    selectedIds: new Set(),  // 일괄 발송 선택 거래처 ID 집합
    collapsedPeriods: new Set(
      JSON.parse(localStorage.getItem(LS_COLLAPSED_PERIODS) || '[]')
    ),                       // 접힌 청구주기 그룹 ID ('1'|'3'|'6'|'12')
  };

  // ── 유틸 ────────────────────────────────────────────────────
  const $  = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const fmtKRW = (n) => {
    const v = Number(n || 0);
    return v.toLocaleString('ko-KR');
  };
  const todayYM = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  const escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );

  function toast(msg, kind = 'info') {
    const el = $('#rb-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.background = kind === 'error' ? '#dc2626' : (kind === 'ok' ? '#16a34a' : '#0f172a');
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function setStatusText(s) {
    const el = $('#rb-status');
    if (el) el.textContent = s || '';
  }

  // ── Supabase 클라이언트 ─────────────────────────────────────
  function sb() {
    if (!window.totalasAuth) {
      throw new Error('Supabase 클라이언트(auth.js) 미초기화');
    }
    return window.totalasAuth;
  }

  // ── override 조회 헬퍼 ─────────────────────────────────────
  // overrides 맵 키: `${customer_id}|${item_id}|${kind}|${field}`
  function ovKey(customerId, itemId, kind, field) {
    return `${customerId}|${itemId}|${kind}|${field}`;
  }

  // 해당 필드에 override가 있으면 override 값, 없으면 fallback 반환
  function getField(customerId, itemId, kind, field, fallback) {
    const row = state.overrides.get(ovKey(customerId, itemId, kind, field));
    return row != null ? Number(row.override_val) : fallback;
  }

  // ── 데이터 로드 ─────────────────────────────────────────────
  async function loadAll() {
    state.loading = true;
    setStatusText('데이터 로딩 중…');
    renderList();
    renderDetail();
    try {
      const ym = state.ym;
      const prevYm = prevMonth(ym);
      // 최대 12개월 합산 청구를 지원하기 위해 13개월(이번달 + 12개월 전)치 카운터 로드
      const ymList = ymRange(ym, 13);
      const client = sb();

      // rate 이력 로드: 합산 기간 범위 내 + 그 이전 최신 1건을 잡기 위해 전체 로드 후 클라이언트 필터
      // (자산 수가 적으므로 전체 로드가 실용적)
      const [
        rCust, rItems, rAssign, rCnt, rBill, rOv, rDisc, rRateHist,
      ] = await Promise.all([
        client.from('rental_customers')
          .select('id, company, biz_no, payment_type, invoice_day, address, phone, fax, mobile, email, active, bill_combined, billing_months, billing_started_at')
          .eq('active', true)
          .order('company', { ascending: true }),
        client.from('rental_items')
          .select('id, category, subtype, brand, model, status, counter_mode, total_free_count, total_unit_price')
          .neq('status', 'returned'),
        client.from('rental_assignments')
          .select('id, item_id, customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate, end_date'),
        client.from('rental_counters')
          .select('item_id, ym, bw, color, uptime_hours')
          .in('ym', ymList),
        client.from('rental_billings')
          .select('id, customer_id, ym, fixed_total, usage_total, total, items, status, issued_at, paid_at, notes, sent_via')
          .in('ym', [ym, prevYm]),
        // 이번 달 override 전체 로드
        client.from('rental_billing_overrides')
          .select('customer_id, ym, item_id, kind, field, original_val, override_val, memo')
          .eq('ym', ym),
        // 이번 달 카운터 오버 할인 로드 (테이블 없으면 무시)
        client.from('rental_counter_discounts')
          .select('customer_id, amount')
          .eq('ym', ym),
        // Phase 3: 자산별 rate 변경 이력 (테이블 없으면 무시)
        // total_free_count, total_unit_price 는 합계 모드용 — 컬럼 없는 환경엔 NULL 반환되어 graceful
        client.from('rental_item_rate_history')
          .select('id, item_id, effective_date, bw_free, co_free, bw_rate, co_rate, total_free_count, total_unit_price, note')
          .order('effective_date', { ascending: true }),
      ]);

      // 에러 체크 (할인/이력 테이블은 미생성 환경에서 건너뜀)
      for (const r of [rCust, rItems, rAssign, rCnt, rBill, rOv]) {
        if (r.error) throw r.error;
      }
      if (rDisc.error) {
        console.warn('[billing] rental_counter_discounts 로드 건너뜀:', rDisc.error.message);
      }
      if (rRateHist.error) {
        console.warn('[billing] rental_item_rate_history 로드 건너뜀:', rRateHist.error.message);
      }

      state.customers = rCust.data || [];
      state.items = new Map();
      (rItems.data || []).forEach((it) => state.items.set(it.id, it));

      // 활성 assignment 만 (end_date null or 미래)
      const todayStr = new Date().toISOString().slice(0, 10);
      state.assignments = (rAssign.data || []).filter((a) =>
        !a.end_date || a.end_date >= todayStr
      );

      // 13개월치 카운터를 (item_id|ym) → {bw, color} 맵으로 적재
      state.allCounters = new Map();
      state.counters = new Map();      // 이번달용 (호환)
      state.prevCounters = new Map();  // 직전월용 (호환)
      (rCnt.data || []).forEach((c) => {
        state.allCounters.set(`${c.item_id}|${c.ym}`, { bw: c.bw || 0, color: c.color || 0 });
        if (c.ym === ym) {
          state.counters.set(`${c.item_id}|${c.ym}`, {
            bw: c.bw || 0, color: c.color || 0, uptime_hours: c.uptime_hours || 0,
          });
        } else if (c.ym === prevYm) {
          state.prevCounters.set(c.item_id, { bw: c.bw || 0, color: c.color || 0 });
        }
      });

      state.billings = new Map();
      state.prevUsageGross = 0;
      state.prevUsageNet = 0;
      state.prevBillingsCount = 0;
      (rBill.data || []).forEach((b) => {
        if (b.ym === ym) {
          state.billings.set(b.customer_id, b);
        } else if (b.ym === prevYm) {
          const usage = b.usage_total || 0;
          // 발행 추가요금(할인 후) = 총청구액 − 고정료 (total 에 할인이 이미 반영됨)
          const net = Math.max(0, (b.total || 0) - (b.fixed_total || 0));
          const disc = Math.max(0, usage - net);
          if (usage > 0 || disc > 0) {
            state.prevUsageGross += usage;
            state.prevUsageNet += net;
            state.prevBillingsCount += 1;
          }
        }
      });
      state.prevBillingsTotal = state.prevUsageNet; // 호환: 발행액(할인 후)

      // override 시스템 비활성화 — rental_items 원본값만 사용 (카운터 모듈과 동일)
      // rental_billing_overrides 테이블/DB는 그대로 두되 코드 경로에서 적용 안 함
      state.overrides = new Map(); // 항상 빈 맵 유지

      // 카운터 오버 할인 맵 구성
      state.discounts = new Map();
      ((rDisc.error ? [] : rDisc.data) || []).forEach((row) => {
        if (row.amount > 0) state.discounts.set(row.customer_id, row.amount);
      });

      // Phase 3: rate 변경 이력 적재
      state.rateHistory = (rRateHist.error ? [] : rRateHist.data) || [];

      setStatusText(`거래처 ${state.customers.length}곳 · 자산 ${state.items.size}건 · 청구 ${state.billings.size}건`);
    } catch (e) {
      console.error('[billing] load error', e);
      toast('데이터 로드 실패: ' + (e.message || e), 'error');
      setStatusText('로드 실패');
    } finally {
      state.loading = false;
      // 첫 거래처 자동 선택: 선택된 거래처가 없거나 현재 거래처 목록에 없을 때
      if (!state.selectedCustomerId ||
          !state.customers.find((c) => c.id === state.selectedCustomerId)) {
        // 추가요금 발생 업체 중 첫 번째, 없으면 전체 첫 번째
        const firstOverage = state.customers.find((c) => {
          const calc = computeBilling(c.id);
          return (calc.usage_total - (calc.counter_discount || 0)) > 0;
        });
        const firstCustomer = firstOverage || state.customers[0];
        state.selectedCustomerId = firstCustomer ? firstCustomer.id : null;
      }
      renderAll();
    }
  }

  // ── Phase 3: rate 이력 유틸 ────────────────────────────────

  // 특정 자산 + 특정 사용월에 적용되는 rate 객체를 반환
  // effective_date <= 해당 월의 말일 기준으로 가장 최신 이력 1건 사용
  // 이력이 없으면 rental_assignments 기본값(split 모드) 또는 rental_items 값(total 모드) 사용
  // "변경 다음 달부터 적용" 동작: effective_date 를 다음 달 1일로 등록하면
  //   이전 달(말일 < effective_date)에는 이전 값 사용, 다음 달부터 새 값 사용
  function getRateAt(assignment, ym, item) {
    const history = state.rateHistory.filter((h) => h.item_id === assignment.item_id);
    if (!history.length) {
      return {
        bw_free: assignment.bw_free || 0,
        co_free: assignment.co_free || 0,
        bw_rate: assignment.bw_rate || 0,
        co_rate: assignment.co_rate || 0,
        // total 모드 fallback: rental_items 현재값
        total_free_count: item ? (item.total_free_count || 0) : 0,
        total_unit_price: item ? (item.total_unit_price || 0) : 0,
        _fromHistory: false,
      };
    }
    // 해당 월 말일 YYYY-MM-DD
    const [y, m] = ym.split('-').map(Number);
    const lastDayStr = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    // effective_date <= 말일 인 이력 중 가장 최신
    const applicable = history
      .filter((h) => h.effective_date <= lastDayStr)
      .sort((a, b) => b.effective_date.localeCompare(a.effective_date));
    if (!applicable.length) {
      // 이력 테이블에 해당 월 이전 이력 없음 → 기본값
      return {
        bw_free: assignment.bw_free || 0,
        co_free: assignment.co_free || 0,
        bw_rate: assignment.bw_rate || 0,
        co_rate: assignment.co_rate || 0,
        total_free_count: item ? (item.total_free_count || 0) : 0,
        total_unit_price: item ? (item.total_unit_price || 0) : 0,
        _fromHistory: false,
      };
    }
    const h = applicable[0];
    return {
      bw_free: h.bw_free != null ? h.bw_free : (assignment.bw_free || 0),
      co_free: h.co_free != null ? h.co_free : (assignment.co_free || 0),
      bw_rate: h.bw_rate != null ? h.bw_rate : (assignment.bw_rate || 0),
      co_rate: h.co_rate != null ? h.co_rate : (assignment.co_rate || 0),
      // total 모드 이력 컬럼 — NULL 이면 rental_items 현재값으로 fallback (graceful)
      total_free_count: h.total_free_count != null ? h.total_free_count : (item ? (item.total_free_count || 0) : 0),
      total_unit_price: h.total_unit_price != null ? h.total_unit_price : (item ? (item.total_unit_price || 0) : 0),
      _fromHistory: true,
      _historyId: h.id,
      _effectiveDate: h.effective_date,
    };
  }

  // 합산 기간(periodStart~periodEnd) 내 rate 변경 지점을 기준으로 구간 배열 반환
  // 반환: [ { startYm, endYm, rate, monthsCount }, ... ]  (변경 없으면 길이 1)
  // item: rental_items 행 (total 모드 fallback 용, 없으면 null)
  function splitPeriodByRateChanges(assignment, periodStart, periodEnd, item) {
    const history = state.rateHistory.filter((h) => h.item_id === assignment.item_id);

    // 합산 기간 내 모든 달 목록
    const months = [];
    let cur = periodStart;
    while (cur <= periodEnd) {
      months.push(cur);
      cur = ymPlus(cur, 1);
    }

    if (!months.length) return [];

    // 각 달의 rate 를 구해 연속된 동일 rate 구간으로 합침
    const segments = [];
    let segStart = months[0];
    let segRate   = getRateAt(assignment, months[0], item);

    const ratesEqual = (a, b) =>
      a.bw_free === b.bw_free &&
      a.co_free === b.co_free &&
      a.bw_rate === b.bw_rate &&
      a.co_rate === b.co_rate &&
      // total 모드 컬럼도 변경 감지 대상
      a.total_free_count === b.total_free_count &&
      a.total_unit_price === b.total_unit_price;

    for (let i = 1; i < months.length; i++) {
      const r = getRateAt(assignment, months[i], item);
      if (!ratesEqual(r, segRate)) {
        // 구간 마감
        segments.push({
          startYm: segStart,
          endYm:   months[i - 1],
          rate:    segRate,
          monthsCount: ymDiff(months[i - 1], segStart) + 1,
        });
        segStart = months[i];
        segRate  = r;
      }
    }
    // 마지막 구간
    segments.push({
      startYm: segStart,
      endYm:   months[months.length - 1],
      rate:    segRate,
      monthsCount: ymDiff(months[months.length - 1], segStart) + 1,
    });

    return segments;
  }

  // ── 빌링 계산 (한 거래처) ───────────────────────────────────
  // 반환: { fixed_total, usage_total, items: [...], billingPeriod }
  function computeBilling(customerId) {
    const ym = state.ym;
    const myAssigns = state.assignments.filter((a) => a.customer_id === customerId);
    const customer = state.customers.find((c) => c.id === customerId);
    const combined = !!customer?.bill_combined;
    const months   = Math.max(1, Number(customer?.billing_months) || 1);
    const startDate = getCustomerStartDate(customer);

    // Phase 2: computeBillingPeriod 로 합산 기간 재정의
    const billingPeriod = computeBillingPeriod(months, startDate, ym);
    // 실제 합산할 개월 수 (첫 청구 부분 기간이면 months 보다 작을 수 있음)
    const actualMonths = billingPeriod.monthsCount;
    // 합산 기간: periodStart ~ periodEnd (사용월)
    // 카운터 차이 = getCnt(periodEnd) - getCnt(직전월of periodStart)
    const startPrevYm = ymMinus(billingPeriod.periodStart, 1); // periodStart 직전월
    const getCnt = (iid, yym) => state.allCounters?.get(`${iid}|${yym}`) || { bw: 0, color: 0 };

    const fixedItems = [];
    const usageItems = [];
    const FIXED_CATS = ['IT', '위생', '출력', '기타'];

    // 고정비 — actualMonths 개월 × monthly_fee (Phase 2: 첫 청구 부분 기간 반영)
    for (const a of myAssigns) {
      const it = state.items.get(a.item_id);
      if (!it) continue;
      const cat = it.category;
      if (FIXED_CATS.includes(cat) && (a.monthly_fee || 0) > 0) {
        const unit = a.monthly_fee || 0;
        const subtotal = unit * actualMonths;
        fixedItems.push({
          item_id: a.item_id,
          kind: 'fixed',
          category: cat,
          subtype: it.subtype,
          label: `${cat}/${it.subtype}${it.model ? ' ' + it.model : ''}${actualMonths > 1 ? ` (${actualMonths}개월 × ₩${unit.toLocaleString()})` : ''}`,
          qty: actualMonths,
          unit_price: unit,
          subtotal,
          _rawSub: subtotal,
          _hasOverride: false,
        });
      }
    }

    // 출력 사용량 — 합산 모드 ↔ 자산별 모드
    // 카운터 기준: periodEnd(=billingPeriod.periodEnd)의 카운터 - periodStart 직전월 카운터
    const periodEndYm = billingPeriod.periodEnd; // 합산 기간 마지막 달

    const printAssigns = myAssigns
      .map((a) => ({ a, it: state.items.get(a.item_id) }))
      .filter((x) => x.it && x.it.category === '출력');

    if (combined && printAssigns.length >= 2) {
      // === 합산 모드 (Phase 3: rate 변경 이력 적용 / Phase 4: 카운터 통합 + 단가 가중 평균) ===
      // Phase 4 이슈 1 보정: 자산별 max를 제거하고 거래처 단위 합산 후 단일 max 적용
      //   → 한 자산이 음수(검침 오류/리셋)여도 다른 자산의 양수와 자연 상쇄됨
      // Phase 4 이슈 2 보정: 단가가 자산별로 다를 경우 bw_free 기준 가중 평균 단가 적용
      let curBwT = 0, curCoT = 0, prevBwT = 0, prevCoT = 0;
      let bwFreeT = 0, coFreeT = 0;
      const itemIds = [];
      const labels = [];
      let _hasRateChange = false;
      let _rateChangeSummary = null; // 대표 자산의 변경 요약

      // 가중 평균 단가 계산용 누적
      let bwRateWeightedSum = 0, coRateWeightedSum = 0;
      let bwFreeForWeight = 0, coFreeForWeight = 0;

      for (const { a, it } of printAssigns) {
        const cnt  = getCnt(a.item_id, periodEndYm);
        const prev = getCnt(a.item_id, startPrevYm);
        // Phase 4 이슈 1: 자산별 max 제거 — 원시값 그대로 누적 (음수 포함)
        curBwT  += cnt.bw    || 0; curCoT  += cnt.color || 0;
        prevBwT += prev.bw   || 0; prevCoT += prev.color || 0;
        itemIds.push(a.item_id);
        labels.push(`${it.subtype || ''}${it.model ? ' '+it.model : ''}`.trim());

        // Phase 3: 구간별 rate로 free/rate 집계 (item 전달 → total 모드 fallback 포함)
        const segs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
        for (const seg of segs) {
          bwFreeT += (seg.rate.bw_free || 0) * seg.monthsCount;
          coFreeT += (seg.rate.co_free || 0) * seg.monthsCount;
        }
        if (segs.length > 1) _hasRateChange = true;

        // Phase 4 이슈 2: 가중 평균 단가 — 마지막 구간(현재 적용) rate 기준, bw_free/co_free 가중
        if (segs.length) {
          const lastRate = segs[segs.length - 1].rate;
          const segBwFree = (lastRate.bw_free || 0) * segs[segs.length - 1].monthsCount;
          const segCoFree = (lastRate.co_free || 0) * segs[segs.length - 1].monthsCount;
          bwRateWeightedSum += (lastRate.bw_rate || 0) * segBwFree;
          coRateWeightedSum += (lastRate.co_rate || 0) * segCoFree;
          bwFreeForWeight   += segBwFree;
          coFreeForWeight   += segCoFree;
        }
      }

      // Phase 4 이슈 1: 거래처 통합 카운터로 단일 max 적용 (음수 차이 → 0)
      const periodBwT = Math.max(0, curBwT - prevBwT);
      const periodCoT = Math.max(0, curCoT - prevCoT);

      // Phase 4 이슈 2: 가중 평균 단가 (기본매수 0이면 단순 산술 평균으로 fallback)
      const bwRate = bwFreeForWeight > 0
        ? bwRateWeightedSum / bwFreeForWeight
        : (printAssigns.length > 0
            ? printAssigns.reduce((s, { a, it }) => {
                const segs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
                return s + (segs.length ? segs[segs.length-1].rate.bw_rate || 0 : 0);
              }, 0) / printAssigns.length
            : 0);
      const coRate = coFreeForWeight > 0
        ? coRateWeightedSum / coFreeForWeight
        : (printAssigns.length > 0
            ? printAssigns.reduce((s, { a, it }) => {
                const segs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
                return s + (segs.length ? segs[segs.length-1].rate.co_rate || 0 : 0);
              }, 0) / printAssigns.length
            : 0);

      // 단가가 자산별로 다른지 확인 (청구서 가중 평균 주석 표시용)
      const bwRates = printAssigns.map(({ a, it }) => {
        const segs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
        return segs.length ? (segs[segs.length-1].rate.bw_rate || 0) : 0;
      });
      const coRates = printAssigns.map(({ a, it }) => {
        const segs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
        return segs.length ? (segs[segs.length-1].rate.co_rate || 0) : 0;
      });
      const _bwRateUniform = bwRates.every((v) => v === bwRates[0]);
      const _coRateUniform = coRates.every((v) => v === coRates[0]);
      const _hasWeightedRate = !_bwRateUniform || !_coRateUniform;

      const exBw = Math.max(0, periodBwT - bwFreeT);
      const exCo = Math.max(0, periodCoT - coFreeT);
      const sub  = Math.round(exBw * bwRate + exCo * coRate);

      // rate 변경 요약 (대표: 첫 자산)
      if (_hasRateChange && printAssigns.length > 0) {
        const firstA = printAssigns[0].a;
        const firstIt = printAssigns[0].it;
        const segs = splitPeriodByRateChanges(firstA, billingPeriod.periodStart, billingPeriod.periodEnd, firstIt);
        if (segs.length > 1) {
          _rateChangeSummary = segs.map((s) =>
            `${s.startYm}~${s.endYm}: BW ${s.rate.bw_free}매/${s.rate.bw_rate}원 CO ${s.rate.co_free}매/${s.rate.co_rate}원`
          ).join(' | ');
        }
      }

      if (sub > 0 || _hasRateChange) {
        const tag = actualMonths > 1
          ? ` · ${billingPeriod.periodStart}~${billingPeriod.periodEnd} (${actualMonths}개월)` : '';
        usageItems.push({
          item_id: itemIds.join(','),
          kind: 'usage',
          category: '출력',
          subtype: 'combined',
          label: `출력 합산 (${printAssigns.length}대: ${labels.filter(Boolean).join(' + ')}) 초과사용${tag}`,
          bw: exBw,
          co: exCo,
          month_bw: periodBwT,
          month_co: periodCoT,
          bw_rate: bwRate,
          co_rate: coRate,
          counter_bw_prev: prevBwT,
          counter_color_prev: prevCoT,
          counter_bw: curBwT,
          counter_color: curCoT,
          bw_free: bwFreeT,
          co_free: coFreeT,
          subtotal: sub,
          combined: true,
          billing_months: actualMonths,
          period_start: billingPeriod.periodStart,
          period_end: billingPeriod.periodEnd,
          _hasRateChange,
          _rateChangeSummary,
          _hasWeightedRate,       // Phase 4: 가중 평균 단가 적용 여부
          _bwRateDisplay: _hasWeightedRate ? bwRate : null,  // 소수점 포함 가중 평균
          _coRateDisplay: _hasWeightedRate ? coRate : null,
          _assetCount: printAssigns.length,
          _rawSub: sub,
          _rawBwRate: bwRate,
          _rawCoRate: coRate,
          _rawBwFree: bwFreeT,
          _rawCoFree: coFreeT,
          _hasOverride: false,
        });
      }
    } else {
      // === 자산별 모드 (Phase 3: rate 변경 이력 적용) ===
      for (const { a, it } of printAssigns) {
        const cnt  = getCnt(a.item_id, periodEndYm);
        const prev = getCnt(a.item_id, startPrevYm);
        const periodBw = Math.max(0, (cnt.bw    || 0) - (prev.bw    || 0));
        const periodCo = Math.max(0, (cnt.color || 0) - (prev.color || 0));

        // ── total 모드 분기 (counter_mode === 'total') ─────────────
        // Phase 3+: rate 변경 이력을 구간별로 적용 (total_free_count, total_unit_price)
        // — splitPeriodByRateChanges 에 item 전달 → getRateAt 이 이력 없으면 rental_items 현재값으로 fallback
        if (it.counter_mode === 'total') {
          const totalSegs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
          const hasTotalRateChange = totalSegs.length > 1;

          // 전월/당월 원시 카운터 (검산용)
          const prevBwRaw  = prev.bw    || 0;
          const prevCoRaw  = prev.color || 0;
          const curBwRaw   = cnt.bw     || 0;
          const curCoRaw   = cnt.color  || 0;
          const prev_total = prevBwRaw + prevCoRaw; // 기간 시작 카운터 합계
          const cur_total  = curBwRaw  + curCoRaw;  // 기간 종료 카운터 합계
          const periodTotal = periodBw + periodCo;   // 흑백+컬러 합산 사용량

          // 구간별 초과료 합산 (구간이 1개면 단일 계산, 여러 구간이면 사용량 안분)
          let subTotal = 0;
          let totalFreeAccum = 0; // 청구서 표시용 누적 기본매수
          const totalSegDetails = [];
          for (const seg of totalSegs) {
            const segTotalFree = (seg.rate.total_free_count || 0) * seg.monthsCount;
            const segUnitPrice = seg.rate.total_unit_price || 0;
            totalFreeAccum += segTotalFree;
            // 구간별 사용량 안분 (월별 카운터 없으므로 비율 안분)
            const ratio = actualMonths > 0 ? seg.monthsCount / actualMonths : 1;
            const segTotal = Math.round(periodTotal * ratio);
            const segEx    = Math.max(0, segTotal - segTotalFree);
            const segFee   = Math.round(segEx * segUnitPrice);
            subTotal += segFee;
            totalSegDetails.push({
              startYm: seg.startYm,
              endYm: seg.endYm,
              monthsCount: seg.monthsCount,
              total_free_count: seg.rate.total_free_count || 0,
              total_unit_price: segUnitPrice,
              total_free: segTotalFree,
              total_used: segTotal,
              total_extra: segEx,
              fee: segFee,
            });
          }

          // 단일 구간이면 반올림 오차 없는 단순 계산으로 덮어씀
          if (!hasTotalRateChange && totalSegs.length === 1) {
            const r = totalSegs[0].rate;
            const totalFree = (r.total_free_count || 0) * actualMonths;
            const exTotal   = Math.max(0, periodTotal - totalFree);
            subTotal = Math.round(exTotal * (r.total_unit_price || 0));
            totalFreeAccum = totalFree;
          }

          if (subTotal > 0 || hasTotalRateChange) {
            const tag = actualMonths > 1
              ? ` · ${billingPeriod.periodStart}~${billingPeriod.periodEnd} (${actualMonths}개월)` : '';
            // 대표 단가: 마지막 구간
            const lastTotalSeg = totalSegs[totalSegs.length - 1];
            usageItems.push({
              item_id: a.item_id,
              kind: 'usage',
              category: '출력',
              subtype: it.subtype,
              label: `${it.subtype}${it.model ? ' ' + it.model : ''} 초과사용${tag}`,
              counter_mode: 'total',
              // 합계 모드 전용 필드
              total_free: totalFreeAccum,
              total_unit_price: lastTotalSeg.rate.total_unit_price || 0,
              total_used: periodTotal,
              total_extra: Math.max(0, periodTotal - totalFreeAccum),
              // 전월/당월 카운터 합계 (검산용 — 기간 시작/종료 카운터)
              prev_total,
              cur_total,
              // 개별 카운터 (PDF 표시용 참고값)
              month_bw: periodBw,
              month_co: periodCo,
              counter_bw_prev: prevBwRaw,
              counter_color_prev: prevCoRaw,
              counter_bw: curBwRaw,
              counter_color: curCoRaw,
              subtotal: subTotal,
              billing_months: actualMonths,
              period_start: billingPeriod.periodStart,
              period_end:   billingPeriod.periodEnd,
              // Phase 3+: 구간 변경 이력 정보
              _hasRateChange: hasTotalRateChange,
              _totalSegDetails: hasTotalRateChange ? totalSegDetails : null,
              _rawSub: subTotal,
              _hasOverride: false,
            });
          }
          continue; // split 모드 처리 건너뜀
        }

        // ── split 모드 (기존 로직, Phase 3: rate 변경 이력 적용) ───
        // Phase 3: 구간 분할 — rate 변경이 있으면 여러 구간으로 분리
        const segs = splitPeriodByRateChanges(a, billingPeriod.periodStart, billingPeriod.periodEnd, it);
        const hasRateChange = segs.length > 1;

        // 구간별 bw_free/co_free 합산 (월별 무료할당량 × 구간 개월 수)
        let freeBwTotal = 0, freeCoTotal = 0;
        for (const seg of segs) {
          freeBwTotal += (seg.rate.bw_free || 0) * seg.monthsCount;
          freeCoTotal += (seg.rate.co_free || 0) * seg.monthsCount;
        }

        // 구간별 초과료 합산
        // 카운터 전체 차이를 구간 비율로 안분 (월별 카운터가 없는 경우 최선)
        // 구간별로 월 카운터 데이터가 있으면 더 정확하게 계산
        let subTotal = 0;
        const segDetails = segs.map((seg) => {
          // 구간 개월 수 / 전체 개월 수 비율로 사용량 안분
          const ratio = actualMonths > 0 ? seg.monthsCount / actualMonths : 1;
          const segBw = Math.round(periodBw * ratio);
          const segCo = Math.round(periodCo * ratio);
          const segBwFree = (seg.rate.bw_free || 0) * seg.monthsCount;
          const segCoFree = (seg.rate.co_free || 0) * seg.monthsCount;
          const segExBw = Math.max(0, segBw - segBwFree);
          const segExCo = Math.max(0, segCo - segCoFree);
          const segFee  = segExBw * (seg.rate.bw_rate || 0) + segExCo * (seg.rate.co_rate || 0);
          subTotal += segFee;
          return {
            startYm: seg.startYm,
            endYm:   seg.endYm,
            monthsCount: seg.monthsCount,
            rate:    seg.rate,
            month_bw: segBw,
            month_co: segCo,
            bw_free:  segBwFree,
            co_free:  segCoFree,
            ex_bw:    segExBw,
            ex_co:    segExCo,
            fee:      segFee,
          };
        });

        // 단일 구간(변경 없음)이면 기존 방식으로 계산 (반올림 오차 방지)
        // 이력 적용된 단가를 사용 (이력 없으면 assignment 기본값과 동일)
        if (!hasRateChange) {
          const r = segs[0].rate;
          const bwRate = r.bw_rate || 0;
          const coRate = r.co_rate || 0;
          const exBw = Math.max(0, periodBw - freeBwTotal);
          const exCo = Math.max(0, periodCo - freeCoTotal);
          subTotal = exBw * bwRate + exCo * coRate;
        }

        if (subTotal > 0 || hasRateChange) {
          const tag = actualMonths > 1
            ? ` · ${billingPeriod.periodStart}~${billingPeriod.periodEnd} (${actualMonths}개월)` : '';
          // 마지막 구간의 rate를 대표값으로 사용 (청구서 단일 행 표시용)
          const lastSeg = segs[segs.length - 1];
          usageItems.push({
            item_id: a.item_id,
            kind: 'usage',
            category: '출력',
            subtype: it.subtype,
            label: `${it.subtype}${it.model ? ' ' + it.model : ''} 초과사용${tag}`,
            bw: Math.max(0, periodBw - freeBwTotal),
            co: Math.max(0, periodCo - freeCoTotal),
            month_bw: periodBw,
            month_co: periodCo,
            bw_rate:  lastSeg.rate.bw_rate || 0,
            co_rate:  lastSeg.rate.co_rate || 0,
            counter_bw_prev: prev.bw || 0,
            counter_color_prev: prev.color || 0,
            counter_bw: cnt.bw || 0,
            counter_color: cnt.color || 0,
            bw_free:  freeBwTotal,
            co_free:  freeCoTotal,
            subtotal: subTotal,
            billing_months: actualMonths,
            period_start: billingPeriod.periodStart,
            period_end:   billingPeriod.periodEnd,
            // Phase 3: rate 변경 구간 상세
            _hasRateChange: hasRateChange,
            _rateSegments: hasRateChange ? segDetails : null,
            _rawSub: subTotal,
            _rawBwRate: lastSeg.rate.bw_rate || 0,
            _rawCoRate: lastSeg.rate.co_rate || 0,
            _rawBwFree: freeBwTotal,
            _rawCoFree: freeCoTotal,
            _hasOverride: false,
          });
        }
      }
    }

    const fixed_total = fixedItems.reduce((s, x) => s + x.subtotal, 0);
    const usage_total = usageItems.reduce((s, x) => s + x.subtotal, 0);
    const counter_discount = state.discounts?.get(customerId) || 0;
    const total = Math.max(0, fixed_total + usage_total - counter_discount);
    return {
      fixed_total,
      usage_total,
      counter_discount,
      total,
      items: [...fixedItems, ...usageItems],
      combined,
      billing_months: actualMonths,
      period_label: actualMonths > 1
        ? `${billingPeriod.periodStart}~${billingPeriod.periodEnd} (${actualMonths}개월 합산)`
        : billingPeriod.periodEnd,
      billingPeriod,
    };
  }

  // ── 상단 stat-card ──────────────────────────────────────────
  function renderStats() {
    const wrap = $('#rb-stats');
    if (!wrap) return;

    // 통계: 청구 사유(오버카운터 발생 OR 할인 적용)가 있는 업체 기준 집계
    // = renderList 의 hasUsage 와 동일 조건 (할인만 있어도 포함)
    // 발행총액은 고정료를 제외한 추가요금부 기준으로 합산 (카운터 모듈의 「최종청구액」 합과 일치)
    let issued = 0, billedSum = 0, thisGross = 0;
    for (const c of state.customers) {
      const b = state.billings.get(c.id);
      const discount = state.discounts.get(c.id) || 0;
      let usageTotal = 0;
      if (b) {
        usageTotal = b.usage_total || 0;
      } else {
        const calc = computeBilling(c.id);
        usageTotal = calc.usage_total || 0;
      }
      const usageNet = usageTotal - discount;
      // 청구 사유 판별: 오버카운터(usage_total > 0) OR 할인 적용(discount > 0)
      const hasBillReason = usageTotal > 0 || discount > 0;
      if (!hasBillReason) continue;
      issued += 1;
      thisGross += usageTotal;            // 추가요금 총액 (할인 전)
      // 발행총액: 순 추가요금 (음수이면 0으로 처리)
      billedSum += Math.max(0, usageNet);
    }
    const thisDisc = Math.max(0, thisGross - billedSum);   // 이번달 할인금액 (= 총액 − 발행액)
    const prevGross = state.prevUsageGross || 0;
    const prevNet = state.prevUsageNet || 0;
    const prevDisc = Math.max(0, prevGross - prevNet);     // 지난달 할인금액
    const prevCount = state.prevBillingsCount || 0;
    // 청구월 기준 표시: state.ym = 데이터월, billingYm = 청구월
    const billingYm = nextMonth(state.ym);
    const prevBillingYm = state.ym; // 지난 청구월 = 이번 데이터월 = state.ym

    // 청구 주기 분포 집계
    const periodDist = { 1: 0, 3: 0, 6: 0, 12: 0 };
    for (const c of state.customers) {
      const m = Math.max(1, Number(c.billing_months) || 1);
      const key = [1, 3, 6, 12].includes(m) ? m : 1;
      periodDist[key] = (periodDist[key] || 0) + 1;
    }
    const periodDistItems = [
      { key: 1, label: '월별' },
      { key: 3, label: '3개월' },
      { key: 6, label: '6개월' },
      { key: 12, label: '1년' },
    ]
      .filter((p) => periodDist[p.key] > 0)
      .map((p) => `${p.label} <b>${periodDist[p.key]}</b>곳`)
      .join(' &middot; ');

    wrap.innerHTML = `
      <div class="stat-card">
        <div class="stat-label">청구 대상 업체</div>
        <div class="stat-value primary">${issued}<span class="unit">곳</span></div>
        <div class="stat-sub muted">${billingYm} 청구 (오버/할인 포함)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">지난달 추가요금</div>
        <div style="display:flex;flex-direction:column;gap:3px;margin:6px 0;font-size:13px;">
          <div style="display:flex;justify-content:space-between;"><span class="muted">총금액</span><b>₩${fmtKRW(prevGross)}</b></div>
          <div style="display:flex;justify-content:space-between;color:#dc2626;"><span>할인금액</span><b>−₩${fmtKRW(prevDisc)}</b></div>
          <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;border-top:1px solid #eee;padding-top:3px;"><span>발행금액</span><span>₩${fmtKRW(prevNet)}</span></div>
        </div>
        <div class="stat-sub muted">${prevBillingYm} 청구 · ${prevCount}곳</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">이번달 추가요금</div>
        <div style="display:flex;flex-direction:column;gap:3px;margin:6px 0;font-size:13px;">
          <div style="display:flex;justify-content:space-between;"><span class="muted">총금액</span><b>₩${fmtKRW(thisGross)}</b></div>
          <div style="display:flex;justify-content:space-between;color:#dc2626;"><span>할인금액</span><b>−₩${fmtKRW(thisDisc)}</b></div>
          <div style="display:flex;justify-content:space-between;font-size:15px;font-weight:700;color:#1e3a8a;border-top:1px solid #eee;padding-top:3px;"><span>발행금액</span><span>₩${fmtKRW(billedSum)}</span></div>
        </div>
        <div class="stat-sub muted">${billingYm} 청구 · ${issued}곳</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">청구 주기 분포</div>
        <div class="stat-value" style="font-size:13px; line-height:1.6;">${periodDistItems || '—'}</div>
        <div class="stat-sub muted">활성 거래처 ${state.customers.length}곳</div>
      </div>
    `;
  }

  // ── 일괄 발송 버튼 카운트 갱신 ────────────────────────────
  function updateBulkSendBtn() {
    const btn = document.getElementById('rb-bulk-send');
    if (!btn) return;
    // sent/void 상태가 아닌 선택 항목만 유효 카운트
    let count = 0;
    for (const cid of state.selectedIds) {
      const b = state.billings.get(cid);
      if (b && (b.status === 'sent' || b.status === 'void')) continue;
      count += 1;
    }
    btn.textContent = `선택 항목 일괄 발송 (${count}개)`;
    btn.disabled = count === 0;
  }

  // ── 청구 주기 레이블 헬퍼 ────────────────────────────────────
  function periodKeyLabel(key) {
    return key === 1 ? '월별' : key === 3 ? '3개월' : key === 6 ? '6개월' : key === 12 ? '1년' : `${key}개월`;
  }

  // ── 더블클릭: 임대카운터의 "카운터오버" 드릴다운으로 이동 (추가요금 할인 입력용) ──
  // 1) localStorage 'rc.intent' 에 거래처 id 와 timestamp 를 저장
  //    → 임대카운터 init 단계에서 10초 이내면 소비하여 자동으로 드릴다운 + 행 강조
  // 2) iframe 임베드 환경(asms.html)이면 사이드바 링크를 클릭하여 부모 프레임을 전환
  //    아니면 상대 경로로 직접 이동
  function openInCounterOverage(customerId) {
    if (!customerId) return;
    try {
      localStorage.setItem('rc.intent', JSON.stringify({ cid: customerId, ts: Date.now() }));
    } catch {}
    try {
      if (window.parent && window.parent !== window) {
        const link = window.parent.document.querySelector('a[href="rental-counters/index.html"]');
        if (link) { link.click(); return; }
      }
    } catch {} // cross-origin 등 — 폴백 진행
    // 폴백: 현재 창에서 이동
    location.href = '../rental-counters/index.html';
  }

  // ── 좌측 거래처 리스트 (청구 주기별 상위 그룹 + 추가요금 발생 하위 그룹) ──
  function renderList() {
    const ul = $('#rb-list');
    if (!ul) return;

    if (state.loading) {
      ul.innerHTML = '<li class="rb-list-empty">로딩 중…</li>';
      return;
    }
    const q = (state.filterText || '').trim().toLowerCase();
    let custs = state.customers;
    if (q) {
      custs = custs.filter((c) =>
        (c.company || '').toLowerCase().includes(q) ||
        (c.biz_no || '').toLowerCase().includes(q)
      );
    }

    // 청구 사유 여부 판별 — 다음 세 조건 중 하나라도 만족하면 true
    // 1) 순 추가요금 > 0 (카운터 오버 발생)
    // 2) 할인 적용 업체 (discount > 0) — 카운터 오버가 할인으로 상쇄된 경우도 포함
    // 3) computeBilling 결과상 bw_charge 또는 co_charge 가 양수 (DB 저장 전 계산 단계)
    const hasUsage = (c) => {
      // 조건 2: 할인 적용 여부 — discount가 있으면 항상 표시
      if ((state.discounts.get(c.id) || 0) > 0) return true;

      const b = state.billings.get(c.id);
      if (b) {
        // 조건 1: DB에 저장된 청구행 기준 순 추가요금
        const usageNet = (b.usage_total || 0) - (state.discounts.get(c.id) || 0);
        if (usageNet > 0) return true;
        // 조건 3: DB 저장 후에도 usage_total 자체가 양수이면 오버카운터 발생으로 간주
        if ((b.usage_total || 0) > 0) return true;
        return false;
      }
      // DB 미저장(미발행) 상태: computeBilling 결과로 판별
      const calc = computeBilling(c.id);
      // 조건 1: 순 추가요금
      if ((calc.usage_total - (calc.counter_discount || 0)) > 0) return true;
      // 조건 3: usage_total 자체 양수 — 할인으로 0 또는 음수가 된 경우도 오버카운터 발생으로 표시
      if ((calc.usage_total || 0) > 0) return true;
      return false;
    };

    // billing_months 폴백 (null → 1)
    const getBillingMonths = (c) => {
      const m = Number(c.billing_months) || 1;
      return [1, 3, 6, 12].includes(m) ? m : 1;
    };

    // Phase 2: 거래처별 청구 기간 판정
    const getBillingPeriodInfo = (c) => {
      const bm = getBillingMonths(c);
      const sd = getCustomerStartDate(c);
      return computeBillingPeriod(bm, sd, state.ym);
    };

    // 이번 달이 청구월인지 여부
    const isCurrentBillingMonth = (c) => getBillingPeriodInfo(c).isBillingMonth;

    // "발생 업체만" 필터 적용
    const totalCount = custs.length;
    const overageCount = custs.filter(hasUsage).length;

    // 필터 카운트 표기 갱신
    const filterCountEl = document.getElementById('rb-filter-count');
    if (filterCountEl) {
      if (state.onlyOverage) {
        filterCountEl.textContent = `청구 사유 업체만 표시 (${overageCount}개) — 전체 ${totalCount}개 중`;
      } else {
        filterCountEl.textContent = `전체 ${totalCount}개 · 청구 사유 업체 ${overageCount}개`;
      }
    }

    if (!custs.length) {
      ul.innerHTML = `<li class="rb-list-empty">${state.onlyOverage ? '청구 사유 업체가 없습니다.' : '검색 결과 없음'}</li>`;
      return;
    }

    // 체크 가능 여부 — sent/void 상태 또는 청구월이 아닌 거래처는 disabled
    const isCheckable = (c) => {
      const b = state.billings.get(c.id);
      if (b && (b.status === 'sent' || b.status === 'void')) return false;
      // 청구월이 아닌 거래처는 일괄 발송 대상에서 제외
      if (!isCurrentBillingMonth(c)) return false;
      return true;
    };

    const makeItem = (c, highlight, showCb) => {
      const b = state.billings.get(c.id);
      const bpInfo = getBillingPeriodInfo(c);
      const isBillMonth = bpInfo.isBillingMonth;
      let total = b ? (b.total || 0) : 0;
      let statusBadge = '';
      if (b) {
        statusBadge = `<span class="badge status-${b.status}">${labelStatus(b.status)}</span>`;
      } else {
        const calc = computeBilling(c.id);
        total = calc.total;
        const usageNet = (calc.usage_total || 0) - (calc.counter_discount || 0);
        if (usageNet > 0) {
          statusBadge = `<span class="badge" style="background:#fef3c7;color:#b45309;">미발행</span>`;
        } else {
          statusBadge = `<span class="badge" style="background:#f1f5f9;color:#64748b;">추가요금없음</span>`;
        }
      }
      // Phase 2: 청구월이 아닌 거래처에 다음 청구 라벨 표시
      const nextBillLabel = !isBillMonth
        ? `<span class="rb-next-bill-label" style="font-size:10px;color:#64748b;display:block;margin-top:2px;">다음 청구: ${bpInfo.nextBillingYm} (${bpInfo.monthsCount}개월 합산)</span>`
        : '';
      const sel = state.selectedCustomerId === c.id ? ' selected' : '';
      const checked = state.selectedIds.has(c.id) ? ' checked' : '';
      const disabled = !isCheckable(c) ? ' disabled' : '';
      const cbHtml = showCb
        ? `<input type="checkbox" class="rb-item-cb"${checked}${disabled}
             data-customer-id="${escapeHtml(c.id)}"
             title="${isCheckable(c) ? '일괄 발송에 포함' : (!isBillMonth ? '이번 달 청구월 아님' : '이미 발송/취소된 건')}">`
        : '';
      // 청구월 아닌 거래처는 흐림 처리
      const dimStyle = !isBillMonth ? 'opacity:0.5;' : '';
      const borderStyle = highlight ? 'border-left:3px solid var(--primary); padding-left:9px;' : '';
      const gridStyle = showCb
        ? `style="grid-template-columns: 20px 1fr auto; ${borderStyle}${dimStyle}"`
        : (highlight ? `style="${borderStyle}${dimStyle}"` : (dimStyle ? `style="${dimStyle}"` : ''));
      return `
        <li class="rb-item${sel}" ${gridStyle} data-customer-id="${escapeHtml(c.id)}">
          ${cbHtml}
          <div>
            <div class="rb-item-name">${escapeHtml(c.company || '(이름없음)')}</div>
            <div class="rb-item-meta">
              ${statusBadge}
              <span>${escapeHtml(c.invoice_day || '-')}</span>
              <span>${escapeHtml(c.payment_type || '')}</span>
            </div>
            ${nextBillLabel}
          </div>
          <div class="rb-item-total">₩${fmtKRW(total)}</div>
        </li>
      `;
    };

    // ── 청구 주기별로 분류 ──
    // groupA: 추가요금 발생 + 청구월 O
    // groupB: 추가요금 없음 또는 청구월 아님
    const PERIOD_KEYS = [1, 3, 6, 12];
    // periodMap: key → { groupA: [], groupB: [] }
    const periodMap = {};
    PERIOD_KEYS.forEach((k) => { periodMap[k] = { groupA: [], groupB: [] }; });

    for (const c of custs) {
      const pm = getBillingMonths(c);
      if (!periodMap[pm]) periodMap[pm] = { groupA: [], groupB: [] };
      // groupA 조건: 청구 사유(오버카운터 발생 OR 할인 적용) 가 있는 업체
      // isBillMonth 조건 제거 — 청구월이 아니더라도 사유 있으면 groupA 표시
      if (hasUsage(c)) {
        periodMap[pm].groupA.push(c);
      } else {
        periodMap[pm].groupB.push(c);
      }
    }

    // 각 주기별 전체 체크 가능한 groupA 목록 (상위 그룹 체크박스용)
    const periodCheckable = {};
    PERIOD_KEYS.forEach((k) => {
      periodCheckable[k] = (periodMap[k]?.groupA || []).filter(isCheckable);
    });

    let html = '';
    let hasAnyContent = false;

    for (const pk of PERIOD_KEYS) {
      const { groupA, groupB } = periodMap[pk];
      // onlyOverage=true 면 groupA 가 없는 주기는 숨김
      const visibleGroupA = groupA;
      const visibleGroupB = state.onlyOverage ? [] : groupB;
      const totalInPeriod = visibleGroupA.length + visibleGroupB.length;
      if (totalInPeriod === 0) continue;

      hasAnyContent = true;
      const pkStr = String(pk);
      const isCollapsed = state.collapsedPeriods.has(pkStr);
      const toggleIcon = isCollapsed ? '[+]' : '[-]';

      // 상위 그룹 체크박스 상태
      const checkableInPeriod = periodCheckable[pk];
      const allPeriodChecked = checkableInPeriod.length > 0 &&
        checkableInPeriod.every((c) => state.selectedIds.has(c.id));
      const somePeriodChecked = checkableInPeriod.some((c) => state.selectedIds.has(c.id));
      const periodCbHtml = checkableInPeriod.length > 0
        ? `<input type="checkbox" class="rb-period-cb" data-period="${pkStr}"
             ${allPeriodChecked ? 'checked' : ''}
             title="${periodKeyLabel(pk)} 주기 전체 선택/해제">`
        : '';

      html += `
        <li class="rb-period-header" data-period="${pkStr}">
          ${periodCbHtml}
          ${periodKeyLabel(pk)}
          <span class="rb-period-badge">${totalInPeriod}곳</span>
          <span class="rb-period-toggle">${toggleIcon}</span>
        </li>
        <li class="rb-period-items-wrap${isCollapsed ? ' rb-period-collapsed' : ''}" data-period-wrap="${pkStr}"
          style="${isCollapsed ? 'display:none;' : ''}">
          <ul style="list-style:none;margin:0;padding:0;">
      `;

      // 하위 그룹 A: 추가요금 발생
      if (visibleGroupA.length) {
        const checkableA = visibleGroupA.filter(isCheckable);
        const allAChecked = checkableA.length > 0 && checkableA.every((c) => state.selectedIds.has(c.id));
        const someAChecked = checkableA.some((c) => state.selectedIds.has(c.id));
        const cbGroupAHtml = checkableA.length > 0
          ? `<input type="checkbox" class="rb-group-cb" data-group="A-${pkStr}"
               ${allAChecked ? 'checked' : ''}
               title="추가요금 발생 그룹 전체 선택/해제">`
          : '';
        html += `<li class="rb-sub-group-header" style="color:var(--primary);">
          ${cbGroupAHtml}추가요금 발생 <span style="font-size:10px;color:var(--muted);">(${visibleGroupA.length}곳)</span></li>`;
        html += visibleGroupA.map((c) => makeItem(c, true, true)).join('');
      }

      // 하위 그룹 B: 추가요금 없음 (onlyOverage=false 일 때만 표시)
      if (visibleGroupB.length) {
        html += `<li class="rb-sub-group-header" style="color:var(--muted); pointer-events:none;">
          추가요금 없음 <span style="font-size:10px;">(${visibleGroupB.length}곳)</span></li>`;
        html += visibleGroupB.map((c) => makeItem(c, false, false)).join('');
      }

      html += `</ul></li>`;
    }

    if (!hasAnyContent) {
      ul.innerHTML = `<li class="rb-list-empty">${state.onlyOverage ? '청구 사유 업체가 없습니다.' : '검색 결과 없음'}</li>`;
      return;
    }

    ul.innerHTML = html;

    // ── 주기 그룹 헤더 체크박스 indeterminate 설정 ──
    ul.querySelectorAll('.rb-period-cb').forEach((cb) => {
      const pk = Number(cb.dataset.period);
      const checkableInPeriod = periodCheckable[pk] || [];
      const allC = checkableInPeriod.length > 0 && checkableInPeriod.every((c) => state.selectedIds.has(c.id));
      const someC = checkableInPeriod.some((c) => state.selectedIds.has(c.id));
      cb.indeterminate = someC && !allC;
    });

    // ── 하위 그룹 A 체크박스 indeterminate 설정 ──
    ul.querySelectorAll('.rb-group-cb').forEach((cb) => {
      const groupKey = cb.dataset.group; // 'A-1', 'A-3', ...
      const pk = Number(groupKey.split('-')[1]);
      const checkableA = (periodMap[pk]?.groupA || []).filter(isCheckable);
      const allA = checkableA.length > 0 && checkableA.every((c) => state.selectedIds.has(c.id));
      const someA = checkableA.some((c) => state.selectedIds.has(c.id));
      cb.indeterminate = someA && !allA;
    });

    // ── 주기 그룹 헤더 클릭 — 펼침/접기 ──
    ul.querySelectorAll('.rb-period-header').forEach((hdr) => {
      hdr.addEventListener('click', (e) => {
        // 체크박스 클릭은 무시
        if (e.target.classList.contains('rb-period-cb')) return;
        const pk = hdr.dataset.period;
        const wrap = ul.querySelector(`[data-period-wrap="${pk}"]`);
        if (!wrap) return;
        if (state.collapsedPeriods.has(pk)) {
          state.collapsedPeriods.delete(pk);
          wrap.style.display = '';
        } else {
          state.collapsedPeriods.add(pk);
          wrap.style.display = 'none';
        }
        // toggle 아이콘 갱신
        const toggleEl = hdr.querySelector('.rb-period-toggle');
        if (toggleEl) toggleEl.textContent = state.collapsedPeriods.has(pk) ? '[+]' : '[-]';
        // localStorage 저장
        localStorage.setItem(LS_COLLAPSED_PERIODS, JSON.stringify([...state.collapsedPeriods]));
      });
    });

    // ── 주기 그룹 헤더 체크박스 ──
    ul.querySelectorAll('.rb-period-cb').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const pk = Number(cb.dataset.period);
        const checkableInPeriod = periodCheckable[pk] || [];
        if (cb.checked) {
          checkableInPeriod.forEach((c) => state.selectedIds.add(c.id));
        } else {
          checkableInPeriod.forEach((c) => state.selectedIds.delete(c.id));
        }
        // 개별/하위 그룹 체크박스 동기화
        _syncCheckboxState(ul, periodMap, periodCheckable, isCheckable);
        updateBulkSendBtn();
      });
    });

    // ── 하위 그룹 A 체크박스 ──
    ul.querySelectorAll('.rb-group-cb').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const groupKey = cb.dataset.group;
        const pk = Number(groupKey.split('-')[1]);
        const checkableA = (periodMap[pk]?.groupA || []).filter(isCheckable);
        if (cb.checked) {
          checkableA.forEach((c) => state.selectedIds.add(c.id));
        } else {
          checkableA.forEach((c) => state.selectedIds.delete(c.id));
        }
        _syncCheckboxState(ul, periodMap, periodCheckable, isCheckable);
        updateBulkSendBtn();
      });
    });

    // ── 거래처 행 클릭 / 더블클릭 (임대카운터 카운터오버로 이동) ──
    ul.querySelectorAll('.rb-item').forEach((li) => {
      li.title = (li.title ? li.title + ' · ' : '') + '더블클릭: 임대카운터 카운터오버로 이동하여 추가요금 할인 입력';
      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('rb-item-cb')) return;
        state.selectedCustomerId = li.dataset.customerId;
        renderList();
        renderDetail();
      });
      li.addEventListener('dblclick', (e) => {
        if (e.target.classList.contains('rb-item-cb')) return;
        e.preventDefault();
        try { window.getSelection?.().removeAllRanges(); } catch {}
        openInCounterOverage(li.dataset.customerId);
      });
    });

    // ── 개별 체크박스 ──
    ul.querySelectorAll('.rb-item-cb').forEach((cb) => {
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        const cid = cb.dataset.customerId;
        if (cb.checked) {
          state.selectedIds.add(cid);
        } else {
          state.selectedIds.delete(cid);
        }
        _syncCheckboxState(ul, periodMap, periodCheckable, isCheckable);
        updateBulkSendBtn();
      });
    });

    updateBulkSendBtn();
  }

  // ── 체크박스 상태 일괄 동기화 헬퍼 ────────────────────────
  function _syncCheckboxState(ul, periodMap, periodCheckable, isCheckable) {
    const PERIOD_KEYS = [1, 3, 6, 12];

    // 개별 체크박스 동기화
    ul.querySelectorAll('.rb-item-cb').forEach((cb) => {
      if (!cb.disabled) cb.checked = state.selectedIds.has(cb.dataset.customerId);
    });

    // 하위 그룹 A 체크박스 동기화
    ul.querySelectorAll('.rb-group-cb').forEach((cb) => {
      const pk = Number(cb.dataset.group.split('-')[1]);
      const checkableA = (periodMap[pk]?.groupA || []).filter(isCheckable);
      const allA = checkableA.length > 0 && checkableA.every((c) => state.selectedIds.has(c.id));
      const someA = checkableA.some((c) => state.selectedIds.has(c.id));
      cb.indeterminate = someA && !allA;
      cb.checked = allA;
    });

    // 주기 그룹 헤더 체크박스 동기화
    ul.querySelectorAll('.rb-period-cb').forEach((cb) => {
      const pk = Number(cb.dataset.period);
      const checkableInPeriod = periodCheckable[pk] || [];
      const allC = checkableInPeriod.length > 0 && checkableInPeriod.every((c) => state.selectedIds.has(c.id));
      const someC = checkableInPeriod.some((c) => state.selectedIds.has(c.id));
      cb.indeterminate = someC && !allC;
      cb.checked = allC;
    });
  }

  function labelStatus(s) {
    return ({ draft: '초안', sent: '발송됨', paid: '입금완료', void: '취소' })[s] || s;
  }

  // ── 우측 상세 (엑셀 양식 청구서 미리보기) ──────────────────
  function renderDetail() {
    const wrap = $('#rb-detail');
    if (!wrap) return;
    const cid = state.selectedCustomerId;
    if (!cid) {
      wrap.innerHTML = '<div class="rb-detail-empty">좌측에서 거래처를 선택하세요.</div>';
      return;
    }
    const c = state.customers.find((x) => x.id === cid);
    if (!c) {
      wrap.innerHTML = '<div class="rb-detail-empty">거래처를 찾을 수 없습니다.</div>';
      return;
    }

    try {
      const billing = state.billings.get(cid);
      // [디버그] renderDetail 진입 시점의 billing 상태 확인
      console.log('[billing] renderDetail — cid:', cid, 'billing.status:', billing ? billing.status : '(없음)');
      const calc = computeBilling(cid);
      // counter_discount 는 항상 최신 discounts 맵에서 가져옴
      // (DB 저장된 billing row 에는 아직 없을 수 있음)
      const counterDiscount = state.discounts.get(cid) || 0;
      const view = billing ? {
        fixed_total: billing.fixed_total || 0,
        usage_total: billing.usage_total || 0,
        total: billing.total != null ? billing.total : calc.total,
        counter_discount: counterDiscount,
        items: calc.items,
      } : { ...calc, counter_discount: counterDiscount };

      const fixedRows = view.items.filter((x) => x.kind === 'fixed');
      const usageRows = view.items.filter((x) => x.kind === 'usage');
      const status = billing ? billing.status : null;
      const sentViaLabel = (billing && billing.sent_via)
        ? ` · ${labelSentVia(billing.sent_via)}` : '';
      const issuedLabel  = (billing && billing.issued_at)
        ? ` · ${billing.issued_at}` : '';
      const statusBadge = status
        ? `<span class="badge status-${status}">${labelStatus(status)}${sentViaLabel}${issuedLabel}</span>`
        : `<span class="badge" style="background:#fef3c7;color:#b45309;">미발행</span>`;

      wrap.innerHTML = `
        <div class="rb-detail-head no-print">
          <div>
            <h2>${escapeHtml(c.company)}</h2>
            <div class="rb-meta-row">
              ${escapeHtml(c.biz_no || '')}${c.biz_no ? ' · ' : ''}${escapeHtml(c.address || '')}
              · ${statusBadge}
            </div>
            <div class="rb-meta-row">청구월: <b>${escapeHtml(nextMonth(state.ym))}</b> · ${(() => {
              const bm2 = Math.max(1, Number(c.billing_months) || 1);
              const sd2 = getCustomerStartDate(c);
              const bp2 = computeBillingPeriod(bm2, sd2, state.ym);
              if (bp2.isBillingMonth) {
                if (bp2.monthsCount > 1) {
                  return `합산기간: <b>${escapeHtml(bp2.periodStart)}~${escapeHtml(bp2.periodEnd)}</b> (${bp2.monthsCount}개월 합산)`;
                }
                return `사용 기간: <b>${escapeHtml(state.ym)}</b>`;
              }
              return `다음 청구: <b>${escapeHtml(bp2.nextBillingYm)}</b> (${bp2.monthsCount}개월 합산)`;
            })()} · 결제: ${escapeHtml(c.payment_type || '-')} · 청구일: ${escapeHtml(c.invoice_day || '-')}</div>
          </div>
          <div class="rb-detail-actions">
            ${renderActionButtons(billing)}
            <button class="btn ghost" id="rb-excel">엑셀</button>
            <button class="btn ghost" id="rb-print">인쇄/PDF</button>
          </div>
        </div>

        <div class="rb-inv-section">
          ${buildInvoiceHTML(c, view, fixedRows, usageRows)}
        </div>
      `;

      // 이벤트 바인딩
      const printBtn = $('#rb-print');
      if (printBtn) printBtn.addEventListener('click', () => window.print());

      const excelBtn = $('#rb-excel');
      if (excelBtn) excelBtn.addEventListener('click', () => downloadExcel(cid));

      // rb-save 버튼 제거됨 — saveBtn 바인딩 없음

      // 수단별 직접 발송 버튼 3개 바인딩
      $$('.rb-send-via', wrap).forEach((btn) => {
        btn.addEventListener('click', () => sendVia(cid, btn.dataset.via));
      });

      const unsendBtn = $('#rb-unsend');
      if (unsendBtn) unsendBtn.addEventListener('click', async () => {
        if (!confirm('발송을 취소하시겠습니까? 청구서가 초안(draft) 상태로 돌아갑니다.')) return;
        await updateStatus(cid, 'draft', { issued_at: null, paid_at: null, sent_via: null }, '발송이 취소되어 초안 상태로 돌아갔습니다.');
        // 강제 안전망: state.billings 의 status/sent_via/issued_at/paid_at 을 명시적으로 한 번 더 보정
        const b = state.billings.get(cid);
        if (b) {
          b.status = 'draft';
          b.sent_via = null;
          b.issued_at = null;
          b.paid_at = null;
          state.billings.set(cid, b);
        }
        console.log('[billing] unsend complete — forced state:', state.billings.get(cid));
        renderDetail();
      });

      const voidBtn = $('#rb-void');
      if (voidBtn) voidBtn.addEventListener('click', () => {
        if (!confirm('이 청구서를 취소(void) 처리하시겠습니까?')) return;
        updateStatus(cid, 'void');
      });

      // 인라인 편집 비활성화 — rental_items 원본값(카운터 모듈과 동일)을 그대로 사용
      // bindInlineEdit(cid) 호출 제거
    } catch (err) {
      console.error('[billing] renderDetail error — cid:', cid, err);
      // catch 진입 시에도 billing 객체를 기반으로 액션 버튼 복원
      const billingOnErr = state.billings.get(cid);
      wrap.innerHTML = `
        <div class="rb-detail-head no-print">
          <div>
            <h2>${escapeHtml(c.company)}</h2>
            <div class="rb-meta-row" style="color:#dc2626;">
              청구서 렌더링 오류: ${escapeHtml(err && err.message ? err.message : String(err))}
            </div>
            <div class="rb-meta-row">청구월: <b>${escapeHtml(nextMonth(state.ym))}</b> · 사용 기간: ${escapeHtml(state.ym)}</div>
          </div>
          <div class="rb-detail-actions">
            ${renderActionButtons(billingOnErr)}
            <button class="btn ghost" id="rb-reload-detail" onclick="hardReload()">새로고침</button>
          </div>
        </div>
        <div style="padding:20px; color:#dc2626; font-size:12px; background:#fef2f2; border-radius:8px; margin-top:12px;">
          <b>오류 상세:</b><br>
          <pre style="white-space:pre-wrap; word-break:break-all;">${escapeHtml(err && err.stack ? err.stack : String(err))}</pre>
        </div>
      `;
      // catch 진입 후에도 액션 버튼 이벤트를 바인딩
      $$('.rb-send-via', wrap).forEach((btn) => {
        btn.addEventListener('click', () => sendVia(cid, btn.dataset.via));
      });
      const unsendBtnErr = $('#rb-unsend');
      if (unsendBtnErr) unsendBtnErr.addEventListener('click', async () => {
        if (!confirm('발송을 취소하시겠습니까? 청구서가 초안(draft) 상태로 돌아갑니다.')) return;
        await updateStatus(cid, 'draft', { issued_at: null, paid_at: null, sent_via: null }, '발송이 취소되어 초안 상태로 돌아갔습니다.');
        const b = state.billings.get(cid);
        if (b) {
          b.status = 'draft'; b.sent_via = null; b.issued_at = null; b.paid_at = null;
          state.billings.set(cid, b);
        }
        renderDetail();
      });
      const voidBtnErr = $('#rb-void');
      if (voidBtnErr) voidBtnErr.addEventListener('click', () => {
        if (!confirm('이 청구서를 취소(void) 처리하시겠습니까?')) return;
        updateStatus(cid, 'void');
      });
    }
  }

  // ── 엑셀 양식 청구서 HTML 생성 ──────────────────────────────
  function buildInvoiceHTML(c, view, fixedRows, usageRows) {
    // state.ym = 데이터월(사용 기간), 청구월 = nextMonth(state.ym)
    const dataYm  = state.ym;                         // 예: "2026-04" (4월 사용량)
    const billYm  = nextMonth(dataYm);                // 예: "2026-05" (5월 청구)
    const [billY, billM] = billYm.split('-').map(Number);
    const billYShort = String(billY).slice(2);        // "26"

    // Phase 2: 청구 기간 계산
    const bm = Math.max(1, Number(c.billing_months) || 1);
    const sd = getCustomerStartDate(c);
    const bpInfo = computeBillingPeriod(bm, sd, dataYm);
    const actualMonths = bpInfo.monthsCount;
    const periodStart = bpInfo.periodStart;   // 'YYYY-MM'
    const periodEnd   = bpInfo.periodEnd;     // 'YYYY-MM'

    // 청구 제목 행 — N개월 합산이면 기간 범위 표시
    let counterLabel, billLabel;
    if (actualMonths > 1) {
      const [psy, psm] = periodStart.split('-').map(Number);
      const [pey, pem] = periodEnd.split('-').map(Number);
      counterLabel = `${String(psy).slice(2)}.${String(psm).padStart(2,'0')}~${String(pey).slice(2)}.${String(pem).padStart(2,'0')} 추가카운터 (${actualMonths}개월 합산)`;
    } else {
      const [dataY, dataM] = dataYm.split('-').map(Number);
      const dataYShort = String(dataY).slice(2);
      counterLabel = `${dataYShort}.${String(dataM).padStart(2,'0')}월 추가카운터`;
    }
    billLabel = `(${billYShort}.${String(billM).padStart(2,'0')}월청구)`;

    const titleHTML = `
      <span class="inv-title-customer">${escapeHtml(c.company)}</span>
      <span class="inv-title-counter">&nbsp;&nbsp;${counterLabel}</span>
      <span class="inv-title-billing">&nbsp;${billLabel}</span>
    `;

    // ── 상품표 ──
    // 고정 임대료가 없는 경우 "추가카운터 청구"로 단일행 처리
    let productRowsHTML = '';
    if (fixedRows.length > 0) {
      productRowsHTML = fixedRows.map((r) => {
        const modelLabel = r.label || (r.category + '/' + r.subtype);
        // 모델명 추출 (예: "IT/레이저 M5526 (1개월 × ₩60,000)" → "M5526 1대")
        const modelMatch = modelLabel.match(/([A-Z0-9\-]+\d+)/i);
        const modelTag = modelMatch ? ` (${modelMatch[1]} 1대)` : '';
        return `
          <tr>
            <td colspan="5" class="prod-name" style="text-align:left; padding-left:8px;">
              유지보수 및 임대료 청구${escapeHtml(modelTag)}
            </td>
            <td colspan="3" class="num" style="text-align:right;">${r.qty || 1}</td>
            <td colspan="3" class="num" style="text-align:right;">${fmtKRW(r.unit_price || 0)}</td>
            <td colspan="4" class="num inv-prod-sub" style="text-align:right;">
              ${fmtKRW(r.subtotal)}
            </td>
          </tr>
        `;
      }).join('');
    } else {
      // 고정 임대료 없음 → 빈 행
      productRowsHTML = `
        <tr>
          <td colspan="5" class="prod-name" style="text-align:left; padding-left:8px; color:#999;">
            유지보수 및 임대료 청구
          </td>
          <td colspan="3" class="num">-</td>
          <td colspan="3" class="num">-</td>
          <td colspan="4" class="num">0</td>
        </tr>
      `;
    }

    // ── 카운터표 ──
    // 출력기기(usage) 없으면 빈 메시지
    let counterBodyHTML = '';
    if (usageRows.length === 0) {
      counterBodyHTML = `
        <tr>
          <td style="color:#999; text-align:center;">
            이번 달 초과 카운터 없음
          </td>
          <td colspan="7" class="num zero">-</td>
          <td colspan="7" class="num zero">-</td>
        </tr>
      `;
    } else {
      counterBodyHTML = usageRows.map((r) => {
        // ── total 모드 행 (합계 카운터 단일 행) ─────────────────
        if (r.counter_mode === 'total') {
          const periodStr = (r.period_start && r.period_end)
            ? buildPeriodStrFromRange(r.period_start, r.period_end)
            : buildPeriodStr(dataYm, r.billing_months || 1);
          const modelName = extractModelName(r.label || r.subtype || '') || r.subtype || '';
          const totalUsed  = r.total_used  || 0;
          const totalFree  = r.total_free  || 0;
          const totalExtra = r.total_extra || 0;
          const unitPrice  = r.total_unit_price || 0;
          const fee        = r.subtotal || 0;
          const extraCls   = totalExtra > 0 ? 'overage' : 'zero';

          // 전월/당월(기간 시작/종료) 카운터 검산 데이터
          const prevBw    = r.counter_bw_prev    || 0;
          const prevCo    = r.counter_color_prev || 0;
          const curBw     = r.counter_bw         || 0;
          const curCo     = r.counter_color      || 0;
          const prevTotal = r.prev_total != null ? r.prev_total : (prevBw + prevCo);
          const curTotal  = r.cur_total  != null ? r.cur_total  : (curBw  + curCo);
          // 다중 개월 여부에 따라 라벨 결정
          const isMultiMonth = (r.billing_months || 1) > 1;
          const prevLabel = isMultiMonth ? '시작 카운터' : '전월 카운터';
          const curLabel  = isMultiMonth ? '현재 카운터' : '당월 카운터';

          return `
            <tr class="inv-counter-row-group inv-total-mode-row">
              <td class="model-cell" colspan="1">
                <div class="model-name">${escapeHtml(modelName)}</div>
                <div class="model-period">${periodStr.split('\n').map(escapeHtml).join('<br>')}</div>
                <div style="font-size:8px;color:#0369a1;font-weight:600;margin-top:2px;">합계모드</div>
              </td>
              <td colspan="14" style="padding:4px 6px;">
                <table style="width:100%;border-collapse:collapse;font-size:10px;">
                  <tr>
                    <td style="color:#64748b;padding:1px 4px;">${escapeHtml(prevLabel)}</td>
                    <td style="font-weight:600;padding:1px 4px;">${fmtKRW(prevTotal)}매</td>
                    <td style="font-size:9px;color:#94a3b8;padding:1px 4px;">(흑백 ${fmtKRW(prevBw)} + 컬러 ${fmtKRW(prevCo)})</td>
                    <td style="color:#64748b;padding:1px 4px;">${escapeHtml(curLabel)}</td>
                    <td style="font-weight:600;padding:1px 4px;">${fmtKRW(curTotal)}매</td>
                    <td style="font-size:9px;color:#94a3b8;padding:1px 4px;">(흑백 ${fmtKRW(curBw)} + 컬러 ${fmtKRW(curCo)})</td>
                    <td style="color:#64748b;padding:1px 4px;border-left:1px solid #e2e8f0;">사용량</td>
                    <td style="font-weight:600;padding:1px 4px;">${fmtKRW(curTotal)}-${fmtKRW(prevTotal)}=${fmtKRW(totalUsed)}매</td>
                  </tr>
                  <tr>
                    <td style="color:#64748b;padding:1px 4px;">기본 무료</td>
                    <td style="padding:1px 4px;">${fmtKRW(totalFree)}매</td>
                    <td style="color:#64748b;padding:1px 4px;">초과 매수</td>
                    <td class="${extraCls}" style="font-weight:600;padding:1px 4px;">${fmtKRW(totalExtra)}매</td>
                    <td style="color:#64748b;padding:1px 4px;">매수당 단가</td>
                    <td style="padding:1px 4px;">${fmtKRW(unitPrice)}원</td>
                    <td style="color:#64748b;padding:1px 4px;border-left:1px solid #e2e8f0;">초과사용료</td>
                    <td class="${totalExtra > 0 ? 'overage' : 'zero'}" style="font-weight:700;padding:1px 4px;">${fmtKRW(fee)}원</td>
                  </tr>
                </table>
              </td>
            </tr>
          `;
        }

        // Phase 3: rate 변경이 있는 자산별 모드는 구간 분리 표시
        if (r._hasRateChange && r._rateSegments && !r.combined) {
          return buildRateChangeRows(r, dataYm);
        }

        const bwPrev  = r.counter_bw_prev || 0;
        const bwCur   = r.counter_bw || 0;
        const bwFree  = r.bw_free || 0;
        const bwMonth = r.month_bw != null ? r.month_bw : Math.max(0, bwCur - bwPrev);
        const bwExtra = bwMonth - bwFree;   // 음수 포함 (표시용)
        const bwRate  = r.bw_rate || 0;
        const bwFee   = bwExtra > 0 ? Math.round(bwExtra * bwRate) : 0;

        const coPrev  = r.counter_color_prev || 0;
        const coCur   = r.counter_color || 0;
        const coFree  = r.co_free || 0;
        const coMonth = r.month_co != null ? r.month_co : Math.max(0, coCur - coPrev);
        const coExtra = coMonth - coFree;
        const coRate  = r.co_rate || 0;
        const coFee   = coExtra > 0 ? Math.round(coExtra * coRate) : 0;

        // Phase 2: period_start/period_end 가 있으면 그걸 사용, 없으면 기존 로직
        const periodStr = (r.period_start && r.period_end)
          ? buildPeriodStrFromRange(r.period_start, r.period_end)
          : buildPeriodStr(dataYm, r.billing_months || 1);

        // 출력합산 행: 날짜(기간) + 합산 댓수 표시 (모델명 생략), 카운터 컬럼은 합산값 그대로 표시
        // 자산별 행: 모델명 + 기간 표시
        let modelCellHTML;
        if (r.subtype === 'combined') {
          const assetCount = r._assetCount || '';
          // Phase 3: 합산 모드 rate 변경 배지
          const rateChangeBadge = (r._hasRateChange && r._rateChangeSummary)
            ? `<div style="font-size:8px;color:#b45309;background:#fef3c7;border-radius:2px;padding:1px 3px;margin-top:2px;line-height:1.3;">rate변경</div>`
            : '';
          modelCellHTML = `
            <div class="model-period">${periodStr.split('\n').map(escapeHtml).join('<br>')}</div>
            <div style="font-size:9px;color:#059669;font-weight:600;margin-top:2px;">합산 ${assetCount}대</div>
            ${rateChangeBadge}
          `;
        } else {
          const modelName = extractModelName(r.label || r.subtype || '') || r.subtype || '';
          // Phase 3: 합산 모드 rate 변경 배지
          const rateChangeBadge = (r._hasRateChange && r._rateChangeSummary)
            ? `<div style="font-size:8px;color:#b45309;background:#fef3c7;border-radius:2px;padding:1px 3px;margin-top:2px;line-height:1.3;">rate변경</div>`
            : '';
          modelCellHTML = `
            <div class="model-name">${escapeHtml(modelName)}</div>
            <div class="model-period">${periodStr.split('\n').map(escapeHtml).join('<br>')}</div>
            ${rateChangeBadge}
          `;
        }

        // Phase 4: 가중 평균 단가 주석
        const bwRateDisplay = r._hasWeightedRate && r._bwRateDisplay != null
          ? `<div style="font-size:8px;color:#7c3aed;margin-top:1px;">가중평균</div>`
          : '';
        const coRateDisplay = r._hasWeightedRate && r._coRateDisplay != null
          ? `<div style="font-size:8px;color:#7c3aed;margin-top:1px;">가중평균</div>`
          : '';
        const bwRateStr = r._hasWeightedRate && r._bwRateDisplay != null
          ? r._bwRateDisplay.toFixed(2)
          : fmtKRW(bwRate);
        const coRateStr = r._hasWeightedRate && r._coRateDisplay != null
          ? r._coRateDisplay.toFixed(2)
          : fmtKRW(coRate);

        const bwExtraCls = bwExtra > 0 ? 'overage' : (bwExtra < 0 ? 'zero' : '');
        const coExtraCls = coExtra > 0 ? 'overage' : (coExtra < 0 ? 'zero' : '');

        return `
          <tr class="inv-counter-row-group">
            <td class="model-cell">
              ${modelCellHTML}
            </td>
            <td class="num">${fmtKRW(bwPrev)}</td>
            <td class="num">${fmtKRW(bwCur)}</td>
            <td class="num">${fmtKRW(bwFree)}</td>
            <td class="num">${fmtKRW(bwMonth)}</td>
            <td class="num ${bwExtraCls}">${bwExtra}</td>
            <td class="num">${bwRateStr}${bwRateDisplay}</td>
            <td class="num ${bwExtra > 0 ? 'overage' : 'zero'}">${fmtKRW(bwFee)}</td>
            <td class="num">${fmtKRW(coPrev)}</td>
            <td class="num">${fmtKRW(coCur)}</td>
            <td class="num">${fmtKRW(coFree)}</td>
            <td class="num">${fmtKRW(coMonth)}</td>
            <td class="num ${coExtraCls}">${coExtra}</td>
            <td class="num">${coRateStr}${coRateDisplay}</td>
            <td class="num ${coExtra > 0 ? 'overage' : 'zero'}">${fmtKRW(coFee)}</td>
          </tr>
        `;
      }).join('');
    }

    // ── 합계 ──
    const fixedTotal   = view.fixed_total || 0;
    // split 모드 행만 흑백/컬러 분리 집계 (total 모드 행은 totalModeExtra 로 별도 집계)
    const bwExtraTotal = usageRows.reduce((s, r) => {
      if (r.counter_mode === 'total') return s; // total 모드는 제외
      const bwPrev  = r.counter_bw_prev || 0;
      const bwCur   = r.counter_bw || 0;
      const bwFree  = r.bw_free || 0;
      const bwMonth = r.month_bw != null ? r.month_bw : Math.max(0, bwCur - bwPrev);
      const bwExtra = bwMonth - bwFree;
      return s + (bwExtra > 0 ? bwExtra * (r.bw_rate || 0) : 0);
    }, 0);
    const coExtraTotal = usageRows.reduce((s, r) => {
      if (r.counter_mode === 'total') return s; // total 모드는 제외
      const coPrev  = r.counter_color_prev || 0;
      const coCur   = r.counter_color || 0;
      const coFree  = r.co_free || 0;
      const coMonth = r.month_co != null ? r.month_co : Math.max(0, coCur - coPrev);
      const coExtra = coMonth - coFree;
      return s + (coExtra > 0 ? coExtra * (r.co_rate || 0) : 0);
    }, 0);
    // total 모드 행의 초과사용료 합산
    const totalModeExtra = usageRows.reduce((s, r) => {
      if (r.counter_mode !== 'total') return s;
      return s + (r.subtotal || 0);
    }, 0);
    // counter_discount 는 view 에서 가져옴 (renderDetail 에서 주입됨)
    const counterDiscount = view.counter_discount || 0;
    const grandTotal = Math.max(0, fixedTotal + bwExtraTotal + coExtraTotal + totalModeExtra - counterDiscount);

    // ── 15열 col 폭 배분 (엑셀 구조 참고) ──
    // A(날짜/모델):11.1%, B-C(BW전월/당월):각7.4%, D(기본):6%, E-F(월카/추가):각7.5%, G(단가):7.6%, H(추가료):9.5%,
    // I-J(CO전월/당월):각7.75%, K(기본):7.75%, L-M(월카/추가):각7.75%, N(단가):8.75%, O(추가료):10.4%
    const colGroup = `
      <colgroup>
        <col style="width:10%">
        <col style="width:6.5%"><col style="width:6.5%">
        <col style="width:5.5%"><col style="width:6%"><col style="width:6%">
        <col style="width:5.5%"><col style="width:7%">
        <col style="width:6.5%"><col style="width:6.5%">
        <col style="width:5.5%"><col style="width:6%"><col style="width:6%">
        <col style="width:5.5%"><col style="width:7%">
      </colgroup>
    `;

    return `
      <div class="invoice-preview">
        <div class="inv-wrap">

          <!-- 상단 로고 -->
          <div class="inv-header">
            <img class="inv-logo" src="assets/logo.jpg" alt="디직스코리아 로고">
          </div>

          <!-- 제목 행 -->
          <div class="inv-title-row">
            ${titleHTML}
          </div>

          <!-- 상품표 -->
          <table class="inv-table inv-product-table" style="margin-top:4px;">
            <colgroup>
              <col style="width:33%"><col style="width:7%"><col style="width:7%"><col style="width:7%">
              <col style="width:7%"><col style="width:7%"><col style="width:7%">
              <col style="width:8%"><col style="width:8%"><col style="width:8%"><col style="width:8%">
              <col style="width:10%"><col style="width:10%"><col style="width:10%">
            </colgroup>
            <thead>
              <tr>
                <th colspan="5" style="font-size:12px;">품 목 명</th>
                <th colspan="3" style="font-size:12px;">수량</th>
                <th colspan="3" style="font-size:12px;">단가</th>
                <th colspan="4" style="font-size:12px;" id="inv-prod-amount-hdr">금액</th>
              </tr>
            </thead>
            <tbody>
              ${productRowsHTML}
            </tbody>
          </table>

          <!-- 카운터표 -->
          <div class="inv-counter-wrap">
            <table class="inv-table inv-counter-table">
              ${colGroup}
              <thead>
                <tr>
                  <th rowspan="2" class="th-date">날짜</th>
                  <th colspan="7" class="th-group">흑 백</th>
                  <th colspan="7" class="th-group">컬 러</th>
                </tr>
                <tr>
                  <th>전월COUNT</th>
                  <th>당월COUNT</th>
                  <th>기본매수</th>
                  <th>월카운터</th>
                  <th>추가카운터</th>
                  <th>추가사용단가</th>
                  <th>추가사용료</th>
                  <th>전월COUNT</th>
                  <th>당월COUNT</th>
                  <th>기본매수</th>
                  <th>월카운터</th>
                  <th>추가카운터</th>
                  <th>추가사용단가</th>
                  <th>추가사용료</th>
                </tr>
              </thead>
              <tbody>
                ${counterBodyHTML}
              </tbody>
            </table>
          </div>

          <!-- 합계 영역 -->
          <div class="inv-summary">
            <table class="inv-summary-table">
              <tr>
                <td class="sum-label">유지보수 및 임대료 청구</td>
                <td class="sum-amount" id="rb-fixed-sub">${fmtKRW(fixedTotal)}<span class="sum-unit">원</span></td>
              </tr>
              <tr>
                <td class="sum-label">흑백추가</td>
                <td class="sum-amount" id="rb-bwextra-sub">${fmtKRW(bwExtraTotal)}<span class="sum-unit">원</span></td>
              </tr>
              <tr>
                <td class="sum-label">칼라추가</td>
                <td class="sum-amount" id="rb-coextra-sub">${fmtKRW(coExtraTotal)}<span class="sum-unit">원</span></td>
              </tr>
              ${totalModeExtra > 0 ? `
              <tr>
                <td class="sum-label">합계카운터 초과</td>
                <td class="sum-amount" id="rb-totalmode-sub">${fmtKRW(totalModeExtra)}<span class="sum-unit">원</span></td>
              </tr>
              ` : ''}
              ${counterDiscount > 0 ? `
              <tr class="sum-discount-row">
                <td class="sum-label" style="color:#16a34a;">추가요금 할인</td>
                <td class="sum-amount" style="color:#16a34a;">-${fmtKRW(counterDiscount)}<span class="sum-unit">원</span></td>
              </tr>
              ` : ''}
              <tr>
                <td class="sum-label total">합 계 <span class="sum-vat-inline">(VAT별도)</span></td>
                <td class="sum-amount total" id="rb-grand-total">${fmtKRW(grandTotal)}<span class="sum-unit">원</span></td>
              </tr>
            </table>
          </div>

          <!-- 거래처 정보 푸터 -->
          ${buildCustomerFooterHTML(c)}

        </div><!-- /inv-wrap -->
      </div><!-- /invoice-preview -->
    `;
  }

  // ── 거래처 정보 푸터 HTML 생성 ───────────────────────────────
  function buildCustomerFooterHTML(c) {
    const v = (val) => {
      const s = (val || '').toString().trim();
      return s ? escapeHtml(s) : '<span class="inv-cf-empty">-</span>';
    };
    return `
      <div class="inv-customer-footer">
        <div class="inv-cf-title">거래처 정보</div>
        <div class="inv-cf-line">
          <span class="inv-cf-item"><span class="inv-cf-label">상호</span><span class="inv-cf-value">${v(c.company)}</span></span>
          <span class="inv-cf-item"><span class="inv-cf-label">전화</span><span class="inv-cf-value">${v(c.phone)}</span></span>
          <span class="inv-cf-item inv-cf-item-grow"><span class="inv-cf-label">주소</span><span class="inv-cf-value">${v(c.address)}</span></span>
        </div>
        <div class="inv-cf-line">
          <span class="inv-cf-item"><span class="inv-cf-label">팩스</span><span class="inv-cf-value">${v(c.fax)}</span></span>
          <span class="inv-cf-item"><span class="inv-cf-label">핸드폰</span><span class="inv-cf-value">${v(c.mobile)}</span></span>
          <span class="inv-cf-item inv-cf-item-grow"><span class="inv-cf-label">이메일</span><span class="inv-cf-value">${v(c.email)}</span></span>
        </div>
      </div>
    `;
  }

  // ── Phase 3: rate 변경 구간 분리 행 생성 ────────────────────
  // _rateSegments 가 있는 자산별 usageRow 를 전반/후반 행으로 분리 출력
  function buildRateChangeRows(r, dataYm) {
    const modelName = extractModelName(r.label || r.subtype || '') || r.subtype || '';
    const segments = r._rateSegments;
    const bwPrev = r.counter_bw_prev || 0;
    const bwCur  = r.counter_bw     || 0;
    const coPrev = r.counter_color_prev || 0;
    const coCur  = r.counter_color     || 0;

    let html = '';
    segments.forEach((seg, idx) => {
      const isFirst = idx === 0;
      const isLast  = idx === segments.length - 1;
      const segPeriodStr = buildPeriodStrFromRange(seg.startYm, seg.endYm);

      // 구간 표시 레이블 (전반/후반 또는 순번)
      const segLabel = segments.length === 2
        ? (isFirst ? '변경 전' : '변경 후')
        : `구간${idx + 1}`;
      const changeBadge = isFirst
        ? '' // 전반에는 배지 없음
        : `<div style="font-size:8px;font-weight:700;color:#fff;background:#b45309;border-radius:2px;padding:1px 3px;margin-top:2px;display:inline-block;">rate변경</div>`;

      const bwFee  = seg.ex_bw > 0 ? seg.ex_bw * (seg.rate.bw_rate || 0) : 0;
      const coFee  = seg.ex_co > 0 ? seg.ex_co * (seg.rate.co_rate || 0) : 0;
      const bwExtraCls = seg.ex_bw > 0 ? 'overage' : (seg.ex_bw < 0 ? 'zero' : '');
      const coExtraCls = seg.ex_co > 0 ? 'overage' : (seg.ex_co < 0 ? 'zero' : '');

      // 전월/당월 카운터: 전반은 전체 전월~분할 중간점(추정), 후반은 중간점~당월
      // 실제 중간 카운터가 없으므로 전반은 prev/cur 표시 (참고용), 후반은 '-'
      const showBwPrev = isFirst ? fmtKRW(bwPrev) : '-';
      const showBwCur  = isLast  ? fmtKRW(bwCur)  : '-';
      const showCoPrev = isFirst ? fmtKRW(coPrev) : '-';
      const showCoCur  = isLast  ? fmtKRW(coCur)  : '-';

      html += `
        <tr class="inv-counter-row-group" style="${isFirst ? '' : 'background:#fffbeb;'}">
          <td class="model-cell">
            <div class="model-name">${escapeHtml(modelName)}</div>
            <div class="model-period">${segPeriodStr.split('\n').map(escapeHtml).join('<br>')}</div>
            <div style="font-size:8px;color:#92400e;margin-top:1px;">${segLabel} (${seg.monthsCount}개월)</div>
            ${changeBadge}
          </td>
          <td class="num">${showBwPrev}</td>
          <td class="num">${showBwCur}</td>
          <td class="num">${fmtKRW(seg.bw_free)}</td>
          <td class="num">${fmtKRW(seg.month_bw)}</td>
          <td class="num ${bwExtraCls}">${seg.ex_bw}</td>
          <td class="num">${fmtKRW(seg.rate.bw_rate || 0)}</td>
          <td class="num ${seg.ex_bw > 0 ? 'overage' : 'zero'}">${fmtKRW(bwFee)}</td>
          <td class="num">${showCoPrev}</td>
          <td class="num">${showCoCur}</td>
          <td class="num">${fmtKRW(seg.co_free)}</td>
          <td class="num">${fmtKRW(seg.month_co)}</td>
          <td class="num ${coExtraCls}">${seg.ex_co}</td>
          <td class="num">${fmtKRW(seg.rate.co_rate || 0)}</td>
          <td class="num ${seg.ex_co > 0 ? 'overage' : 'zero'}">${fmtKRW(coFee)}</td>
        </tr>
      `;
    });
    return html;
  }

  // ── 모델명 추출 헬퍼 ────────────────────────────────────────
  function extractModelName(label) {
    // "레이저 M5526 초과사용" → "M5526"
    const m = label.match(/\b([A-Z][A-Z0-9\-]{2,})\b/);
    return m ? m[1] : null;
  }

  // ── 기간 문자열 헬퍼 (카운터표 날짜 셀) ────────────────────
  // ym = 데이터월(사용월) — 그대로 그 달의 1일~말일 기간을 출력
  // (호출자: buildInvoiceHTML 에서 dataYm 을 넘김 — 청구월 변환은 호출자 책임)
  function buildPeriodStr(ym, months) {
    if (months <= 1) {
      const [y, m] = ym.split('-').map(Number);
      const lastDay = new Date(y, m, 0).getDate();
      return `${m}월1일부터\n${m}월 ${lastDay}일까지`;
    }
    // N개월 합산 — ym = 마지막 데이터월
    const startYm = ymMinus(ym, months - 1);
    const [sy, sm] = startYm.split('-').map(Number);
    const [ey, em] = ym.split('-').map(Number);
    const eLastDay = new Date(ey, em, 0).getDate();
    return `${sy}.${String(sm).padStart(2,'0')}.1부터\n${ey}.${String(em).padStart(2,'0')}.${eLastDay}까지`;
  }

  // Phase 2: periodStart~periodEnd 직접 지정 버전 (첫 청구 부분 기간 지원)
  function buildPeriodStrFromRange(periodStart, periodEnd) {
    const [sy, sm] = periodStart.split('-').map(Number);
    const [ey, em] = periodEnd.split('-').map(Number);
    if (sy === ey && sm === em) {
      const lastDay = new Date(ey, em, 0).getDate();
      return `${sm}월1일부터\n${em}월 ${lastDay}일까지`;
    }
    const eLastDay = new Date(ey, em, 0).getDate();
    return `${sy}.${String(sm).padStart(2,'0')}.1부터\n${ey}.${String(em).padStart(2,'0')}.${eLastDay}까지`;
  }

  function renderActionButtons(billing) {
    // draft/미발행: 수단별 직접 버튼 3개 + 취소 버튼
    // sent/paid: 발송 취소 버튼만
    // A안: status 가 null/undefined/예상 외 값이어도 3개 버튼 노출
    const s = billing?.status;
    // [디버그] renderActionButtons 진입 시점의 status 확인
    console.log('[billing] renderActionButtons — status:', s, '| billing:', billing ? JSON.stringify({ id: billing.id, status: s }) : '(없음)');
    const isDraftOrNew = !billing || s === 'draft' || (s !== 'sent' && s !== 'paid' && s !== 'void');
    const parts = [];

    if (isDraftOrNew) {
      // 팩스 — ghost
      parts.push(`<button class="btn ghost small rb-send-via" id="rb-send-fax" data-via="fax">📠 팩스</button>`);
      // 카카오톡 — 카카오 노란색
      parts.push(`<button class="btn small rb-send-via" id="rb-send-kakao" data-via="kakao"
        style="background:#FEE500;color:#000;border:1px solid #d4c300;">💬 카카오톡</button>`);
      // 이메일 — primary
      parts.push(`<button class="btn primary small rb-send-via" id="rb-send-email" data-via="email">✉️ 이메일</button>`);
    }

    if (billing) {
      const s = billing.status;
      if (s === 'sent' || s === 'paid') parts.push(`<button class="btn ghost small" id="rb-unsend">발송 취소</button>`);
      if (s !== 'void' && s !== 'paid') parts.push(`<button class="btn danger small" id="rb-void">취소</button>`);
    }

    return parts.join('');
  }

  // ── 인라인 편집 셀 (청구서 양식 내 숫자 셀용) ─────────────
  function editableCellInv(customerId, itemId, kind, field, currentVal, rawVal) {
    const hasOv = rawVal != null && currentVal !== rawVal;
    const ovStyle = hasOv ? ' style="background:#fef3c7; font-weight:bold;"' : '';
    const ovTitle = hasOv ? ` title="원본: ${fmtKRW(rawVal)} (클릭해서 수정)"` : ' title="클릭해서 수정"';
    return `<span class="rb-ov-wrap" style="justify-content:flex-end;">
      ${hasOv ? `<span class="rb-ov-badge" style="font-size:9px;">수정됨</span>` : ''}
      <input type="number" class="rb-ov-input" style="width:70px;"${ovStyle}${ovTitle}
        value="${currentVal}"
        data-cid="${escapeHtml(customerId || '')}"
        data-iid="${escapeHtml(itemId)}"
        data-kind="${escapeHtml(kind)}"
        data-field="${escapeHtml(field)}"
        data-original="${rawVal != null ? rawVal : currentVal}">
      ${hasOv ? `<button class="rb-ov-revert" title="원복"
          data-cid="${escapeHtml(customerId || '')}"
          data-iid="${escapeHtml(itemId)}"
          data-kind="${escapeHtml(kind)}"
          data-field="${escapeHtml(field)}">↩</button>` : ''}
    </span>`;
  }

  // ── 합계 영역 즉시 갱신 (override 변경 시) ─────────────────
  function refreshGrandTotal(customerId) {
    const calc = computeBilling(customerId);
    const usageRows = calc.items.filter((x) => x.kind === 'usage');

    const fixedTotal = calc.fixed_total || 0;
    const bwExtraTotal = usageRows.reduce((s, r) => {
      const bwPrev  = r.counter_bw_prev || 0;
      const bwCur   = r.counter_bw || 0;
      const bwFree  = r.bw_free || 0;
      const bwMonth = r.month_bw != null ? r.month_bw : Math.max(0, bwCur - bwPrev);
      const bwExtra = bwMonth - bwFree;
      return s + (bwExtra > 0 ? bwExtra * (r.bw_rate || 0) : 0);
    }, 0);
    const coExtraTotal = usageRows.reduce((s, r) => {
      const coPrev  = r.counter_color_prev || 0;
      const coCur   = r.counter_color || 0;
      const coFree  = r.co_free || 0;
      const coMonth = r.month_co != null ? r.month_co : Math.max(0, coCur - coPrev);
      const coExtra = coMonth - coFree;
      return s + (coExtra > 0 ? coExtra * (r.co_rate || 0) : 0);
    }, 0);
    const counterDiscount = state.discounts.get(customerId) || 0;
    const grandTotal = Math.max(0, fixedTotal + bwExtraTotal + coExtraTotal - counterDiscount);

    const fixedEl   = $('#rb-fixed-sub');
    const bwEl      = $('#rb-bwextra-sub');
    const coEl      = $('#rb-coextra-sub');
    const grandEl   = $('#rb-grand-total');
    const unit = '<span class="sum-unit">원</span>';
    if (fixedEl)  fixedEl.innerHTML  = fmtKRW(fixedTotal) + unit;
    if (bwEl)     bwEl.innerHTML     = fmtKRW(bwExtraTotal) + unit;
    if (coEl)     coEl.innerHTML     = fmtKRW(coExtraTotal) + unit;
    if (grandEl)  grandEl.innerHTML  = fmtKRW(grandTotal) + unit;
    // 할인 행 금액도 즉시 갱신
    const discEl = document.querySelector('.sum-discount-row .sum-amount');
    if (discEl && counterDiscount > 0) discEl.innerHTML = '-' + fmtKRW(counterDiscount) + unit;
  }

  // ── 인라인 편집 이벤트 바인딩 ─────────────────────────────
  function bindInlineEdit(customerId) {
    const detail = $('#rb-detail');
    if (!detail) return;

    // blur / Enter 로 저장
    $$('.rb-ov-input', detail).forEach((inp) => {
      const save = () => handleOverrideSave(inp, customerId);
      inp.addEventListener('blur', save);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      });
    });

    // 원복 버튼
    $$('.rb-ov-revert', detail).forEach((btn) => {
      btn.addEventListener('click', () => handleOverrideRevert(btn, customerId));
    });
  }

  async function handleOverrideSave(inp, customerId) {
    const itemId  = inp.dataset.iid;
    const kind    = inp.dataset.kind;
    const field   = inp.dataset.field;
    const origVal = Number(inp.dataset.original);
    const newVal  = Number(inp.value);

    // 원본과 같으면 override 삭제 (원복과 동일 효과)
    if (newVal === origVal) {
      await deleteOverride(customerId, itemId, kind, field);
      return;
    }

    try {
      const payload = {
        customer_id: customerId,
        ym: state.ym,
        item_id: itemId,
        kind,
        field,
        original_val: origVal,
        override_val: newVal,
      };
      const { error } = await sb()
        .from('rental_billing_overrides')
        .upsert(payload, { onConflict: 'customer_id,ym,item_id,kind,field' });
      if (error) throw error;

      // 메모리 갱신
      state.overrides.set(ovKey(customerId, itemId, kind, field), { ...payload });
      refreshGrandTotal(customerId);
      toast('수정값 저장', 'ok');
    } catch (e) {
      console.error('[billing] override save error', e);
      toast('저장 실패: ' + (e.message || e), 'error');
      inp.value = origVal; // 실패 시 원본으로 복원
    }
  }

  async function handleOverrideRevert(btn, customerId) {
    const itemId = btn.dataset.iid;
    const kind   = btn.dataset.kind;
    const field  = btn.dataset.field;
    await deleteOverride(customerId, itemId, kind, field);
  }

  async function deleteOverride(customerId, itemId, kind, field) {
    try {
      const { error } = await sb()
        .from('rental_billing_overrides')
        .delete()
        .eq('customer_id', customerId)
        .eq('ym', state.ym)
        .eq('item_id', itemId)
        .eq('kind', kind)
        .eq('field', field);
      if (error) throw error;

      state.overrides.delete(ovKey(customerId, itemId, kind, field));
      // 전체 재렌더 (원복 시 테이블 행이 달라질 수 있으므로)
      renderDetail();
      renderList();
      toast('원복 완료', 'ok');
    } catch (e) {
      console.error('[billing] override revert error', e);
      toast('원복 실패: ' + (e.message || e), 'error');
    }
  }

  // ── 저장 (개별) — rental_items 원본값 기준 최종값을 items 에 기록 ──
  // silent=true 이면 성공 toast 를 띄우지 않음 (발송 처리 경로에서 중복 방지)
  async function saveOne(customerId, { silent = false } = {}) {
    try {
      const calc = computeBilling(customerId);
      const ym = state.ym;
      // _rawSub 등 내부 메타 필드는 저장하지 않음
      const cleanItems = calc.items.map(stripMeta);
      // Phase 2: 청구 기간 정보 — ym(YYYY-MM) → DATE(YYYY-MM-DD) 변환
      const bp = calc.billingPeriod;
      const ymToFirstDay = (s) => `${s}-01`;
      const ymToLastDay  = (s) => {
        const [y, m] = s.split('-').map(Number);
        const last = new Date(y, m, 0).getDate();
        return `${s}-${String(last).padStart(2, '0')}`;
      };
      const payload = {
        id: `b_${customerId}_${ym}`,
        customer_id: customerId,
        ym,
        fixed_total: calc.fixed_total,
        usage_total: calc.usage_total,
        // total 은 rental_billings 에서 generated column (fixed_total + usage_total - counter_discount)
        // 으로 DB가 자동 계산하므로 payload 에서 제외
        items: cleanItems,
        // counter_discount: rental_billings 에 컬럼이 존재해야 저장 가능
        ...(calc.counter_discount > 0 ? { counter_discount: calc.counter_discount } : {}),
        // 청구 기간 정보 (Phase 2 — 컬럼이 없으면 무시됨)
        ...(bp ? {
          billing_period_start: ymToFirstDay(bp.periodStart),
          billing_period_end:   ymToLastDay(bp.periodEnd),
          billing_months_actual: bp.monthsCount,
        } : {}),
      };
      const existing = state.billings.get(customerId);
      if (!existing) payload.status = 'draft';

      const { data, error } = await sb()
        .from('rental_billings')
        .upsert(payload, { onConflict: 'customer_id,ym' })
        .select()
        .single();
      if (error) throw error;
      state.billings.set(customerId, data);
      if (!silent) {
        renderAll();
        toast('청구서를 저장했습니다.', 'ok');
      }
    } catch (e) {
      console.error('[billing] save error', JSON.stringify(e));
      const hint = (e.code === '42703' || (e.message || '').includes('column'))
        ? ' — 컬럼 누락일 수 있습니다. Supabase SQL로 ALTER TABLE을 실행하세요.'
        : '';
      toast('저장 실패: ' + (e.message || JSON.stringify(e)) + hint, 'error');
      throw e; // 발송 처리 경로에서 saveOne 실패 시 updateStatus 를 중단하기 위해 re-throw
    }
  }

  // _rawSub 등 UI 전용 메타 필드 제거
  function stripMeta(item) {
    const out = {};
    for (const k of Object.keys(item)) {
      if (!k.startsWith('_')) out[k] = item[k];
    }
    return out;
  }

  // ── 상태 변경 ───────────────────────────────────────────────
  async function updateStatus(customerId, status, extra = {}, customMsg = null) {
    try {
      const existing = state.billings.get(customerId);
      // saveOne 이 항상 선행 실행되므로 existing 없는 경우는 발생하지 않음
      // 단, 혹시 billings 맵이 비어있다면 에러로 처리
      if (!existing) {
        toast('청구서 생성에 실패했습니다. 새로고침 후 다시 시도하세요.', 'error');
        return;
      }
      const patch = { status };
      // extra의 null 값도 그대로 포함해야 컬럼이 비워짐
      Object.keys(extra).forEach((k) => { patch[k] = extra[k]; });
      if (status === 'sent' && !existing.issued_at) {
        patch.issued_at = new Date().toISOString().slice(0, 10);
      }
      if (status === 'paid' && !existing.paid_at) {
        patch.paid_at = new Date().toISOString().slice(0, 10);
      }
      const { data, error } = await sb()
        .from('rental_billings')
        .update(patch)
        .eq('id', existing.id)
        .select()
        .single();
      if (error) throw error;
      // B안: Supabase 응답이 null 이거나 status 가 의도와 다를 경우 patch 를 우선 적용
      console.log('[billing] updateStatus result', data && data.status, JSON.stringify(data));
      if (data) {
        // DB 응답이 있으면 병합 (기존 → patch → DB 응답 순으로 덮어씀)
        // 단, patch 에 명시적 null 값이 있으면 DB 응답이 덮어씌우지 못하도록 재적용
        const merged = { ...existing, ...patch, ...data };
        // patch 의 null 값을 명시적으로 재적용 (DB 응답이 기존 값을 돌려줬을 때 대비)
        Object.keys(patch).forEach((k) => {
          if (patch[k] === null) merged[k] = null;
        });
        if (merged.status !== status) {
          console.warn('[billing] updateStatus: DB 반환 status 불일치 — 강제 보정', merged.status, '->', status);
          merged.status = status;
        }
        console.log('[billing] updateStatus merged.status:', merged.status, '| merged.sent_via:', merged.sent_via);
        state.billings.set(customerId, merged);
      } else {
        // 응답 없으면 patch 로 강제 갱신
        console.warn('[billing] updateStatus: Supabase data=null — patch 로 강제 갱신');
        state.billings.set(customerId, { ...existing, ...patch });
      }
      renderAll();
      if (customMsg) {
        toast(customMsg, 'ok');
      } else {
        const viaStr = extra.sent_via ? ` (${labelSentVia(extra.sent_via)})` : '';
        toast(`상태를 '${labelStatus(status)}'(으)로 변경${viaStr}.`, 'ok');
      }
    } catch (e) {
      console.error('[billing] status error', JSON.stringify(e));
      toast('상태 변경 실패: ' + (e.message || JSON.stringify(e)), 'error');
    }
  }

  // ── 수단별 직접 발송 (단일 거래처) ────────────────────────
  // via: 'fax' | 'kakao' | 'email'
  async function sendVia(customerId, via) {
    try {
      await saveOne(customerId, { silent: true });
      await updateStatus(customerId, 'sent', { sent_via: via });
    } catch (e) {
      // saveOne 에서 이미 토스트 표시 — 추가 처리 불필요
      return;
    }

    const c = state.customers.find((x) => x.id === customerId);
    const billing = state.billings.get(customerId);
    const calc = computeBilling(customerId);
    const counterDiscount = state.discounts.get(customerId) || 0;
    const total = billing && billing.total != null ? billing.total : calc.total;
    const fixedTotal = billing ? (billing.fixed_total || 0) : (calc.fixed_total || 0);
    const usageTotal = billing ? (billing.usage_total || 0) : (calc.usage_total || 0);

    // 사용량 행에서 흑백/컬러 초과료 분리
    const usageRows = calc.items.filter((x) => x.kind === 'usage');
    let bwExtra = 0, coExtra = 0;
    for (const r of usageRows) {
      const bwPrev  = r.counter_bw_prev || 0;
      const bwCur   = r.counter_bw || 0;
      const bwFree  = r.bw_free || 0;
      const bwMonth = r.month_bw != null ? r.month_bw : Math.max(0, bwCur - bwPrev);
      const bwEx    = bwMonth - bwFree;
      if (bwEx > 0) bwExtra += bwEx * (r.bw_rate || 0);

      const coPrev  = r.counter_color_prev || 0;
      const coCur   = r.counter_color || 0;
      const coFree  = r.co_free || 0;
      const coMonth = r.month_co != null ? r.month_co : Math.max(0, coCur - coPrev);
      const coEx    = coMonth - coFree;
      if (coEx > 0) coExtra += coEx * (r.co_rate || 0);
    }

    const company  = c ? c.company : '';
    const billYm   = nextMonth(state.ym);         // 예: 2026-05
    const dataYm   = state.ym;                    // 예: 2026-04
    const [by, bm] = billYm.split('-').map(Number);
    const byShort  = String(by).slice(2);
    const billLabel = `${byShort}.${String(bm).padStart(2,'0')}월`;
    const discountLine = counterDiscount > 0
      ? `\n추가요금 할인: -${fmtKRW(counterDiscount)}원` : '';

    // Phase 2: 합산 기간 표시
    const bpSend = calc.billingPeriod;
    const periodLine = (bpSend && bpSend.monthsCount > 1)
      ? `합산기간: ${bpSend.periodStart}~${bpSend.periodEnd} (${bpSend.monthsCount}개월 합산)`
      : `사용기간: ${dataYm}`;

    const summaryText =
`[디직스코리아 청구서]
거래처: ${company}
청구월: ${billLabel} (${periodLine})
합계: ${fmtKRW(total)}원 (VAT별도)

유지보수 및 임대료: ${fmtKRW(fixedTotal)}원
흑백 추가: ${fmtKRW(bwExtra)}원
컬러 추가: ${fmtKRW(coExtra)}원${discountLine}`;

    if (via === 'fax') {
      // 팩스: 인쇄 다이얼로그 자동 호출
      window.print();
      toast('팩스 발송 처리 완료 — 인쇄/PDF 다이얼로그를 열었습니다.', 'ok');

    } else if (via === 'kakao') {
      // 카카오톡: 요약 텍스트 클립보드 복사
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(summaryText);
          toast('카카오톡 발송 처리 완료 — 청구서 요약을 클립보드에 복사했습니다. 카카오톡에 붙여넣어 전송하세요.', 'ok');
        } catch (clipErr) {
          // 권한 거부 시 fallback: textarea + execCommand
          _clipboardFallback(summaryText);
          toast('카카오톡 발송 처리 완료 — 클립보드 복사(대체 방식). 카카오톡에 붙여넣어 전송하세요.', 'ok');
        }
      } else {
        // 구형 브라우저 fallback
        _clipboardFallback(summaryText);
        toast('카카오톡 발송 처리 완료 — 클립보드 복사(대체 방식). 카카오톡에 붙여넣어 전송하세요.', 'ok');
      }

    } else if (via === 'email') {
      const email   = (c && c.email) ? c.email.trim() : '';
      const subject = `[디직스코리아] ${company} ${billLabel}청구 임대료 청구서`;

      // ── PDF 파일명 생성 (파일명 부적합 문자 제거) ──
      const safeCompany = company.replace(/[\\/:*?"<>|]/g, '');
      const safeBillLabel = billLabel.replace(/[\\/:*?"<>|]/g, '');
      const pdfFilename = `디직스코리아_청구서_${safeCompany}_${safeBillLabel}.pdf`;

      // ── PDF 생성 + 다운로드 ──
      toast('PDF 생성 중... 잠시 기다려 주세요.', 'ok');
      let pdfGenerated = false;
      try {
        const invEl = document.querySelector('#rb-detail .rb-inv-section');
        if (invEl && typeof html2pdf !== 'undefined') {
          const opts = {
            margin: 10,
            filename: pdfFilename,
            image: { type: 'jpeg', quality: 0.95 },
            // windowWidth 고정 — 모바일에서 생성해도 데스크톱 레이아웃(거래처 정보 가로 3줄 등)으로 캡처
            html2canvas: { scale: 2, useCORS: true, logging: false, windowWidth: 1200 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
          };
          await html2pdf().set(opts).from(invEl).save();
          pdfGenerated = true;
        } else {
          console.warn('[billing] html2pdf 미로드 또는 .rb-inv-section 없음 — PDF 생성 건너뜀');
        }
      } catch (pdfErr) {
        console.error('[billing] PDF 생성 오류', pdfErr);
      }

      // ── Gmail 본문 구성 (첨부 안내 포함) ──
      const attachGuide = pdfGenerated
        ? `\n\n※ 첨부파일: 방금 다운로드된 『${pdfFilename}』을 메일에 첨부해 주세요.`
        : '';
      const body =
`안녕하세요, 디직스코리아입니다.

${company} 귀중

${billLabel} (${periodLine}) 임대료 청구서를 아래와 같이 발송해 드립니다.

${summaryText}

감사합니다.
디직스코리아 드림${attachGuide}`;

      const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.open(gmailUrl, '_blank', 'noopener,noreferrer');

      if (!email) {
        if (pdfGenerated) {
          toast(`PDF 다운로드 완료 + Gmail 작성창을 열었습니다. 수신자를 직접 입력하고, 다운로드한 『${pdfFilename}』를 첨부하세요.`, 'warn');
        } else {
          toast('수신자 이메일이 없습니다 — Gmail 작성창을 열었습니다. 수신자를 직접 입력하세요.', 'warn');
        }
      } else {
        if (pdfGenerated) {
          toast(`PDF 다운로드 완료 + Gmail 작성창을 열었습니다. 다운로드한 『${pdfFilename}』를 메일에 첨부하세요.`, 'ok');
        } else {
          toast('이메일 발송 처리 완료 — Gmail 작성창을 열었습니다.', 'ok');
        }
      }
    }
  }

  // 클립보드 API 미지원/권한 거부 시 execCommand 대체 복사
  function _clipboardFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {
      console.warn('[billing] clipboard fallback 실패', e);
    }
  }

  // ── 발송수단 선택 모달 (단일 거래처 직접 버튼 방식으로 대체됨 — 코드 유지) ──
  const VIA_OPTIONS = [
    { value: 'fax',    label: '팩스' },
    { value: 'kakao',  label: '카카오톡' },
    { value: 'email',  label: '이메일' },
  ];
  function labelSentVia(via) {
    return (VIA_OPTIONS.find((o) => o.value === via) || { label: via || '' }).label;
  }

  function openSentViaModal(customerId) {
    // 기존 모달 제거
    const old = document.getElementById('rb-via-modal-overlay');
    if (old) old.remove();

    let selected = VIA_OPTIONS[0].value;

    const overlay = document.createElement('div');
    overlay.id = 'rb-via-modal-overlay';
    overlay.className = 'rb-modal-overlay';
    overlay.innerHTML = `
      <div class="rb-modal" role="dialog" aria-modal="true" aria-labelledby="rb-via-title">
        <h3 id="rb-via-title">발송 처리 — 발송수단 선택</h3>
        <div class="rb-via-options">
          ${VIA_OPTIONS.map((o, i) => `
            <label class="rb-via-option${i === 0 ? ' selected' : ''}">
              <input type="radio" name="rb-via" value="${o.value}"${i === 0 ? ' checked' : ''}>
              ${escapeHtml(o.label)}
            </label>
          `).join('')}
        </div>
        <div class="rb-modal-actions">
          <button class="btn ghost" id="rb-via-cancel">취소</button>
          <button class="btn primary" id="rb-via-confirm">발송 처리</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // 라디오 선택 반영
    overlay.querySelectorAll('input[name=rb-via]').forEach((r) => {
      r.addEventListener('change', () => {
        selected = r.value;
        overlay.querySelectorAll('.rb-via-option').forEach((el) => el.classList.remove('selected'));
        r.closest('.rb-via-option').classList.add('selected');
      });
    });

    overlay.querySelector('#rb-via-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#rb-via-confirm').addEventListener('click', async () => {
      overlay.remove();
      // 발송 처리 = 저장(upsert) + 상태 sent 변경 (한 번에 처리)
      // saveOne 실패 시 updateStatus 는 실행되지 않음 (re-throw 로 중단)
      try {
        await saveOne(customerId, { silent: true });
        await updateStatus(customerId, 'sent', { sent_via: selected });
      } catch (e) {
        // saveOne 에서 이미 toast 띄움 — 여기선 추가 처리 불필요
      }
    });
    // 오버레이 클릭으로 닫기
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ── 일괄 발송 모달 (다중 선택용) ──────────────────────────
  function openBulkSentViaModal(ids, onConfirm) {
    const old = document.getElementById('rb-via-bulk-overlay');
    if (old) old.remove();

    // sent/void 제외한 유효 ID 만 처리
    const validIds = ids.filter((cid) => {
      const b = state.billings.get(cid);
      return !b || (b.status !== 'sent' && b.status !== 'void');
    });
    if (!validIds.length) {
      toast('발송 처리 가능한 거래처가 없습니다.', 'info');
      return;
    }

    let selected = VIA_OPTIONS[0].value;

    const overlay = document.createElement('div');
    overlay.id = 'rb-via-bulk-overlay';
    overlay.className = 'rb-modal-overlay';
    overlay.innerHTML = `
      <div class="rb-modal" role="dialog" aria-modal="true" aria-labelledby="rb-via-bulk-title">
        <h3 id="rb-via-bulk-title">${validIds.length}건 일괄 발송 — 발송수단 선택</h3>
        <div class="rb-via-options">
          ${VIA_OPTIONS.map((o, i) => `
            <label class="rb-via-option${i === 0 ? ' selected' : ''}">
              <input type="radio" name="rb-via-bulk" value="${o.value}"${i === 0 ? ' checked' : ''}>
              ${escapeHtml(o.label)}
            </label>
          `).join('')}
        </div>
        <div class="rb-modal-actions">
          <button class="btn ghost" id="rb-via-bulk-cancel">취소</button>
          <button class="btn primary" id="rb-via-bulk-confirm">일괄 발송 처리</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('input[name=rb-via-bulk]').forEach((r) => {
      r.addEventListener('change', () => {
        selected = r.value;
        overlay.querySelectorAll('.rb-via-option').forEach((el) => el.classList.remove('selected'));
        r.closest('.rb-via-option').classList.add('selected');
      });
    });

    overlay.querySelector('#rb-via-bulk-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#rb-via-bulk-confirm').addEventListener('click', () => {
      overlay.remove();
      onConfirm(validIds, selected);
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // ── 선택 항목 일괄 발송 처리 ────────────────────────────────
  async function bulkSend(ids, sentVia) {
    const progressEl = document.getElementById('rb-bulk-progress');
    const bulkBtn = document.getElementById('rb-bulk-send');
    if (bulkBtn) bulkBtn.disabled = true;

    let done = 0, failed = 0;
    const total = ids.length;

    for (const cid of ids) {
      if (progressEl) progressEl.textContent = `${done + 1}/${total} 처리 중…`;
      try {
        await saveOne(cid, { silent: true });
        await updateStatus(cid, 'sent', { sent_via: sentVia });
        done += 1;
      } catch (e) {
        console.error('[billing] bulkSend 실패 — cid:', cid, e);
        failed += 1;
      }
    }

    if (progressEl) progressEl.textContent = '';
    // 완료 후 선택 초기화
    state.selectedIds.clear();
    renderAll();

    if (failed > 0) {
      toast(`${done}건 발송 완료 (${labelSentVia(sentVia)}) · ${failed}건 실패 — 콘솔 확인`, 'error');
    } else {
      toast(`${done}건 발송 처리 완료 (수단: ${labelSentVia(sentVia)})`, 'ok');
    }
  }

  // ── 일괄 생성 — override 유지 (덮어쓰지 않음) ───────────────
  async function bulkGenerate() {
    if (state.loading) return;
    if (!confirm(`${state.ym} 청구서를 모든 활성 거래처(${state.customers.length}곳)에 대해 일괄 생성/갱신합니다.\n기존 draft 는 갱신, 발송/입금된 건은 건너뜁니다. 계속하시겠습니까?`)) {
      return;
    }

    setStatusText('일괄 생성 중…');
    const ym = state.ym;
    const rows = [];
    let skipped = 0, candidate = 0;

    for (const c of state.customers) {
      // override 포함 최종 계산값 사용 — 추가요금부(usage_total - counter_discount) > 0 인 경우만 생성 대상
      // 카운터 모듈 최종청구액 기준과 일치시킴 (고정료만 있는 거래처는 제외)
      const calc = computeBilling(c.id);
      const usageNet = (calc.usage_total || 0) - (calc.counter_discount || 0);
      if (usageNet <= 0) continue;
      candidate += 1;

      const existing = state.billings.get(c.id);
      if (existing && (existing.status === 'sent' || existing.status === 'paid')) {
        skipped += 1;
        continue;
      }

      // override 가 있는 거래처: 기존 청구가 이미 있으면 override 유지 (갱신 스킵)
      if (existing) {
        const hasAnyOverride = [...state.overrides.keys()].some((k) => k.startsWith(`${c.id}|`));
        if (hasAnyOverride) {
          skipped += 1;
          continue;
        }
      }

      rows.push({
        id: `b_${c.id}_${ym}`,
        customer_id: c.id,
        ym,
        fixed_total: calc.fixed_total,
        usage_total: calc.usage_total,
        // total 은 DB generated column 이므로 payload 에서 제외
        items: calc.items.map(stripMeta),
        status: existing ? existing.status : 'draft',
        ...(calc.counter_discount > 0 ? { counter_discount: calc.counter_discount } : {}),
      });
    }

    if (!rows.length) {
      setStatusText('생성할 청구서 없음');
      toast(`생성 대상 없음 (후보 ${candidate}건, 잠긴/override 건 ${skipped}건)`, 'info');
      return;
    }

    try {
      const CHUNK = 200;
      let ok = 0;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { data, error } = await sb()
          .from('rental_billings')
          .upsert(slice, { onConflict: 'customer_id,ym' })
          .select();
        if (error) throw error;
        (data || []).forEach((b) => state.billings.set(b.customer_id, b));
        ok += slice.length;
        setStatusText(`일괄 생성 중… ${ok}/${rows.length}`);
      }
      toast(`청구서 ${ok}건 생성/갱신 (잠긴/override 건 ${skipped}건 스킵)`, 'ok');
      setStatusText(`생성 완료: ${ok}건`);
      renderAll();
    } catch (e) {
      console.error('[billing] bulk error', JSON.stringify(e));
      const hint = (e.code === '42703' || (e.message || '').includes('column'))
        ? ' — 컬럼 누락. Supabase SQL ALTER TABLE 실행 필요.'
        : '';
      toast('일괄 생성 실패: ' + (e.message || JSON.stringify(e)) + hint, 'error');
      setStatusText('일괄 생성 실패');
    }
  }

  // ── 엑셀 다운로드 — override 병합 후 view 생성 ──────────────
  async function downloadExcel(customerId) {
    try {
      if (typeof XLSX === 'undefined') {
        toast('엑셀 라이브러리(XLSX) 로드 실패', 'error');
        return;
      }
      const c = state.customers.find((x) => x.id === customerId);
      if (!c) { toast('거래처를 찾을 수 없습니다', 'error'); return; }

      const ym = state.ym;
      // override 포함 최종 계산값으로 view 구성
      const calc = computeBilling(customerId);
      const view = {
        fixed_total: calc.fixed_total,
        usage_total: calc.usage_total,
        counter_discount: calc.counter_discount || 0,
        total: calc.total,
        items: calc.items,
      };

      const prevCnt = state.prevCounters;

      const aoa = [];
      const blank = () => aoa.push([]);

      aoa.push([`${c.company}  ${ym} 청구서`]);
      aoa.push([`사업자번호: ${c.biz_no || ''}   주소: ${c.address || ''}`]);
      blank();

      const fixedRows = view.items.filter((x) => x.kind === 'fixed');
      aoa.push([`고정 임대료 (${fixedRows.length}건)`]);
      aoa.push(['품목', '수량', '단가', '금액']);
      for (const r of fixedRows) {
        aoa.push([r.label || `${r.category}/${r.subtype}`, r.qty || 1, r.unit_price || 0, r.subtotal || 0]);
      }
      aoa.push(['소계', '', '', view.fixed_total]);
      blank();

      const usageRows = view.items.filter((x) => x.kind === 'usage');
      aoa.push([`사용량 초과 과금 (${usageRows.length}건)`]);
      aoa.push([
        '기기', '날짜',
        '흑백', '', '', '', '', '', '',
        '컬러', '', '', '', '', '', ''
      ]);
      aoa.push([
        '', '',
        '전월COUNT', '당월COUNT', '기본매수', '월카운터', '추가카운터', '추가사용단가', '추가사용료',
        '전월COUNT', '당월COUNT', '기본매수', '월카운터', '추가카운터', '추가사용단가', '추가사용료'
      ]);

      let bwExtraSum = 0, coExtraSum = 0;
      for (const r of usageRows) {
        const fromState = prevCnt.get(r.item_id) || { bw: 0, color: 0 };
        const prevBw = (r.counter_bw_prev != null) ? r.counter_bw_prev : (fromState.bw || 0);
        const prevCo = (r.counter_color_prev != null) ? r.counter_color_prev : (fromState.color || 0);
        const bwCur   = r.counter_bw || 0;
        const coCur   = r.counter_color || 0;
        const bwMonth = (r.month_bw != null) ? r.month_bw : Math.max(0, bwCur - prevBw);
        const coMonth = (r.month_co != null) ? r.month_co : Math.max(0, coCur - prevCo);
        const bwExtra = bwMonth - (r.bw_free || 0);
        const coExtra = coMonth - (r.co_free || 0);
        const bwFee   = bwExtra > 0 ? bwExtra * (r.bw_rate || 0) : 0;
        const coFee   = coExtra > 0 ? coExtra * (r.co_rate || 0) : 0;
        bwExtraSum += bwFee;
        coExtraSum += coFee;
        aoa.push([
          r.label || r.subtype || '',
          ym,
          prevBw, bwCur, r.bw_free || 0, bwMonth, bwExtra, r.bw_rate || 0, bwFee,
          prevCo, coCur, r.co_free || 0, coMonth, coExtra, r.co_rate || 0, coFee
        ]);
      }
      if (!usageRows.length) {
        aoa.push(['(초과 사용 없음)']);
      }
      blank();

      aoa.push(['', '', '', '', '', '', '', '흑백추가', bwExtraSum]);
      aoa.push(['', '', '', '', '', '', '', '칼라추가', coExtraSum]);
      aoa.push(['', '', '', '', '', '', '', '고정임대료', view.fixed_total]);
      if ((view.counter_discount || 0) > 0) {
        aoa.push(['', '', '', '', '', '', '', '추가요금 할인', -(view.counter_discount)]);
      }
      aoa.push(['', '', '', '', '', '', '', '총 청구액', view.total, '', '', '', '부가세별도']);

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [
        { wch: 22 }, { wch: 10 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 },
        { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${ym} 청구`);

      const safeName = String(c.company || 'customer').replace(/[\\\/:*?"<>|]/g, '_');
      const filename = `청구서_${safeName}_${ym}.xlsx`;
      XLSX.writeFile(wb, filename);
      toast('엑셀 다운로드 완료', 'ok');
    } catch (e) {
      console.error('[billing] excel error', e);
      toast('엑셀 생성 실패: ' + (e.message || e), 'error');
    }
  }

  function prevMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // 데이터월 → 청구월 변환 (state.ym = 데이터월, 청구월 = nextMonth(state.ym))
  function nextMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m, 1); // m은 0-based이고 m-1+1=m이므로 다음달
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function ymRange(ym, count) {
    const [y, m] = ym.split('-').map(Number);
    const out = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(y, m - 1 - i, 1);
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  }
  function ymMinus(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 - n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function ymPlus(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // ym1 < ym2 이면 음수, ym1 === ym2 이면 0, ym1 > ym2 이면 양수
  function ymDiff(ym1, ym2) {
    const [y1, m1] = ym1.split('-').map(Number);
    const [y2, m2] = ym2.split('-').map(Number);
    return (y1 - y2) * 12 + (m1 - m2);
  }
  function periodLabel(ym, months) {
    if (months <= 1) return ym;
    const startYm = ymMinus(ym, months - 1);
    const [y, m] = ym.split('-').map(Number);
    if (months === 3) {
      const q = Math.ceil(m / 3);
      return `${y}년 ${q}분기 (${startYm}~${ym})`;
    }
    if (months === 6) {
      return `${y}년 ${m <= 6 ? '상반기' : '하반기'} (${startYm}~${ym})`;
    }
    if (months === 12) {
      return `${y}년 (${startYm}~${ym})`;
    }
    return `${months}개월 (${startYm}~${ym})`;
  }

  // ── 청구 기간 계산 (Phase 2 핵심 함수) ─────────────────────
  // 입력:
  //   billingMonths: 1 | 3 | 6 | 12
  //   startDate:     'YYYY-MM-DD' | null  (billing_started_at; null 허용)
  //   currentYm:     'YYYY-MM'             (현재 선택된 데이터월)
  // 출력:
  //   isBillingMonth: boolean
  //   periodStart:    'YYYY-MM'  (합산 기간 시작 사용월)
  //   periodEnd:      'YYYY-MM'  (합산 기간 끝 사용월)
  //   monthsCount:    number     (실제 합산 개월 수)
  //   nextBillingYm:  'YYYY-MM'  (다음 청구 발행월 — 데이터월 기준, 청구월은 +1)
  //
  // 핵심 캘린더 규칙:
  //   billingMonths=1  → 항상 청구. periodStart/End = currentYm.
  //   billingMonths=3  → 데이터월이 3/6/9/12월일 때 청구.
  //   billingMonths=6  → 데이터월이 6/12월일 때 청구.
  //   billingMonths=12 → 데이터월이 12월일 때 청구.
  //   첫 청구: startDate(YYYY-MM) 이후 첫 번째 캘린더 경계(마지막 월)가 periodEnd.
  //            periodStart = startDate 의 년월.
  function computeBillingPeriod(billingMonths, startDate, currentYm) {
    // ── 월별 ───────────────────────────────────────────────────
    if (billingMonths === 1) {
      return {
        isBillingMonth: true,
        periodStart: currentYm,
        periodEnd: currentYm,
        monthsCount: 1,
        nextBillingYm: nextMonth(currentYm),
      };
    }

    // ── 폴백: startDate 없으면 2020-01 (항상 정상 캘린더 정렬) ─
    let startYm;
    if (startDate && /^\d{4}-\d{2}(-\d{2})?$/.test(startDate)) {
      startYm = startDate.slice(0, 7); // 'YYYY-MM'
    } else {
      startYm = '2020-01';
    }

    // ── 캘린더 경계 계산 ───────────────────────────────────────
    // billingMonths=3  → 청구 경계 달: 3, 6, 9, 12
    // billingMonths=6  → 청구 경계 달: 6, 12
    // billingMonths=12 → 청구 경계 달: 12
    function boundaryMonths(bm) {
      if (bm === 3)  return [3, 6, 9, 12];
      if (bm === 6)  return [6, 12];
      if (bm === 12) return [12];
      return [];
    }
    const bounds = boundaryMonths(billingMonths);

    // currentYm 이 경계달인지
    const [curY, curM] = currentYm.split('-').map(Number);
    const isAtBoundary = bounds.includes(curM);

    if (!isAtBoundary) {
      // 청구월이 아닌 달 — 다음 경계달 계산
      let nextBoundM = bounds.find((b) => b > curM) || bounds[0];
      let nextBoundY = (nextBoundM > curM) ? curY : curY + 1;
      const nextBillingYm = `${nextBoundY}-${String(nextBoundM).padStart(2, '0')}`;
      // periodStart/End 는 참고용으로 해당 구간을 돌려줌 (isBillingMonth=false)
      // periodStart = startYm vs. 직전 경계달+1 중 더 늦은 것
      let prevBoundM = [...bounds].reverse().find((b) => b < curM) || bounds[bounds.length - 1];
      let prevBoundY = (prevBoundM < curM) ? curY : curY - 1;
      const prevBoundYm = `${prevBoundY}-${String(prevBoundM).padStart(2, '0')}`;
      const calendarPeriodStart = ymPlus(prevBoundYm, 1); // 직전 경계달 다음달
      const effectiveStart = ymDiff(startYm, calendarPeriodStart) > 0 ? startYm : calendarPeriodStart;
      return {
        isBillingMonth: false,
        periodStart: effectiveStart,
        periodEnd: nextBillingYm,
        monthsCount: ymDiff(nextBillingYm, effectiveStart) + 1,
        nextBillingYm,
      };
    }

    // ── 청구월 확정 — periodEnd = currentYm ────────────────────
    const periodEnd = currentYm;

    // ── 정상 캘린더 기준 periodStart ───────────────────────────
    // billingMonths=3 에서 curM=3 이면 1월, curM=6 이면 4월, ...
    // billingMonths=6 에서 curM=6 이면 1월, curM=12 이면 7월
    // billingMonths=12 에서 curM=12 이면 1월
    const calendarPeriodStartM = curM - billingMonths + 1; // 예: 3-3+1=1, 6-6+1=1, 12-12+1=1
    let calendarPeriodStartY = curY;
    let adjM = calendarPeriodStartM;
    while (adjM <= 0) {
      adjM += 12;
      calendarPeriodStartY -= 1;
    }
    const calendarPeriodStart = `${calendarPeriodStartY}-${String(adjM).padStart(2, '0')}`;

    // ── 첫 청구 판정 ───────────────────────────────────────────
    // startYm 이 calendarPeriodStart 보다 늦으면 → 첫 청구 (부분 기간)
    // startYm 이 calendarPeriodStart 이하이면 → 정상 캘린더
    let periodStart;
    if (ymDiff(startYm, calendarPeriodStart) > 0) {
      // startYm > calendarPeriodStart → 첫 청구 부분 기간
      // startYm 이 periodEnd 보다 미래이면 이번 달은 아직 청구 아님
      if (ymDiff(startYm, periodEnd) > 0) {
        // 시작일이 periodEnd 보다 미래 → 이 경계는 해당 없음
        // 다음 경계달 계산 후 false 반환
        let nextBoundIdx = bounds.indexOf(curM) + 1;
        let nextBoundM, nextBoundY;
        if (nextBoundIdx < bounds.length) {
          nextBoundM = bounds[nextBoundIdx];
          nextBoundY = curY;
        } else {
          nextBoundM = bounds[0];
          nextBoundY = curY + 1;
        }
        const nextBillingYm = `${nextBoundY}-${String(nextBoundM).padStart(2, '0')}`;
        return {
          isBillingMonth: false,
          periodStart: startYm,
          periodEnd: nextBillingYm,
          monthsCount: ymDiff(nextBillingYm, startYm) + 1,
          nextBillingYm,
        };
      }
      periodStart = startYm;
    } else {
      // 정상 캘린더 정렬
      periodStart = calendarPeriodStart;
    }

    const monthsCount = ymDiff(periodEnd, periodStart) + 1;

    // 다음 청구 경계
    let nextBoundIdx = bounds.indexOf(curM) + 1;
    let nextBoundM, nextBoundY;
    if (nextBoundIdx < bounds.length) {
      nextBoundM = bounds[nextBoundIdx];
      nextBoundY = curY;
    } else {
      nextBoundM = bounds[0];
      nextBoundY = curY + 1;
    }
    const nextBillingYm = `${nextBoundY}-${String(nextBoundM).padStart(2, '0')}`;

    return {
      isBillingMonth: true,
      periodStart,
      periodEnd,
      monthsCount,
      nextBillingYm,
    };
  }

  // ── 거래처의 청구 시작일(startDate) 해석 ──────────────────
  // billing_started_at → 폴백 없으면 '2020-01-01'
  function getCustomerStartDate(customer) {
    if (customer && customer.billing_started_at) return customer.billing_started_at;
    return '2020-01-01';
  }

  // ── 통합 렌더 ───────────────────────────────────────────────
  function renderAll() {
    renderStats();
    renderList();
    renderDetail();
  }

  // ── 부트스트랩 ──────────────────────────────────────────────
  function attachEvents() {
    const ymInput = $('#rb-ym');
    if (ymInput) {
      // input에는 청구월(nextMonth) 표시, state.ym은 데이터월 유지
      ymInput.value = nextMonth(state.ym);
      const dataYmEl = document.getElementById('rb-data-ym');
      if (dataYmEl) dataYmEl.textContent = `사용 기간: ${state.ym}`;
      ymInput.addEventListener('change', () => {
        const v = (ymInput.value || '').trim();
        if (!/^\d{4}-\d{2}$/.test(v)) {
          toast('월 형식이 올바르지 않습니다.', 'error');
          ymInput.value = nextMonth(state.ym);
          return;
        }
        // 사용자가 청구월을 선택하면 데이터월로 역변환
        state.ym = prevMonth(v);
        // 사용 기간 보조 텍스트 갱신
        const dataYmEl = document.getElementById('rb-data-ym');
        if (dataYmEl) dataYmEl.textContent = `사용 기간: ${state.ym}`;
        state.selectedIds.clear(); // ym 변경 시 선택 초기화
        loadAll();
      });
    }

    const sBox = $('#rb-search');
    if (sBox) {
      sBox.addEventListener('input', () => {
        state.filterText = sBox.value || '';
        renderList();
      });
    }

    // 일괄 발송 버튼
    const bulkSendBtn = document.getElementById('rb-bulk-send');
    if (bulkSendBtn) {
      bulkSendBtn.addEventListener('click', () => {
        const ids = Array.from(state.selectedIds);
        openBulkSentViaModal(ids, (validIds, sentVia) => {
          bulkSend(validIds, sentVia);
        });
      });
    }

    // "전체 보기" 토글 — 기본값은 발생 업체만(onlyOverage=true)
    const showAllChk = $('#rb-show-all');
    if (showAllChk) {
      // 체크 = 전체 보기 (onlyOverage = false)
      showAllChk.checked = !state.onlyOverage;
      showAllChk.addEventListener('change', () => {
        state.onlyOverage = !showAllChk.checked;
        localStorage.setItem(LS_ONLY_OVERAGE, String(!showAllChk.checked));
        renderList();
      });
    }
  }

  function start() {
    // state.ym = 데이터월(사용 기간). 화면 표시는 nextMonth(state.ym) = 청구월로 보여줌.
    // 오늘이 2026-05 이면 state.ym = 2026-04(데이터월), 툴바 input = 2026-05(청구월).
    state.ym = prevMonth(todayYM());
    attachEvents();
    loadAll();
  }

  // auth.js 가 totalas:ready 발행 후 시작
  if (window.currentUser && window.totalasAuth) {
    start();
  } else {
    document.addEventListener('totalas:ready', start, { once: true });
  }
})();
