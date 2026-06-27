// ===========================================================
// totalas — 임대카운터 (rental-counters)
// 실데이터 Supabase 연동
//  · 월별 BW/컬러/uptime 카운터 입력 (upsert by item_id+ym)
//  · 이전 6개월 평균 대비 이상치 경고
//  · 토너/잉크/필터 잔여 일수 예측
// ===========================================================
'use strict';

// 평균 소모품 수명 (장당) — 카테고리/subtype별 기본값
const TONER_LIFE = {
  laser:    { bw: 12000, color: 8000 },
  printer:  { bw: 10000, color: 6000 }, // generic printer
  inkjet:   { bw: 1500,  color: 1200 },
  복합기:    { bw: 12000, color: 8000 },
};
const FILTER_LIFE_DAYS = 180; // 웰리스 필터 6개월

const supa = window.totalasAuth || (window.supabase && window.TOTALAS
  ? supabase.createClient(window.TOTALAS.URL, window.TOTALAS.PUBLISHABLE, {
      auth: { storageKey: window.TOTALAS.AUTH_KEY, persistSession: true, autoRefreshToken: true }
    })
  : null);

const state = {
  ym: ymOfNow(),
  customerQuery: '',
  onlyMissing: false,
  items: [],            // 자산 + 배정 + 거래처
  curMap: {},           // item_id → 이번달 row
  prevMap: {},          // item_id → 이전월 row
  histMap: {},          // item_id → [ {ym, bw, color, uptime_hours} ... ]  (최근 6개월)
  suppliesMap: {},      // item_id → 최근 supplies row
  itemsEverCounted: new Set(),     // 과거 어느 달이든 카운터 1건 이상 입력된 item_id
  customersEverCounted: new Set(), // 과거 어느 달이든 카운터 입력된 customer_id
  customers: [],
  customerCombined: {}, // cid → boolean (합산 청구 여부 캐시)
  customerPeriod: {},   // cid → 1/3/6/12 (청구 주기 개월)
  drilldown: null,      // { new, entered, missing, anomaly }
  activeDrilldown: null,
  // 거래처별 자산 수 (1대만 가진 거래처는 합산 토글 숨김용)
  itemsPerCustomer: {},
  // 거래처 인라인 확장 (지난 자료 펼침)
  expandedCustomerId: null,
  expansionMonths: 6,                  // 3 / 6 / 12 (sticky)
  expansionRows: null,                 // Map: `${item_id}|${ym}` → {bw, color, uptime_hours}
  expansionLoading: false,
  // 카운터 오버 할인 (customer_id → amount)
  discountMap: {},
  // 이번달 청구 행 (customer_id → { usage_total, fixed_total, total, status }) — 청구와 정렬용
  billingsMap: {},
};

// auth.js 의 bootstrap() 이 완료되어 window.currentUser 가 채워질 때까지 대기
if (window.currentUser) {
  init();
} else {
  document.addEventListener('totalas:ready', init, { once: true });
  // 안전망 — 인증이 끝났는데 이벤트를 놓친 경우 대비
  setTimeout(() => {
    if (!state.items.length && window.currentUser) init();
  }, 4000);
}

async function init() {
  if (!supa) {
    toast('Supabase 클라이언트 초기화 실패', true);
    return;
  }
  // 가장 최근 업로드 이력이 있으면 그 월을 초기값으로
  await pickInitialYmFromUploads();
  document.getElementById('f-month').value = state.ym;
  updateYearHeader();
  document.getElementById('f-month').addEventListener('change', e => {
    state.ym = e.target.value || ymOfNow();
    updateYearHeader();
    reload();
  });
  document.getElementById('f-customer-search').addEventListener('input', e => {
    state.customerQuery = e.target.value || '';
    render();
  });
  document.getElementById('f-only-missing').addEventListener('change', e => { state.onlyMissing = e.target.checked; render(); });

  // 상세 컬럼 토글 (기본매수·월카운터·추가사용단가)
  const showDetailSaved = localStorage.getItem('rc.showDetail') === '1';
  const showDetailEl = document.getElementById('f-show-detail');
  const gridEl = document.querySelector('.counters-grid');
  const applyShowDetail = on => {
    gridEl.classList.toggle('show-detail', on);
    // 첫 행 그룹 헤더(흑백/컬러)의 colspan을 보이는 컬럼 수에 맞춰 동기화
    gridEl.querySelectorAll('thead tr:first-child th[colspan]').forEach(th => {
      th.colSpan = on ? 7 : 4;
    });
  };
  showDetailEl.checked = showDetailSaved;
  applyShowDetail(showDetailSaved);
  showDetailEl.addEventListener('change', e => {
    const on = e.target.checked;
    applyShowDetail(on);
    localStorage.setItem('rc.showDetail', on ? '1' : '0');
  });

  document.getElementById('btn-refresh').addEventListener('click', () => hardReload());

  // 통계 카드 클릭 → 드릴다운 토글
  document.querySelectorAll('#stats .stat-card').forEach(card => {
    card.addEventListener('click', () => {
      const key = card.dataset.drill;
      if (key) toggleDrilldown(key);
    });
  });
  document.getElementById('btn-drilldown-close').addEventListener('click', () => closeDrilldown());

  initExcelImport();

  await reload();
}

async function reload() {
  setBodyLoading();
  try {
    await Promise.all([loadCustomers(), loadItems(), loadCounters(), loadSupplies(), loadDiscounts(), loadBillings()]);
    deriveCustomersEverCounted();
    render();
    updateExcelTargetYm();
    rematchExcelRows();
    consumeOverageIntent();
  } catch (err) {
    console.error(err);
    toast('로드 실패: ' + (err.message || err), true);
    document.getElementById('grid-body').innerHTML =
      `<tr><td colspan="16" style="text-align:center; padding:20px; color:#dc2626;">데이터 로드 실패: ${escapeHtml(err.message || String(err))}</td></tr>`;
  }
}

