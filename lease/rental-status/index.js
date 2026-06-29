// ============================================================
// totalas — 임대현황 v3 (rental-status)
// 전략 분석 패널 — 도표 6개 + 분석 5섹션
// 의존: window.totalasAuth (auth.js), supabase-js v2, chart.js v4
// ============================================================
(function () {
  'use strict';

  // ============================================================
  // 임계값 상수 — 이 위치에서 한 번에 관리
  // ============================================================
  const THRESHOLDS = {
    AGED_MONTHS:    60,   // 위험 노후도 (5년, 이 이상 = 교체 검토)
    WARN_MONTHS:    36,   // 주의 노후도 (3년, 이 이상 = 점검 권장)
    NEAR_AGED:      6,    // 향후 N개월 내 노후화 도달 예측 경계
    TOP10_FEE:      10,   // 매출 상위 N개사
    FEW_ASSETS:     2,    // '자산 적은 거래처' 기준 (N개 이하)
    HIGH_REVENUE_PCT: 20, // 상위 수익 거래처 비율 (%)
  };

  // 9개 카테고리 — 이 순서로 차트/히트맵 표시
  const CATS = [
    '흑백복사기', '컬러복사기', '흑백레이저', '컬러레이저', '잉크젯',
    '컴퓨터', '모니터', '웰리스', '나스',
  ];

  let CATEGORIES_ALL = [
    '흑백복사기', '컬러복사기', '흑백레이저', '컬러레이저', '잉크젯',
    '컴퓨터', '노트북', '모니터', 'PC유지보수', '웰리스', '나스',
  ];

  const MAX_RENDER = 1000;

  // ============================================================
  // 상태
  // ============================================================
  const state = {
    customers: [],        // raw (DB 원본)
    billingGroups: [],    // rental_billing_groups 원본
    items: [],
    assignments: [],
    orders: [],           // ASMS 접수(orders) 중 임대 관련 건 (교체/초기설치/회수)
    loaded: false,
    activeTab: 'customers',
    charts: {},  // 차트 인스턴스 보관
    filters: {
      cust: { q: '', pay: '', cat: '' },
      item: { q: '', cat: '', status: '', assign: '', rtype: '' },
      age:  { q: '', cat: '', band: '' },
      memo: { q: '', kind: '' },
    },
  };

  // ============================================================
  // 유틸
  // ============================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
  function fmtMoney(n) {
    if (n == null || Number.isNaN(Number(n))) return '–';
    return Math.round(Number(n)).toLocaleString('ko-KR');
  }
  function fmtDate(d) {
    if (!d) return '–';
    return String(d).slice(0, 10);
  }
  function todayStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }
  function timeStr() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ============================================================
  // 품목 분류
  // ============================================================
  function classifyItem(it, asgn) {
    const sub = ((it && it.subtype) || '').toLowerCase();
    const isColor = asgn ? ((asgn.co_rate || 0) > 0 || (asgn.co_free || 0) > 0) : false;
    if (sub.includes('흑백복합기') || sub.includes('흑백복사기')) return '흑백복사기';
    if (sub.includes('컬러복합기') || sub.includes('컬러복사기')) return '컬러복사기';
    if (sub.includes('흑백레이저')) return '흑백레이저';
    if (sub.includes('컬러레이저')) return '컬러레이저';
    if (/복합기|mfp|복사/.test(sub))  return isColor ? '컬러복사기' : '흑백복사기';
    if (/laser|레이저/.test(sub))     return isColor ? '컬러레이저' : '흑백레이저';
    if (/inkjet|잉크젯/.test(sub))    return '잉크젯';
    if (/유지보수|maintenance|maintain/.test(sub)) return 'PC유지보수';
    if (/노트북|notebook|laptop/.test(sub)) return '노트북';
    if (/pc|컴퓨터|데스크/.test(sub)) return '컴퓨터';
    if (/monitor|모니터/.test(sub))   return '모니터';
    if ((it && it.category) === '위생' || /wellness|wellis|웰리스|제균|필터/.test(sub)) return '웰리스';
    if (/nas|나스/.test(sub))         return '나스';
    return '기타';
  }

  // ============================================================
  // 노후도
  // ============================================================
  function ageMonths(item) {
    if (!item || !item.install_date) return null;
    const ins = new Date(item.install_date);
    if (Number.isNaN(ins.getTime())) return null;
    const now = new Date();
    return Math.max(0,
      (now.getFullYear() - ins.getFullYear()) * 12 + (now.getMonth() - ins.getMonth())
    );
  }
  function ageBand(m) {
    if (m == null) return 'none';
    if (m >= THRESHOLDS.AGED_MONTHS) return 'bad';
    if (m >= THRESHOLDS.WARN_MONTHS) return 'warn';
    return 'ok';
  }
  function agePillHtml(m) {
    const band = ageBand(m);
    const label = m == null ? '–' : `${m}개월`;
    return `<span class="age-pill ${band}">${label}</span>`;
  }
  function statusTagHtml(s) {
    const safe = String(s || 'active').toLowerCase();
    return `<span class="status-tag ${safe}">${escHtml(safe)}</span>`;
  }
  function payTagHtml(p) {
    if (!p) return '<span class="muted-cell">–</span>';
    return `<span class="pay-tag ${escHtml(p)}">${escHtml(p)}</span>`;
  }
  function rtypeTagHtml(rtype) {
    if (rtype === 'free') return '<span class="rtype-tag free">무상</span>';
    return '<span class="rtype-tag paid">유상</span>';
  }

  // ============================================================
  // 파생 데이터 헬퍼
  // ============================================================
  function activeAssignmentsList() {
    const t = todayStr();
    return state.assignments.filter(a =>
      (!a.end_date || a.end_date >= t) && (!a.start_date || a.start_date <= t));
  }
  function buildItemAssignMap() {
    const map = new Map();
    const acts = activeAssignmentsList().sort((a, b) =>
      String(b.start_date || '').localeCompare(String(a.start_date || '')));
    for (const a of acts) {
      if (!map.has(a.item_id)) map.set(a.item_id, a);
    }
    return map;
  }
  function buildCustomerMap() {
    const m = new Map();
    for (const c of state.customers) m.set(c.id, c);
    return m;
  }
  function buildItemMap() {
    const m = new Map();
    for (const it of state.items) m.set(it.id, it);
    return m;
  }
  function activeCustList() {
    return state.customers.filter(c => c.active !== false && !c.archived_at);
  }

  // ============================================================
  // 그룹 인식 헬퍼
  // ============================================================

  /**
   * active=true 인 그룹 Map (id -> group row) — bill_combined 무관 합산
   */
  function activeGroupMap() {
    const m = new Map();
    for (const g of (state.billingGroups || [])) {
      if (g.active !== false) {
        m.set(g.id, g);
      }
    }
    return m;
  }

  /**
   * 활성 거래처 배열을 "그룹 인식 뷰"로 변환.
   * active 그룹의 멤버는 가상의 그룹 행 1건으로 대체 (bill_combined 무관).
   * 그룹 미소속 거래처는 그대로 유지.
   *
   * 반환 배열 요소 형식 (기존 customer row 와 유사하게 맞춤):
   *   { _key, _isGroup, id, company, contact_name, address, payment_type,
   *     invoice_day, notes, active, _memberIds, _memberCount, _groupObj }
   *
   * _key: 'group:${billing_group_id}' | 'cust:${id}'
   */
  function buildGroupedCustomerList() {
    const custs = activeCustList();
    const gmap = activeGroupMap();

    // 그룹별 멤버 수집 (활성 멤버만)
    const groupMembers = new Map(); // groupId -> customer[]
    const handledByGroup = new Set(); // 그룹으로 흡수된 customer.id

    for (const c of custs) {
      const gid = c.billing_group_id;
      if (gid && gmap.has(gid)) {
        if (!groupMembers.has(gid)) groupMembers.set(gid, []);
        groupMembers.get(gid).push(c);
        handledByGroup.add(c.id);
      }
    }

    const result = [];

    // 그룹 행 생성
    for (const [gid, members] of groupMembers.entries()) {
      const g = gmap.get(gid);
      const memberCount = members.length;
      result.push({
        _key: `group:${gid}`,
        _isGroup: true,
        id: `group:${gid}`,
        company: `${g.name} (${memberCount}개사)`,
        contact_name: null,
        address: null,
        payment_type: g.payment_type || null,
        invoice_day: g.invoice_day || null,
        notes: g.notes || null,
        active: true,
        archived_at: null,
        billing_group_id: gid,
        bill_combined: true,
        _memberIds: members.map(c => c.id),
        _memberCount: memberCount,
        _members: members,
        _groupObj: g,
      });
    }

    // 그룹 미소속 거래처 (active 그룹에 흡수되지 않은 거래처)
    for (const c of custs) {
      if (!handledByGroup.has(c.id)) {
        result.push(Object.assign({ _key: `cust:${c.id}`, _isGroup: false }, c));
      }
    }

    return result;
  }

  /**
   * buildCustomerStats()의 그룹 인식 버전.
   * Map 키: 'group:${gid}' 또는 'cust:${id}'
   *
   * 기존 코드 호환을 위해 buildCustomerStats() 자체도 유지하되,
   * 이후 렌더 함수는 모두 buildGroupAwareStats() 를 사용한다.
   */
  function buildGroupAwareStats() {
    const itemMap = buildItemMap();
    const gmap = activeGroupMap();
    // customer.id -> groupId (active 그룹 소속)
    const custGroupId = new Map();
    for (const c of state.customers) {
      if (c.billing_group_id && gmap.has(c.billing_group_id)) {
        custGroupId.set(c.id, c.billing_group_id);
      }
    }

    const stats = new Map();

    function getOrCreate(key) {
      if (!stats.has(key)) {
        stats.set(key, {
          items: [], assignments: [], monthlyFee: 0,
          byCat: {}, maxAge: null, ages: [],
        });
      }
      return stats.get(key);
    }

    const acts = activeAssignmentsList();
    for (const a of acts) {
      const it = itemMap.get(a.item_id);
      if (!it) continue;
      // 이 assignment 의 고객이 합산 그룹 소속이면 그룹 키로 집계
      const gid = custGroupId.get(a.customer_id);
      const key = gid ? `group:${gid}` : `cust:${a.customer_id}`;
      const s = getOrCreate(key);
      s.items.push(it);
      s.assignments.push(a);
      s.monthlyFee += Number(a.monthly_fee || 0);
      const cat = classifyItem(it, a);
      s.byCat[cat] = (s.byCat[cat] || 0) + 1;
      const ag = ageMonths(it);
      if (ag != null) {
        s.ages.push(ag);
        s.maxAge = s.maxAge == null ? ag : Math.max(s.maxAge, ag);
      }
    }
    return stats;
  }

  /** (기존 호환용 — 거래처별 단순 집계, customer_id 키) */
  function buildCustomerStats() {
    const itemMap = buildItemMap();
    const stats = new Map();
    const acts = activeAssignmentsList();
    for (const a of acts) {
      const it = itemMap.get(a.item_id);
      if (!it) continue;
      const s = stats.get(a.customer_id) || {
        items: [], assignments: [], monthlyFee: 0, byCat: {}, maxAge: null, ages: [],
      };
      s.items.push(it);
      s.assignments.push(a);
      s.monthlyFee += Number(a.monthly_fee || 0);
      const c = classifyItem(it, a);
      s.byCat[c] = (s.byCat[c] || 0) + 1;
      const ag = ageMonths(it);
      if (ag != null) {
        s.ages.push(ag);
        s.maxAge = s.maxAge == null ? ag : Math.max(s.maxAge, ag);
      }
      stats.set(a.customer_id, s);
    }
    return stats;
  }

  function getItemRows() {
    const assignMap = buildItemAssignMap();
    const custMap = buildCustomerMap();
    return state.items.map(it => {
      const a = assignMap.get(it.id);
      const cust = a && custMap.get(a.customer_id);
      return { it, assignment: a || null, customer: cust || null, ageM: ageMonths(it) };
    });
  }

  // ============================================================
  // 데이터 로딩
  // ============================================================
  async function loadCategoriesFromMaster() {
    if (typeof window.loadItemTypes !== 'function') return;
    try {
      const types = await window.loadItemTypes();
      if (types && types.length) CATEGORIES_ALL = types.filter(t => t.active).map(t => t.label);
    } catch (e) {
      console.warn('[rental-status] 마스터 로드 실패:', e);
    }
  }

  async function loadAll() {
    const supa = window.totalasAuth;
    if (!supa) throw new Error('Supabase 클라이언트 미초기화');
    await loadCategoriesFromMaster();
    const leaseKindList = '("임대초기설치","임대제품교체","임대제품회수")';
    const [cuRes, itRes, asRes, bgRes, odRes] = await Promise.all([
      supa.from('rental_customers').select('*').range(0, 9999),
      supa.from('rental_items').select('*').range(0, 9999),
      supa.from('rental_assignments').select('*').range(0, 9999),
      supa.from('rental_billing_groups').select('*').range(0, 999),
      // ASMS 접수관리툴(orders) — 임대 관련 건만 (product 또는 mo_engname 기준)
      supa.from('orders')
        .select('seq_no, cu_name, product, mo_engname, process_date, re_now, status')
        .or(`product.in.${leaseKindList},mo_engname.in.${leaseKindList}`)
        .range(0, 9999),
    ]);
    if (cuRes.error) throw cuRes.error;
    if (itRes.error) throw itRes.error;
    if (asRes.error) throw asRes.error;
    // billing_groups / orders 실패는 치명적이지 않음 — 빈 배열로 폴백
    state.customers = cuRes.data || [];
    state.items = itRes.data || [];
    state.assignments = asRes.data || [];
    state.billingGroups = bgRes.error ? [] : (bgRes.data || []);
    state.orders = odRes.error ? [] : (odRes.data || []);
    if (odRes.error) console.warn('[rental-status] ASMS orders 로드 실패:', odRes.error);
    state.loaded = true;
  }

  // ============================================================
  // 만원 단위 약식 표기 (예: 234.5만, 1,234만)
  // ============================================================
  function fmtWan(n) {
    if (n == null || Number.isNaN(Number(n))) return '–';
    const v = Math.round(Number(n));
    if (v === 0) return '0';
    if (v < 10000) return v.toLocaleString('ko-KR');
    const man = v / 10000;
    if (man < 100) return man.toFixed(1).replace(/\.0$/, '') + '만';
    return Math.round(man).toLocaleString('ko-KR') + '만';
  }

  // ============================================================
  // KPI 카드 렌더
  // ============================================================
  function renderKpi() {
    const items = state.items;
    const activeItems = items.filter(i => (i.status || 'active') === 'active');
    const acts = activeAssignmentsList();

    const totalFee = acts.reduce((s, a) => s + Number(a.monthly_fee || 0), 0);
    const ages = activeItems.map(ageMonths).filter(v => v != null);
    const avgAge = ages.length ? Math.round(ages.reduce((s, v) => s + v, 0) / ages.length) : null;
    const dangerCount = activeItems.filter(i => {
      const m = ageMonths(i);
      return m != null && m >= THRESHOLDS.AGED_MONTHS;
    }).length;

    // 배정된 자산 수 (item_id 기준 unique)
    const assignedItemIds = new Set(acts.map(a => a.item_id));
    const util = items.length ? Math.round(assignedItemIds.size / items.length * 100) : 0;

    const setEl = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

    // 그룹 인식 통계
    const groupedList = buildGroupedCustomerList();
    const gaStats = buildGroupAwareStats();

    const unitsWithFee = groupedList.filter(u => gaStats.has(u._key));
    const feeList = unitsWithFee.map(u => gaStats.get(u._key).monthlyFee || 0).sort((a, b) => a - b);
    const avgFeePerCust = feeList.length
      ? Math.round(feeList.reduce((s, v) => s + v, 0) / feeList.length)
      : null;
    const medianFee = feeList.length
      ? (feeList.length % 2 === 0
          ? Math.round((feeList[feeList.length/2 - 1] + feeList[feeList.length/2]) / 2)
          : feeList[Math.floor(feeList.length/2)])
      : null;
    const maxFee = feeList.length ? feeList[feeList.length - 1] : null;
    const avgItemsPerCust = unitsWithFee.length
      ? (unitsWithFee.reduce((s, u) => s + (gaStats.get(u._key).items || []).length, 0) / unitsWithFee.length).toFixed(1)
      : null;

    // 파레트 계산: 상위 20% 단위(그룹/거래처)가 매출에서 차지하는 비중
    const sortedFeeList = unitsWithFee
      .map(u => {
        const s = gaStats.get(u._key) || {};
        return { key: u._key, company: u.company, fee: s.monthlyFee || 0, isGroup: u._isGroup };
      })
      .sort((a, b) => b.fee - a.fee);
    const top20n = Math.max(1, Math.ceil(sortedFeeList.length * 0.2));
    const top20fee = sortedFeeList.slice(0, top20n).reduce((s, r) => s + r.fee, 0);
    const top20pct = totalFee > 0 ? Math.round(top20fee / totalFee * 100) : 0;

    // 활성 거래처 수 — KPI 카드는 실제 회사 수(그룹 포함 멤버 수)를 표시
    const activeCusts = activeCustList();
    setEl('kpi-cust', groupedList.length.toLocaleString());
    setEl('kpi-cust-sub', `거래처 ${activeCusts.length}개사 · 그룹 ${groupedList.filter(u=>u._isGroup).length}건 합산`);
    setEl('kpi-items', items.length.toLocaleString());
    setEl('kpi-items-sub', `활성 ${activeItems.length} · 배정 ${assignedItemIds.size}`);
    setEl('kpi-fee', fmtMoney(totalFee));
    setEl('kpi-util', `${util}<span class="unit">%</span>`);
    setEl('kpi-avgage', avgAge != null
      ? `${avgAge}<span class="unit">개월</span>`
      : `–<span class="unit">개월</span>`);
    setEl('kpi-avgage-sub', ages.length ? `${ages.length}건 평균` : '도입일 없음');
    setEl('kpi-danger', dangerCount.toLocaleString());
    setEl('kpi-danger-sub', dangerCount > 0
      ? `노후도 60개월+ (교체 검토)`
      : '노후도 60개월+ 자산');

    // 거래처당 평균 임대료
    if (avgFeePerCust != null) {
      setEl('kpi-avg-fee',
        `<span style="font-size:22px;">${fmtWan(avgFeePerCust)}</span><span class="unit" style="font-size:12px;">원</span>`);
      const subParts = [];
      if (medianFee != null) subParts.push(`중앙값 ${fmtWan(medianFee)}원`);
      if (maxFee != null) subParts.push(`최대 ${fmtWan(maxFee)}원`);
      setEl('kpi-avg-fee-sub', subParts.join(' · ') || `${unitsWithFee.length}개 단위 기준`);
    } else {
      setEl('kpi-avg-fee', '–');
      setEl('kpi-avg-fee-sub', '배정 데이터 없음');
    }

    // 거래처당 평균 자산수
    if (avgItemsPerCust != null) {
      setEl('kpi-avg-items', `${avgItemsPerCust}<span class="unit">대</span>`);
      setEl('kpi-avg-items-sub', `${unitsWithFee.length}개 활성 단위 기준`);
    } else {
      setEl('kpi-avg-items', '–<span class="unit">대</span>');
      setEl('kpi-avg-items-sub', '배정 데이터 없음');
    }

    // 거래처당 평균 임대료 카드 클릭 → 드릴다운 (임대료 내림차순)
    const avgFeeCard = document.getElementById('kpi-card-avg-fee');
    if (avgFeeCard) {
      avgFeeCard.onclick = () => {
        const drillItems = sortedFeeList.map(r => {
          const s = gaStats.get(r.key) || { items: [], maxAge: null };
          return {
            company: r.company || '–',
            contact: '–',
            monthlyFee: r.fee,
            itemCount: (s.items || []).length,
            maxAge: s.maxAge,
            custId: r.key,
          };
        });
        openDrillModal({
          type: 'customers',
          title: `거래처별 월 임대료 (내림차순) — 평균 ${fmtWan(avgFeePerCust)}원`,
          items: drillItems,
        });
      };
    }

    // state에 파레트 값 저장 → 책사 조언에서 참조
    state._top20pct = top20pct;
    state._top20n = top20n;
    state._avgFeePerCust = avgFeePerCust;
    state._sortedFeeList = sortedFeeList;
    state._gaStats = gaStats;
    state._groupedList = groupedList;
  }

  // ============================================================
  // 차트 공통 헬퍼
  // ============================================================
  function destroyChart(key) {
    if (state.charts[key]) {
      state.charts[key].destroy();
      delete state.charts[key];
    }
  }

  const CHART_COLORS = [
    '#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6',
    '#06b6d4','#f97316','#84cc16','#ec4899','#64748b',
  ];

  // ============================================================
  // Chart 1: 매출 상위 거래처 TOP 10
  // ============================================================
  function renderChartTop10() {
    destroyChart('top10');
    const gaStats = buildGroupAwareStats();
    const groupedList = buildGroupedCustomerList();

    const allRows = groupedList.map(u => ({
      name: u.company || `#${u.id}`,
      fee: (gaStats.get(u._key) || {}).monthlyFee || 0,
      key: u._key,
    })).sort((a, b) => b.fee - a.fee);
    const rows = allRows.slice(0, THRESHOLDS.TOP10_FEE);

    // KPI 핵심 숫자
    const top1fee = rows.length ? rows[0].fee : 0;
    const kpiEl = document.getElementById('kpi-top10');
    if (kpiEl) kpiEl.innerHTML = rows.length
      ? `${fmtMoney(top1fee)}<span class="unit">원</span>`
      : '–';

    if (rows.length === 0) {
      setCaption('cap-top10', '데이터 없음');
      return;
    }
    const ctx = document.getElementById('chart-top10');
    if (!ctx) return;

    // 드릴 데이터 저장
    _chartDrills['top10'] = {
      type: 'customers',
      title: `매출 상위 거래처 TOP ${rows.length}`,
      items: rows.map(r => {
        const s = gaStats.get(r.key) || { items: [], maxAge: null };
        return {
          company: r.name,
          contact: '–',
          monthlyFee: r.fee,
          itemCount: s.items.length,
          maxAge: s.maxAge,
          custId: r.key,
        };
      }),
    };

    state.charts['top10'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name.length > 10 ? r.name.slice(0, 10) + '…' : r.name),
        datasets: [{
          label: '월 임대료 (원)',
          data: rows.map(r => r.fee),
          backgroundColor: '#3b82f6',
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => fmtMoney(c.raw) + '원' } },
        },
        scales: {
          x: {
            ticks: {
              font: { size: 10 },
              callback: v => (v >= 10000 ? Math.round(v/10000) + '만' : v),
            },
          },
          y: { ticks: { font: { size: 11 } } },
        },
        onClick: (evt, els) => {
          if (!els.length) return;
          const idx = els[0].index;
          const r = rows[idx];
          if (!r) return;
          const s = gaStats.get(r.key) || { items: [], maxAge: null };
          openDrillModal({
            type: 'customers',
            title: `${r.name} — 상세`,
            items: [{
              company: r.name,
              contact: '–',
              monthlyFee: r.fee,
              itemCount: s.items.length,
              maxAge: s.maxAge,
              custId: r.key,
            }],
          });
        },
      },
    });
    const top1 = rows[0];
    setCaption('cap-top10',
      `1위 ${top1.name}: 월 ${fmtMoney(top1.fee)}원. 상위 ${rows.length}개사 합계: ${fmtMoney(rows.reduce((s,r)=>s+r.fee,0))}원.`);
  }

  // ============================================================
  // Chart 2: 거래처 × 카테고리 히트맵 (HTML 테이블)
  // ============================================================
  function renderHeatmap() {
    const wrap = document.getElementById('heatmap-wrap');
    if (!wrap) return;

    const assignMap = buildItemAssignMap();
    const gaStats = buildGroupAwareStats();
    const groupedList = buildGroupedCustomerList();

    const units = groupedList
      .map(u => ({ u, fee: (gaStats.get(u._key) || {}).monthlyFee || 0 }))
      .sort((a, b) => b.fee - a.fee)
      .slice(0, 15);

    const activeCats = CATS.filter(cat =>
      state.items.some(it => classifyItem(it, assignMap.get(it.id)) === cat)
    );

    // KPI 핵심 숫자: 3종 이상 보유 단위 수
    const multiCatCount = units.filter(({ u }) => {
      const s = gaStats.get(u._key) || {};
      return Object.keys(s.byCat || {}).length >= 3;
    }).length;
    const kpiEl = document.getElementById('kpi-heatmap');
    if (kpiEl) kpiEl.innerHTML = `${multiCatCount}<span class="unit">사 복합보유</span>`;

    // 드릴 데이터 저장 (다중 카테고리 보유)
    const multiCatList = units.filter(({ u }) => {
      const s = gaStats.get(u._key) || {};
      return Object.keys(s.byCat || {}).length >= 3;
    }).map(({ u }) => {
      const s = gaStats.get(u._key) || { items: [], monthlyFee: 0, maxAge: null };
      return {
        company: u.company || '–',
        contact: u._isGroup ? `${u._memberCount}개 계열사` : (u.contact_name || '–'),
        monthlyFee: s.monthlyFee,
        itemCount: s.items.length,
        maxAge: s.maxAge,
        custId: u._key,
      };
    });
    _chartDrills['heatmap'] = {
      type: 'customers',
      title: `3종 이상 카테고리 보유 거래처 ${multiCatCount}곳`,
      items: multiCatList,
    };

    if (units.length === 0 || activeCats.length === 0) {
      wrap.innerHTML = '<div class="rs-loading">데이터 없음</div>';
      return;
    }

    let maxCount = 1;
    for (const { u } of units) {
      const s = gaStats.get(u._key) || {};
      for (const cat of activeCats) {
        const n = (s.byCat || {})[cat] || 0;
        if (n > maxCount) maxCount = n;
      }
    }
    function cellBg(n) {
      if (!n) return '#f8fafc';
      const ratio = Math.min(n / maxCount, 1);
      return `rgba(37,99,235,${(0.15 + ratio * 0.75).toFixed(2)})`;
    }
    function cellColor(n) {
      if (!n) return '#cbd5e1';
      return Math.min(n / maxCount, 1) > 0.5 ? '#fff' : '#1e3a8a';
    }
    const thCats = activeCats.map(c => {
      const short = c.length > 5 ? c.slice(0,4)+'…' : c;
      return `<th title="${escHtml(c)}">${escHtml(short)}</th>`;
    }).join('');
    const rows = units.map(({ u }) => {
      const s = gaStats.get(u._key) || {};
      const cells = activeCats.map(cat => {
        const n = (s.byCat || {})[cat] || 0;
        return `<td style="background:${cellBg(n)};color:${cellColor(n)};">${n || ''}</td>`;
      }).join('');
      const fullName = u.company || '–';
      const name = fullName.length > 8 ? fullName.slice(0, 8) + '…' : fullName;
      return `<tr><td class="row-head" title="${escHtml(fullName)}">${escHtml(name)}</td>${cells}</tr>`;
    }).join('');
    wrap.innerHTML = `
      <table class="heatmap-table">
        <thead><tr><th class="row-head">거래처</th>${thCats}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    setCaption('cap-heatmap',
      `상위 ${units.length}개 거래처 × ${activeCats.length}개 카테고리. 3종 이상 복합 보유: ${multiCatCount}개사.`);
  }

  // ============================================================
  // Chart 4: 매출 기회 (가로막대)
  // ============================================================
  function renderChartOpportunity() {
    destroyChart('opportunity');
    const acts = activeAssignmentsList();
    const gaStats = buildGroupAwareStats();
    const groupedList = buildGroupedCustomerList();

    // 그룹/거래처 단위별 보유 카테고리 set
    // 먼저 고객 id → 그룹 키 매핑
    const gmap = activeGroupMap();
    const custToKey = new Map();
    for (const c of state.customers) {
      const gid = c.billing_group_id;
      custToKey.set(c.id, (gid && gmap.has(gid)) ? `group:${gid}` : `cust:${c.id}`);
    }

    const unitCats = new Map(); // key -> Set<cat>
    for (const a of acts) {
      const it = state.items.find(i => i.id === a.item_id);
      if (!it) continue;
      const cat = classifyItem(it, a);
      const key = custToKey.get(a.customer_id) || `cust:${a.customer_id}`;
      if (!unitCats.has(key)) unitCats.set(key, new Set());
      unitCats.get(key).add(cat);
    }

    const pcNoMonitor = groupedList.filter(u => {
      const cats = unitCats.get(u._key) || new Set();
      return cats.has('컴퓨터') && !cats.has('모니터');
    });
    const printNoWell = groupedList.filter(u => {
      const cats = unitCats.get(u._key) || new Set();
      const hasPrint = ['흑백복사기','컬러복사기','흑백레이저','컬러레이저','잉크젯'].some(k => cats.has(k));
      return hasPrint && !cats.has('웰리스');
    });
    const noNas     = groupedList.filter(u => !(unitCats.get(u._key)||new Set()).has('나스'));
    const singleCat = groupedList.filter(u => (unitCats.get(u._key)||new Set()).size === 1);

    const labels = ['모니터 미보유\n(PC거래처)', '웰리스 미보유\n(출력기기거래처)', 'NAS 미보유', '단일품목만 보유'];
    const data   = [pcNoMonitor.length, printNoWell.length, noNas.length, singleCat.length];
    const drillSets = [pcNoMonitor, printNoWell, noNas, singleCat];
    const drillTitles = [
      `PC만 임대(모니터 無) ${pcNoMonitor.length}곳`,
      `출력기기 있고 웰리스 없는 ${printNoWell.length}곳`,
      `NAS 미보유 ${noNas.length}곳`,
      `단일 품목 보유 ${singleCat.length}곳`,
    ];

    function unitsToDrillItems(units) {
      return units.map(u => {
        const s = gaStats.get(u._key) || { items: [], monthlyFee: 0, maxAge: null };
        return {
          company: u.company || '–',
          contact: u._isGroup ? `${u._memberCount}개 계열사` : (u.contact_name || '–'),
          monthlyFee: s.monthlyFee,
          itemCount: s.items.length,
          maxAge: s.maxAge,
          custId: u._key,
        };
      }).sort((a, b) => b.monthlyFee - a.monthlyFee);
    }

    const totalTarget = new Set([
      ...pcNoMonitor.map(u=>u._key),
      ...printNoWell.map(u=>u._key),
      ...noNas.map(u=>u._key),
      ...singleCat.map(u=>u._key),
    ]).size;

    // KPI 핵심 숫자
    const kpiEl = document.getElementById('kpi-opportunity');
    if (kpiEl) kpiEl.innerHTML = `${totalTarget}<span class="unit">곳</span>`;

    const maxIdx = data.indexOf(Math.max(...data));
    _chartDrills['opportunity'] = {
      type: 'customers',
      title: drillTitles[maxIdx],
      items: unitsToDrillItems(drillSets[maxIdx]),
    };

    const ctx = document.getElementById('chart-opportunity');
    if (!ctx) return;

    state.charts['opportunity'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '해당 거래처 수',
          data,
          backgroundColor: ['#3b82f6','#8b5cf6','#06b6d4','#f59e0b'],
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => `${c.raw}곳` } },
        },
        scales: {
          x: { ticks: { font: { size: 11 }, stepSize: 1 } },
          y: { ticks: { font: { size: 10 } } },
        },
        onClick: (evt, els) => {
          if (!els.length) {
            openDrillModal(_chartDrills['opportunity']);
            return;
          }
          const idx = els[0].index;
          openDrillModal({
            type: 'customers',
            title: drillTitles[idx],
            items: unitsToDrillItems(drillSets[idx]),
          });
        },
      },
    });
    const maxLabel = labels[maxIdx].replace('\n','');
    setCaption('cap-opportunity',
      `총 영업 타깃 ${totalTarget}곳. 가장 큰 기회: ${maxLabel} ${data[maxIdx]}곳.`);
  }

  // ============================================================
  // Chart 5: 이탈 방지 (가로막대 — 매출 상위 20% 중 위험자산 보유)
  // ============================================================
  function renderChartRetention() {
    destroyChart('retention');
    const assignMap = buildItemAssignMap();
    const gaStats = buildGroupAwareStats();
    const groupedList = buildGroupedCustomerList();
    const activeItems = state.items.filter(i => (i.status || 'active') === 'active');

    // 그룹 키 → 위험자산 수 집계
    const gmap = activeGroupMap();
    const custToKey = new Map();
    for (const c of state.customers) {
      const gid = c.billing_group_id;
      custToKey.set(c.id, (gid && gmap.has(gid)) ? `group:${gid}` : `cust:${c.id}`);
    }

    const dangerByKey = {};
    for (const it of activeItems) {
      const m = ageMonths(it);
      if (m == null || m < THRESHOLDS.AGED_MONTHS) continue;
      const a = assignMap.get(it.id);
      if (!a) continue;
      const key = custToKey.get(a.customer_id) || `cust:${a.customer_id}`;
      dangerByKey[key] = (dangerByKey[key] || 0) + 1;
    }

    // 매출 내림차순 정렬 후 상위 20% 추출
    const sorted = groupedList.map(u => ({
      u,
      fee: (gaStats.get(u._key) || {}).monthlyFee || 0,
      dangerN: dangerByKey[u._key] || 0,
    })).sort((a, b) => b.fee - a.fee);

    const topN = Math.max(1, Math.ceil(groupedList.length * THRESHOLDS.HIGH_REVENUE_PCT / 100));
    const atRisk = sorted.slice(0, topN).filter(r => r.dangerN > 0);

    const totalFee = sorted.reduce((s, r) => s + r.fee, 0);
    const riskFee  = atRisk.reduce((s, r) => s + r.fee, 0);
    const riskPct  = totalFee > 0 ? Math.round(riskFee / totalFee * 100) : 0;

    // KPI 핵심 숫자
    const kpiEl = document.getElementById('kpi-retention');
    if (kpiEl) kpiEl.innerHTML = atRisk.length
      ? `${atRisk.length}<span class="unit">곳 (매출 ${riskPct}%)</span>`
      : `0<span class="unit">곳</span>`;

    // 드릴 데이터
    _chartDrills['retention'] = {
      type: 'customers',
      title: `이탈 위험 거래처 (매출 상위 20% 내 위험자산 보유) ${atRisk.length}곳`,
      items: atRisk.map(r => {
        const s = gaStats.get(r.u._key) || { items: [], maxAge: null };
        return {
          company: r.u.company || '–',
          contact: r.u._isGroup ? `${r.u._memberCount}개 계열사` : (r.u.contact_name || '–'),
          monthlyFee: r.fee,
          itemCount: s.items.length,
          maxAge: s.maxAge,
          custId: r.u._key,
        };
      }),
    };

    const ctx = document.getElementById('chart-retention');
    if (!ctx) return;

    if (atRisk.length === 0) {
      setCaption('cap-retention', '매출 상위 20% 거래처 중 위험자산 보유 없음 — 안정적입니다.');
      return;
    }

    const maxDanger = Math.max(...atRisk.map(r => r.dangerN), 1);
    state.charts['retention'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: atRisk.map(r => {
          const nm = r.u.company || '–';
          return nm.length > 10 ? nm.slice(0, 10) + '…' : nm;
        }),
        datasets: [{
          label: '월 임대료 (원)',
          data: atRisk.map(r => r.fee),
          backgroundColor: atRisk.map(r => {
            const ratio = Math.min(r.dangerN / maxDanger, 1);
            const r2 = Math.round(220 - ratio * 130);
            return `rgb(${220},${r2},${r2})`;
          }),
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: c => {
                const r = atRisk[c.dataIndex];
                return `월 ${fmtMoney(c.raw)}원 · 위험자산 ${r.dangerN}건`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              font: { size: 10 },
              callback: v => v >= 10000 ? Math.round(v/10000)+'만' : v,
            },
          },
          y: { ticks: { font: { size: 11 } } },
        },
        onClick: (evt, els) => {
          openDrillModal(_chartDrills['retention']);
        },
      },
    });
    const top1 = atRisk[0];
    setCaption('cap-retention',
      `최우선: ${top1.u.company||'–'} (월 ${fmtMoney(top1.fee)}원, 위험자산 ${top1.dangerN}건). 총 ${atRisk.length}곳.`);
  }

  function setCaption(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  // 차트 카드 → 드릴다운 매핑 (renderChart* 함수에서 채움)
  const _chartDrills = {};

  // ============================================================
  // ASMS 접수관리툴(orders) 기반 임대 추이 공통 헬퍼
  // 데이터: orders.product(또는 mo_engname), 상태(re_now/status)가 완료·출고 인 건만,
  //         process_date('YYYY/MM/DD') 월별 집계
  // ============================================================
  const LEASE_KIND = { replace: '임대제품교체', install: '임대초기설치', recover: '임대제품회수' };

  function last12Months() {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return months;
  }

  // 지정 임대 항목(kind)의 완료/출고 접수만 추출
  function leaseOrders(kind) {
    return (state.orders || []).filter(o => {
      const k = o.product || o.mo_engname || '';
      const st = o.re_now || o.status || '';
      return k === kind && (st === '완료' || st === '출고');
    });
  }

  // process_date('YYYY/MM/DD' 또는 'YYYY-MM-DD') → 'YYYY-MM'
  function orderYM(o) {
    return String(o.process_date || '').replace(/\//g, '-').slice(0, 7);
  }

  // 드릴 항목(orders 타입) 변환 — 최신순
  function makeOrderDrillItems(list) {
    return list.map(o => ({
      company: String(o.cu_name || '').trim() || '–',
      kind: o.product || o.mo_engname || '–',
      date: String(o.process_date || '').replace(/\//g, '-'),
      seq: o.seq_no,
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  // 월별 집계 — orders 를 month 버킷에 적재
  function bucketOrdersByMonth(kind, months) {
    const buckets = {};
    months.forEach(m => { buckets[m] = []; });
    for (const o of leaseOrders(kind)) {
      const ym = orderYM(o);
      if (buckets[ym] !== undefined) buckets[ym].push(o);
    }
    return buckets;
  }

  // 막대 차트 공통 옵션 빌더 (월별 추이)
  function monthlyBarOptions(months, drillKey, unitLabel, buckets, drillTitleFn) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => months[items[0].dataIndex],
            label: c => `${c.raw}${unitLabel}`,
          },
        },
      },
      scales: {
        y: { ticks: { font: { size: 11 }, stepSize: 1 }, beginAtZero: true },
        x: { ticks: { font: { size: 10 } } },
      },
      onClick: (evt, els) => {
        if (!els.length) { openDrillModal(_chartDrills[drillKey]); return; }
        const ym = months[els[0].index];
        const list = buckets[ym] || [];
        if (!list.length) return;
        openDrillModal({ type: 'orders', title: drillTitleFn(ym, list.length), items: makeOrderDrillItems(list) });
      },
    };
  }

  // ============================================================
  // Chart 7: 최근 1년 제품 교체 추이 (월별 막대)
  // 데이터: ASMS 접수 '임대제품교체' (완료/출고)
  // ============================================================
  function renderChartReplaced() {
    destroyChart('replaced');
    const months = last12Months();
    const buckets = bucketOrdersByMonth(LEASE_KIND.replace, months);
    const counts = months.map(m => buckets[m].length);
    const totalYear = counts.reduce((s, v) => s + v, 0);

    const kpiEl = document.getElementById('kpi-replaced');
    if (kpiEl) kpiEl.innerHTML = `${totalYear}<span class="unit">건 교체</span>`;

    _chartDrills['replaced'] = {
      type: 'orders',
      title: `1년간 제품 교체 ${totalYear}건`,
      items: makeOrderDrillItems(months.flatMap(m => buckets[m])),
    };

    const last3avg = counts.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const maxIdx = counts.indexOf(Math.max(...counts));
    const maxMonth = months[maxIdx] || '';
    const maxVal = counts[maxIdx] || 0;
    let caption;
    if (!(state.orders || []).length) {
      caption = 'ASMS 접수(orders) 데이터를 불러오지 못했거나 임대 접수가 없습니다';
    } else if (totalYear === 0) {
      caption = "최근 1년간 '임대제품교체' 완료 접수가 없습니다";
    } else {
      caption = `최근 3개월 평균 ${last3avg.toFixed(1)}건/월 · 가장 많은 달: ${maxMonth} (${maxVal}건)`;
    }

    const ctx = document.getElementById('chart-replaced');
    if (!ctx) return;
    state.charts['replaced'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.slice(5)),
        datasets: [{ label: '교체 건수', data: counts, backgroundColor: '#ef4444', borderRadius: 4 }],
      },
      options: monthlyBarOptions(months, 'replaced', '건 교체', buckets, (ym, n) => `${ym} 제품 교체 ${n}건`),
    });
    setCaption('cap-replaced', caption);
  }

  // ============================================================
  // Chart 8: 최근 1년 신규 거래처 추이 (월별 막대)
  // 데이터: ASMS 접수 '임대초기설치' (완료/출고) — 월별 거래처 수(distinct cu_name)
  // ============================================================
  function renderChartNewCust() {
    destroyChart('newcust');
    const months = last12Months();
    const buckets = bucketOrdersByMonth(LEASE_KIND.install, months);
    const distinctCos = list => new Set(list.map(o => String(o.cu_name || '').trim()).filter(Boolean));
    const counts = months.map(m => distinctCos(buckets[m]).size);
    const totalDistinct = distinctCos(months.flatMap(m => buckets[m])).size;

    const kpiEl = document.getElementById('kpi-newcust');
    if (kpiEl) kpiEl.innerHTML = `${totalDistinct}<span class="unit">개사 신규</span>`;

    _chartDrills['newcust'] = {
      type: 'orders',
      title: `1년간 신규 설치 거래처 ${totalDistinct}개사`,
      items: makeOrderDrillItems(months.flatMap(m => buckets[m])),
    };

    const last3avg = counts.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const maxIdx = counts.indexOf(Math.max(...counts));
    const maxMonth = months[maxIdx] || '';
    const maxVal = counts[maxIdx] || 0;
    let caption;
    if (!(state.orders || []).length) {
      caption = 'ASMS 접수(orders) 데이터를 불러오지 못했거나 임대 접수가 없습니다';
    } else if (totalDistinct === 0) {
      caption = "최근 1년간 '임대초기설치' 완료 접수가 없습니다";
    } else {
      caption = `최근 3개월 평균 ${last3avg.toFixed(1)}개사/월 · 가장 많은 달: ${maxMonth} (${maxVal}개사)`;
    }

    const ctx = document.getElementById('chart-newcust');
    if (!ctx) return;
    state.charts['newcust'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.slice(5)),
        datasets: [{ label: '신규 거래처', data: counts, backgroundColor: '#10b981', borderRadius: 4 }],
      },
      options: monthlyBarOptions(months, 'newcust', '개사 신규', buckets, (ym, n) => `${ym} 신규 설치 ${n}건`),
    });
    setCaption('cap-newcust', caption);
  }

  // ============================================================
  // Chart 9: 최근 1년 임대제품 회수 추이 (월별 막대)
  // 데이터: ASMS 접수 '임대제품회수' (완료/출고)
  // ============================================================
  function renderChartRecover() {
    destroyChart('recover');
    const months = last12Months();
    const buckets = bucketOrdersByMonth(LEASE_KIND.recover, months);
    const counts = months.map(m => buckets[m].length);
    const totalYear = counts.reduce((s, v) => s + v, 0);

    const kpiEl = document.getElementById('kpi-recover');
    if (kpiEl) kpiEl.innerHTML = `${totalYear}<span class="unit">건 회수</span>`;

    _chartDrills['recover'] = {
      type: 'orders',
      title: `1년간 제품 회수 ${totalYear}건`,
      items: makeOrderDrillItems(months.flatMap(m => buckets[m])),
    };

    const last3avg = counts.slice(-3).reduce((s, v) => s + v, 0) / 3;
    const maxIdx = counts.indexOf(Math.max(...counts));
    const maxMonth = months[maxIdx] || '';
    const maxVal = counts[maxIdx] || 0;
    let caption;
    if (!(state.orders || []).length) {
      caption = 'ASMS 접수(orders) 데이터를 불러오지 못했거나 임대 접수가 없습니다';
    } else if (totalYear === 0) {
      caption = "최근 1년간 '임대제품회수' 완료 접수가 없습니다";
    } else {
      caption = `최근 3개월 평균 ${last3avg.toFixed(1)}건/월 · 가장 많은 달: ${maxMonth} (${maxVal}건)`;
    }

    const ctx = document.getElementById('chart-recover');
    if (!ctx) return;
    state.charts['recover'] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: months.map(m => m.slice(5)),
        datasets: [{ label: '회수 건수', data: counts, backgroundColor: '#f59e0b', borderRadius: 4 }],
      },
      options: monthlyBarOptions(months, 'recover', '건 회수', buckets, (ym, n) => `${ym} 제품 회수 ${n}건`),
    });
    setCaption('cap-recover', caption);
  }

  // ============================================================
  // 도넛 공통 — 리더라인 커스텀 플러그인 팩토리
  // afterDraw 훅에서 캔버스에 직접 꺾인 선 + 외부 라벨을 그린다.
  // MIN_PCT 미만 슬라이스는 라벨 생략(툴팁으로 확인).
  // ============================================================
  function makeDonutLeaderPlugin(totalRef, labelFormatFn, MIN_PCT) {
    return {
      id: 'donutLeader',
      afterDraw(chart) {
        const { ctx, chartArea, data } = chart;
        if (!chartArea) return;
        const ds = chart.getDatasetMeta(0);
        if (!ds || !ds.data.length) return;

        const total = totalRef();
        if (!total) return;

        const isMobile = window.innerWidth <= 640;
        // 모바일에서는 리더라인 생략(legend 사용)
        if (isMobile) return;

        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2;
        // 도넛 외곽 반지름 — Chart.js arc에서 직접 읽는다
        const outerRadius = ds.data[0] ? ds.data[0].outerRadius : Math.min(
          (chartArea.right - chartArea.left),
          (chartArea.bottom - chartArea.top)
        ) / 2;

        ctx.save();
        ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textBaseline = 'middle';

        // 이미 배치된 라벨 y 좌표 목록 — 겹침 회피에 사용
        const placed = [];

        ds.data.forEach((arc, i) => {
          const val = data.datasets[0].data[i];
          const pct = total > 0 ? val / total * 100 : 0;

          // MIN_PCT 미만은 라벨 생략
          if (pct < MIN_PCT) return;

          const color = data.datasets[0].backgroundColor[i];
          const midAngle = (arc.startAngle + arc.endAngle) / 2;

          // 꺾임점 1: 반지름 바깥 약 22px
          const r1 = outerRadius + 18;
          // 꺾임점 2: 수평 수염 끝 (좌/우 판단)
          const r2 = outerRadius + 38;

          const cos = Math.cos(midAngle);
          const sin = Math.sin(midAngle);

          const x1 = cx + cos * (outerRadius + 4);
          const y1 = cy + sin * (outerRadius + 4);
          const x2 = cx + cos * r1;
          const y2 = cy + sin * r1;
          let x3 = cx + cos * r2;
          let y3 = cy + sin * r2;

          // 겹침 회피: placed 목록과 y 거리가 12px 미만이면 밀어낸다
          let shifted = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            let collision = placed.find(py => Math.abs(py - y3) < 13);
            if (!collision) break;
            y3 += (sin >= 0 ? 14 : -14);
            shifted = true;
          }
          placed.push(y3);

          // 수평 방향
          const isRight = cos >= 0;
          const xLabel = x3 + (isRight ? 5 : -5);

          // 선 그리기
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          if (shifted) {
            ctx.lineTo(x3, y3);
          } else {
            ctx.lineTo(x3, y3);
          }
          ctx.lineTo(isRight ? x3 + 6 : x3 - 6, y3);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.4;
          ctx.stroke();

          // 라벨 텍스트
          const labelText = labelFormatFn(data.labels[i], val, pct);
          ctx.fillStyle = '#1e293b';
          ctx.textAlign = isRight ? 'left' : 'right';
          ctx.fillText(labelText, xLabel, y3);
        });

        ctx.restore();
      },
    };
  }

  // ============================================================
  // Chart 9: 카테고리별 자산 수 비중 (도넛)
  // ============================================================
  function renderChartDonutCount() {
    destroyChart('donut-count');
    const assignMap = buildItemAssignMap();

    // 활성 자산 기준 카테고리별 집계
    const activeItems = state.items.filter(i => (i.status || 'active') === 'active');
    const countByCat = {};
    for (const it of activeItems) {
      const a = assignMap.get(it.id);
      const cat = classifyItem(it, a);
      countByCat[cat] = (countByCat[cat] || 0) + 1;
    }

    // 모든 카테고리 합산 후 % 내림차순 정렬
    const rawEntries = [];
    for (const cat of CATS) {
      if (countByCat[cat]) rawEntries.push([cat, countByCat[cat]]);
    }
    for (const [cat, n] of Object.entries(countByCat)) {
      if (!CATS.includes(cat)) rawEntries.push([cat, n]);
    }
    rawEntries.sort((a, b) => b[1] - a[1]);

    const labels = rawEntries.map(e => e[0]);
    const data   = rawEntries.map(e => e[1]);

    const total = data.reduce((s, v) => s + v, 0);

    // KPI 핵심 숫자
    const kpiEl = document.getElementById('kpi-donut-count');
    if (kpiEl) kpiEl.innerHTML = `${total.toLocaleString()}<span class="unit">건</span>`;

    const ctx = document.getElementById('chart-donut-count');
    if (!ctx) return;

    if (total === 0) {
      setCaption('cap-donut-count', '활성 자산 없음');
      return;
    }

    // 드릴 데이터: 가장 많은 카테고리의 자산 목록
    const maxIdx = 0; // 정렬 후 첫 번째가 최대
    const topCat = labels[maxIdx];
    const topCatItems = activeItems.filter(it => {
      const a = assignMap.get(it.id);
      return classifyItem(it, a) === topCat;
    });
    const custMap9 = buildCustomerMap();
    function makeDonutDrillItems(itemList) {
      return itemList.map(it => {
        const a = assignMap.get(it.id);
        const cust = a ? custMap9.get(a.customer_id) : null;
        return {
          cat: classifyItem(it, a),
          subtype: it.subtype || '–',
          model: [it.brand, it.model].filter(Boolean).join(' ') || '–',
          company: cust ? (cust.company || '–') : '미배정',
          ageM: ageMonths(it),
          installDate: it.install_date || '',
          itemId: it.id,
        };
      }).sort((a, b) => (b.ageM || 0) - (a.ageM || 0));
    }
    _chartDrills['donut-count'] = {
      type: 'assets',
      title: `${topCat} 자산 ${data[maxIdx]}건`,
      items: makeDonutDrillItems(topCatItems),
    };

    const DONUT_COLORS = [
      '#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6',
      '#06b6d4','#f97316','#84cc16','#ec4899','#64748b',
    ];

    const isMobile = window.innerWidth <= 640;
    const totalRef = () => total;
    const leaderPlugin = makeDonutLeaderPlugin(
      totalRef,
      (label, val, pct) => `${label} ${val}건 (${Math.round(pct)}%)`,
      3 // 3% 미만 라벨 생략
    );

    state.charts['donut-count'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: labels.map((_, i) => DONUT_COLORS[i % DONUT_COLORS.length]),
          borderColor: '#fff',
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        // 리더라인 공간 확보: 도넛 바깥 여백 확보
        layout: { padding: isMobile ? 4 : 55 },
        plugins: {
          legend: {
            // 모바일에서만 legend 표시, PC는 리더라인으로 대체
            display: isMobile,
            position: 'bottom',
            labels: {
              font: { size: 11 },
              boxWidth: 10,
              padding: 6,
              generateLabels: chart => {
                const ds = chart.data.datasets[0];
                return chart.data.labels.map((label, i) => {
                  const val = ds.data[i];
                  const pct = total > 0 ? Math.round(val / total * 100) : 0;
                  return {
                    text: `${label} ${val}건 (${pct}%)`,
                    fillStyle: ds.backgroundColor[i],
                    strokeStyle: '#fff',
                    lineWidth: 1,
                    hidden: false,
                    index: i,
                    datasetIndex: 0,
                  };
                });
              },
            },
          },
          tooltip: {
            callbacks: {
              label: c => {
                const val = c.raw;
                const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
                return `${c.label}: ${val}건 (${pct}%)`;
              },
            },
          },
        },
        onClick: (evt, els) => {
          if (!els.length) {
            openDrillModal(_chartDrills['donut-count']);
            return;
          }
          const idx = els[0].index;
          const cat = labels[idx];
          const catItems = activeItems.filter(it => {
            const a = assignMap.get(it.id);
            return classifyItem(it, a) === cat;
          });
          if (!catItems.length) return;
          openDrillModal({
            type: 'assets',
            title: `${cat} 자산 ${catItems.length}건`,
            items: makeDonutDrillItems(catItems),
          });
        },
      },
      plugins: [leaderPlugin],
    });

    const top1 = labels[maxIdx];
    const top1pct = total > 0 ? Math.round(data[maxIdx] / total * 100) : 0;
    setCaption('cap-donut-count',
      `활성 자산 ${total}건 중 최다: ${top1} ${data[maxIdx]}건 (${top1pct}%). 클릭하면 해당 자산 목록을 확인합니다.`);
  }

  // ============================================================
  // Chart 10: 카테고리별 월 임대료 비중 (도넛)
  // ============================================================
  function renderChartDonutFee() {
    destroyChart('donut-fee');
    const assignMap = buildItemAssignMap();
    const acts = activeAssignmentsList();

    // 활성 배정 기준 카테고리별 월 임대료 집계
    const feeByCat = {};
    const itemMap10 = buildItemMap();
    for (const a of acts) {
      const it = itemMap10.get(a.item_id);
      if (!it) continue;
      const cat = classifyItem(it, a);
      feeByCat[cat] = (feeByCat[cat] || 0) + Number(a.monthly_fee || 0);
    }

    // 모든 카테고리 합산 후 % 내림차순 정렬
    const rawEntries = [];
    for (const cat of CATS) {
      if (feeByCat[cat]) rawEntries.push([cat, Math.round(feeByCat[cat])]);
    }
    for (const [cat, n] of Object.entries(feeByCat)) {
      if (!CATS.includes(cat) && n > 0) rawEntries.push([cat, Math.round(n)]);
    }
    rawEntries.sort((a, b) => b[1] - a[1]);

    const labels = rawEntries.map(e => e[0]);
    const data   = rawEntries.map(e => e[1]);

    const total = data.reduce((s, v) => s + v, 0);

    // KPI 핵심 숫자
    const kpiEl = document.getElementById('kpi-donut-fee');
    if (kpiEl) kpiEl.innerHTML = `${fmtMoney(total)}<span class="unit">원</span>`;

    const ctx = document.getElementById('chart-donut-fee');
    if (!ctx) return;

    if (total === 0) {
      setCaption('cap-donut-fee', '활성 임대료 없음');
      return;
    }

    // 드릴 데이터: 가장 임대료 높은 카테고리 거래처 목록
    const maxIdx = 0; // 정렬 후 첫 번째가 최대
    const topCat = labels[maxIdx];
    const gaStats10 = buildGroupAwareStats();
    const groupedList10 = buildGroupedCustomerList();
    // 해당 카테고리를 보유한 단위(그룹/거래처) 집합
    const topCatUnits = groupedList10.filter(u => {
      const s = gaStats10.get(u._key) || {};
      return !!(s.byCat || {})[topCat];
    });
    _chartDrills['donut-fee'] = {
      type: 'customers',
      title: `${topCat} 임대 거래처 ${topCatUnits.length}곳`,
      items: topCatUnits.map(u => {
        const s = gaStats10.get(u._key) || { items: [], monthlyFee: 0, maxAge: null };
        return {
          company: u.company || '–',
          contact: u._isGroup ? `${u._memberCount}개 계열사` : (u.contact_name || '–'),
          monthlyFee: s.monthlyFee,
          itemCount: s.items.length,
          maxAge: s.maxAge,
          custId: u._key,
        };
      }).sort((a, b) => b.monthlyFee - a.monthlyFee),
    };

    const DONUT_COLORS = [
      '#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6',
      '#06b6d4','#f97316','#84cc16','#ec4899','#64748b',
    ];

    const isMobile = window.innerWidth <= 640;
    const totalRef = () => total;
    const leaderPlugin = makeDonutLeaderPlugin(
      totalRef,
      (label, _val, pct) => `${label} ${Math.round(pct)}%`,
      3 // 3% 미만 라벨 생략
    );

    state.charts['donut-fee'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: labels.map((_, i) => DONUT_COLORS[i % DONUT_COLORS.length]),
          borderColor: '#fff',
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        // 리더라인 공간 확보
        layout: { padding: isMobile ? 4 : 55 },
        plugins: {
          legend: {
            // 모바일에서만 legend 표시, PC는 리더라인으로 대체
            display: isMobile,
            position: 'bottom',
            labels: {
              font: { size: 11 },
              boxWidth: 10,
              padding: 6,
              generateLabels: chart => {
                const ds = chart.data.datasets[0];
                return chart.data.labels.map((label, i) => {
                  const val = ds.data[i];
                  const pct = total > 0 ? Math.round(val / total * 100) : 0;
                  return {
                    text: `${label} ${pct}%`,
                    fillStyle: ds.backgroundColor[i],
                    strokeStyle: '#fff',
                    lineWidth: 1,
                    hidden: false,
                    index: i,
                    datasetIndex: 0,
                  };
                });
              },
            },
          },
          tooltip: {
            callbacks: {
              label: c => {
                const val = c.raw;
                const pct = total > 0 ? (val / total * 100).toFixed(1) : 0;
                return `${c.label}: ${fmtMoney(val)}원 (${pct}%)`;
              },
            },
          },
        },
        onClick: (evt, els) => {
          if (!els.length) {
            openDrillModal(_chartDrills['donut-fee']);
            return;
          }
          const idx = els[0].index;
          const cat = labels[idx];
          // 해당 카테고리 보유 단위(그룹/거래처) 드릴
          const catUnits = groupedList10.filter(u => {
            const s = gaStats10.get(u._key) || {};
            return !!(s.byCat || {})[cat];
          });
          openDrillModal({
            type: 'customers',
            title: `${cat} 임대 거래처 ${catUnits.length}곳`,
            items: catUnits.map(u => {
              const s = gaStats10.get(u._key) || { items: [], monthlyFee: 0, maxAge: null };
              return {
                company: u.company || '–',
                contact: u._isGroup ? `${u._memberCount}개 계열사` : (u.contact_name || '–'),
                monthlyFee: s.monthlyFee,
                itemCount: s.items.length,
                maxAge: s.maxAge,
                custId: u._key,
              };
            }).sort((a, b) => b.monthlyFee - a.monthlyFee),
          });
        },
      },
      plugins: [leaderPlugin],
    });

    const top1 = labels[maxIdx];
    const top1pct = total > 0 ? Math.round(data[maxIdx] / total * 100) : 0;
    setCaption('cap-donut-fee',
      `월 임대료 총 ${fmtMoney(total)}원 중 최다: ${top1} ${top1pct}% (${fmtMoney(data[maxIdx])}원). 클릭하면 해당 거래처를 확인합니다.`);
  }

  // ============================================================
  // Chart 11: 임대 유형 분포 (유상 / 무상 도넛)
  // ============================================================
  function renderChartDonutRtype() {
    destroyChart('donut-rtype');
    const ctx = document.getElementById('chart-donut-rtype');
    if (!ctx) return;

    const activeItems = state.items.filter(i => (i.status || 'active') === 'active');
    const assignMap = buildItemAssignMap();
    const custMap = buildCustomerMap();

    const paidItems = activeItems.filter(i => (i.rental_type || 'paid') !== 'free');
    const freeItems = activeItems.filter(i => i.rental_type === 'free');
    const total = activeItems.length;

    if (total === 0) {
      setCaption('cap-donut-rtype', '데이터 없음');
      return;
    }

    const paidPct = Math.round(paidItems.length / total * 100);
    const freePct = 100 - paidPct;

    const kpiEl = document.getElementById('kpi-donut-rtype');
    if (kpiEl) kpiEl.innerHTML = `유상 ${paidPct}% · 무상 ${freePct}%`;

    // 드릴다운용 데이터
    const makeDrillItems = (list) => list.map(it => {
      const a = assignMap.get(it.id);
      const cust = a ? custMap.get(a.customer_id) : null;
      return {
        cat: classifyItem(it, a),
        subtype: it.subtype || '–',
        model: [it.brand, it.model].filter(Boolean).join(' ') || '–',
        company: cust ? (cust.company || '–') : '미배정',
        ageM: ageMonths(it),
        installDate: it.install_date || '',
        itemId: it.id,
      };
    });

    _chartDrills['donut-rtype'] = {
      type: 'assets',
      title: `전체 자산 유형 분포 ${total}건`,
      items: makeDrillItems(activeItems),
    };

    state.charts['donut-rtype'] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [`유상 (${paidItems.length}건)`, `무상 (${freeItems.length}건)`],
        datasets: [{
          data: [paidItems.length, freeItems.length],
          backgroundColor: ['#0369a1', '#15803d'],
          borderColor: ['#e0f2fe', '#dcfce7'],
          borderWidth: 2,
          hoverOffset: 10,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { size: 12 }, padding: 14, boxWidth: 14 },
          },
          tooltip: {
            callbacks: {
              label: ctx => {
                const v = ctx.raw;
                const pct = total > 0 ? Math.round(v / total * 100) : 0;
                return ` ${v}건 (${pct}%)`;
              },
            },
          },
        },
        onClick: (evt, elements) => {
          if (!elements.length) return;
          const idx = elements[0].index;
          const targetItems = idx === 0 ? paidItems : freeItems;
          const label = idx === 0 ? '유상' : '무상';
          openDrillModal({
            type: 'assets',
            title: `${label} 임대 자산 ${targetItems.length}건`,
            items: makeDrillItems(targetItems),
          });
        },
      },
    });

    setCaption('cap-donut-rtype',
      `유상 ${paidItems.length}건(${paidPct}%) · 무상 ${freeItems.length}건(${freePct}%). ` +
      `무상은 토너구매 조건 포함. 클릭하면 해당 자산을 확인합니다.`);
  }

  function renderAllCharts() {
    renderChartTop10();
    renderHeatmap();
    renderChartOpportunity();
    renderChartRetention();
    renderChartReplaced();
    renderChartNewCust();
    renderChartRecover();
    renderChartDonutCount();
    renderChartDonutFee();
    renderChartDonutRtype();
  }

  // ============================================================
  // 전략 분석 패널 — 메시지 생성
  // ============================================================
  function generateGahuAdvice() {
    const assignMap = buildItemAssignMap();
    const gaStats = buildGroupAwareStats();
    const groupedList = buildGroupedCustomerList();
    const activeItems = state.items.filter(i => (i.status || 'active') === 'active');
    const acts = activeAssignmentsList();

    // 고객 id → 그룹 키 매핑 (책사 내부 공통 사용)
    const gmap = activeGroupMap();
    const custToKey = new Map();
    for (const c of state.customers) {
      const gid = c.billing_group_id;
      custToKey.set(c.id, (gid && gmap.has(gid)) ? `group:${gid}` : `cust:${c.id}`);
    }

    // ------ 사전 계산 ------
    // 위험 자산(60개월+) — 카테고리별 집계
    const dangerItems = activeItems.filter(it => {
      const m = ageMonths(it);
      return m != null && m >= THRESHOLDS.AGED_MONTHS;
    });
    const dangerByCat = {};
    dangerItems.forEach(it => {
      const c = classifyItem(it, assignMap.get(it.id));
      dangerByCat[c] = (dangerByCat[c] || 0) + 1;
    });

    // 위험자산 — 그룹 키 기준 집계
    const dangerByKey = {};
    dangerItems.forEach(it => {
      const a = assignMap.get(it.id);
      if (!a) return;
      const key = custToKey.get(a.customer_id) || `cust:${a.customer_id}`;
      dangerByKey[key] = (dangerByKey[key] || 0) + 1;
    });

    // 카테고리별 평균 노후도
    const catAges = {};
    activeItems.forEach(it => {
      const m = ageMonths(it);
      if (m == null) return;
      const c = classifyItem(it, assignMap.get(it.id));
      if (!catAges[c]) catAges[c] = [];
      catAges[c].push(m);
    });
    const catAvgAge = {};
    Object.entries(catAges).forEach(([c, arr]) => {
      catAvgAge[c] = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
    });
    const maxAgeCat = Object.entries(catAvgAge).sort((a, b) => b[1] - a[1])[0];

    // 그룹/거래처 단위별 보유 카테고리 set
    const unitCats = new Map();
    for (const a of acts) {
      const it = state.items.find(i => i.id === a.item_id);
      if (!it) continue;
      const cat = classifyItem(it, a);
      const key = custToKey.get(a.customer_id) || `cust:${a.customer_id}`;
      if (!unitCats.has(key)) unitCats.set(key, new Set());
      unitCats.get(key).add(cat);
    }

    // 매출 상위 20% 단위 중 위험자산 보유
    const sortedByFee = groupedList.map(u => ({
      u,
      fee: (gaStats.get(u._key) || {}).monthlyFee || 0,
    })).sort((a, b) => b.fee - a.fee);
    const topN = Math.ceil(groupedList.length * THRESHOLDS.HIGH_REVENUE_PCT / 100) || 1;
    const highRevWithDanger = sortedByFee.slice(0, topN).filter(({ u }) => {
      return (dangerByKey[u._key] || 0) > 0;
    });

    // 향후 6개월 내 신규 위험 도달
    const now = new Date();

    // ------ 드릴 아이템 빌더 ------
    const custMap = buildCustomerMap();
    function makeUnitDrillItems(unitList) {
      return unitList.map(u => {
        const s = gaStats.get(u._key) || { items: [], monthlyFee: 0, maxAge: null };
        return {
          company: u.company || '–',
          contact: u._isGroup ? `${u._memberCount}개 계열사` : (u.contact_name || '–'),
          monthlyFee: s.monthlyFee,
          itemCount: s.items.length,
          maxAge: s.maxAge,
          custId: u._key,
        };
      }).sort((a, b) => b.monthlyFee - a.monthlyFee);
    }
    function makeAssetDrillItems(itemList) {
      return itemList.map(it => {
        const a = assignMap.get(it.id);
        const cust = a ? custMap.get(a.customer_id) : null;
        return {
          cat: classifyItem(it, a),
          subtype: it.subtype || '–',
          model: [it.brand, it.model].filter(Boolean).join(' ') || '–',
          company: cust ? (cust.company || '–') : '미배정',
          ageM: ageMonths(it),
          installDate: it.install_date || '',
          itemId: it.id,
        };
      }).sort((a, b) => (b.ageM == null ? -1 : b.ageM) - (a.ageM == null ? -1 : a.ageM));
    }

    // ------ 메시지 생성 ------
    const msgs = { cheongi: [], bumin: [], suseong: [], gongnyak: [], ganjung: [] };

    // 천기경 — 위험자산
    if (dangerItems.length > 0) {
      const topCats = Object.entries(dangerByCat)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([c, n]) => `<strong>${c}</strong> ${n}건`)
        .join(' / ');
      msgs.cheongi.push({
        cls: 'danger',
        text: `위험자산(60개월+) <strong>${dangerItems.length}건</strong>${topCats ? ' — ' + topCats : ''}`,
        drill: {
          type: 'assets',
          title: `위험자산 (60개월+) ${dangerItems.length}건`,
          items: makeAssetDrillItems(dangerItems),
        },
      });
    }
    // 위험자산 최다 보유 단위
    const worstDangerEntry = Object.entries(dangerByKey).sort((a, b) => b[1] - a[1])[0];
    if (worstDangerEntry) {
      const [worstKey, worstN] = worstDangerEntry;
      const worstUnit = groupedList.find(u => u._key === worstKey);
      const worstName = worstUnit ? worstUnit.company : worstKey;
      const worstItems = dangerItems.filter(it => {
        const a = assignMap.get(it.id);
        if (!a) return false;
        const k = custToKey.get(a.customer_id) || `cust:${a.customer_id}`;
        return k === worstKey;
      });
      msgs.cheongi.push({
        cls: 'warning',
        text: `최다 보유: <strong>${escHtml(worstName)}</strong> <strong>${worstN}건</strong> → 우선 교체`,
        drill: {
          type: 'assets',
          title: `${worstName} — 위험자산 ${worstN}건`,
          items: makeAssetDrillItems(worstItems),
        },
      });
    }
    if (maxAgeCat) {
      const catItems = activeItems.filter(it => classifyItem(it, assignMap.get(it.id)) === maxAgeCat[0]);
      msgs.cheongi.push({
        cls: 'warning',
        text: `최노화 품목: <strong>${maxAgeCat[0]}</strong> 평균 <strong>${maxAgeCat[1]}개월</strong>`,
        drill: {
          type: 'assets',
          title: `${maxAgeCat[0]} — 노후도 내림차순`,
          items: makeAssetDrillItems(catItems),
        },
      });
    }
    if (dangerItems.length === 0 && activeItems.length > 0) {
      msgs.cheongi.push({
        cls: 'success',
        text: `60개월+ 자산 <strong>0건</strong> — 36개월 이상 자산 지속 모니터링 권장`,
      });
    }

    // 부민책 — 매출 기회
    const pcNoMonitorUnits = groupedList.filter(u => {
      const cats = unitCats.get(u._key) || new Set();
      return cats.has('컴퓨터') && !cats.has('모니터');
    });
    if (pcNoMonitorUnits.length > 0) {
      msgs.bumin.push({
        cls: 'info',
        text: `PC만 임대(모니터 無): <strong>${pcNoMonitorUnits.length}곳</strong> → 모니터 추가 영업`,
        drill: {
          type: 'customers',
          title: `PC만 임대 (모니터 無) ${pcNoMonitorUnits.length}곳`,
          items: makeUnitDrillItems(pcNoMonitorUnits),
        },
      });
    }
    const printerNoWellnessUnits = groupedList.filter(u => {
      const cats = unitCats.get(u._key) || new Set();
      const hasPrint = ['흑백복사기','컬러복사기','흑백레이저','컬러레이저','잉크젯'].some(cat => cats.has(cat));
      return hasPrint && !cats.has('웰리스');
    });
    if (printerNoWellnessUnits.length > 0) {
      msgs.bumin.push({
        cls: 'info',
        text: `출력기기 보유·웰리스 無: <strong>${printerNoWellnessUnits.length}곳</strong> → 웰리스 패키지 제안`,
        drill: {
          type: 'customers',
          title: `출력기기 있고 웰리스 없는 거래처 ${printerNoWellnessUnits.length}곳`,
          items: makeUnitDrillItems(printerNoWellnessUnits),
        },
      });
    }
    const noNasUnits = groupedList.filter(u => !(unitCats.get(u._key) || new Set()).has('나스'));
    if (noNasUnits.length > 0) {
      msgs.bumin.push({
        cls: 'info',
        text: `NAS 미보유: <strong>${noNasUnits.length}곳</strong> → 장기 계약 영업 타깃`,
        drill: {
          type: 'customers',
          title: `NAS 미보유 거래처 ${noNasUnits.length}곳`,
          items: makeUnitDrillItems(noNasUnits),
        },
      });
    }
    if (msgs.bumin.length === 0) {
      msgs.bumin.push({ cls: 'muted', text: '현재 파악된 크로스셀 기회 없음 — 데이터 보강 후 재확인' });
    }

    // 수성책 — 이탈 위험
    const top20pct = state._top20pct;
    const top20n   = state._top20n;
    const avgFeePerCust = state._avgFeePerCust;
    if (top20pct != null && top20n != null && groupedList.length > 0) {
      const cls = top20pct >= 70 ? 'danger' : top20pct >= 50 ? 'warning' : 'info';
      const avgStr = avgFeePerCust != null ? ` · 전체 평균 <strong>${fmtWan(avgFeePerCust)}원</strong>` : '';
      msgs.suseong.push({
        cls,
        text: `상위 ${top20n}개 거래처(20%)가 매출 <strong>${top20pct}%</strong> 집중${avgStr} — 이탈 시 타격 큰 곳 우선 관리`,
        drill: {
          type: 'customers',
          title: `매출 상위 ${top20n}개 거래처`,
          items: makeUnitDrillItems(sortedByFee.slice(0, top20n).map(({ u }) => u)),
        },
      });
    }
    if (highRevWithDanger.length > 0) {
      const names = highRevWithDanger.slice(0, 3).map(({ u }) => `<strong>${escHtml(u.company || '거래처')}</strong>`).join(', ');
      msgs.suseong.push({
        cls: 'danger',
        text: `매출 상위 ${THRESHOLDS.HIGH_REVENUE_PCT}% 중 노후자산 보유: <strong>${highRevWithDanger.length}곳</strong> — ${names}`,
        drill: {
          type: 'customers',
          title: `매출 상위 ${THRESHOLDS.HIGH_REVENUE_PCT}% 중 위험자산 보유 ${highRevWithDanger.length}곳`,
          items: makeUnitDrillItems(highRevWithDanger.map(({ u }) => u)),
        },
      });
    }
    const singleCatUnits = groupedList.filter(u => (unitCats.get(u._key)||new Set()).size === 1);
    if (singleCatUnits.length > 0) {
      msgs.suseong.push({
        cls: 'warning',
        text: `단일 품목만 보유(이탈 용이): <strong>${singleCatUnits.length}곳</strong> → 추가 품목 제안으로 결속 강화`,
        drill: {
          type: 'customers',
          title: `단일 품목 보유 거래처 ${singleCatUnits.length}곳`,
          items: makeUnitDrillItems(singleCatUnits),
        },
      });
    }
    if (msgs.suseong.length === 0) {
      msgs.suseong.push({ cls: 'success', text: `고매출 거래처 위험자산 <strong>0건</strong> — 현재 이탈 위험 없음` });
    }

    // 공략책 — 확장 타깃
    const fewAssetsUnits = groupedList.filter(u => {
      const s = gaStats.get(u._key);
      return s && s.items.length <= THRESHOLDS.FEW_ASSETS;
    });
    if (fewAssetsUnits.length > 0) {
      msgs.gongnyak.push({
        cls: 'info',
        text: `자산 ${THRESHOLDS.FEW_ASSETS}건 이하 소규모 거래처: <strong>${fewAssetsUnits.length}곳</strong> → 영업 우선 공략`,
        drill: {
          type: 'customers',
          title: `소규모 거래처 (자산 ${THRESHOLDS.FEW_ASSETS}건 이하) ${fewAssetsUnits.length}곳`,
          items: makeUnitDrillItems(fewAssetsUnits),
        },
      });
    }
    const near6Items = activeItems.filter(it => {
      if (!it.install_date) return false;
      const ins = new Date(it.install_date);
      if (Number.isNaN(ins.getTime())) return false;
      const targetMonth = new Date(ins.getFullYear(), ins.getMonth() + THRESHOLDS.AGED_MONTHS, 1);
      const diffM = (targetMonth.getFullYear() - now.getFullYear()) * 12
                  + (targetMonth.getMonth() - now.getMonth());
      return diffM > 0 && diffM <= THRESHOLDS.NEAR_AGED;
    });
    if (near6Items.length > 0) {
      msgs.gongnyak.push({
        cls: 'warning',
        text: `6개월 내 60개월 도달: <strong>${near6Items.length}건</strong> → 선점 교체 영업 착수`,
        drill: {
          type: 'assets',
          title: `6개월 내 60개월 도달 자산 ${near6Items.length}건`,
          items: makeAssetDrillItems(near6Items),
        },
      });
    }
    if (msgs.gongnyak.length === 0) {
      msgs.gongnyak.push({ cls: 'muted', text: '현재 즉각적인 공략 대상 없음 — 자산 현황 지속 모니터링' });
    }

    // 간정 — 데이터 점검
    const noInstallDateItems = activeItems.filter(it => !it.install_date);
    if (noInstallDateItems.length > 0) {
      msgs.ganjung.push({
        cls: 'danger',
        text: `도입일 결측 자산: <strong>${noInstallDateItems.length}건</strong> → 노후도 계산 불가, 즉시 입력 필요`,
        drill: {
          type: 'assets',
          title: `도입일 미입력 자산 ${noInstallDateItems.length}건`,
          items: makeAssetDrillItems(noInstallDateItems),
        },
      });
    }
    // 메모 공란 — 원본 거래처 단위(그룹 소속 포함)로 집계
    const activeCusts = activeCustList();
    const noMemoCusts = activeCusts.filter(c => !c.notes || !String(c.notes).trim());
    const noMemoPctVal = activeCusts.length ? Math.round(noMemoCusts.length / activeCusts.length * 100) : 0;
    if (noMemoPctVal >= 30) {
      msgs.ganjung.push({
        cls: 'warning',
        text: `메모 공란 거래처: <strong>${noMemoPctVal}%</strong> (${noMemoCusts.length}개사) → 방문 이력 등 보강`,
        drill: {
          type: 'customers',
          title: `메모 없는 거래처 ${noMemoCusts.length}곳`,
          items: noMemoCusts.map(c => ({
            company: c.company || '–',
            contact: c.contact_name || '–',
            monthlyFee: 0,
            itemCount: 0,
            maxAge: null,
            custId: c.id,
          })),
        },
      });
    }
    const activeUnassignedItems = activeItems.filter(it => !assignMap.has(it.id));
    if (activeUnassignedItems.length > 0) {
      msgs.ganjung.push({
        cls: 'warning',
        text: `active 상태·미배정 자산: <strong>${activeUnassignedItems.length}건</strong> → 유휴 or 데이터 오류 확인`,
        drill: {
          type: 'assets',
          title: `미배정 활성 자산 ${activeUnassignedItems.length}건`,
          items: makeAssetDrillItems(activeUnassignedItems),
        },
      });
    }

    // 무상임대 비중 분석
    const freeItems = activeItems.filter(it => it.rental_type === 'free');
    const paidItems = activeItems.filter(it => (it.rental_type || 'paid') !== 'free');
    const freePct = activeItems.length ? Math.round(freeItems.length / activeItems.length * 100) : 0;
    if (freeItems.length > 0) {
      const freeMsg = freePct >= 15
        ? { cls: 'warning', text: `무상임대 비중 <strong>${freePct}%</strong> (${freeItems.length}건) — 토너구매 조건 등 계약 이행 여부 정기 점검 권장` }
        : { cls: 'info',    text: `무상임대 <strong>${freeItems.length}건</strong> (${freePct}%) / 유상 ${paidItems.length}건 — 무상임대는 토너구매 조건 포함` };
      msgs.ganjung.push(Object.assign(freeMsg, {
        drill: {
          type: 'assets',
          title: `무상임대 자산 ${freeItems.length}건`,
          items: makeAssetDrillItems(freeItems),
        },
      }));
    }

    if (msgs.ganjung.length === 0) {
      msgs.ganjung.push({ cls: 'success', text: '데이터 이상 없음 — 정기 점검 유지' });
    }

    return msgs;
  }

  // drill 데이터 임시 저장소 (index → drill 객체)
  const _drillStore = new Map();
  let _drillIdx = 0;

  function renderGahuPanel() {
    _drillStore.clear();
    _drillIdx = 0;
    const msgs = generateGahuAdvice();
    const sections = ['cheongi', 'bumin', 'suseong', 'gongnyak', 'ganjung'];
    for (const key of sections) {
      const el = document.getElementById(`acc-${key}`);
      if (!el) continue;
      const list = msgs[key] || [];
      if (list.length === 0) {
        el.innerHTML = `<div class="rs-gahu-section-empty">해당 섹션에 대한 분석 내용이 없습니다.</div>`;
      } else {
        el.innerHTML = list.map(m => {
          if (m.drill) {
            const idx = _drillIdx++;
            _drillStore.set(idx, m.drill);
            return `<div class="rs-gahu-msg ${escHtml(m.cls)}" data-drill="${idx}">${m.text}</div>`;
          }
          return `<div class="rs-gahu-msg ${escHtml(m.cls)}">${m.text}</div>`;
        }).join('');
      }
    }
    const sign = document.getElementById('gahu-sign');
    if (sign) sign.textContent = `${timeStr()} 기준 분석`;
  }

  // ============================================================
  // 드릴다운 모달
  // ============================================================
  let _currentDrill = null;

  function openDrillModal(drill) {
    _currentDrill = drill;
    const backdrop = document.getElementById('drill-modal-backdrop');
    const titleEl = document.getElementById('drill-modal-title');
    const bodyEl  = document.getElementById('drill-modal-body');
    const countEl = document.getElementById('drill-modal-count');
    if (!backdrop || !bodyEl) return;

    titleEl.textContent = drill.title;
    countEl.textContent = `${drill.items.length.toLocaleString()}건`;

    if (drill.type === 'customers') {
      bodyEl.innerHTML = buildCustDrillTable(drill.items);
    } else if (drill.type === 'orders') {
      bodyEl.innerHTML = buildOrderDrillTable(drill.items);
    } else {
      bodyEl.innerHTML = buildAssetDrillTable(drill.items);
    }

    backdrop.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeDrillModal() {
    const backdrop = document.getElementById('drill-modal-backdrop');
    if (backdrop) backdrop.classList.remove('show');
    document.body.style.overflow = '';
    _currentDrill = null;
  }

  function buildCustDrillTable(items) {
    if (!items.length) return '<div class="rs-loading">항목 없음</div>';
    const rows = items.map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td data-label="회사명"><strong>${escHtml(r.company)}</strong></td>
        <td data-label="담당자" class="hide-mobile">${escHtml(r.contact)}</td>
        <td class="num" data-label="월임대료">${r.monthlyFee > 0 ? fmtMoney(r.monthlyFee) : '<span class="muted-cell">–</span>'}</td>
        <td class="num" data-label="자산수">${r.itemCount}</td>
        <td class="num" data-label="최대노후">${agePillHtml(r.maxAge)}</td>
      </tr>`).join('');
    return `<div style="overflow-x:auto;">
      <table class="rs-data-table">
        <thead><tr>
          <th>#</th><th>회사명</th><th class="hide-mobile">담당자</th>
          <th class="num">월 임대료</th><th class="num">자산수</th><th class="num">최대 노후도</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function buildOrderDrillTable(items) {
    if (!items.length) return '<div class="rs-loading">항목 없음</div>';
    const rows = items.map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td data-label="거래처"><strong>${escHtml(r.company)}</strong></td>
        <td data-label="접수항목"><span class="cat-badge">${escHtml(r.kind)}</span></td>
        <td class="num" data-label="처리일">${r.date ? fmtDate(r.date) : '<span class="muted-cell">–</span>'}</td>
        <td class="num hide-mobile" data-label="접수번호">${escHtml(String(r.seq ?? '–'))}</td>
      </tr>`).join('');
    return `<div style="overflow-x:auto;">
      <table class="rs-data-table">
        <thead><tr>
          <th>#</th><th>거래처</th><th>접수 항목</th>
          <th class="num">처리일</th><th class="num hide-mobile">접수번호</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function buildAssetDrillTable(items) {
    if (!items.length) return '<div class="rs-loading">항목 없음</div>';
    const rows = items.map((r, i) => `
      <tr>
        <td>${i+1}</td>
        <td data-label="카테고리"><span class="cat-badge">${escHtml(r.cat)}</span></td>
        <td data-label="품목" class="hide-mobile">${escHtml(r.subtype)}</td>
        <td data-label="모델"><strong>${escHtml(r.model)}</strong></td>
        <td data-label="거래처">${escHtml(r.company)}</td>
        <td class="num" data-label="노후도">${agePillHtml(r.ageM)}</td>
        <td class="num hide-mobile" data-label="도입일">${r.installDate ? fmtDate(r.installDate) : '<span class="muted-cell">–</span>'}</td>
      </tr>`).join('');
    return `<div style="overflow-x:auto;">
      <table class="rs-data-table">
        <thead><tr>
          <th>#</th><th>카테고리</th><th class="hide-mobile">품목</th><th>모델</th>
          <th>거래처</th><th class="num">노후도</th><th class="num hide-mobile">도입일</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  function exportDrillCsv() {
    if (!_currentDrill) return;
    const d = _currentDrill;
    const date = todayStr();
    let rows;
    if (d.type === 'customers') {
      rows = [['#','회사명','담당자','월임대료','자산수','최대노후도(개월)']];
      d.items.forEach((r, i) => rows.push([i+1, r.company, r.contact, r.monthlyFee, r.itemCount, r.maxAge == null ? '' : r.maxAge]));
    } else if (d.type === 'orders') {
      rows = [['#','거래처','접수항목','처리일','접수번호']];
      d.items.forEach((r, i) => rows.push([i+1, r.company, r.kind, r.date || '', r.seq ?? '']));
    } else {
      rows = [['#','카테고리','품목','모델','거래처','노후도(개월)','도입일']];
      d.items.forEach((r, i) => rows.push([i+1, r.cat, r.subtype, r.model, r.company, r.ageM == null ? '' : r.ageM, r.installDate || '']));
    }
    const safeTitle = d.title.replace(/[^\w가-힣\s]/g, '').trim().slice(0, 30).replace(/\s+/g, '_');
    downloadCsv(`drill_${safeTitle}_${date}.csv`, rows);
  }

  // ============================================================
  // 아코디언 이벤트
  // ============================================================
  function bindAccordion() {
    $$('.rs-gahu-accordion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.acc;
        const body = document.getElementById(`acc-${key}`);
        const isOpen = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        if (body) body.classList.toggle('open', !isOpen);
      });
    });
  }

  // ============================================================
  // 탭 전환
  // ============================================================
  function switchTab(tab) {
    state.activeTab = tab;
    $$('.rs-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.rs-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  }

  function refreshTabCounts() {
    const groupedList = buildGroupedCustomerList();
    let memoCount = 0;
    for (const c of state.customers) if (c.notes && String(c.notes).trim()) memoCount++;
    for (const it of state.items) if (it.notes && String(it.notes).trim()) memoCount++;
    const setTc = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n.toLocaleString(); };
    setTc('tc-customers', groupedList.length);
    setTc('tc-items', state.items.length);
    setTc('tc-age', state.items.length);
    setTc('tc-memo', memoCount);
  }

  // ============================================================
  // 거래처별 탭
  // ============================================================
  function renderCustomersTab() {
    const tbody = document.querySelector('#cust-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const f = state.filters.cust;
    const q = f.q.trim().toLowerCase();
    const gaStats = buildGroupAwareStats();
    const groupedList = buildGroupedCustomerList();

    let rows = groupedList.map(u => ({
      u,
      s: gaStats.get(u._key) || { items: [], monthlyFee: 0, byCat: {}, maxAge: null },
    }));

    rows = rows.filter(({ u, s }) => {
      if (f.pay && u.payment_type !== f.pay) return false;
      if (f.cat && !s.byCat[f.cat]) return false;
      if (q) {
        // 그룹이면 멤버 회사명도 검색 대상
        const memberNames = u._isGroup ? (u._members || []).map(m => m.company || '').join(' ') : '';
        const hay = [u.company, u.address, u.notes, u.contact_name, memberNames]
          .map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    rows.sort((a, b) =>
      (b.s.items.length - a.s.items.length) ||
      String(a.u.company || '').localeCompare(String(b.u.company || ''), 'ko'));

    const cnt = document.getElementById('cf-count');
    if (cnt) cnt.textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-row-td">조건에 맞는 거래처가 없습니다.</td></tr>`;
      return;
    }

    tbody.insertAdjacentHTML('beforeend', rows.slice(0, MAX_RENDER).map(({ u, s }, idx) => {
      const dist = Object.entries(s.byCat)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="cat-badge">${escHtml(k)} ${v}</span>`)
        .join('');
      const subLine = u._isGroup
        ? `<br><span class="muted-cell" style="font-size:11px;">그룹 합산 ${u._memberCount}개사</span>`
        : (u.contact_name ? `<br><span class="muted-cell" style="font-size:11px;">${escHtml(u.contact_name)}</span>` : '');
      // 그룹 행은 상세 모달 미지원(data-cid 생략), 개별 거래처만 클릭 가능
      const rowAttr = u._isGroup
        ? `class="cust-row group-row" title="${escHtml(u.company)} — 합산 그룹 (${u._memberCount}개사)"`
        : `class="cust-row" data-cid="${escHtml(u.id)}" title="클릭하여 상세 보기"`;
      return `
        <tr ${rowAttr}>
          <td>${idx + 1}</td>
          <td data-label="회사명"><strong>${escHtml(u.company || '–')}</strong>${subLine}</td>
          <td class="num" data-label="자산수">${s.items.length.toLocaleString()}</td>
          <td data-label="카테고리">${dist || '<span class="muted-cell">–</span>'}</td>
          <td class="num" data-label="월임대료">${s.monthlyFee > 0 ? fmtMoney(s.monthlyFee) : '<span class="muted-cell">–</span>'}</td>
          <td class="hide-mobile" data-label="주소">${escHtml(u.address || '–')}</td>
          <td data-label="결제">${payTagHtml(u.payment_type)}</td>
          <td class="num hide-mobile" data-label="청구일">${u.invoice_day != null ? escHtml(String(u.invoice_day)) + '일' : '<span class="muted-cell">–</span>'}</td>
          <td class="num" data-label="최대노후">${agePillHtml(s.maxAge)}</td>
        </tr>`;
    }).join(''));
  }

  // ============================================================
  // 자산별 탭
  // ============================================================
  function renderItemsTab() {
    const tbody = document.querySelector('#item-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const f = state.filters.item;
    const q = f.q.trim().toLowerCase();

    let rows = getItemRows();
    rows = rows.filter(({ it, customer, assignment }) => {
      const klass = classifyItem(it, assignment);
      if (f.cat && klass !== f.cat) return false;
      if (f.status && (it.status || 'active') !== f.status) return false;
      if (f.assign === 'assigned' && !assignment) return false;
      if (f.assign === 'idle' && assignment) return false;
      if (f.rtype === 'paid' && it.rental_type === 'free') return false;
      if (f.rtype === 'free' && it.rental_type !== 'free') return false;
      if (q) {
        const hay = [it.brand, it.model, it.serial, it.subtype, klass,
                     it.notes, customer && customer.company]
          .map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      const ka = classifyItem(a.it, a.assignment);
      const kb = classifyItem(b.it, b.assignment);
      return String(ka).localeCompare(String(kb), 'ko') ||
             String(a.it.model || '').localeCompare(String(b.it.model || ''), 'ko');
    });

    const cnt = document.getElementById('if-count');
    if (cnt) cnt.textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-row-td">조건에 맞는 자산이 없습니다.</td></tr>`;
      return;
    }

    tbody.insertAdjacentHTML('beforeend', rows.slice(0, MAX_RENDER).map(({ it, assignment, customer, ageM }, idx) => {
      const klass = classifyItem(it, assignment);
      const custHtml = customer
        ? `<strong>${escHtml(customer.company || '–')}</strong>`
        : '<span class="muted-cell">미배정</span>';
      const fee = assignment && Number(assignment.monthly_fee) > 0
        ? fmtMoney(assignment.monthly_fee) : '<span class="muted-cell">–</span>';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td data-label="카테고리"><span class="cat-badge">${escHtml(klass)}</span></td>
          <td data-label="브랜드/모델">${escHtml(it.brand || '–')} / ${escHtml(it.model || '–')}</td>
          <td class="hide-mobile" data-label="시리얼">${escHtml(it.serial || '–')}</td>
          <td data-label="거래처">${custHtml}</td>
          <td class="num hide-mobile" data-label="도입일">${fmtDate(it.install_date)}</td>
          <td class="num" data-label="노후도">${agePillHtml(ageM)}</td>
          <td class="num" data-label="월임대료">${fee}</td>
          <td data-label="유형">${rtypeTagHtml(it.rental_type)}</td>
          <td data-label="상태">${statusTagHtml(it.status)}</td>
        </tr>`;
    }).join(''));
  }

  // ============================================================
  // 노후도 순 탭
  // ============================================================
  function renderAgeTab() {
    const tbody = document.querySelector('#age-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const f = state.filters.age;
    const q = f.q.trim().toLowerCase();

    let rows = getItemRows();
    rows = rows.filter(({ it, customer, assignment, ageM }) => {
      const klass = classifyItem(it, assignment);
      if (f.cat && klass !== f.cat) return false;
      if (f.band && ageBand(ageM) !== f.band) return false;
      if (q) {
        const hay = [it.brand, it.model, it.serial, klass, customer && customer.company]
          .map(v => String(v == null ? '' : v).toLowerCase()).join(' ');
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      const aA = a.ageM == null ? -1 : a.ageM;
      const bA = b.ageM == null ? -1 : b.ageM;
      return bA - aA;
    });

    const cnt = document.getElementById('af-count');
    if (cnt) cnt.textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-row-td">조건에 맞는 자산이 없습니다.</td></tr>`;
      return;
    }

    tbody.insertAdjacentHTML('beforeend', rows.slice(0, MAX_RENDER).map(({ it, customer, assignment, ageM }, idx) => {
      const klass = classifyItem(it, assignment);
      const custHtml = customer ? escHtml(customer.company || '–') : '<span class="muted-cell">미배정</span>';
      const replace = ageM != null && ageM >= THRESHOLDS.AGED_MONTHS
        ? '<span class="replace-tag">교체</span>' : '';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td data-label="카테고리"><span class="cat-badge">${escHtml(klass)}</span></td>
          <td data-label="브랜드/모델">${escHtml(it.brand || '–')} / ${escHtml(it.model || '–')}</td>
          <td class="hide-mobile" data-label="시리얼">${escHtml(it.serial || '–')}</td>
          <td data-label="거래처">${custHtml}</td>
          <td class="num hide-mobile" data-label="도입일">${fmtDate(it.install_date)}</td>
          <td class="num" data-label="노후도">${agePillHtml(ageM)}</td>
          <td data-label="상태">${statusTagHtml(it.status)}</td>
          <td data-label="교체">${replace}</td>
        </tr>`;
    }).join(''));
  }

  // ============================================================
  // 메모 탭
  // ============================================================
  function getMemoRows() {
    const rows = [];
    for (const c of state.customers) {
      if (c.notes && String(c.notes).trim()) {
        rows.push({ kind: 'customer', target: c.company || c.contact_name || `#${c.id}`, memo: String(c.notes) });
      }
    }
    for (const it of state.items) {
      if (it.notes && String(it.notes).trim()) {
        const label = [it.brand, it.model].filter(Boolean).join(' ').trim() || it.serial || `#${it.id}`;
        rows.push({ kind: 'item', target: label, memo: String(it.notes) });
      }
    }
    return rows;
  }

  function renderMemoTab() {
    const tbody = document.querySelector('#memo-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const f = state.filters.memo;
    const q = f.q.trim().toLowerCase();

    let rows = getMemoRows().filter(r => {
      if (f.kind && r.kind !== f.kind) return false;
      if (q && !(r.target + ' ' + r.memo).toLowerCase().includes(q)) return false;
      return true;
    });

    rows.sort((a, b) =>
      String(a.kind).localeCompare(String(b.kind)) ||
      String(a.target).localeCompare(String(b.target), 'ko'));

    const cnt = document.getElementById('mf-count');
    if (cnt) cnt.textContent = `${rows.length.toLocaleString()} 건`;

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="empty-row-td">메모가 입력된 항목이 없습니다.</td></tr>`;
      return;
    }

    tbody.insertAdjacentHTML('beforeend', rows.map(r => {
      const memo = r.memo.length > 200 ? r.memo.slice(0, 200) + '…' : r.memo;
      const tag = r.kind === 'customer'
        ? '<span class="kind-tag">거래처</span>'
        : '<span class="kind-tag item">자산</span>';
      return `
        <tr>
          <td data-label="종류">${tag}</td>
          <td data-label="대상"><strong>${escHtml(r.target)}</strong></td>
          <td data-label="메모"><div style="white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.5;">${escHtml(memo)}</div></td>
        </tr>`;
    }).join(''));
  }

  // ============================================================
  // 필터 select 초기화
  // ============================================================
  let _selectsBuilt = false;
  function populateSelectsOnce() {
    if (_selectsBuilt) return;
    _selectsBuilt = true;

    const fillSel = (sel, values) => {
      if (!sel) return;
      for (const v of values) {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        sel.appendChild(opt);
      }
    };

    fillSel(document.getElementById('if-cat'), CATS);
    fillSel(document.getElementById('af-cat'), CATS);

    const cfCat = document.getElementById('cf-cat');
    if (cfCat) {
      cfCat.innerHTML = '<option value="">보유 카테고리 전체</option>' +
        CATS.map(c => `<option value="${escHtml(c)}">${escHtml(c)} 보유</option>`).join('');
    }
  }

  // ============================================================
  // 이벤트 바인딩
  // ============================================================
  function bindEvents() {
    // 탭 전환
    $$('.rs-tab-btn').forEach(b => {
      b.addEventListener('click', () => {
        switchTab(b.dataset.tab);
        renderActiveTab();
      });
    });

    // 거래처 행 클릭
    document.addEventListener('click', e => {
      const row = e.target.closest('.cust-row');
      if (row && row.dataset.cid) openCustomerDetail(row.dataset.cid);
    });

    // 거래처 상세 모달 닫기
    document.addEventListener('click', e => {
      if (e.target.id === 'rs-modal-backdrop' || e.target.closest('[data-modal-close]')) {
        closeCustomerDetail();
      }
    });

    // 드릴다운 메시지 클릭 (분석 패널)
    document.addEventListener('click', e => {
      const msg = e.target.closest('.rs-gahu-msg[data-drill]');
      if (msg) {
        const idx = parseInt(msg.dataset.drill, 10);
        const drill = _drillStore.get(idx);
        if (drill) openDrillModal(drill);
      }
    });

    // 차트 카드 클릭 → 드릴다운 (canvas 위 click 은 Chart.js onClick 처리, 빈 영역 클릭 처리)
    document.addEventListener('click', e => {
      const card = e.target.closest('.rs-chart-card[data-chart-drill]');
      if (!card) return;
      // canvas 자체는 Chart.js onClick 에서 처리하므로 canvas 클릭은 넘김
      if (e.target.tagName === 'CANVAS') return;
      const key = card.dataset.chartDrill;
      const drill = _chartDrills[key];
      if (drill && drill.items && drill.items.length) openDrillModal(drill);
    });

    // 드릴 모달 닫기 — 백드롭 / X 버튼
    document.addEventListener('click', e => {
      if (e.target.id === 'drill-modal-backdrop') closeDrillModal();
      if (e.target.id === 'drill-modal-close') closeDrillModal();
    });

    // 드릴 CSV 내보내기
    const csvBtn = document.getElementById('drill-modal-csv');
    if (csvBtn) csvBtn.addEventListener('click', exportDrillCsv);

    // 거래처별 필터
    const debCust = debounce(() => renderCustomersTab(), 150);
    document.getElementById('cf-q').addEventListener('input', e => { state.filters.cust.q = e.target.value; debCust(); });
    document.getElementById('cf-pay').addEventListener('change', e => { state.filters.cust.pay = e.target.value; renderCustomersTab(); });
    document.getElementById('cf-cat').addEventListener('change', e => { state.filters.cust.cat = e.target.value; renderCustomersTab(); });

    // 자산별 필터
    const debItem = debounce(() => renderItemsTab(), 150);
    document.getElementById('if-q').addEventListener('input', e => { state.filters.item.q = e.target.value; debItem(); });
    document.getElementById('if-cat').addEventListener('change', e => { state.filters.item.cat = e.target.value; renderItemsTab(); });
    document.getElementById('if-status').addEventListener('change', e => { state.filters.item.status = e.target.value; renderItemsTab(); });
    document.getElementById('if-assign').addEventListener('change', e => { state.filters.item.assign = e.target.value; renderItemsTab(); });
    document.getElementById('if-rtype').addEventListener('change', e => { state.filters.item.rtype = e.target.value; renderItemsTab(); });

    // 노후도 필터
    const debAge = debounce(() => renderAgeTab(), 150);
    document.getElementById('af-q').addEventListener('input', e => { state.filters.age.q = e.target.value; debAge(); });
    document.getElementById('af-cat').addEventListener('change', e => { state.filters.age.cat = e.target.value; renderAgeTab(); });
    document.getElementById('af-band').addEventListener('change', e => { state.filters.age.band = e.target.value; renderAgeTab(); });

    // 메모 필터
    const debMemo = debounce(() => renderMemoTab(), 150);
    document.getElementById('mf-q').addEventListener('input', e => { state.filters.memo.q = e.target.value; debMemo(); });
    document.getElementById('mf-kind').addEventListener('change', e => { state.filters.memo.kind = e.target.value; renderMemoTab(); });

    // 새로고침
    document.getElementById('btn-refresh').addEventListener('click', () => {
      state.loaded = false;
      refresh();
    });

    // CSV 내보내기
    document.getElementById('btn-export').addEventListener('click', exportCurrentTabCsv);

    // 아코디언
    bindAccordion();
  }

  // ============================================================
  // 거래처 상세 모달
  // ============================================================
  function openCustomerDetail(cid) {
    const c = state.customers.find(x => x.id === cid);
    if (!c) return;
    const assignMap = buildItemAssignMap();
    const items = state.items
      .filter(it => { const a = assignMap.get(it.id); return a && a.customer_id === cid; })
      .sort((a, b) => (b.install_date || '').localeCompare(a.install_date || ''));

    let monthlyTotal = 0;
    items.forEach(it => {
      const a = assignMap.get(it.id);
      if (a && a.monthly_fee) monthlyTotal += Number(a.monthly_fee) || 0;
    });
    const maxAge = items.reduce((m, it) => {
      const ag = ageMonths(it); return ag != null && ag > m ? ag : m;
    }, 0);

    const itemRows = items.length === 0
      ? `<tr><td colspan="7" class="empty-row-td">배정된 자산이 없습니다.</td></tr>`
      : items.map((it, i) => {
          const a = assignMap.get(it.id) || {};
          return `<tr>
            <td>${i+1}</td>
            <td data-label="카테고리"><span class="cat-badge">${escHtml(classifyItem(it,a))}</span></td>
            <td data-label="품목">${escHtml(it.subtype || '–')}</td>
            <td data-label="브랜드/모델"><strong>${escHtml(it.brand||'')} ${escHtml(it.model||'–')}</strong>${it.serial?`<br><span class="muted-cell" style="font-size:11px;">${escHtml(it.serial)}</span>`:''}</td>
            <td class="num" data-label="도입일">${fmtDate(it.install_date)}</td>
            <td class="num" data-label="노후도">${agePillHtml(ageMonths(it))}</td>
            <td class="num" data-label="월임대료">${a.monthly_fee ? fmtMoney(a.monthly_fee) : '<span class="muted-cell">–</span>'}</td>
          </tr>`;
        }).join('');

    let modal = document.getElementById('rs-modal-backdrop');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'rs-modal-backdrop';
      modal.className = 'rs-modal-backdrop';
      document.body.appendChild(modal);
    }
    modal.innerHTML = `
      <div class="rs-modal" role="dialog" aria-modal="true">
        <div class="rs-modal-head">
          <div>
            <h2 style="margin:0; font-size:17px;">${escHtml(c.company || '거래처')}</h2>
            <div style="margin-top:3px; font-size:12.5px; color:#64748b;">
              ${c.contact_name ? '담당: ' + escHtml(c.contact_name) + ' · ' : ''}자산 ${items.length}건 · 월 ${fmtMoney(monthlyTotal)}원${maxAge ? ' · 최대 노후 ' + maxAge + '개월' : ''}
            </div>
          </div>
          <button type="button" class="rs-btn" data-modal-close aria-label="닫기">&#x2715;</button>
        </div>
        <div class="rs-modal-body">
          <div class="rs-section-title">기본 정보</div>
          <div class="rs-info-grid">
            <div><label>회사명</label>${escHtml(c.company||'–')}</div>
            <div><label>담당자</label>${escHtml(c.contact_name||'–')}</div>
            <div><label>전화</label>${escHtml(c.phone||'–')}</div>
            <div><label>이메일</label>${escHtml(c.email||'–')}</div>
            <div><label>사업자번호</label>${escHtml(c.biz_no||'–')}</div>
            <div><label>결제방식</label>${payTagHtml(c.payment_type)}</div>
            <div><label>청구일</label>${c.invoice_day ? escHtml(String(c.invoice_day))+'일' : '–'}</div>
            <div><label>보증금</label>${c.deposit ? fmtMoney(c.deposit) : '–'}</div>
            <div style="grid-column:1/-1;"><label>주소</label>${escHtml(c.address||'–')}</div>
          </div>
          <div class="rs-section-title">보유 자산 (${items.length}건)</div>
          <div style="overflow-x:auto;">
            <table class="rs-data-table">
              <thead><tr><th>#</th><th>카테고리</th><th>품목</th><th>브랜드/모델</th><th>도입일</th><th class="num">노후도</th><th class="num">월임대료</th></tr></thead>
              <tbody>${itemRows}</tbody>
            </table>
          </div>
          ${c.notes && c.notes.trim() ? `
            <div class="rs-section-title">메모/특이사항</div>
            <div class="rs-notes-block">${escHtml(c.notes)}</div>
          ` : ''}
        </div>
        <div class="rs-modal-foot">
          <button type="button" class="rs-btn" data-modal-close>닫기</button>
        </div>
      </div>`;
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function closeCustomerDetail() {
    const modal = document.getElementById('rs-modal-backdrop');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = '';
  }

  // ============================================================
  // CSV 내보내기
  // ============================================================
  function csvEsc(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function downloadCsv(filename, rows) {
    const BOM = '﻿';
    const csv = rows.map(r => r.map(csvEsc).join(',')).join('\r\n');
    const blob = new Blob([BOM + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function exportCurrentTabCsv() {
    const tab = state.activeTab;
    const date = todayStr();
    if (tab === 'customers') {
      const gaStats = buildGroupAwareStats();
      const groupedList = buildGroupedCustomerList();
      const csv = [['#','회사명','구분','담당자/멤버수','자산수','카테고리분포','월임대료','주소','결제','청구일','최대노후도(개월)']];
      groupedList.forEach((u, idx) => {
        const s = gaStats.get(u._key) || {};
        const dist = Object.entries(s.byCat||{}).map(([k,v]) => `${k}:${v}`).join(' / ');
        csv.push([
          idx+1, u.company||'', u._isGroup ? '그룹' : '단독',
          u._isGroup ? `${u._memberCount}개사` : (u.contact_name||''),
          (s.items||[]).length, dist, s.monthlyFee||0,
          u.address||'', u.payment_type||'', u.invoice_day||'',
          s.maxAge==null?'':s.maxAge,
        ]);
      });
      downloadCsv(`임대현황_거래처별_${date}.csv`, csv);
    } else if (tab === 'items') {
      const rows = getItemRows();
      const csv = [['#','카테고리','브랜드','모델','시리얼','거래처','도입일','노후도(개월)','월임대료','임대유형','상태']];
      rows.forEach(({ it, assignment, customer, ageM }, idx) => {
        const klass = classifyItem(it, assignment);
        csv.push([idx+1, klass, it.brand||'', it.model||'', it.serial||'',
          customer?(customer.company||''):'', fmtDate(it.install_date)==='–'?'':fmtDate(it.install_date),
          ageM==null?'':ageM, assignment?(assignment.monthly_fee||0):'',
          it.rental_type === 'free' ? '무상' : '유상', it.status||'active']);
      });
      downloadCsv(`임대현황_자산별_${date}.csv`, csv);
    } else if (tab === 'age') {
      const rows = getItemRows().sort((a,b)=>(b.ageM==null?-1:b.ageM)-(a.ageM==null?-1:a.ageM));
      const csv = [['#','카테고리','브랜드','모델','시리얼','거래처','도입일','노후도(개월)','상태','교체권장']];
      rows.forEach(({ it, customer, assignment, ageM }, idx) => {
        const klass = classifyItem(it, assignment);
        csv.push([idx+1, klass, it.brand||'', it.model||'', it.serial||'',
          customer?(customer.company||''):'', fmtDate(it.install_date)==='–'?'':fmtDate(it.install_date),
          ageM==null?'':ageM, it.status||'active',
          ageM!=null&&ageM>=THRESHOLDS.AGED_MONTHS?'교체':'']);
      });
      downloadCsv(`임대현황_노후도순_${date}.csv`, csv);
    } else if (tab === 'memo') {
      const rows = getMemoRows();
      const csv = [['종류','대상','메모']];
      rows.forEach(r => csv.push([r.kind==='customer'?'거래처':'자산', r.target, r.memo]));
      downloadCsv(`임대현황_메모_${date}.csv`, csv);
    }
  }

  // ============================================================
  // 렌더 진입점
  // ============================================================
  function renderActiveTab() {
    if (state.activeTab === 'customers') renderCustomersTab();
    else if (state.activeTab === 'items') renderItemsTab();
    else if (state.activeTab === 'age') renderAgeTab();
    else if (state.activeTab === 'memo') renderMemoTab();
  }

  function renderAll() {
    renderKpi();
    renderAllCharts();
    renderGahuPanel();
    refreshTabCounts();
    populateSelectsOnce();
    renderActiveTab();
    const el = document.getElementById('last-updated');
    if (el) el.textContent = timeStr();
  }

  async function refresh() {
    if (state._refreshing) return;
    state._refreshing = true;
    try {
      await loadAll();
      renderAll();
      state._lastRefreshAt = Date.now();
    } catch (err) {
      console.error('[rental-status] 로드 실패:', err);
      showError(err);
    } finally {
      state._refreshing = false;
    }
  }

  // 자동 갱신: 페이지가 보이는 동안 90초 폴링 + 탭 복귀 시 30초 경과면 즉시 갱신.
  // (실시간 채널 publication 설정 없이 동작하도록 polling + visibility 조합 사용)
  function startAutoRefresh() {
    if (state._autoRefreshStarted) return;
    state._autoRefreshStarted = true;
    setInterval(() => {
      if (!document.hidden && window.totalasAuth) refresh();
    }, 90 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !window.totalasAuth) return;
      const last = state._lastRefreshAt || 0;
      if (Date.now() - last > 30 * 1000) refresh();
    });
  }

  function showError(err) {
    const msg = (err && (err.message || err.hint)) || String(err);
    const banner = document.getElementById('rs-err-banner');
    if (banner) {
      banner.style.display = '';
      banner.innerHTML = `데이터 로드 실패: <code>${escHtml(msg)}</code><br>
        <span style="font-size:12px;">Supabase 스키마(rental_customers / rental_items / rental_assignments) 적용 여부를 확인하십시오.</span>`;
    }
  }

  // ============================================================
  // 부팅
  // ============================================================
  function boot() {
    if (state.loaded) return;
    refresh();
    startAutoRefresh();
  }

  function start() {
    bindEvents();
    if (window.totalasAuth) {
      boot();
    } else {
      document.addEventListener('totalas:ready', boot, { once: true });
      setTimeout(() => { if (!state.loaded && window.totalasAuth) boot(); }, 2000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