// 임대추가요금청구 등 외부 모듈에서 더블클릭으로 넘어온 "특정 거래처 카운터오버 열기" 의도 처리.
// localStorage 'rc.intent' = { cid, ts } 가 최근(10초 이내) 기록돼 있으면 즉시 소비한다.
function consumeOverageIntent() {
  let intent = null;
  try {
    const raw = localStorage.getItem('rc.intent');
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.cid && obj.ts && (Date.now() - obj.ts) < 10000) intent = obj;
    }
  } catch {}
  if (!intent) return;
  try { localStorage.removeItem('rc.intent'); } catch {}

  const cust = state.customers.find(c => c.id === intent.cid);
  if (!cust) {
    toast('해당 거래처를 찾을 수 없습니다', true);
    return;
  }
  // 거래처명으로 메인 그리드 필터 — 카운터오버 닫더라도 사용자가 행을 바로 볼 수 있게
  const inp = document.getElementById('f-customer-search');
  if (inp) inp.value = cust.company || '';
  state.customerQuery = cust.company || '';
  render();
  // 카운터오버 드릴다운 열기
  if (state.activeDrilldown !== 'overage') toggleDrilldown('overage');
  // 드릴다운에서 해당 행 강조 + 스크롤 + 할인 input 포커스
  setTimeout(() => {
    const row = document.querySelector(`.drilldown-row[data-cid="${CSS.escape(cust.id)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.classList.add('intent-flash');
      setTimeout(() => row.classList.remove('intent-flash'), 1600);
      const disc = row.querySelector('input.disc-input');
      if (disc) { disc.focus(); disc.select?.(); }
    } else {
      toast('카운터오버에 표시되지 않는 거래처입니다 (추가요금/할인 0)', true);
    }
  }, 100);
}

async function loadCustomers() {
  // bill_combined / billing_months 컬럼이 아직 없는 환경에서도 동작하도록 시도-실패 분기
  let { data, error } = await supa.from('rental_customers')
    .select('id, company, bill_combined, billing_months').order('company');
  if (error && /column .* does not exist/i.test(error.message || '')) {
    console.warn('[loadCustomers] bill_combined/billing_months 컬럼 없음 — 17, 18 SQL 실행 필요');
    const fallback = await supa.from('rental_customers').select('id, company').order('company');
    if (fallback.error) throw fallback.error;
    data = (fallback.data || []).map(c => ({ ...c, bill_combined: false, billing_months: 1 }));
  } else if (error) {
    throw error;
  }
  state.customers = data || [];
  state.customerCombined = {};
  state.customerPeriod = {};
  for (const c of state.customers) {
    state.customerCombined[c.id] = !!c.bill_combined;
    state.customerPeriod[c.id]   = c.billing_months || 1;
  }
}

async function loadItems() {
  // rental_items + 배정/거래처 join (배정이 없는 자산은 LEFT join 결과로 null)
  const { data, error } = await supa.from('rental_items')
    .select(`
      id, category, subtype, brand, model, asset_number, serial, install_date, status,
      counter_mode, total_free_count, total_unit_price,
      rental_assignments ( customer_id, monthly_fee, bw_free, co_free, bw_rate, co_rate,
                            rental_customers ( id, company ) )
    `)
    .eq('status', 'active')
    .order('install_date', { ascending: false, nullsFirst: false })
    .order('id');
  if (error) throw error;
  state.items = (data || []).map(it => {
    const asgn = Array.isArray(it.rental_assignments) ? it.rental_assignments[0] : it.rental_assignments;
    return {
      id: it.id,
      category: it.category,
      subtype: it.subtype,
      brand: it.brand,
      model: it.model,
      asset_number: it.asset_number || null,
      serial: it.serial || null,
      install_date: it.install_date,
      customer_id: asgn?.customer_id || null,
      customer_name: asgn?.rental_customers?.company || '(미배정)',
      monthly_fee: asgn?.monthly_fee ?? 0,
      bw_rate: asgn?.bw_rate ?? 0,
      co_rate: asgn?.co_rate ?? 0,
      bw_free: asgn?.bw_free ?? 0,
      co_free: asgn?.co_free ?? 0,
      counter_mode: it.counter_mode || 'split',
      total_free_count: it.total_free_count ?? null,
      total_unit_price: it.total_unit_price ?? null,
    };
  });
}

async function loadCounters() {
  // 이번달 + 이전 6개월 한 번에 가져와서 클라이언트에서 그룹핑
  const monthsBack = listMonthsBack(state.ym, 7); // 이번달 + 6개월 전까지
  // "과거 어느 달이든 카운터 입력된" 집합은 ym 필터 없이 별도 조회
  const [detailRes, everRes] = await Promise.all([
    supa.from('rental_counters')
      .select('item_id, ym, bw, color, uptime_hours, read_at, source')
      .in('ym', monthsBack),
    supa.from('rental_counters')
      .select('item_id')
      .range(0, 99999),
  ]);
  if (detailRes.error) throw detailRes.error;
  if (everRes.error) throw everRes.error;

  const prevYm = listMonthsBack(state.ym, 2)[1]; // 직전월
  state.curMap = {};
  state.prevMap = {};
  state.histMap = {};

  for (const r of (detailRes.data || [])) {
    if (r.ym === state.ym) state.curMap[r.item_id] = r;
    else if (r.ym === prevYm) state.prevMap[r.item_id] = r;
    if (r.ym !== state.ym) {
      (state.histMap[r.item_id] ||= []).push(r);
    }
  }

  state.itemsEverCounted = new Set((everRes.data || []).map(r => r.item_id));
}

async function loadSupplies() {
  // 자산별 가장 최근 교체 기록 1건씩 (단순화: 전체 가져와 클라이언트 groupBy)
  const { data, error } = await supa.from('rental_supplies')
    .select('item_id, kind, changed_at, next_due, cost')
    .order('changed_at', { ascending: false });
  if (error) {
    // 테이블이 없을 수도 있음 — 경고만, 진행
    console.warn('[supplies] load skipped:', error.message);
    state.suppliesMap = {};
    return;
  }
  const map = {};
  for (const r of (data || [])) {
    if (!map[r.item_id]) map[r.item_id] = r;
  }
  state.suppliesMap = map;
}

async function loadBillings() {
  // 청구 모듈이 이번달에 저장해둔 rental_billings 행 — usage_total>0 이면 카운터오버 누락 보강용
  const { data, error } = await supa.from('rental_billings')
    .select('customer_id, fixed_total, usage_total, total, status')
    .eq('ym', state.ym);
  if (error) {
    console.warn('[billings] load skipped:', error.message);
    state.billingsMap = {};
    return;
  }
  const map = {};
  for (const r of (data || [])) {
    map[r.customer_id] = {
      fixed_total: r.fixed_total || 0,
      usage_total: r.usage_total || 0,
      total: r.total || 0,
      status: r.status || null,
    };
  }
  state.billingsMap = map;
}

async function loadDiscounts() {
  // 이번달 카운터 오버 할인 금액 로드
  const { data, error } = await supa.from('rental_counter_discounts')
    .select('customer_id, ym, amount, memo')
    .eq('ym', state.ym);
  if (error) {
    // 테이블이 아직 없으면 경고만 (26_counter_discounts.sql 실행 필요)
    console.warn('[discounts] load skipped:', error.message);
    state.discountMap = {};
    return;
  }
  const map = {};
  for (const r of (data || [])) {
    map[r.customer_id] = r.amount || 0;
  }
  state.discountMap = map;
}

function deriveCustomersEverCounted() {
  const ever = new Set();
  for (const it of state.items) {
    if (it.customer_id && state.itemsEverCounted.has(it.id)) ever.add(it.customer_id);
  }
  state.customersEverCounted = ever;
}

function render() {
  const tbody = document.getElementById('grid-body');
  const q = normalize(state.customerQuery || '');
  let rows = state.items
    .filter(it => it.customer_id && state.customersEverCounted.has(it.customer_id))
    .filter(it => !q || normalize(it.customer_name || '').includes(q))
    .map(it => buildRow(it))
    .filter(r => !state.onlyMissing || r.missing);

  // 거래처별 정렬 → 한 거래처의 첫 행에 합산 체크박스 표시
  rows.sort((a, b) => {
    const an = a.item.customer_name || '';
    const bn = b.item.customer_name || '';
    if (an !== bn) return an.localeCompare(bn);
    return (a.item.model || '').localeCompare(b.item.model || '');
  });
  state.itemsPerCustomer = {};
  for (const r of rows) {
    const cid = r.item.customer_id;
    if (cid) state.itemsPerCustomer[cid] = (state.itemsPerCustomer[cid] || 0) + 1;
  }
  let lastCid = null;
  for (const r of rows) {
    r._isCustomerFirst = r.item.customer_id !== lastCid;
    lastCid = r.item.customer_id;
  }

  // === 통계 ===
  // 신규 입력 = 이전월에 카운터 없었지만 이번달에 입력된 거래처 (= 새로 시작된 업체)
  // 카운터 입력된 업체 = 이번달 카운터 1건 이상 입력된 거래처 (총)
  // 입력 안된 업체 = 자산 보유 중 이번달 미입력 거래처
  // 이상치 경고 = 자산 단위 이상치 수
  let alerts = 0;
  const customerStats = new Map(); // cid → { id, name, items[], enteredItems[], anomalies[], overageItems[], bwTotal, coTotal, hadPrev, overageBwCharge, overageCoCharge }
  for (const r of rows) {
    const cid = r.item.customer_id;
    if (!cid) continue;
    if (!customerStats.has(cid)) {
      customerStats.set(cid, {
        id: cid, name: r.item.customer_name,
        items: [], enteredItems: [], anomalies: [], overageItems: [],
        bwTotal: 0, coTotal: 0,
        hadPrev: false,  // 이전월 카운터 존재 여부 (자산 1대라도)
        overageBwCharge: 0, overageCoCharge: 0,
      });
    }
    const cs = customerStats.get(cid);
    cs.items.push(r);
    if (r.cur) {
      cs.enteredItems.push(r);
      cs.bwTotal += (r.cur.bw || 0);
      cs.coTotal += (r.cur.color || 0);
    }
    if (r.prev) cs.hadPrev = true;
    if (r.anomaly) { alerts++; cs.anomalies.push(r); }
    // 오버: 청구 모듈과 동일 기준(직전월 누락=0)으로 추가요금이 0 초과인 자산
    // total 모드는 total_charge_billing 기준으로 판정
    const isOver = (r.item.counter_mode === 'total')
      ? (r.total_charge_billing || 0) > 0
      : ((r.bw_charge_billing || 0) > 0 || (r.co_charge_billing || 0) > 0);
    if (isOver) {
      cs.overageItems.push(r);
      if (r.item.counter_mode === 'total') {
        cs.overageBwCharge += (r.total_charge_billing || 0); // 합계 금액을 bw 쪽에 누적 (단일 금액)
      } else {
        cs.overageBwCharge += (r.bw_charge_billing || 0);
        cs.overageCoCharge += (r.co_charge_billing || 0);
      }
    }
  }

  // 합산청구 거래처는 자산별 추가요금 단순 합이 아니라
  // 전체 카운터를 합산한 뒤 합산 기본매수를 초과한 금액으로 재계산한다.
  // (renderCombinedSummaryRow 와 동일한 로직)
  for (const cs of customerStats.values()) {
    const cid = cs.id;
    if (!state.customerCombined[cid]) continue;
    const meterRows = cs.items.filter(r => r.isMeter);
    if (meterRows.length < 2) continue;

    let curBwT = 0, curCoT = 0, prevBwT = 0, prevCoT = 0;
    let bwFreeT = 0, coFreeT = 0;
    let bwRateWeightedSum = 0, coRateWeightedSum = 0;
    let bwFreeForWeight = 0, coFreeForWeight = 0;

    for (const r of meterRows) {
      // 청구 모듈과 동일하게 누락된 카운터는 0으로 처리 (운영 요구: 일부 누락돼도 합산 결과 표시)
      curBwT  += (r.bw_cur  || 0);
      curCoT  += (r.co_cur  || 0);
      prevBwT += (r.bw_prev || 0);
      prevCoT += (r.co_prev || 0);
      const bwFree = r.item.bw_free || 0;
      const coFree = r.item.co_free || 0;
      bwFreeT += bwFree; coFreeT += coFree;
      bwRateWeightedSum += (r.item.bw_rate || 0) * bwFree;
      coRateWeightedSum += (r.item.co_rate || 0) * coFree;
      bwFreeForWeight   += bwFree;
      coFreeForWeight   += coFree;
    }

    const bwMonthT = Math.max(0, curBwT - prevBwT);
    const coMonthT = Math.max(0, curCoT - prevCoT);
    const bwRate = bwFreeForWeight > 0
      ? bwRateWeightedSum / bwFreeForWeight
      : (meterRows.length > 0
          ? meterRows.reduce((s, r) => s + (r.item.bw_rate || 0), 0) / meterRows.length
          : 0);
    const coRate = coFreeForWeight > 0
      ? coRateWeightedSum / coFreeForWeight
      : (meterRows.length > 0
          ? meterRows.reduce((s, r) => s + (r.item.co_rate || 0), 0) / meterRows.length
          : 0);
    const bwExtra = bwMonthT - bwFreeT;
    const coExtra = coMonthT - coFreeT;
    const combinedBwCharge = bwExtra > 0 ? Math.round(bwExtra * bwRate) : 0;
    const combinedCoCharge = coExtra > 0 ? Math.round(coExtra * coRate) : 0;

    // 합산 후 실제 추가요금으로 덮어쓰기
    cs.overageBwCharge = combinedBwCharge;
    cs.overageCoCharge = combinedCoCharge;

    // overageItems: 합산 기준으로 초과 발생 여부 재판정
    if (combinedBwCharge > 0 || combinedCoCharge > 0) {
      // 자산-단위로는 초과가 0이라도 합산 시 초과면 meterRows 전체를 자산 수 표시용으로 채움
      if (cs.overageItems.length === 0) cs.overageItems = meterRows.slice();
    } else {
      // 합산 기준으로 초과 없음 → 드릴다운 오버 목록에서 제외
      cs.overageItems = [];
    }
  }

  // 청구 모듈에 저장된 rental_billings 의 usage_total 도 정렬 기준에 반영
  // (단가/매수 사후 변경 등으로 카운터 재계산은 0이지만 청구 저장본은 양수인 경우)
  for (const cs of customerStats.values()) {
    const b = state.billingsMap[cs.id];
    if (b && b.usage_total > 0) cs.billingUsageTotal = b.usage_total;
  }

  const all = [...customerStats.values()];
  const entered = all.filter(cs => cs.enteredItems.length > 0);
  const missing = all.filter(cs => cs.enteredItems.length === 0);
  const newly   = entered.filter(cs => !cs.hadPrev); // 이전월 미입력 → 이번달 입력
  const anomaly = all.filter(cs => cs.anomalies.length > 0);

  // 카운터 오버 = 청구 모듈의 "청구 사유 업체"와 동일 기준
  //   (1) 자산별 추가요금 > 0
  //   (2) 합산 추가요금 > 0
  //   (3) 청구 저장본 usage_total > 0
  //   (4) 할인 입력 > 0
  const overage = all.filter(cs =>
    cs.overageItems.length > 0 ||
    (cs.overageBwCharge || 0) > 0 || (cs.overageCoCharge || 0) > 0 ||
    (cs.billingUsageTotal || 0) > 0 ||
    (state.discountMap[cs.id] || 0) > 0
  );

  // customerStats 에 없는 phantom 거래처(카운터 이력은 없지만 청구/할인은 있는 케이스) 보강
  // → 드릴다운에 행이 생겨야 할인 입력 가능
  const seen = new Set(overage.map(cs => cs.id));
  const phantomSources = new Set([
    ...Object.keys(state.billingsMap || {}).filter(cid => (state.billingsMap[cid]?.usage_total || 0) > 0),
    ...Object.keys(state.discountMap || {}).filter(cid => (state.discountMap[cid] || 0) > 0),
  ]);
  for (const cid of phantomSources) {
    if (seen.has(cid)) continue;
    const cust = state.customers.find(c => c.id === cid);
    if (!cust) continue;
    const b = state.billingsMap[cid] || {};
    overage.push({
      id: cid,
      name: cust.company || '(이름없음)',
      items: [], enteredItems: [], anomalies: [], overageItems: [],
      bwTotal: 0, coTotal: 0,
      hadPrev: false,
      overageBwCharge: b.usage_total || 0,  // 청구 저장본 합계로 대체 (흑백/컬러 구분 정보 없음)
      overageCoCharge: 0,
      billingUsageTotal: b.usage_total || 0,
      _phantom: true,
    });
  }

  state.drilldown = { new: newly, entered, missing, anomaly, overage };

  document.getElementById('st-new').textContent = newly.length.toLocaleString();
  document.getElementById('st-co-done').textContent = entered.length.toLocaleString();
  document.getElementById('st-co-missing').textContent = missing.length.toLocaleString();
  document.getElementById('st-alerts').textContent = alerts.toLocaleString();
  document.getElementById('st-overage').textContent = overage.length.toLocaleString();
  document.getElementById('row-count').textContent = `${rows.length}개 자산`;

  // 활성 드릴다운 재렌더
  if (state.activeDrilldown) renderDrilldown(state.activeDrilldown);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="16" class="muted-small" style="text-align:center; padding:30px;">조건에 맞는 자산이 없습니다.</td></tr>';
    return;
  }

  // 거래처별 그룹 끝마다 확장 영역 + 합산 요약 행 삽입
  let html = '';
  lastCid = null;
  for (const r of rows) {
    const cid = r.item.customer_id;
    if (lastCid !== null && cid !== lastCid) {
      // 이전 거래처 그룹 종료 — 합산 청구 ON이면 합산 요약 행 삽입
      if (state.customerCombined[lastCid]) {
        html += renderCombinedSummaryRow(lastCid, rows.filter(rr => rr.item.customer_id === lastCid));
      }
      if (state.expandedCustomerId === lastCid) {
        html += renderExpansion(lastCid);
      }
    }
    html += renderRow(r);
    lastCid = cid;
  }
  if (lastCid !== null) {
    if (state.customerCombined[lastCid]) {
      html += renderCombinedSummaryRow(lastCid, rows.filter(rr => rr.item.customer_id === lastCid));
    }
    if (state.expandedCustomerId === lastCid) {
      html += renderExpansion(lastCid);
    }
  }
  tbody.innerHTML = html;
  attachCellHandlers();
}

function buildRow(item) {
  const cur  = state.curMap[item.id]  || null;
  const prev = state.prevMap[item.id] || null;
  const hist = state.histMap[item.id] || [];

  const isMeter = (item.category === 'printer') || (item.category === '출력') || ['laser', 'inkjet', '복합기'].includes(item.subtype);

  const bw_cur  = cur?.bw ?? null;
  const co_cur  = cur?.color ?? null;
  const bw_prev = prev?.bw ?? null;
  const co_prev = prev?.color ?? null;

  // 월카운터 = max(0, 당월 - 전월)
  const bw_month = (bw_cur != null && bw_prev != null) ? Math.max(0, bw_cur - bw_prev) : null;
  const co_month = (co_cur != null && co_prev != null) ? Math.max(0, co_cur - co_prev) : null;

  // 추가카운터 = max(0, 월카운터 - 기본매수)
  const bw_extra = bw_month != null ? Math.max(0, bw_month - (item.bw_free || 0)) : null;
  const co_extra = co_month != null ? Math.max(0, co_month - (item.co_free || 0)) : null;

  // 추가사용료 = 추가카운터 × 추가사용단가
  const bw_charge = bw_extra != null ? bw_extra * (item.bw_rate || 0) : null;
  const co_charge = co_extra != null ? co_extra * (item.co_rate || 0) : null;

  // 청구 모듈과 동일한 기준(직전월 누락 = 0)으로 산출한 오버 추가요금 — 분류/합산 전용
  const bw_month_billing = (bw_cur != null) ? Math.max(0, bw_cur - (bw_prev || 0)) : null;
  const co_month_billing = (co_cur != null) ? Math.max(0, co_cur - (co_prev || 0)) : null;
  const bw_extra_billing = bw_month_billing != null ? Math.max(0, bw_month_billing - (item.bw_free || 0)) : 0;
  const co_extra_billing = co_month_billing != null ? Math.max(0, co_month_billing - (item.co_free || 0)) : 0;
  const bw_charge_billing = bw_extra_billing * (item.bw_rate || 0);
  const co_charge_billing = co_extra_billing * (item.co_rate || 0);

  // 합계 모드(counter_mode='total') — bw+color 합산 단일 과금
  let total_charge_billing = 0;
  let total_extra_billing  = 0;
  let total_month_billing  = 0;
  if (item.counter_mode === 'total') {
    const tot_cur  = (bw_cur  != null ? bw_cur  : 0) + (co_cur  != null ? co_cur  : 0);
    const tot_prev = (bw_prev != null ? bw_prev : 0) + (co_prev != null ? co_prev : 0);
    // 당월 카운터가 하나라도 있어야 의미 있음
    if (bw_cur != null || co_cur != null) {
      total_month_billing = Math.max(0, tot_cur - tot_prev);
      total_extra_billing = Math.max(0, total_month_billing - (item.total_free_count || 0));
      total_charge_billing = Math.round(total_extra_billing * (item.total_unit_price || 0));
    }
  }

  // 이전 6개월 평균 증가량 (이상치 탐지용)
  const avgBW = avgIncrease(hist, 'bw');
  const avgCO = avgIncrease(hist, 'color');

  // 흑백 이상치 사유 수집
  const bwReasons = [];
  if (bw_month != null) {
    if (avgBW > 0 && bw_month > avgBW * 3)
      bwReasons.push(`평균의 3배 초과 (당월 ${bw_month.toLocaleString()}/평균 ${Math.round(avgBW).toLocaleString()})`);
    if (bw_cur != null && bw_prev != null && bw_cur === bw_prev)
      bwReasons.push('전월=당월 (변화 없음)');
    if (bw_cur != null && bw_prev != null && bw_cur < bw_prev)
      bwReasons.push('당월<전월 (감소)');
  }
  // 컬러 이상치 사유 수집
  const coReasons = [];
  if (co_month != null) {
    if (avgCO > 0 && co_month > avgCO * 3)
      coReasons.push(`평균의 3배 초과 (당월 ${co_month.toLocaleString()}/평균 ${Math.round(avgCO).toLocaleString()})`);
    if (co_cur != null && co_prev != null && co_cur === co_prev)
      coReasons.push('전월=당월 (변화 없음)');
    if (co_cur != null && co_prev != null && co_cur < co_prev)
      coReasons.push('당월<전월 (감소)');
  }
  const bwAnomaly = bwReasons.length > 0;
  const coAnomaly = coReasons.length > 0;
  const anomaly = bwAnomaly || coAnomaly;
  const anomalyReasons = [
    ...bwReasons.map(r => `흑백: ${r}`),
    ...coReasons.map(r => `컬러: ${r}`),
  ];

  return {
    item, cur, prev, isMeter,
    bw_prev, bw_cur, bw_month, bw_extra, bw_charge, bwAnomaly,
    co_prev, co_cur, co_month, co_extra, co_charge, coAnomaly,
    bw_charge_billing, co_charge_billing,
    total_month_billing, total_extra_billing, total_charge_billing,
    avgBW, avgCO,
    anomaly, anomalyReasons,
    missing: !cur,
  };
}

function avgIncrease(hist, field) {
  if (!hist || hist.length < 2) return 0;
  const sorted = hist.slice().sort((a, b) => a.ym.localeCompare(b.ym));
  const last6 = sorted.slice(-6);
  let total = 0, n = 0;
  for (let i = 1; i < last6.length; i++) {
    const a = last6[i - 1][field] ?? 0;
    const b = last6[i][field] ?? 0;
    if (b >= a) { total += (b - a); n++; }
  }
  return n ? total / n : 0;
}

function forecastSupply(item, bw_inc, co_inc) {
  // category/subtype 기반 toner life
  const key = item.subtype || item.category || '';
  const life = TONER_LIFE[key] || TONER_LIFE.printer;

  // 직전 교체 이후 누적 사용량 추정 — 직전월 카운터에서 +bw_inc / +co_inc 가 한 달치
  // (단순화) 월 증가량 → 평균 사용량으로 잔여 일수 = (life - used_since_change)/(daily_use)
  const last = state.suppliesMap[item.id];
  const out = [];

  if (item.category === 'printer' || ['laser','inkjet','복합기'].includes(item.subtype)) {
    // BW 토너
    const monthlyBW = bw_inc || 0;
    const dailyBW = monthlyBW / 30;
    const usedSinceBW = monthlyBW; // 단순: 이번달 사용량
    const remainBW = Math.max(0, life.bw - usedSinceBW);
    const daysBW = dailyBW > 0 ? Math.round(remainBW / dailyBW) : null;
    if (daysBW != null) out.push({ kind: 'BW토너', days: daysBW });

    if (life.color) {
      const monthlyCO = co_inc || 0;
      const dailyCO = monthlyCO / 30;
      const usedSinceCO = monthlyCO;
      const remainCO = Math.max(0, life.color - usedSinceCO);
      const daysCO = dailyCO > 0 ? Math.round(remainCO / dailyCO) : null;
      if (daysCO != null) out.push({ kind: '컬러토너', days: daysCO });
    }
  }
  if (item.category === 'wellness' || item.subtype === 'wellness') {
    if (last && last.changed_at) {
      const diff = Math.round((Date.now() - new Date(last.changed_at).getTime()) / 86400000);
      const days = FILTER_LIFE_DAYS - diff;
      out.push({ kind: '필터', days });
    } else if (item.install_date) {
      const diff = Math.round((Date.now() - new Date(item.install_date).getTime()) / 86400000);
      const days = FILTER_LIFE_DAYS - (diff % FILTER_LIFE_DAYS);
      out.push({ kind: '필터', days });
    }
  }
  return out;
}

function renderRow(r) {
  const it = r.item;
  const rowId = it.id;
  const dateLabel = state.ym ? `${Number(state.ym.split('-')[1])}월` : '–';
  const subtag = it.subtype ? ` <span class="muted-small">/${escapeHtml(it.subtype)}</span>` : '';
  const isTotal = (it.counter_mode === 'total');
  const totalBadge = isTotal
    ? ` <span style="display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:#7c3aed;color:#fff;vertical-align:middle;margin-left:3px;" title="합계 단일 청구 모드">합계</span>`
    : '';
  // 합계 모드 오버 뱃지 — total_charge_billing > 0 일 때만 표시
  const totalOverBadge = (isTotal && (r.total_charge_billing || 0) > 0)
    ? ` <span style="display:inline-block;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;background:#dc2626;color:#fff;vertical-align:middle;margin-left:2px;" title="합계 초과 ${r.total_extra_billing.toLocaleString()}매 · ${r.total_charge_billing.toLocaleString()}원">합계 초과 ${r.total_extra_billing.toLocaleString()}매</span>`
    : '';

  // 거래처 옵션 (합산 청구 + 청구 주기) — 첫 행에만 표시
  const cid = it.customer_id;
  const showCombine = r._isCustomerFirst && cid && (state.itemsPerCustomer[cid] || 0) >= 2;
  const combined = !!state.customerCombined[cid];
  const period   = Number(state.customerPeriod[cid]) || 1;
  const combineHTML = showCombine
    ? `<label class="bill-combine-toggle ${combined ? 'on' : ''}" title="여러 자산 합산하여 청구">
         <input type="checkbox" class="bill-combined-chk" data-cid="${escapeAttr(cid)}" ${combined ? 'checked' : ''}>
         ${combined ? '합산 청구 ON' : '합산 청구'}
       </label>`
    : '';
  const periodHTML = (r._isCustomerFirst && cid)
    ? `<select class="bill-period-sel ${period > 1 ? 'on' : ''}" data-cid="${escapeAttr(cid)}" title="청구 주기">
         <option value="1"  ${period===1?'selected':''}>월별</option>
         <option value="3"  ${period===3?'selected':''}>3개월</option>
         <option value="6"  ${period===6?'selected':''}>6개월</option>
         <option value="12" ${period===12?'selected':''}>1년</option>
       </select>`
    : '';
  const optsHTML = (combineHTML || periodHTML)
    ? `<div class="bill-options">${combineHTML}${periodHTML}</div>`
    : '';
  const expandedCls = (cid && state.expandedCustomerId === cid) ? ' expanded' : '';
  const expandedIcon = (cid && state.expandedCustomerId === cid) ? '📂' : '📅';
  const customerLine = r._isCustomerFirst
    ? `<div style="font-weight:600;"><span class="customer-name-link${expandedCls}" data-cid="${escapeAttr(cid || '')}" role="button" tabindex="0" title="지난 자료 펼치기/접기">${escapeHtml(it.customer_name)}<span class="icon">${expandedIcon}</span></span></div>${optsHTML}`
    : `<div class="muted-small" style="color:#94a3b8;">↳ ${escapeHtml(it.customer_name)}</div>`;

  // 출력기기가 아니면 흑백/컬러 셀 모두 N/A 처리
  if (!r.isMeter) {
    const dBw  = `<td class="num grp-bw dim">N/A</td>`;
    const dBwD = `<td class="num grp-bw dim col-detail">N/A</td>`;
    const dCo  = `<td class="num grp-co dim">N/A</td>`;
    const dCoD = `<td class="num grp-co dim col-detail">N/A</td>`;
    return `
      <tr data-row="${escapeAttr(rowId)}">
        <td>
          ${customerLine}
          <div class="muted-small">${escapeHtml(it.brand || '')} ${escapeHtml(it.model || rowId)}${subtag}${totalBadge}</div>
        </td>
        <td style="text-align:center; color:#64748b;">${dateLabel}</td>
        ${dBw}${dBw}${dBwD}${dBwD}${dBw}${dBwD}${dBw}
        ${dCo}${dCo}${dCoD}${dCoD}${dCo}${dCoD}${dCo}
      </tr>`;
  }

  const bwAnomStyle = r.bwAnomaly ? 'color:#dc2626;font-weight:600;' : '';
  const coAnomStyle = r.coAnomaly ? 'color:#dc2626;font-weight:600;' : '';

  // 합산청구 거래처의 행은 누락 셀을 0으로 표시 — 합산 계산 흐름을 그대로 노출
  // (합산이 누락=0 으로 처리되므로 셀 표기도 일치시켜 운영자가 합산 결과를 검산할 수 있게)
  const fmtR = combined ? (v) => (v == null ? '0' : Number(v).toLocaleString()) : fmt;
  // 당월 입력 셀: 합산청구면 placeholder 도 0
  const curPh = combined ? '0' : '–';
  // 합산모드일 때 표시용 billing-aligned 값 우선 사용 (직전월 누락=0 기준)
  const bwExtraDisp = combined ? (r.bw_charge_billing != null
        ? Math.max(0, (r.bw_cur || 0) - (r.bw_prev || 0) - (it.bw_free || 0))
        : 0)
    : r.bw_extra;
  const coExtraDisp = combined ? (r.co_charge_billing != null
        ? Math.max(0, (r.co_cur || 0) - (r.co_prev || 0) - (it.co_free || 0))
        : 0)
    : r.co_extra;
  const bwChargeDisp = combined ? (r.bw_charge_billing || 0) : r.bw_charge;
  const coChargeDisp = combined ? (r.co_charge_billing || 0) : r.co_charge;
  const bwMonthDisp = combined && r.bw_month == null
    ? Math.max(0, (r.bw_cur || 0) - (r.bw_prev || 0))
    : r.bw_month;
  const coMonthDisp = combined && r.co_month == null
    ? Math.max(0, (r.co_cur || 0) - (r.co_prev || 0))
    : r.co_month;

  const bwCells = `
    <td class="num grp-bw" style="color:#64748b;">${fmtR(r.bw_prev)}</td>
    <td class="num grp-bw">
      <input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="bw" value="${r.bw_cur ?? ''}" placeholder="${curPh}">
    </td>
    <td class="num grp-bw dim col-detail">${fmt(it.bw_free)}</td>
    <td class="num grp-bw col-detail" style="${bwAnomStyle}">${r.bwAnomaly ? '🔴 ' : ''}${fmtR(bwMonthDisp)}</td>
    <td class="num grp-bw">${fmtR(bwExtraDisp)}</td>
    <td class="num grp-bw dim col-detail">${fmt(it.bw_rate)}</td>
    <td class="num grp-bw charge">${fmtR(bwChargeDisp)}</td>
  `;

  const coCells = `
    <td class="num grp-co" style="color:#64748b;">${fmtR(r.co_prev)}</td>
    <td class="num grp-co">
      <input type="number" class="cell-edit num" data-item="${escapeAttr(rowId)}" data-field="color" value="${r.co_cur ?? ''}" placeholder="${curPh}">
    </td>
    <td class="num grp-co dim col-detail">${fmt(it.co_free)}</td>
    <td class="num grp-co col-detail" style="${coAnomStyle}">${r.coAnomaly ? '🔴 ' : ''}${fmtR(coMonthDisp)}</td>
    <td class="num grp-co">${fmtR(coExtraDisp)}</td>
    <td class="num grp-co dim col-detail">${fmt(it.co_rate)}</td>
    <td class="num grp-co charge">${fmtR(coChargeDisp)}</td>
  `;

  return `
    <tr data-row="${escapeAttr(rowId)}">
      <td>
        ${customerLine}
        <div class="muted-small">🖨 ${escapeHtml(it.brand || '')} ${escapeHtml(it.model || rowId)}${subtag}${totalBadge}${totalOverBadge}</div>
      </td>
      <td style="text-align:center; color:#64748b;">${dateLabel}</td>
      ${bwCells}
      ${coCells}
    </tr>
  `;
}

// Phase 4: 합산 청구 ON 거래처의 합산 카운터 요약 행
// 출력기기(isMeter) 행들의 카운터를 통합하여 거래처 단위 합산 표시
function renderCombinedSummaryRow(cid, groupRows) {
  const meterRows = groupRows.filter(r => r.isMeter);
  if (meterRows.length < 2) return ''; // 출력기기 2대 미만이면 표시 안 함

  // 합산 카운터는 청구 모듈과 동일하게 누락 카운터를 0으로 간주하여 항상 산출
  // (개별 카운터가 일부 누락돼도 합산 결과를 보여줘야 한다는 운영 요구)
  let curBwT = 0, curCoT = 0, prevBwT = 0, prevCoT = 0;
  let bwFreeT = 0, coFreeT = 0;
  let bwRateWeightedSum = 0, coRateWeightedSum = 0;
  let bwFreeForWeight = 0, coFreeForWeight = 0;
  let curMissingCount = 0, prevMissingCount = 0;

  for (const r of meterRows) {
    if (r.bw_cur == null && r.co_cur == null) curMissingCount++;
    if (r.bw_prev == null && r.co_prev == null) prevMissingCount++;
    curBwT  += (r.bw_cur  || 0);
    curCoT  += (r.co_cur  || 0);
    prevBwT += (r.bw_prev || 0);
    prevCoT += (r.co_prev || 0);
    const bwFree = r.item.bw_free || 0;
    const coFree = r.item.co_free || 0;
    bwFreeT += bwFree; coFreeT += coFree;
    bwRateWeightedSum += (r.item.bw_rate || 0) * bwFree;
    coRateWeightedSum += (r.item.co_rate || 0) * coFree;
    bwFreeForWeight   += bwFree;
    coFreeForWeight   += coFree;
  }

  // 통합 월카운터 (단일 max 적용, 누락=0)
  const bwMonthT = Math.max(0, curBwT - prevBwT);
  const coMonthT = Math.max(0, curCoT - prevCoT);

  // 가중 평균 단가
  const bwRate = bwFreeForWeight > 0
    ? bwRateWeightedSum / bwFreeForWeight
    : (meterRows.length > 0
        ? meterRows.reduce((s, r) => s + (r.item.bw_rate || 0), 0) / meterRows.length
        : 0);
  const coRate = coFreeForWeight > 0
    ? coRateWeightedSum / coFreeForWeight
    : (meterRows.length > 0
        ? meterRows.reduce((s, r) => s + (r.item.co_rate || 0), 0) / meterRows.length
        : 0);

  const bwExtra = bwMonthT - bwFreeT;
  const coExtra = coMonthT - coFreeT;
  const bwCharge = bwExtra > 0 ? Math.round(bwExtra * bwRate) : 0;
  const coCharge = coExtra > 0 ? Math.round(coExtra * coRate) : 0;
  const totalCharge = bwCharge + coCharge;

  const bwRateUniform = meterRows.every(r => (r.item.bw_rate || 0) === (meterRows[0].item.bw_rate || 0));
  const coRateUniform = meterRows.every(r => (r.item.co_rate || 0) === (meterRows[0].item.co_rate || 0));
  const hasWeighted = !bwRateUniform || !coRateUniform;
  const bwRateLabel = hasWeighted ? `${bwRate.toFixed(2)} (가중평균)` : fmt(bwRate);
  const coRateLabel = hasWeighted ? `${coRate.toFixed(2)} (가중평균)` : fmt(coRate);

  const fmtCharge = (v) => v > 0 ? `<span style="color:#dc2626;font-weight:700;">${v.toLocaleString()}</span>` : '0';
  const fmtSignedExtra = (v) => v.toLocaleString();
  const subLabel = curMissingCount > 0
    ? `합산청구 통합 · ${curMissingCount}대 미입력(=0)`
    : '합산청구 통합';

  // 열 구조: 거래처(1) + 날짜(1) + BW[전월/당월/기본(col-detail)/월카(col-detail)/추가/단가(col-detail)/추가료](7) + CO[동일](7) = 16열
  return `
    <tr class="combined-summary-row" style="background:#f0fdf4;border-top:2px solid #16a34a;">
      <td style="padding:4px 8px;">
        <div style="font-weight:700;font-size:11px;color:#15803d;">합산 카운터 (${meterRows.length}대)</div>
        <div style="font-size:10px;color:#166534;">${subLabel}</div>
      </td>
      <td style="text-align:center;font-size:10px;color:#15803d;">합산</td>
      <td class="num grp-bw" style="font-weight:600;">${prevBwT.toLocaleString()}</td>
      <td class="num grp-bw" style="font-weight:600;">${curBwT.toLocaleString()}</td>
      <td class="num grp-bw col-detail" style="color:#6b7280;">${bwFreeT.toLocaleString()}</td>
      <td class="num grp-bw col-detail" style="font-weight:700;color:${bwMonthT > 0 ? '#dc2626' : '#15803d'};">${bwMonthT.toLocaleString()}</td>
      <td class="num grp-bw" style="color:#6b7280;">${fmtSignedExtra(bwExtra)}</td>
      <td class="num grp-bw col-detail" style="font-size:10px;color:#7c3aed;">${bwRateLabel}</td>
      <td class="num grp-bw charge">${fmtCharge(bwCharge)}</td>
      <td class="num grp-co" style="font-weight:600;">${prevCoT.toLocaleString()}</td>
      <td class="num grp-co" style="font-weight:600;">${curCoT.toLocaleString()}</td>
      <td class="num grp-co col-detail" style="color:#6b7280;">${coFreeT.toLocaleString()}</td>
      <td class="num grp-co col-detail" style="font-weight:700;color:${coMonthT > 0 ? '#dc2626' : '#15803d'};">${coMonthT.toLocaleString()}</td>
      <td class="num grp-co" style="color:#6b7280;">${fmtSignedExtra(coExtra)}</td>
      <td class="num grp-co col-detail" style="font-size:10px;color:#7c3aed;">${coRateLabel}</td>
      <td class="num grp-co charge" style="font-weight:700;">${totalCharge > 0 ? `<span style="color:#dc2626;">${totalCharge.toLocaleString()}</span>` : '0'}</td>
    </tr>
  `;
}

function attachCellHandlers() {
  document.querySelectorAll('input.cell-edit').forEach(inp => {
    inp.addEventListener('change', onCellChange);
    inp.addEventListener('blur',   onCellChange);
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
  });
  // 합산 청구 체크박스
  document.querySelectorAll('input.bill-combined-chk').forEach(chk => {
    chk.addEventListener('change', onCombinedToggle);
    chk.addEventListener('click', e => e.stopPropagation());
  });
  // 청구 주기 드롭다운
  document.querySelectorAll('select.bill-period-sel').forEach(sel => {
    sel.addEventListener('change', onPeriodChange);
    sel.addEventListener('click', e => e.stopPropagation());
  });
  // 거래처명 클릭 → 인라인 확장 토글 (지난 자료 펼침/접기)
  document.querySelectorAll('.customer-name-link').forEach(el => {
    const handle = (e) => {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleCustomerExpansion(el.dataset.cid);
    };
    el.addEventListener('click', handle);
    el.addEventListener('keydown', handle);
  });
  // 확장 영역: 기간 탭 (3/6/12개월)
  document.querySelectorAll('tr.expansion-header .ch-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = Number(btn.dataset.months) || 6;
      changeExpansionMonths(m);
    });
  });
  // 확장 영역: 접기 버튼
  const collapseBtn = document.getElementById('btn-collapse-expansion');
  if (collapseBtn) collapseBtn.addEventListener('click', collapseCustomerExpansion);
}

async function onPeriodChange(e) {
  const sel = e.currentTarget;
  const cid = sel.dataset.cid;
  const newVal = parseInt(sel.value, 10) || 1;
  const prevVal = Number(state.customerPeriod[cid]) || 1;
  state.customerPeriod[cid] = newVal;
  try {
    const { error } = await supa.from('rental_customers')
      .update({ billing_months: newVal }).eq('id', cid);
    if (error) throw error;
    const label = { 1: '월별', 3: '3개월', 6: '6개월', 12: '1년' }[newVal] || `${newVal}개월`;
    toast(`청구 주기: ${label}`);
    render();
    // 월별 거래처만 자동 청구 갱신 (다개월 거래처는 청구 페이지에서 발행)
    if (newVal === 1) {
      autoUpdateBillings([cid], { silent: true }).catch(err =>
        console.warn('[billing-sync] period change', err));
    }
  } catch (err) {
    console.error(err);
    state.customerPeriod[cid] = prevVal;
    sel.value = String(prevVal);
    if (/column .* does not exist/i.test(err.message || '')) {
      toast('18_add_billing_period.sql 을 먼저 실행해 주세요', true);
    } else {
      toast('청구 주기 저장 실패: ' + (err.message || err), true);
    }
  }
}

async function onCombinedToggle(e) {
  const cid = e.currentTarget.dataset.cid;
  const newVal = e.currentTarget.checked;
  const prevVal = !!state.customerCombined[cid];
  state.customerCombined[cid] = newVal; // 낙관적 업데이트
  try {
    const { error } = await supa.from('rental_customers')
      .update({ bill_combined: newVal }).eq('id', cid);
    if (error) throw error;
    toast(newVal ? '합산 청구 ON' : '합산 청구 OFF');
    render(); // 토글 라벨 갱신
    // 청구서 자동 재계산
    autoUpdateBillings([cid], { silent: true }).catch(err => {
      console.warn('[billing-sync] combined toggle', err);
    });
  } catch (err) {
    console.error(err);
    state.customerCombined[cid] = prevVal;
    e.currentTarget.checked = prevVal;
    if (/column .* does not exist/i.test(err.message || '')) {
      toast('17_add_bill_combined.sql 을 먼저 실행해 주세요', true);
    } else {
      toast('합산 청구 저장 실패: ' + (err.message || err), true);
    }
  }
}

let saveTimer = null;
async function onCellChange(e) {
  const inp = e.currentTarget;
  const itemId = inp.dataset.item;
  const field = inp.dataset.field;
  const raw = inp.value.trim();
  const val = raw === '' ? null : Number(raw);
  if (raw !== '' && !Number.isFinite(val)) {
    toast('숫자만 입력하세요', true);
    return;
  }
  // 기존 row와 병합 후 upsert
  const existing = state.curMap[itemId] || { item_id: itemId, ym: state.ym, bw: null, color: null, uptime_hours: null };
  const payload = {
    item_id: itemId,
    ym: state.ym,
    bw: field === 'bw' ? val : (existing.bw ?? null),
    color: field === 'color' ? val : (existing.color ?? null),
    uptime_hours: field === 'uptime_hours' ? val : (existing.uptime_hours ?? null),
    read_at: new Date().toISOString(),
    source: 'manual',
  };
  try {
    const { error } = await supa.from('rental_counters')
      .upsert(payload, { onConflict: 'item_id,ym' });
    if (error) throw error;
    state.curMap[itemId] = payload;
    state.itemsEverCounted.add(itemId);
    deriveCustomersEverCounted();
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 900);
    // 통계 즉시 갱신
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => render(), 250);
    toast('저장됨');

    // 청구서 자동 갱신 (해당 거래처)
    const item = state.items.find(i => i.id === itemId);
    if (item?.customer_id) {
      autoUpdateBillings([item.customer_id], { silent: true }).catch(e =>
        console.warn('[billing-sync] cell update fail', e)
      );
    }
  } catch (err) {
    console.error(err);
    toast('저장 실패: ' + (err.message || err), true);
  }
}

// ---------- 드릴다운 ----------
const DRILL_TITLES = {
  new:     '이번달 신규 입력 업체',
  entered: '카운터 입력된 업체',
  missing: '입력 안된 업체',
  anomaly: '이상치 경고 업체',
  overage: '카운터 오버 업체 (추가요금 발생)',
};

function toggleDrilldown(key) {
  if (state.activeDrilldown === key) return closeDrilldown();
  state.activeDrilldown = key;
  document.querySelectorAll('#stats .stat-card').forEach(c => {
    c.classList.toggle('active', c.dataset.drill === key);
  });
  document.getElementById('drilldown').style.display = '';
  renderDrilldown(key);
}
function closeDrilldown() {
  state.activeDrilldown = null;
  document.querySelectorAll('#stats .stat-card').forEach(c => c.classList.remove('active'));
  document.getElementById('drilldown').style.display = 'none';
}
function renderDrilldown(key) {
  const list = state.drilldown?.[key] || [];
  document.getElementById('drilldown-title').textContent =
    `${DRILL_TITLES[key] || '업체 목록'} (${list.length})`;
  const body = document.getElementById('drilldown-body');
  if (!list.length) {
    body.innerHTML = `<div class="drilldown-empty">해당하는 업체가 없습니다.</div>`;
    return;
  }
  const isAnomaly = key === 'anomaly';
  const isOverage = key === 'overage';
  body.innerHTML = `
    <table class="drilldown-table">
      <thead><tr>
        <th>업체</th>
        <th class="num">자산</th>
        <th class="num">입력</th>
        <th class="num">흑백 합계</th>
        <th class="num">컬러 합계</th>
        ${isAnomaly ? '<th>이상치 자산</th>' : ''}
        ${isOverage ? '<th class="num">오버 자산</th><th class="num">흑백 추가료</th><th class="num">컬러 추가료</th><th class="num">합계 추가료</th><th class="num disc-col">추가요금 할인</th><th class="num disc-col">최종 청구액</th>' : ''}
        <th></th>
      </tr></thead>
      <tbody>
        ${list.map(cs => {
          const total = (cs.overageBwCharge||0) + (cs.overageCoCharge||0);
          const discount = state.discountMap[cs.id] || 0;
          const final = Math.max(0, total - discount);
          const hasDiscount = discount > 0;
          const phantomBadge = cs._phantom
            ? ` <span title="현재 카운터 데이터에는 추가요금이 잡히지 않지만 청구 저장본이 양수입니다" style="font-size:10px;background:#fef3c7;color:#92400e;padding:1px 5px;border-radius:6px;margin-left:4px;">청구 저장본</span>`
            : '';
          return `
          <tr class="drilldown-row${cs._phantom ? ' phantom' : ''}" data-cid="${escapeAttr(cs.id)}">
            <td data-label="업체"><b>${escapeHtml(cs.name)}</b>${phantomBadge}</td>
            <td class="num" data-label="자산">${cs.items.length || '—'}</td>
            <td class="num" data-label="입력">${cs.enteredItems.length || '—'}</td>
            <td class="num" data-label="흑백 합계">${cs.bwTotal ? cs.bwTotal.toLocaleString() : '—'}</td>
            <td class="num" data-label="컬러 합계">${cs.coTotal ? cs.coTotal.toLocaleString() : '—'}</td>
            ${isAnomaly ? `<td data-label="이상치 자산">${(() => {
              return cs.anomalies.map(a => {
                const assetName = escapeHtml((a.item.brand||'') + ' ' + (a.item.model||a.item.id));
                const reasons = (a.anomalyReasons || []).map(r => escapeHtml(r)).join('<br>');
                return `<div class="anomaly-asset"><div class="asset-name">${assetName}</div>${reasons ? `<div class="anomaly-reasons" style="font-size:11px;color:#dc2626;">${reasons}</div>` : ''}</div>`;
              }).join('');
            })()}</td>` : ''}
            ${isOverage ? `
              <td class="num" data-label="오버 자산">${cs.overageItems.length}</td>
              <td class="num" data-label="흑백 추가료">${(cs.overageBwCharge||0).toLocaleString()}원</td>
              <td class="num" data-label="컬러 추가료">${(cs.overageCoCharge||0).toLocaleString()}원</td>
              <td class="num" data-label="합계 추가료" style="font-weight:700; color:var(--primary);">${total.toLocaleString()}원</td>
              <td class="num disc-col" data-label="추가요금 할인" onclick="event.stopPropagation()">
                <input
                  type="number"
                  class="disc-input"
                  data-cid="${escapeAttr(cs.id)}"
                  value="${discount || ''}"
                  placeholder="0"
                  min="0"
                  step="100"
                  title="추가요금 할인 금액 입력 (원 단위)"
                >
              </td>
              <td class="num disc-col final-charge ${hasDiscount ? 'has-discount' : 'no-discount'}"
                  data-label="최종 청구액"
                  data-cid="${escapeAttr(cs.id)}">
                ${hasDiscount
                  ? `<span class="final-amt">${final.toLocaleString()}원</span>`
                  : `<span class="final-amt muted-val">${total.toLocaleString()}원</span>`
                }
              </td>
            ` : ''}
            <td><span class="muted-small">필터 →</span></td>
          </tr>
        `;}).join('')}
      </tbody>
    </table>
  `;

  // 드릴다운 행 클릭 — 필터 이동 (할인 input 클릭은 전파 차단 처리 완료)
  body.querySelectorAll('.drilldown-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const cid = tr.dataset.cid;
      const cust = state.customers.find(c => c.id === cid);
      const name = cust?.company || '';
      const inp = document.getElementById('f-customer-search');
      if (inp) inp.value = name;
      state.customerQuery = name;
      render();
      const card = document.querySelector('.counters-card');
      if (card) window.scrollTo({ top: card.offsetTop - 20, behavior: 'smooth' });
    });
  });

  // 할인 input debounce 저장 (overage 드릴다운에서만)
  if (isOverage) {
    const debounceTimers = {};
    body.querySelectorAll('.disc-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const cid = inp.dataset.cid;
        clearTimeout(debounceTimers[cid]);
        debounceTimers[cid] = setTimeout(() => saveDiscount(cid, inp), 500);
      });
      inp.addEventListener('blur', () => {
        const cid = inp.dataset.cid;
        clearTimeout(debounceTimers[cid]);
        saveDiscount(cid, inp);
      });
    });
  }
}

let _discSaveInFlight = {};
async function saveDiscount(cid, inp) {
  if (_discSaveInFlight[cid]) return;
  const raw = (inp.value || '').trim();
  const amount = raw === '' ? 0 : parseInt(raw, 10);
  if (!Number.isFinite(amount) || amount < 0) {
    toast('양수 정수를 입력하세요', true);
    return;
  }
  // 이미 저장된 값과 동일하면 스킵
  if ((state.discountMap[cid] || 0) === amount) return;

  _discSaveInFlight[cid] = true;
  const totalCell = document.querySelector(`.final-charge[data-cid="${CSS.escape(cid)}"]`);
  if (totalCell) totalCell.innerHTML = '<span class="disc-saving">저장 중…</span>';

  try {
    const { error } = await supa.from('rental_counter_discounts')
      .upsert({ customer_id: cid, ym: state.ym, amount }, { onConflict: 'customer_id,ym' });
    if (error) throw error;
    state.discountMap[cid] = amount;
    toast('저장됨');
    // 해당 행의 최종 청구액 셀 즉시 갱신
    if (totalCell) {
      const cs = state.drilldown?.overage?.find(c => c.id === cid);
      if (cs) {
        const total = (cs.overageBwCharge||0) + (cs.overageCoCharge||0);
        const final = Math.max(0, total - amount);
        const hasDiscount = amount > 0;
        totalCell.className = `num disc-col final-charge ${hasDiscount ? 'has-discount' : 'no-discount'}`;
        totalCell.innerHTML = hasDiscount
          ? `<span class="final-amt">${final.toLocaleString()}원</span>`
          : `<span class="final-amt muted-val">${total.toLocaleString()}원</span>`;
      }
    }
  } catch (err) {
    console.error('[discount] save error', err);
    toast('할인 저장 실패: ' + (err.message || err), true);
    if (totalCell) {
      const cs = state.drilldown?.overage?.find(c => c.id === cid);
      if (cs) {
        const total = (cs.overageBwCharge||0) + (cs.overageCoCharge||0);
        const prev = state.discountMap[cid] || 0;
        const final = Math.max(0, total - prev);
        totalCell.innerHTML = `<span class="final-amt">${final.toLocaleString()}원</span>`;
      }
    }
  } finally {
    _discSaveInFlight[cid] = false;
  }
}

// ===========================================================
// 거래처 인라인 확장 — 지난 자료 (3 / 6 / 12개월)
// 거래처명 클릭 시 해당 거래처 행 그룹 바로 아래에
// 동일한 16개 컬럼(전월/당월/기본매수/월카운터/추가카운터/단가/추가요금 × 흑백/컬러)
// 으로 과거 N개월치 행을 펼친다.
// ===========================================================
async function toggleCustomerExpansion(cid) {
  if (!cid) return;
  if (state.expandedCustomerId === cid) {
    collapseCustomerExpansion();
    return;
  }
  state.expandedCustomerId = cid;
  state.expansionLoading = true;
  state.expansionRows = null;
  render();
  await loadExpansionData(cid, state.expansionMonths);
  // 사용자가 로딩 중 다른 거래처를 클릭한 경우 무시
  if (state.expandedCustomerId !== cid) return;
  render();
}

function collapseCustomerExpansion() {
  state.expandedCustomerId = null;
  state.expansionRows = null;
  state.expansionLoading = false;
  render();
}

async function changeExpansionMonths(months) {
  const m = [3, 6, 12].includes(months) ? months : 6;
  if (m === state.expansionMonths && state.expansionRows) return;
  state.expansionMonths = m;
  if (!state.expandedCustomerId) return;
  state.expansionLoading = true;
  render();
  await loadExpansionData(state.expandedCustomerId, m);
  render();
}

async function loadExpansionData(cid, months) {
  const myItems = state.items.filter(it => it.customer_id === cid);
  if (!myItems.length) {
    state.expansionRows = new Map();
    state.expansionLoading = false;
    return;
  }
  // 가장 오래된 표시 월의 "전월" 까지 포함하려면 months+2 개월 필요
  const ymList = listMonthsBack(state.ym, months + 2);
  try {
    const { data, error } = await supa.from('rental_counters')
      .select('item_id, ym, bw, color, uptime_hours')
      .in('item_id', myItems.map(i => i.id))
      .in('ym', ymList);
    if (error) throw error;
    const m = new Map();
    for (const r of (data || [])) m.set(`${r.item_id}|${r.ym}`, r);
    state.expansionRows = m;
  } catch (err) {
    console.error(err);
    toast('이력 로드 실패: ' + (err.message || err), true);
    state.expansionRows = new Map();
  } finally {
    state.expansionLoading = false;
  }
}

function renderExpansion(cid) {
  const months = state.expansionMonths;
  const periodHtml = [3, 6, 12].map(m =>
    `<button class="ch-tab${m === months ? ' active' : ''}" data-months="${m}" type="button">${m}개월</button>`
  ).join('');

  const headerRow = `
    <tr class="expansion-header">
      <td colspan="16">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <strong style="font-size:13px;">📂 지난 자료</strong>
            <div style="display:flex; gap:4px;">${periodHtml}</div>
          </div>
          <button class="btn ghost small" id="btn-collapse-expansion" type="button">✕ 접기</button>
        </div>
      </td>
    </tr>
  `;

  if (state.expansionLoading || !state.expansionRows) {
    return headerRow + `<tr class="expansion-row"><td colspan="16" style="padding:18px; text-align:center; color:#64748b;">로딩 중…</td></tr>`;
  }

  const items = state.items.filter(it => it.customer_id === cid);
  if (!items.length) {
    return headerRow + `<tr class="expansion-row"><td colspan="16" style="padding:18px; text-align:center; color:#64748b;">자산이 없습니다.</td></tr>`;
  }

  // 표시 대상: 과거 N개월 (현재월 제외, 최신부터)
  const ymAll  = listMonthsBack(state.ym, months + 2);
  const pastYms = ymAll.slice(1, months + 1);

  let rowsHtml = '';
  for (const it of items) {
    const isMeter = (it.category === 'printer') || (it.category === '출력') || ['laser','inkjet','복합기'].includes(it.subtype);
    for (let i = 0; i < pastYms.length; i++) {
      const ym = pastYms[i];
      const prevYm = ymAll[i + 2]; // ym 의 직전월
      const cur  = state.expansionRows.get(`${it.id}|${ym}`) || null;
      const prev = state.expansionRows.get(`${it.id}|${prevYm}`) || null;
      rowsHtml += renderExpansionRow(it, ym, cur, prev, isMeter);
    }
  }

  return headerRow + (rowsHtml ||
    `<tr class="expansion-row"><td colspan="16" style="padding:18px; text-align:center; color:#64748b;">표시할 데이터가 없습니다.</td></tr>`);
}

function renderExpansionRow(it, ym, cur, prev, isMeter) {
  const [yy, mm] = ym.split('-');
  const dateLabel = `${Number(mm)}월<br><span style="font-size:10px;color:#94a3b8;">${yy}</span>`;
  const subtag = it.subtype ? ` <span class="muted-small">/${escapeHtml(it.subtype)}</span>` : '';

  if (!isMeter) {
    const dBw  = `<td class="num grp-bw dim">N/A</td>`;
    const dBwD = `<td class="num grp-bw dim col-detail">N/A</td>`;
    const dCo  = `<td class="num grp-co dim">N/A</td>`;
    const dCoD = `<td class="num grp-co dim col-detail">N/A</td>`;
    return `
      <tr class="expansion-row">
        <td><div class="muted-small" style="padding-left:18px; color:#94a3b8;">↳ ${escapeHtml(it.brand||'')} ${escapeHtml(it.model||it.id)}${subtag}</div></td>
        <td style="text-align:center; color:#64748b;">${dateLabel}</td>
        ${dBw}${dBw}${dBwD}${dBwD}${dBw}${dBwD}${dBw}
        ${dCo}${dCo}${dCoD}${dCoD}${dCo}${dCoD}${dCo}
      </tr>
    `;
  }

  const bw_cur  = cur?.bw ?? null;
  const co_cur  = cur?.color ?? null;
  const bw_prev = prev?.bw ?? null;
  const co_prev = prev?.color ?? null;
  const bw_month = (bw_cur != null && bw_prev != null) ? Math.max(0, bw_cur - bw_prev) : null;
  const co_month = (co_cur != null && co_prev != null) ? Math.max(0, co_cur - co_prev) : null;
  const bw_extra = bw_month != null ? Math.max(0, bw_month - (it.bw_free || 0)) : null;
  const co_extra = co_month != null ? Math.max(0, co_month - (it.co_free || 0)) : null;
  const bw_charge = bw_extra != null ? bw_extra * (it.bw_rate || 0) : null;
  const co_charge = co_extra != null ? co_extra * (it.co_rate || 0) : null;

  return `
    <tr class="expansion-row">
      <td><div class="muted-small" style="padding-left:18px; color:#94a3b8;">↳ ${escapeHtml(it.brand||'')} ${escapeHtml(it.model||it.id)}${subtag}</div></td>
      <td style="text-align:center; color:#64748b;">${dateLabel}</td>
      <td class="num grp-bw" style="color:#64748b;">${fmt(bw_prev)}</td>
      <td class="num grp-bw">${fmt(bw_cur)}</td>
      <td class="num grp-bw dim col-detail">${fmt(it.bw_free)}</td>
      <td class="num grp-bw col-detail">${fmt(bw_month)}</td>
      <td class="num grp-bw">${fmt(bw_extra)}</td>
      <td class="num grp-bw dim col-detail">${fmt(it.bw_rate)}</td>
      <td class="num grp-bw charge">${fmt(bw_charge)}</td>
      <td class="num grp-co" style="color:#64748b;">${fmt(co_prev)}</td>
      <td class="num grp-co">${fmt(co_cur)}</td>
      <td class="num grp-co dim col-detail">${fmt(it.co_free)}</td>
      <td class="num grp-co col-detail">${fmt(co_month)}</td>
      <td class="num grp-co">${fmt(co_extra)}</td>
      <td class="num grp-co dim col-detail">${fmt(it.co_rate)}</td>
      <td class="num grp-co charge">${fmt(co_charge)}</td>
    </tr>
  `;
}

// ---------- utils ----------
function setBodyLoading() {
  document.getElementById('grid-body').innerHTML =
    '<tr><td colspan="16" class="muted-small" style="text-align:center; padding:30px;">데이터 로딩 중…</td></tr>';
}
function updateYearHeader() {
  const el = document.getElementById('hdr-year');
  if (el && state.ym) el.textContent = state.ym.split('-')[0];
}
function ymOfNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 기존 업로드 중 가장 최근 active 항목의 ym 을 state.ym 에 적용
async function pickInitialYmFromUploads() {
  try {
    const { data, error } = await supa.from('rental_counter_uploads')
      .select('ym, uploaded_at')
      .eq('status', 'active')
      .order('uploaded_at', { ascending: false })
      .limit(1);
    if (error) return; // 테이블 없거나 권한 없으면 ymOfNow() 그대로
    if (data && data.length && data[0].ym) {
      state.ym = data[0].ym;
    }
  } catch (_) { /* 무시 — 기본 ym 유지 */ }
}
function listMonthsBack(ym, count) {
  const [y, m] = ym.split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(y, m - 1 - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
function fmt(n) {
  if (n == null || n === '') return '–';
  return Number(n).toLocaleString();
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ===========================================================
// 엑셀 일괄 입력
// ===========================================================
const excelState = {
  rows: [],      // [{ idx, raw, company, model, bw, color, customerId, itemId, status, note }]
  uploadId: null, // 현재 업로드 세션의 rental_counter_uploads.id
  storagePath: null, // Storage 업로드 경로 (롤백용)
  manualMap: {}, // manual_company_map.json 에서 로드한 자산번호→회사명 강제 매핑
  isSameFile: false, // 동일 파일명 재업로드 여부 — true 이면 중복 체크 없이 강제 덮어쓰기
};

const HEADER_ALIASES = {
  company: ['업체명', '거래처', '거래처명', '회사', '회사명', '고객사', '고객명', 'company', 'customer', '자산번호', '자산 번호', '자산'],
  model:   ['모델', '모델명', '기종', 'model'],
  bw:      ['흑백', '흑백카운터', '흑백카운트', 'bw', 'mono', '모노'],
  color:   ['컬러', '컬러카운터', '컬러카운트', 'color', 'col'],
};

let _excelInited = false;
function initExcelImport() {
  if (_excelInited) return;
  _excelInited = true;

  // 한별카운터 자산번호→회사명 강제 매핑 로드 (build_counters.py 와 동기화)
  fetch('../tools/manual_company_map.json')
    .then(res => { if (res.ok) return res.json(); })
    .then(data => {
      if (data && typeof data === 'object') {
        // _unmatched_new_customers 는 메모 배열이므로 제외
        const map = {};
        for (const [k, v] of Object.entries(data)) {
          if (k.startsWith('_')) continue;
          if (typeof v === 'string') map[k] = v;
        }
        excelState.manualMap = map;
      }
    })
    .catch(() => {});  // 로드 실패 시 graceful fallback — 기존 매칭 그대로

  const toggle = document.getElementById('btn-excel-toggle');
  const body   = document.getElementById('excel-body');
  const drop   = document.getElementById('excel-drop');
  const file   = document.getElementById('excel-file');
  const clear  = document.getElementById('btn-excel-clear');
  const save   = document.getElementById('btn-excel-save');

  toggle.addEventListener('click', () => {
    const open = body.style.display === 'none';
    body.style.display = open ? '' : 'none';
    toggle.textContent = open ? '닫기 ▴' : '열기 ▾';
  });

  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleExcelFile(f);
  });
  file.addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) handleExcelFile(f);
  });

  clear.addEventListener('click', () => {
    excelState.rows = [];
    excelState.uploadId = null;
    excelState.storagePath = null;
    excelState.isSameFile = false;
    file.value = '';
    document.getElementById('excel-preview').classList.add('hidden');
    document.getElementById('excel-preview-body').innerHTML = '';
    save.disabled = true;
  });

  save.addEventListener('click', () => saveExcelBatch({ auto: false }));

  // 업로드 이력 패널 토글
  document.getElementById('upload-history-toggle').addEventListener('click', () => {
    const body2 = document.getElementById('upload-history-body');
    const icon  = document.getElementById('upload-history-toggle-icon');
    const open  = body2.classList.toggle('open');
    icon.textContent = open ? '닫기 ▴' : '열기 ▾';
    if (open) loadUploadHistory();
  });

  document.getElementById('btn-show-all-uploads').addEventListener('click', () => {
    loadUploadHistory({ all: true });
  });

  // 한별 분석 패널 토글 — 클릭 시에만 열리고, 열릴 때 분석 렌더링
  const hbToggle = document.getElementById('hb-analysis-toggle');
  if (hbToggle) {
    hbToggle.addEventListener('click', () => {
      const body = document.getElementById('hb-analysis');
      const icon = document.getElementById('hb-analysis-toggle-icon');
      if (!body) return;
      const isHidden = body.style.display === 'none';
      body.style.display = isHidden ? '' : 'none';
      icon.textContent = isHidden ? '닫기 ▴' : '열기 ▾';
      // 패널이 열릴 때 분석 렌더링 (autoOpen=true 로 패널 강제 표시 없이 내용만 채움)
      if (isHidden) {
        renderHanbyeolAnalysis(state.ym, { autoOpen: false }).catch(err =>
          console.error('[hb-analysis toggle]', err));
      }
    });
  }

  updateExcelTargetYm();
}

function updateExcelTargetYm() {
  const el = document.getElementById('excel-target-ym');
  if (el) el.textContent = state.ym;
}

async function handleExcelFile(file) {
  if (typeof XLSX === 'undefined') {
    toast('엑셀 라이브러리 로드 실패', true);
    return;
  }

  // ★ 한별로 시작하는 파일만 허용
  if (!/^한별/.test(file.name)) {
    toast('한별로 시작하는 엑셀 파일만 업로드 가능합니다.\n(현재 파일: ' + file.name + ')', true);
    return;
  }

  // ★ 파일명에서 ym 추출: 한별카운터_YYYY_MM_DD-... → ym = YYYY-(MM-1)
  // 예) 한별카운터_2026_05_01-00_00_31.xlsx → ym = '2026-04'
  const ymFromFile = extractYmFromHanbyeolName(file.name);
  const ym = ymFromFile || state.ym;

  // ★ 상단 "대상 월" 셀렉터와 state.ym 을 추출된 ym 으로 즉시 전환
  // 이렇게 해야 saveExcelBatch 가 올바른 ym 으로 rental_counters 에 저장하고
  // 저장 후 render() 가 메인 그리드에 해당 월 데이터를 표시한다.
  if (ymFromFile && ymFromFile !== state.ym) {
    state.ym = ymFromFile;
    const monthInput = document.getElementById('f-month');
    if (monthInput) monthInput.value = ymFromFile;
    updateYearHeader();
    updateExcelTargetYm();
    // prevMap / histMap 재조회 (전월 카운터가 있어야 월카운터 계산 가능)
    await loadCounters();
  }

  // 1) 같은 ym 에 active 업로드 이력이 있는지 확인
  //    - 파일명이 동일한 경우: 같은 파일 재업로드 → 기존 이력 삭제 후 자동 덮어쓰기 (confirm 없음)
  //    - 파일명이 다른 경우: 다른 파일이지만 이미 해당 월 이력 존재 → excelState 에 isSameFile=false 플래그
  //      저장 단계(saveExcelBatch)에서 개별 item 수준의 중복을 모달로 알림
  const { data: existing } = await supa.from('rental_counter_uploads')
    .select('id, file_name, ok_count, storage_path')
    .eq('ym', ym)
    .eq('status', 'active')
    .limit(1);

  excelState.isSameFile = false;
  if (existing && existing.length > 0) {
    const prev = existing[0];
    if (prev.file_name === file.name) {
      // 동일 파일명 = 같은 파일 재업로드 → 자동 덮어쓰기
      excelState.isSameFile = true;
      for (const row of existing) {
        await supa.storage.from('counter-uploads').remove([row.storage_path]).catch(() => {});
      }
      const existIds = existing.map(r => r.id);
      await supa.from('rental_counter_uploads').delete().in('id', existIds);
    }
    // 파일명이 다른 경우: 삭제하지 않음. saveExcelBatch 에서 item 수준 중복 확인 모달 처리
  }

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // ★ 한별 고정 컬럼 방식: header:1 로 2차원 배열 취득, 8행 헤더 건너뛰고 9행~
    const raw2d = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    // 9행(index 8)부터 데이터
    const dataRows = raw2d.slice(8).filter(r => Array.isArray(r) && r.length > 3 && r[3]);

    if (!dataRows.length) {
      toast('데이터 행이 없습니다 (9행부터 읽음)', true);
      return;
    }

    // 2) Storage 에 원본 파일 업로드
    const uuid = crypto.randomUUID();
    const safeName = uuid + '_' + file.name.replace(/[^\w.\-]/g, '_');
    const storagePath = ym + '/' + safeName;

    const { error: storageErr } = await supa.storage
      .from('counter-uploads')
      .upload(storagePath, buf, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (storageErr) {
      toast('파일 Storage 업로드 실패: ' + storageErr.message, true);
      return;
    }
    excelState.storagePath = storagePath;

    // 3) rental_counter_uploads INSERT — status='active'
    const userEmail = window.currentUser?.email || '';
    const { data: uploadRow, error: insertErr } = await supa.from('rental_counter_uploads')
      .insert({
        ym,
        file_name: file.name,
        storage_path: storagePath,
        file_size: file.size,
        uploaded_by: userEmail,
        row_count: dataRows.length,
        ok_count: 0,
        status: 'active',
      })
      .select('id')
      .single();

    if (insertErr) {
      await supa.storage.from('counter-uploads').remove([storagePath]).catch(() => {});
      excelState.storagePath = null;
      toast('업로드 이력 기록 실패: ' + insertErr.message, true);
      return;
    }
    excelState.uploadId = uploadRow.id;

    // 4) 한별 고정 컬럼 파싱
    //   열0: 그룹(거래처명). '1임대제품'이면 열5(자산번호) 사용
    //   열2: 모델, 열3: 일련번호, 열5: 자산번호, 열6: IP
    //   열9: 마지막 업데이트, 열12: 결합합계, 열13: 흑백, 열14: 컬러
    excelState.rows = dataRows.map((r, i) => {
      const group  = String(r[0] || '').trim();
      const model  = String(r[2] || '').trim();
      const serial = String(r[3] || '').trim();
      const loc    = String(r[5] || '').trim();
      const ip     = String(r[6] || '').trim();
      const rawDate = r[9];
      const total  = toNum(r[12]);
      const bw     = toNum(r[13]);
      const color  = toNum(r[14]);

      // 거래처명: 그룹이 '1임대제품'이면 자산번호(열5)로 대체, 아니면 그룹명
      const company = (group === '1임대제품' || group === '') ? loc : group;

      // last_update: SheetJS 숫자날짜 또는 문자열 모두 처리
      let lastUpdate = null;
      if (rawDate) {
        if (typeof rawDate === 'number') {
          // Excel serial date → JS Date
          const d = XLSX.SSF.parse_date_code(rawDate);
          if (d) lastUpdate = d.y + '-' + String(d.m).padStart(2,'0') + '-' + String(d.d).padStart(2,'0');
        } else {
          const s = String(rawDate).trim();
          if (/^\d{4}/.test(s)) lastUpdate = s.slice(0, 10);
        }
      }

      return {
        idx: i + 1,
        // 한별 전용 필드
        serial,
        assetNumber: loc, // 🏷 열5 는 한별 자산번호. 매칭 1차 기준
        company,
        location: loc,    // 거래처명 fallback 용도로 보존 (manual_company_map 키)
        model,
        ip_address: ip,
        last_update: lastUpdate,
        total,
        bw,
        color,
        // 기존 엑셀 미리보기 호환 필드
        customerId: null,
        itemId: null,
        status: 'pending',
        note: '',
      };
    }).filter(r => r.serial);

    rematchExcelRows();
    document.getElementById('excel-preview').classList.remove('hidden');

    // 5) hanbyeol_counters 에 전체 upsert (매칭 여부 무관)
    await saveHanbyeolCounters(ym, uploadRow.id);

    // 6) 매칭된 항목만 rental_counters 에도 upsert
    const okCount = excelState.rows.filter(r => r.status === 'ok' && r.itemId).length;
    if (okCount > 0) {
      toast(excelState.rows.length + '행 분석 완료 — ' + okCount + '건 자산 매칭');
      await saveExcelBatch({ auto: true, forceOverwrite: excelState.isSameFile });
    } else {
      // 매칭 0건이어도 경고 없이 중립 메시지 (hanbyeol_counters에는 모두 저장됨)
      toast(excelState.rows.length + '행 분석 완료 — 자산 자동 매칭 0건 (미리보기 확인)');
    }

    // 7) hb-analysis 패널은 자동으로 열지 않음 (사용자가 토글 클릭 시에만 표시)
    // renderHanbyeolAnalysis 는 hb-analysis-toggle 클릭 핸들러에서만 호출

  } catch (err) {
    console.error(err);
    if (excelState.storagePath) {
      await supa.storage.from('counter-uploads').remove([excelState.storagePath]).catch(() => {});
    }
    if (excelState.uploadId) {
      try { await supa.from('rental_counter_uploads').delete().eq('id', excelState.uploadId); } catch (_) {}
    }
    excelState.storagePath = null;
    excelState.uploadId = null;
    toast('파일 읽기 실패: ' + (err.message || err), true);
  }
}

// ★ 파일명에서 ym 추출: 한별카운터_YYYY_MM_DD-... → ym = YYYY-(MM-1)
function extractYmFromHanbyeolName(fname) {
  // 예) 한별카운터_2026_05_01-00_00_31.xlsx
  const m = fname.match(/(\d{4})_(\d{2})_\d{2}/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  // 파일명 월 - 1 = 데이터 기준 월
  const d = new Date(y, mo - 1 - 1, 1); // mo-1(0-based) - 1(한 달 전)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// ★ hanbyeol_counters 전체 upsert (매칭 여부 무관)
async function saveHanbyeolCounters(ym, uploadId) {
  if (!excelState.rows.length) return;
  const payloads = excelState.rows.map(r => ({
    ym,
    serial:      r.serial,
    customer:    r.company || null,
    location:    r.location || null,
    model:       r.model || null,
    ip_address:  r.ip_address || null,
    bw:          r.bw,
    color:       r.color,
    total:       r.total,
    last_update: r.last_update || null,
    upload_id:   uploadId || null,
    item_id:     r.itemId || null,
    match_status: r.itemId ? 'matched' : 'unmatched',
  }));

  const { error } = await supa.from('hanbyeol_counters')
    .upsert(payloads, { onConflict: 'serial,ym' });
  if (error) {
    // 사용자에게 에러 표시 없음 — 콘솔에만 기록
    console.warn('[hanbyeol_counters] upsert 실패 (silent):', error.message, error.code);
  }
}

function detectHeaders(keys) {
  const out = {};
  for (const key of keys) {
    const norm = normalize(key);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (out[field]) continue;
      if (aliases.some(a => normalize(a) === norm)) { out[field] = key; break; }
    }
  }
  return out;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[()\[\]\-_./]/g, '');
}

function rematchExcelRows() {
  if (!excelState.rows.length) return;
  // 중복 픽 방지. 신뢰도 순: 1) 자산번호 → 2) 시리얼 → 3) 회사명+모델
  // 자산번호는 한별이 직접 부여하는 코드라 거래처 이전과 무관하게 정확.
  // 시리얼은 장비를 다른 회사로 옮긴 경우 옛 거래처에 잘못 매칭될 수 있어 보조 기준으로 강등.
  const usedItemIds = new Set();

  // 1패스: 자산번호 매칭 (asset_number ≥ 2자)
  for (const row of excelState.rows) {
    matchRowByAssetNumber(row, usedItemIds);
  }
  // 2패스: 시리얼 보완 (자산번호 매칭 안 된 행만)
  for (const row of excelState.rows) {
    if (row.itemId) continue;
    matchRowBySerial(row, usedItemIds);
  }
  // 3패스: 회사명+모델 보완 (위 두 단계 모두 실패한 행만)
  for (const row of excelState.rows) {
    if (row.itemId) continue;
    matchRowByCustomerModel(row, usedItemIds);
  }
  renderExcelPreview();
}

// 🏷 자산번호 매칭 (가장 신뢰도 높음). 2자 미만이면 매칭 시도 안 함 — 너무 짧으면 우연 충돌 위험.
function matchRowByAssetNumber(row, usedItemIds) {
  row.note = '';
  row.customerId = null;
  row.itemId = null;
  row.status = 'pending';

  const assetNo = (row.assetNumber || row.location || '').trim();
  if (!assetNo) return;

  // 보호: 너무 짧은 자산번호는 매칭 거부 — 메시지로 알림, 다음 단계(시리얼/회사명)로 fallback 가능
  if (assetNo.length < 2) {
    row.note = `자산번호 '${assetNo}' 너무 짧음 (2자 이상 필요)`;
    row.status = 'warn';
    return;
  }

  const key = normalize(assetNo);
  const it = state.items.find(i => i.asset_number && normalize(i.asset_number) === key);
  if (!it) {
    // 자산번호가 입력은 됐지만 임대거래처에 등록 안 됨 — 시리얼/회사명 매칭에 맡김
    row.note = `자산번호 '${assetNo}' 등록 안 됨`;
    row.status = 'warn';
    return;
  }
  if (usedItemIds.has(it.id)) {
    row.note = `자산번호 '${assetNo}' 중복`;
    row.status = 'warn';
    return;
  }
  row.customerId = it.customer_id || null;
  row.itemId = it.id;
  row.status = 'ok';
  row.note = ''; // 성공 시 경고 클리어
  usedItemIds.add(it.id);
}

function matchRowBySerial(row, usedItemIds) {
  // 자산번호 단계에서 warn 으로 표시된 note 가 있을 수 있음 — 시리얼 매칭 성공 시 덮어쓰고, 실패 시 유지
  if (!row.serial) return;
  const serialKey = normalize(row.serial);
  const it = state.items.find(i => i.serial && normalize(i.serial) === serialKey);
  if (!it) return;
  if (usedItemIds.has(it.id)) return;
  row.customerId = it.customer_id || null;
  row.itemId = it.id;
  row.status = 'ok';
  row.note = '';
  usedItemIds.add(it.id);
}

function matchRowByCustomerModel(row, usedItemIds) {
  // 0단계) manual_company_map 강제 매핑
  const rawCompany = row.company;
  const rawLocation = row.location || '';
  if (excelState.manualMap) {
    if (excelState.manualMap[rawLocation]) {
      row.company = excelState.manualMap[rawLocation];
    } else if (excelState.manualMap[rawCompany]) {
      row.company = excelState.manualMap[rawCompany];
    }
  }

  // 1) 거래처 매칭
  const normCompany = normalize(row.company);
  const cust = state.customers.find(c => normalize(c.company) === normCompany)
            || state.customers.find(c => normalize(c.company).includes(normCompany) || normCompany.includes(normalize(c.company)));

  if (!cust) {
    row.customerId = null;
    row.itemId = null;
    row.status = 'fail';
    row.note = '거래처 없음';
    return;
  }
  row.customerId = cust.id;

  // 2) 자산 매칭 — 이미 사용된 item 은 제외
  const candidates = state.items.filter(it => it.customer_id === cust.id && !usedItemIds.has(it.id));
  if (!candidates.length) {
    row.itemId = null;
    row.status = 'warn';
    row.note = '배정 자산 없음 (또는 모두 매칭됨)';
    return;
  }

  let picked = null;
  if (row.model) {
    const nm = normalize(row.model);
    picked = candidates.find(it => normalize(it.model) === nm)
          || candidates.find(it => normalize(it.model).includes(nm) || nm.includes(normalize(it.model)));
  }
  if (!picked && candidates.length === 1) picked = candidates[0];

  if (picked) {
    row.itemId = picked.id;
    row.status = 'ok';
    usedItemIds.add(picked.id);
  } else {
    row.itemId = null;
    row.status = 'warn';
    row.note = `자산 선택 필요 (${candidates.length}대)`;
  }
}

// 단일 행 재매칭 (사용자가 수동으로 회사/모델/자산번호 바꿀 때)
function matchRow(row) {
  // 기존 픽 유지하면서 본인만 재계산. 신뢰도 순: 자산번호 → 시리얼 → 회사명+모델
  const usedItemIds = new Set(excelState.rows.filter(r => r !== row && r.itemId).map(r => r.itemId));
  matchRowByAssetNumber(row, usedItemIds);
  if (!row.itemId) matchRowBySerial(row, usedItemIds);
  if (!row.itemId) matchRowByCustomerModel(row, usedItemIds);
}

function renderExcelPreview() {
  const tbody = document.getElementById('excel-preview-body');
  const rows = excelState.rows;
  let ok = 0, warn = 0, fail = 0;

  tbody.innerHTML = rows.map(r => {
    if (r.status === 'ok' || r.status === 'saved') ok++;
    if (r.status === 'warn') warn++;
    if (r.status === 'fail' || r.status === 'dup-skipped') fail++;

    const cust = r.customerId ? state.customers.find(c => c.id === r.customerId) : null;
    const cands = r.customerId ? state.items.filter(it => it.customer_id === r.customerId) : [];
    const item  = r.itemId ? state.items.find(it => it.id === r.itemId) : null;

    const prev = r.itemId ? state.prevMap[r.itemId] : null;
    const bwPrev = prev?.bw ?? null;
    const coPrev = prev?.color ?? null;
    const bwInc  = (r.bw != null && bwPrev != null) ? Math.max(0, r.bw - bwPrev) : null;
    const coInc  = (r.color != null && coPrev != null) ? Math.max(0, r.color - coPrev) : null;

    const itemSel = r.status === 'fail'
      ? `<span class="muted-small">–</span>`
      : `<select class="cell-edit excel-item-sel" data-idx="${r.idx}">
           <option value="">— 선택 —</option>
           ${cands.map(c => `<option value="${escapeAttr(c.id)}" ${c.id === r.itemId ? 'selected' : ''}>${escapeHtml((c.brand||'') + ' ' + (c.model||c.id))}</option>`).join('')}
         </select>`;

    const custCell = cust
      ? `<span title="${escapeAttr(cust.id)}">${escapeHtml(cust.company)}</span>`
      : `<span style="color:#94a3b8;">미매칭</span>`;

    const statusBadge =
      r.status === 'saved'       ? `<span class="excel-badge ok">저장됨</span>`
    : r.status === 'ok'          ? `<span class="excel-badge ok">✔ 매칭</span>`
    : r.status === 'dup-skipped' ? `<span class="excel-badge warn">중복 제외됨</span>`
    : r.status === 'warn'        ? `<span class="excel-badge warn">⚠ ${escapeHtml(r.note || '확인필요')}</span>`
                                 : `<span class="excel-badge fail">✖ ${escapeHtml(r.note || '실패')}</span>`;

    // 자산번호 셀: 2자 이상이면 강조, 짧으면 흐림. 매칭된 자산의 등록 자산번호와 다르면 표시.
    const assetNo = (r.assetNumber || r.location || '').trim();
    const itemRegAsset = item ? (item.asset_number || '') : '';
    let assetCellHtml;
    if (!assetNo) {
      assetCellHtml = `<span style="color:#94a3b8;">–</span>`;
    } else if (assetNo.length < 2) {
      assetCellHtml = `<span style="color:#dc2626;font-weight:600;" title="2자 미만은 매칭 거부">${escapeHtml(assetNo)}</span><div class="muted-small" style="font-size:10px;color:#dc2626;">⚠ 2자 이상 필요</div>`;
    } else if (item && itemRegAsset && normalize(itemRegAsset) !== normalize(assetNo)) {
      assetCellHtml = `<span style="color:#b45309;font-weight:600;">${escapeHtml(assetNo)}</span><div class="muted-small" style="font-size:10px;color:#b45309;">⚠ 등록값: ${escapeHtml(itemRegAsset)}</div>`;
    } else {
      assetCellHtml = `<span style="font-weight:600;color:#0369a1;">${escapeHtml(assetNo)}</span>`;
    }

    return `
      <tr class="excel-row excel-row-${r.status}">
        <td data-label="#">${r.idx}</td>
        <td data-label="자산번호">${assetCellHtml}</td>
        <td data-label="엑셀 업체명">${escapeHtml(r.company)}${r.model ? `<div class="muted-small">${escapeHtml(r.model)}</div>` : ''}</td>
        <td data-label="매칭 거래처">${custCell}</td>
        <td data-label="매칭 자산">${itemSel}</td>
        <td class="num" data-label="직전 BW">${fmt(bwPrev)}</td>
        <td class="num" data-label="이번 BW">${fmt(r.bw)}</td>
        <td class="num" data-label="BW 증가" style="${bwInc != null && bwInc > 0 ? 'color:#16a34a;font-weight:600;' : ''}">${fmt(bwInc)}</td>
        <td class="num" data-label="직전 컬러">${fmt(coPrev)}</td>
        <td class="num" data-label="이번 컬러">${fmt(r.color)}</td>
        <td class="num" data-label="컬러 증가" style="${coInc != null && coInc > 0 ? 'color:#16a34a;font-weight:600;' : ''}">${fmt(coInc)}</td>
        <td data-label="상태">${statusBadge}</td>
      </tr>
    `;
  }).join('');

  document.getElementById('excel-total').textContent = rows.length;
  document.getElementById('excel-matched').textContent = ok;
  document.getElementById('excel-warn').textContent = warn;
  document.getElementById('excel-fail').textContent = fail;
  document.getElementById('btn-excel-save').disabled = ok === 0;

  // 수동 자산 선택 핸들러
  tbody.querySelectorAll('select.excel-item-sel').forEach(sel => {
    sel.addEventListener('change', e => {
      const idx = Number(e.target.dataset.idx);
      const row = excelState.rows.find(r => r.idx === idx);
      if (!row) return;
      row.itemId = e.target.value || null;
      if (row.itemId) { row.status = 'ok'; row.note = ''; }
      else            { row.status = 'warn'; row.note = '자산 선택 필요'; }
      renderExcelPreview();
    });
  });
}

// ===========================================================
// 중복 카운터 알림 모달
// 이미 이번 달 카운터가 있는 항목을 사용자에게 보여주고
// '취소' / '중복 제외 후 저장' / '전체 덮어쓰기' 중 선택하게 함
// 반환값: null(취소) | 'skip'(중복 제외) | 'force'(덮어쓰기)
// ===========================================================
function showDuplicateModal(duplicates, allTargets) {
  return new Promise(resolve => {
    const overlay = document.getElementById('dup-modal-overlay');
    const tbody   = document.getElementById('dup-modal-tbody');
    const desc    = document.getElementById('dup-modal-desc');
    const btnCancel = document.getElementById('dup-btn-cancel');
    const btnSkip   = document.getElementById('dup-btn-skip');
    const btnForce  = document.getElementById('dup-btn-force');

    // 중복 업체 수
    const uniqueCustomers = new Set();
    for (const r of duplicates) {
      const it = state.items.find(i => i.id === r.itemId);
      if (it?.customer_id) uniqueCustomers.add(it.customer_id);
    }
    desc.textContent =
      `아래 ${duplicates.length}건 (${uniqueCustomers.size}개 업체)은 이번 달(${state.ym})에 이미 카운터가 저장되어 있습니다.`;

    // 테이블 채우기
    tbody.innerHTML = duplicates.map(r => {
      const it = state.items.find(i => i.id === r.itemId);
      const cur = state.curMap[r.itemId] || {};
      const company = it
        ? (state.customers.find(c => c.id === it.customer_id)?.company || it.customer_id)
        : r.company || '-';
      const model = it?.model || r.model || '-';
      const fmtN = v => (v == null ? '-' : Number(v).toLocaleString());
      return `<tr>
        <td style="padding:5px 8px; border-bottom:1px solid #f1f5f9;">${escapeHtml(company)}</td>
        <td style="padding:5px 8px; border-bottom:1px solid #f1f5f9; color:#475569;">${escapeHtml(model)}</td>
        <td style="padding:5px 8px; border-bottom:1px solid #f1f5f9; text-align:center; color:#64748b;">${fmtN(cur.bw)}</td>
        <td style="padding:5px 8px; border-bottom:1px solid #f1f5f9; text-align:center; color:#64748b;">${fmtN(cur.color)}</td>
        <td style="padding:5px 8px; border-bottom:1px solid #f1f5f9; text-align:center; font-weight:600;">${fmtN(r.bw)}</td>
        <td style="padding:5px 8px; border-bottom:1px solid #f1f5f9; text-align:center; font-weight:600;">${fmtN(r.color)}</td>
      </tr>`;
    }).join('');

    // 스킵 버튼: 새 파일에 중복이 아닌 항목이 있을 때만 활성화
    const newOnly = allTargets.filter(r => {
      const cur = state.curMap[r.itemId];
      return !(cur && (cur.bw != null || cur.color != null));
    });
    btnSkip.disabled = newOnly.length === 0;
    btnSkip.title = newOnly.length === 0 ? '중복 제외 시 저장할 항목이 없습니다' : '';

    // 오버레이 표시 (flex)
    overlay.style.display = 'flex';

    function cleanup(result) {
      overlay.style.display = 'none';
      btnCancel.removeEventListener('click', onCancel);
      btnSkip.removeEventListener('click', onSkip);
      btnForce.removeEventListener('click', onForce);
      overlay.removeEventListener('click', onOverlayClick);
      resolve(result);
    }
    const onCancel = () => cleanup(null);
    const onSkip   = () => cleanup('skip');
    const onForce  = () => cleanup('force');
    const onOverlayClick = e => { if (e.target === overlay) cleanup(null); };

    btnCancel.addEventListener('click', onCancel);
    btnSkip.addEventListener('click', onSkip);
    btnForce.addEventListener('click', onForce);
    overlay.addEventListener('click', onOverlayClick);
  });
}

async function saveExcelBatch({ auto = false, forceOverwrite = false } = {}) {
  const targets = excelState.rows.filter(r => r.status === 'ok' && r.itemId);
  if (!targets.length) {
    if (!auto) toast('저장할 행이 없습니다', true);
    return;
  }

  // 동일 파일이 아닐 때: 이미 이번 달 카운터가 있는 항목 감지 → 모달 안내
  if (!forceOverwrite) {
    const duplicates = targets.filter(r => {
      const cur = state.curMap[r.itemId];
      return cur && (cur.bw != null || cur.color != null);
    });
    if (duplicates.length > 0) {
      const proceed = await showDuplicateModal(duplicates, targets);
      if (proceed === null) return; // 취소
      if (proceed === 'skip') {
        // 중복 항목 제외 — status 를 'dup-skipped' 로 표시하고 나머지만 저장
        for (const r of duplicates) r.status = 'dup-skipped';
        renderExcelPreview();
        // 남은 targets 재계산 후 재호출 (force=true 로 중복 검사 통과)
        const remaining = excelState.rows.filter(r => r.status === 'ok' && r.itemId);
        if (!remaining.length) {
          toast('중복 제외 후 저장할 행이 없습니다');
          return;
        }
        await saveExcelBatch({ auto, forceOverwrite: true });
        return;
      }
      // proceed === 'force' → 전체 덮어쓰기, 아래 로직 그대로 진행
    }
  }

  const btn = document.getElementById('btn-excel-save');
  btn.disabled = true;
  btn.textContent = auto ? '자동 저장 중…' : '저장 중…';

  // 저장할 최종 targets (dup-skipped 제외)
  const finalTargets = excelState.rows.filter(r => r.status === 'ok' && r.itemId);
  if (!finalTargets.length) {
    btn.disabled = false;
    btn.textContent = '💾 최종 저장';
    toast('저장할 행이 없습니다', true);
    return;
  }

  try {
    const now = new Date().toISOString();
    const uploadId = excelState.uploadId || null;
    // 안전망: (item_id, ym) 중복 제거 — 마지막 행이 이김
    const dedup = new Map();
    for (const r of finalTargets) {
      const key = r.itemId + '|' + state.ym;
      const existing = state.curMap[r.itemId] || {};
      dedup.set(key, {
        item_id: r.itemId,
        ym: state.ym,
        bw:    r.bw    != null ? r.bw    : (existing.bw    ?? null),
        color: r.color != null ? r.color : (existing.color ?? null),
        uptime_hours: existing.uptime_hours ?? null,
        read_at: now,
        source: 'excel',
        upload_id: uploadId,
      });
    }
    const payloads = Array.from(dedup.values());
    if (payloads.length < finalTargets.length) {
      console.warn(`[saveExcelBatch] (item_id, ym) 중복 ${finalTargets.length - payloads.length}건 자동 제거`);
    }

    const { error } = await supa.from('rental_counters')
      .upsert(payloads, { onConflict: 'item_id,ym' });
    if (error) throw error;

    // ok_count 업데이트
    if (uploadId) {
      try {
        await supa.from('rental_counter_uploads')
          .update({ ok_count: payloads.length })
          .eq('id', uploadId);
      } catch (_) { /* silent */ }
    }

    for (const p of payloads) {
      state.curMap[p.item_id] = p;
      state.itemsEverCounted.add(p.item_id);
    }
    deriveCustomersEverCounted();
    // 저장된 행 상태 표시
    for (const r of finalTargets) r.status = 'saved';

    if (auto) {
      toast(`✔ ${payloads.length}건 저장 완료`);
    } else {
      toast(`${payloads.length}건 저장됨`);
    }
    render();
    renderExcelPreview();

    // 저장 후 serial 자동 백필 (1:1 매칭 케이스만)
    backfillSerials(finalTargets).catch(err => console.warn('[backfillSerials]', err));

    // 청구서 자동 갱신 (영향받은 거래처 일괄)
    const affected = [];
    for (const p of payloads) {
      const it = state.items.find(i => i.id === p.item_id);
      if (it?.customer_id) affected.push(it.customer_id);
    }
    if (affected.length) {
      autoUpdateBillings(affected, { silent: auto }).catch(e => {
        console.warn('[billing-sync] batch fail', e);
        if (!auto) toast('청구서 자동 갱신 실패', true);
      });
    }
  } catch (err) {
    console.error('[saveExcelBatch] err =', err);
    console.error('[saveExcelBatch] err detail =', JSON.stringify(err, null, 2));
    const msg = err?.message || err?.details || err?.hint || String(err);
    const code = err?.code || '';
    // 데이터 문제(중복/FK 위반 등)는 silent — 네트워크 단절 등 치명적 오류만 표시
    const isFatal = !code || /^(PGRST|08|57|XX)/i.test(code);
    if (isFatal && !auto) {
      toast('저장 실패: ' + msg, true);
    } else {
      console.warn('[saveExcelBatch] non-fatal error (silent):', code, msg);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 추가 저장';
  }
}

// ===========================================================
// serial 자동 백필 — saveExcelBatch 성공 후 호출
// 안전 가드: 같은 (customer_id, model) 그룹에 후보가 2개 이상이면 백필 X
// 데이터 손실/오염 방지를 위해 1:1 매칭 케이스만 UPDATE
// ===========================================================
async function backfillSerials(savedTargets) {
  if (!savedTargets || !savedTargets.length) return;

  // 백필 후보: serial 이 있는 엑셀 행 중, rental_items.serial 이 비어있거나 다른 경우
  const candidates = savedTargets.filter(r => r.serial && r.itemId);
  if (!candidates.length) return;

  // (customer_id, model) 단위로 그룹핑해 후보가 1대뿐인 경우만 허용
  // → 같은 거래처에 같은 모델이 여러 대면 어느 serial 인지 확신 못하므로 스킵
  const groupMap = new Map(); // key = `${customer_id}|${model}` → count
  for (const r of candidates) {
    const it = state.items.find(i => i.id === r.itemId);
    if (!it) continue;
    const gk = `${it.customer_id || ''}|${it.model || ''}`;
    groupMap.set(gk, (groupMap.get(gk) || 0) + 1);
  }

  const updateQueue = [];
  for (const r of candidates) {
    const it = state.items.find(i => i.id === r.itemId);
    if (!it) continue;

    // 이미 동일 serial 로 등록돼 있으면 스킵
    if (it.serial && it.serial === r.serial) continue;

    // 안전 가드: 같은 거래처+모델 그룹에 매칭 후보가 2개 이상이면 백필 X
    const gk = `${it.customer_id || ''}|${it.model || ''}`;
    if ((groupMap.get(gk) || 0) > 1) {
      console.warn(`[backfillSerials] 스킵 (그룹 중복): ${gk} — serial=${r.serial}`);
      continue;
    }

    updateQueue.push({ itemId: r.itemId, serial: r.serial });
  }

  if (!updateQueue.length) return;

  for (const { itemId, serial } of updateQueue) {
    try {
      const { error } = await supa.from('rental_items')
        .update({ serial })
        .eq('id', itemId);
      if (error) {
        console.warn(`[backfillSerials] UPDATE 실패 (silent) item=${itemId}:`, error.message);
      } else {
        // 메모리도 갱신 — 다음 업로드 때 1패스 serial 매칭 적용됨
        const it = state.items.find(i => i.id === itemId);
        if (it) it.serial = serial;
        console.info(`[backfillSerials] serial 백필 완료: item=${itemId} serial=${serial}`);
      }
    } catch (e) {
      console.warn(`[backfillSerials] 예외 (silent) item=${itemId}:`, e);
    }
  }
}

function toNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ===========================================================
// 한별 파일 분석 패널 (거래처별 합계 / 전월 대비 / 이상치)
// ===========================================================

async function renderHanbyeolAnalysis(ym, { autoOpen = false } = {}) {
  const panel = document.getElementById('hb-analysis');
  const card  = document.getElementById('hb-analysis-card');
  if (!panel) return;

  // autoOpen=true 일 때만 패널을 강제로 표시 (엑셀 업로드 시에는 false)
  if (autoOpen) {
    if (card) card.style.display = '';
    panel.style.display = '';
    document.getElementById('hb-analysis-toggle-icon').textContent = '닫기 ▴';
  }
  // 패널이 닫혀 있으면 렌더링 스킵
  if (panel.style.display === 'none') return;
  panel.innerHTML = '<div style="padding:20px; color:#64748b;">분석 중…</div>';

  try {
    const prevYm = listMonthsBack(ym, 2)[1];

    // 이번달: 메모리(방금 파싱한 엑셀) 우선, 없으면 DB 조회
    let curRows = [];
    if (excelState.rows && excelState.rows.length) {
      curRows = excelState.rows.map(r => ({
        serial:   r.serial,
        customer: r.company || null,
        location: r.location || null,
        model:    r.model || null,
        bw:       r.bw,
        color:    r.color,
        total:    r.total,
      }));
    } else {
      const curRes = await supa.from('hanbyeol_counters')
        .select('serial,customer,location,model,bw,color,total').eq('ym', ym);
      if (curRes.error) throw curRes.error;
      curRows = curRes.data || [];
    }

    // 전월: DB에서만 조회 (없거나 에러여도 분석 자체는 진행)
    let prevRows = [];
    const prevRes = await supa.from('hanbyeol_counters')
      .select('serial,bw,color').eq('ym', prevYm);
    if (!prevRes.error) prevRows = prevRes.data || [];

    // serial → 전월 데이터 맵
    const prevMap = {};
    for (const r of prevRows) prevMap[r.serial] = r;

    // 거래처별 집계
    const custMap = {};
    for (const r of curRows) {
      const key = r.customer || r.location || '(미상)';
      if (!custMap[key]) custMap[key] = { name: key, devices: [], bwSum: 0, colorSum: 0 };
      const prev = prevMap[r.serial];
      const bwDiff   = (r.bw   != null && prev?.bw   != null) ? r.bw   - prev.bw   : null;
      const colDiff  = (r.color != null && prev?.color != null) ? r.color - prev.color : null;
      custMap[key].devices.push({ ...r, bwDiff, colDiff });
      custMap[key].bwSum    += r.bw    || 0;
      custMap[key].colorSum += r.color || 0;
    }
    const custList = Object.values(custMap).sort((a, b) => a.name.localeCompare(b.name));

    // 전체 기기 평균 증분 (이상치 기준)
    const diffs = curRows.map(r => {
      const p = prevMap[r.serial];
      return (r.bw != null && p?.bw != null) ? r.bw - p.bw : null;
    }).filter(d => d != null && d >= 0);
    const avgDiff = diffs.length ? diffs.reduce((a,b)=>a+b,0)/diffs.length : 0;

    // 이상치 목록
    const anomalies = [];
    for (const r of curRows) {
      const p = prevMap[r.serial];
      const bwD = (r.bw != null && p?.bw != null) ? r.bw - p.bw : null;
      const colD = (r.color != null && p?.color != null) ? r.color - p.color : null;
      if (bwD != null && bwD < 0) {
        anomalies.push({ ...r, kind: 'decrease', bwDiff: bwD, colDiff: colD, msg: '카운터 감소 (기기 교체/리셋 의심)' });
      } else if (avgDiff > 0 && bwD != null && bwD > avgDiff * 3) {
        anomalies.push({ ...r, kind: 'spike', bwDiff: bwD, colDiff: colD, msg: '평균의 3배 초과 (오남용 의심)' });
      }
      if (r.bw == null && r.color == null) {
        anomalies.push({ ...r, kind: 'null', bwDiff: null, colDiff: null, msg: '카운터 미수집 (기기 고장 또는 수집 실패)' });
      }
    }

    // 렌더링
    let html = '';

    // --- 섹션1: 거래처별 합계 ---
    html += `
      <div class="hb-section">
        <div class="hb-section-title">거래처 / 기기별 합계 <span class="muted-small">(${ym} 기준 누적)</span></div>
        <div class="counters-table-wrap">
          <table class="counters-grid" style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="text-align:left; padding:6px 8px;">거래처</th>
                <th style="text-align:left; padding:6px 8px;">모델</th>
                <th style="text-align:left; padding:6px 8px;">일련번호</th>
                <th class="num" style="padding:6px 8px;">흑백 누적</th>
                <th class="num" style="padding:6px 8px;">컬러 누적</th>
                <th class="num" style="padding:6px 8px;">합계</th>
              </tr>
            </thead>
            <tbody>`;
    for (const cs of custList) {
      const rowspan = cs.devices.length;
      cs.devices.forEach((d, di) => {
        html += `<tr class="hb-row" style="${di % 2 === 0 ? '' : 'background:#f8fafc;'}">
          ${di === 0 ? `<td data-label="거래처" style="padding:6px 8px; font-weight:600; border-right:1px solid #e2e8f0;">${escapeHtml(cs.name)}</td>` : '<td data-label="거래처" style="padding:6px 8px;"></td>'}
          <td data-label="모델" style="padding:4px 8px;">${escapeHtml(d.model || '–')}</td>
          <td data-label="일련번호" style="padding:4px 8px; color:#64748b; font-size:11px;">${escapeHtml(d.serial)}</td>
          <td class="num" data-label="흑백 누적" style="padding:4px 8px;">${fmt(d.bw)}</td>
          <td class="num" data-label="컬러 누적" style="padding:4px 8px;">${fmt(d.color)}</td>
          <td class="num" data-label="합계" style="padding:4px 8px;">${fmt(d.total)}</td>
        </tr>`;
      });
    }
    html += `</tbody></table></div></div>`;

    // --- 섹션2: 전월 대비 증가량 ---
    html += `
      <div class="hb-section" style="margin-top:16px;">
        <div class="hb-section-title">전월 대비 증가량 <span class="muted-small">(${prevYm} → ${ym})</span></div>
        <div class="counters-table-wrap">
          <table class="counters-grid" style="width:100%; border-collapse:collapse; font-size:12px;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="text-align:left; padding:6px 8px;">거래처</th>
                <th style="text-align:left; padding:6px 8px;">모델</th>
                <th class="num" style="padding:6px 8px;">흑백 증가</th>
                <th class="num" style="padding:6px 8px;">컬러 증가</th>
                <th style="padding:6px 8px; text-align:center;">비고</th>
              </tr>
            </thead>
            <tbody>`;
    for (const cs of custList) {
      cs.devices.forEach((d, di) => {
        const bwStyle = d.bwDiff != null && d.bwDiff < 0 ? 'color:#dc2626;font-weight:600;' : (d.bwDiff > 0 ? 'color:#16a34a;' : '');
        const colStyle = d.colDiff != null && d.colDiff < 0 ? 'color:#dc2626;font-weight:600;' : (d.colDiff > 0 ? 'color:#16a34a;' : '');
        const note = d.bwDiff == null ? '<span class="muted-small">전월 없음</span>' : '';
        html += `<tr class="hb-row" style="${di % 2 === 0 ? '' : 'background:#f8fafc;'}">
          <td data-label="거래처" style="padding:4px 8px;">${di === 0 ? escapeHtml(cs.name) : ''}</td>
          <td data-label="모델" style="padding:4px 8px;">${escapeHtml(d.model || '–')}</td>
          <td class="num" data-label="흑백 증가" style="padding:4px 8px; ${bwStyle}">${d.bwDiff != null ? (d.bwDiff >= 0 ? '+' : '') + d.bwDiff.toLocaleString() : '–'}</td>
          <td class="num" data-label="컬러 증가" style="padding:4px 8px; ${colStyle}">${d.colDiff != null ? (d.colDiff >= 0 ? '+' : '') + d.colDiff.toLocaleString() : '–'}</td>
          <td data-label="비고" style="padding:4px 8px; text-align:center;">${note}</td>
        </tr>`;
      });
    }
    html += `</tbody></table></div></div>`;

    // --- 섹션3: 이상치 경고 ---
    html += `
      <div class="hb-section" style="margin-top:16px;">
        <div class="hb-section-title" style="color:${anomalies.length ? '#dc2626' : '#64748b'};">
          이상치 경고 <span class="muted-small">(${anomalies.length}건)</span>
        </div>`;
    if (!anomalies.length) {
      html += `<div style="padding:12px 0; color:#64748b; font-size:13px;">이상치 없음</div>`;
    } else {
      html += `<div class="counters-table-wrap">
        <table class="counters-grid" style="width:100%; border-collapse:collapse; font-size:12px;">
          <thead><tr style="background:#fff5f5;">
            <th style="text-align:left; padding:6px 8px;">거래처</th>
            <th style="text-align:left; padding:6px 8px;">모델</th>
            <th style="text-align:left; padding:6px 8px;">일련번호</th>
            <th class="num" style="padding:6px 8px;">흑백 변화</th>
            <th style="padding:6px 8px;">경고 사유</th>
            <th style="padding:6px 8px; text-align:center;">권장 조치</th>
          </tr></thead>
          <tbody>`;
      for (const a of anomalies) {
        const action = a.kind === 'decrease' ? '검침원 재방문 / 기기 교체 확인'
                     : a.kind === 'spike'    ? '사용량 오남용 점검 요청'
                     :                        '기기 점검 / 수집 재시도';
        html += `<tr class="hb-row" style="background:#fff5f5;">
          <td data-label="거래처" style="padding:4px 8px;">${escapeHtml(a.customer || a.location || '–')}</td>
          <td data-label="모델" style="padding:4px 8px;">${escapeHtml(a.model || '–')}</td>
          <td data-label="일련번호" style="padding:4px 8px; font-size:11px; color:#64748b;">${escapeHtml(a.serial)}</td>
          <td class="num" data-label="흑백 변화" style="padding:4px 8px; color:#dc2626; font-weight:600;">${a.bwDiff != null ? (a.bwDiff >= 0 ? '+' : '') + a.bwDiff.toLocaleString() : '–'}</td>
          <td data-label="경고 사유" style="padding:4px 8px; color:#dc2626;">${escapeHtml(a.msg)}</td>
          <td data-label="권장 조치" style="padding:4px 8px; font-size:11px; color:#b45309;">${escapeHtml(action)}</td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
    }
    html += `</div>`;

    panel.innerHTML = html;

  } catch (err) {
    console.error('[hb-analysis]', err);
    if (/relation .* does not exist/i.test(err.message || '')) {
      panel.innerHTML = '<div style="padding:16px; color:#dc2626;">hanbyeol_counters 테이블이 없습니다. <b>rental-counters/schema.sql</b> 을 Supabase 콘솔에서 실행해주세요.</div>';
    } else {
      panel.innerHTML = '<div style="padding:16px; color:#dc2626;">분석 실패: ' + escapeHtml(err.message || String(err)) + '</div>';
    }
  }
}

// ===========================================================
// 청구서 자동 동기화 (카운터 → rental_billings)
// rental-billing/index.js 의 computeBilling 로직을 미러링.
// sent / paid / void 상태는 잠금 → 건너뜀, 그 외는 draft 로 upsert.
// ===========================================================
const BILLING_FIXED_CATS = ['IT', '위생', '출력'];
const BILLING_LOCKED_STATUSES = new Set(['sent', 'paid', 'void']);

function computeCustomerBilling(customerId) {
  const myItems = state.items.filter(it => it.customer_id === customerId);
  const combined = !!state.customerCombined[customerId];
  const fixedItems = [];
  const usageItems = [];

  // 고정비 (IT/위생/출력 monthly_fee)
  for (const it of myItems) {
    const cat = it.category;
    if (BILLING_FIXED_CATS.includes(cat) && (it.monthly_fee || 0) > 0) {
      fixedItems.push({
        item_id: it.id,
        kind: 'fixed',
        category: cat,
        subtype: it.subtype,
        label: `${cat}/${it.subtype}${it.model ? ' ' + it.model : ''}`,
        qty: 1,
        unit_price: it.monthly_fee || 0,
        subtotal: it.monthly_fee || 0,
      });
    }
  }

  // 출력 사용량
  const printItems = myItems.filter(it => it.category === '출력');

  if (combined && printItems.length >= 2) {
    // === 합산 모드 (Phase 4: 카운터 통합 + 단가 가중 평균) ===
    // Phase 4 이슈 1: 자산별 max 제거 → 거래처 단위 합산 후 단일 max 적용
    // Phase 4 이슈 2: bw_free 기준 가중 평균 단가 적용
    let bwFreeT = 0, coFreeT = 0;
    let curBwT = 0, curCoT = 0, prevBwT = 0, prevCoT = 0;
    // 가중 평균 단가 계산용
    let bwRateWeightedSum = 0, coRateWeightedSum = 0;
    let bwFreeForWeight = 0, coFreeForWeight = 0;
    const itemIds = [];
    const labels = [];
    for (const it of printItems) {
      const cnt  = state.curMap[it.id]  || { bw: 0, color: 0 };
      const prev = state.prevMap[it.id] || { bw: 0, color: 0 };
      // Phase 4 이슈 1: 음수 포함 원시값 그대로 누적
      curBwT  += cnt.bw    || 0; curCoT  += cnt.color || 0;
      prevBwT += prev.bw   || 0; prevCoT += prev.color || 0;
      bwFreeT += it.bw_free || 0; coFreeT += it.co_free || 0;
      // Phase 4 이슈 2: 가중 평균 단가 누적 (bw_free 기준 가중)
      const bwFreeW = it.bw_free || 0;
      const coFreeW = it.co_free || 0;
      bwRateWeightedSum += (it.bw_rate || 0) * bwFreeW;
      coRateWeightedSum += (it.co_rate || 0) * coFreeW;
      bwFreeForWeight   += bwFreeW;
      coFreeForWeight   += coFreeW;
      itemIds.push(it.id);
      labels.push(`${it.subtype || ''}${it.model ? ' '+it.model : ''}`.trim());
    }
    // Phase 4 이슈 1: 거래처 통합 카운터로 단일 max 적용
    const monthBwT = Math.max(0, curBwT - prevBwT);
    const monthCoT = Math.max(0, curCoT - prevCoT);
    // Phase 4 이슈 2: 가중 평균 단가 (free 합이 0이면 산술 평균 fallback)
    const bwRate = bwFreeForWeight > 0
      ? bwRateWeightedSum / bwFreeForWeight
      : (printItems.length > 0
          ? printItems.reduce((s, it) => s + (it.bw_rate || 0), 0) / printItems.length
          : 0);
    const coRate = coFreeForWeight > 0
      ? coRateWeightedSum / coFreeForWeight
      : (printItems.length > 0
          ? printItems.reduce((s, it) => s + (it.co_rate || 0), 0) / printItems.length
          : 0);
    // 단가 균일 여부
    const bwRateUniform = printItems.every((it) => (it.bw_rate || 0) === (printItems[0].bw_rate || 0));
    const coRateUniform = printItems.every((it) => (it.co_rate || 0) === (printItems[0].co_rate || 0));
    const hasWeightedRate = !bwRateUniform || !coRateUniform;
    const exBw = Math.max(0, monthBwT - bwFreeT);
    const exCo = Math.max(0, monthCoT - coFreeT);
    const sub  = Math.round(exBw * bwRate + exCo * coRate);
    if (sub > 0) {
      usageItems.push({
        item_id: itemIds.join(','),
        kind: 'usage',
        category: '출력',
        subtype: 'combined',
        label: `출력 합산 (${printItems.length}대: ${labels.filter(Boolean).join(' + ')}) 초과사용`,
        bw: exBw,
        co: exCo,
        month_bw: monthBwT,
        month_co: monthCoT,
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
        _hasWeightedRate: hasWeightedRate,
        _assetCount: printItems.length,
      });
    }
  } else {
    // === 자산별 모드 ===
    for (const it of printItems) {
      const cnt  = state.curMap[it.id]  || { bw: 0, color: 0 };
      const prev = state.prevMap[it.id] || { bw: 0, color: 0 };
      const monthBw = Math.max(0, (cnt.bw    || 0) - (prev.bw    || 0));
      const monthCo = Math.max(0, (cnt.color || 0) - (prev.color || 0));
      const exBw = Math.max(0, monthBw - (it.bw_free || 0));
      const exCo = Math.max(0, monthCo - (it.co_free || 0));
      const sub = exBw * (it.bw_rate || 0) + exCo * (it.co_rate || 0);
      if (sub > 0) {
        usageItems.push({
          item_id: it.id,
          kind: 'usage',
          category: '출력',
          subtype: it.subtype,
          label: `${it.subtype}${it.model ? ' ' + it.model : ''} 초과사용`,
          bw: exBw,
          co: exCo,
          month_bw: monthBw,
          month_co: monthCo,
          bw_rate: it.bw_rate || 0,
          co_rate: it.co_rate || 0,
          counter_bw_prev: prev.bw || 0,
          counter_color_prev: prev.color || 0,
          counter_bw: cnt.bw || 0,
          counter_color: cnt.color || 0,
          bw_free: it.bw_free || 0,
          co_free: it.co_free || 0,
          subtotal: sub,
        });
      }
    }
  }

  const fixed_total = fixedItems.reduce((s, x) => s + x.subtotal, 0);
  const usage_total = usageItems.reduce((s, x) => s + x.subtotal, 0);
  return {
    fixed_total,
    usage_total,
    total: fixed_total + usage_total,
    items: [...fixedItems, ...usageItems],
    combined,
  };
}

async function autoUpdateBillings(customerIds, { silent = false } = {}) {
  // 다개월 거래처(분기/반기/연간)는 카운터 페이지에서 자동 갱신하지 않음
  // (정확한 N개월 합산은 청구 페이지에서 발행)
  const uniq = [...new Set((customerIds || []).filter(Boolean))]
    .filter(cid => (Number(state.customerPeriod[cid]) || 1) === 1);
  if (!uniq.length) return { ok: 0, skipped: 0, empty: 0 };

  const ym = state.ym;

  // 기존 청구서 상태 조회
  const { data: existRows, error: exErr } = await supa.from('rental_billings')
    .select('id, customer_id, ym, status')
    .eq('ym', ym)
    .in('customer_id', uniq);
  if (exErr) throw exErr;

  const existMap = new Map();
  for (const b of (existRows || [])) existMap.set(b.customer_id, b);

  const rows = [];
  let skipped = 0, empty = 0;

  for (const cid of uniq) {
    const ex = existMap.get(cid);
    if (ex && BILLING_LOCKED_STATUSES.has(ex.status)) { skipped++; continue; }

    const calc = computeCustomerBilling(cid);
    // 추가요금(usage)이 발생한 거래처만 청구서 발행
    if ((calc.usage_total || 0) <= 0) { empty++; continue; }

    rows.push({
      id: `b_${cid}_${ym}`,
      customer_id: cid,
      ym,
      fixed_total: calc.fixed_total,
      usage_total: calc.usage_total,
      items: calc.items,
      status: ex?.status || 'draft',
    });
  }

  if (!rows.length) {
    if (!silent) toast(`청구서 갱신 대상 없음 (잠금 ${skipped}건)`);
    return { ok: 0, skipped, empty };
  }

  const { error: upErr } = await supa.from('rental_billings')
    .upsert(rows, { onConflict: 'customer_id,ym' });
  if (upErr) throw upErr;

  if (!silent) {
    const parts = [`청구서 ${rows.length}건 자동 갱신`];
    if (skipped) parts.push(`잠긴 ${skipped}건 스킵`);
    toast(parts.join(' · '));
  }
  return { ok: rows.length, skipped, empty };
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.style.background = isError ? '#dc2626' : '#0f172a';
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

// ===========================================================
// 업로드 이력 패널
// ===========================================================
let _uploadHistoryShowAll = false;

async function loadUploadHistory({ all = false } = {}) {
  if (all) _uploadHistoryShowAll = true;
  const list = document.getElementById('upload-history-list');
  const btnAll = document.getElementById('btn-show-all-uploads');
  list.innerHTML = '<div class="upload-history-empty">로딩 중…</div>';

  let query = supa.from('rental_counter_uploads')
    .select('id, ym, file_name, storage_path, file_size, uploaded_by, uploaded_at, row_count, ok_count, status')
    .in('status', ['active', 'replaced'])
    .order('ym', { ascending: false })
    .order('uploaded_at', { ascending: false });

  if (!_uploadHistoryShowAll) {
    // 최근 12개월
    const cutoff = listMonthsBack(state.ym, 12).at(-1);
    query = query.gte('ym', cutoff);
  }

  const { data, error } = await query.limit(200);
  if (error) {
    list.innerHTML = '<div class="upload-history-empty" style="color:#dc2626;">이력 로드 실패</div>';
    return;
  }

  if (!data || !data.length) {
    list.innerHTML = '<div class="upload-history-empty">업로드 이력 없음</div>';
    btnAll.style.display = 'none';
    return;
  }

  // ym 기준으로 그룹핑
  const groups = new Map();
  for (const row of data) {
    if (!groups.has(row.ym)) groups.set(row.ym, []);
    groups.get(row.ym).push(row);
  }

  list.innerHTML = [...groups.entries()].map(([ym, rows]) => `
    <div class="upload-ym-group">
      <div class="upload-ym-label">${escapeHtml(ym)} (${rows.length}건)</div>
      ${rows.map(row => renderUploadRow(row)).join('')}
    </div>
  `).join('');

  // 이벤트 바인딩
  list.querySelectorAll('[data-action="download"]').forEach(btn => {
    btn.addEventListener('click', () => downloadUpload(btn.dataset.id, btn.dataset.path));
  });
  list.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', () => deleteUpload(btn.dataset.id, btn.dataset.path, btn.dataset.name));
  });

  // 전체 보기 버튼: 12개월 제한 중이고 데이터가 꽉 찬 경우 표시
  btnAll.style.display = (!_uploadHistoryShowAll && data.length >= 1) ? '' : 'none';
}

function renderUploadRow(row) {
  const isReplaced = row.status === 'replaced';
  const dateStr = row.uploaded_at
    ? new Date(row.uploaded_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';
  const sizeStr = row.file_size ? `${(row.file_size / 1024).toFixed(0)}KB` : '';
  const meta = [dateStr, sizeStr, `${row.ok_count || 0}건 처리`].filter(Boolean).join(' · ');

  return `
    <div class="upload-row${isReplaced ? ' replaced' : ''}">
      <div class="upload-row-name" title="${escapeAttr(row.file_name)}">
        ${isReplaced ? '<span style="color:#94a3b8;">[대체됨] </span>' : ''}${escapeHtml(row.file_name)}
      </div>
      <div class="upload-row-meta">${escapeHtml(meta)}</div>
      <div class="upload-row-btns">
        <button class="btn ghost small" style="font-size:11px;" data-action="download" data-id="${escapeAttr(row.id)}" data-path="${escapeAttr(row.storage_path)}" title="다운로드">다운로드</button>
        <button class="btn ghost small" style="font-size:11px; color:#dc2626;" data-action="delete" data-id="${escapeAttr(row.id)}" data-path="${escapeAttr(row.storage_path)}" data-name="${escapeAttr(row.file_name)}" title="삭제">삭제</button>
      </div>
    </div>
  `;
}

async function downloadUpload(id, storagePath) {
  const { data, error } = await supa.storage
    .from('counter-uploads')
    .createSignedUrl(storagePath, 60);
  if (error || !data?.signedUrl) {
    toast('다운로드 URL 생성 실패', true);
    return;
  }
  window.open(data.signedUrl, '_blank');
}

async function deleteUpload(id, storagePath, fileName) {
  const ok = confirm(
    `"${fileName}" 파일과 이 파일이 입력한 카운터 값을 모두 삭제합니다.\n진행할까요?`
  );
  if (!ok) return;

  // Storage 파일 삭제 (실패해도 DB 행 삭제는 진행)
  await supa.storage.from('counter-uploads').remove([storagePath]).catch(() => {});

  // DB 행 삭제 → cascade로 rental_counters 행도 자동 삭제
  const { error } = await supa.from('rental_counter_uploads').delete().eq('id', id);
  if (error) {
    toast('삭제 실패: ' + error.message, true);
    return;
  }

  toast('파일 및 카운터 데이터 삭제 완료');

  // 이력 + 카운터 화면 재로드
  await loadUploadHistory({ all: _uploadHistoryShowAll });
  await reload();
}
